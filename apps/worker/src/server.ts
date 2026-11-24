// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Firestore } from "@google-cloud/firestore";
import {
  geminiFromEnv,
  resolveModelRouting,
  usdToMicros,
  type PriceTable,
} from "@after-genesis/cognition";
import {
  FirestoreCanonicalStore,
  FirestoreIdempotencyStore,
  FirestoreModelAuditStore,
  FirestoreSpendReservationStore,
  SystemClock,
} from "@after-genesis/persistence";
import {
  CloudTasksTurnQueue,
  ProviderCognitionService,
  createTurnWorker,
  type TurnWorkerHttpRequest,
} from "@after-genesis/runtime";

const MAX_BODY_BYTES = 16 * 1024;
const environment = requiredEnvironment(process.env);
const database = new Firestore({ projectId: environment.projectId });
const canonical = new FirestoreCanonicalStore(database);
const clock = new SystemClock();
const queue = new CloudTasksTurnQueue({
  projectId: environment.projectId,
  location: environment.tasksLocation,
  queue: environment.tasksQueue,
  workerUrl: environment.workerUrl,
  serviceAccountEmail: environment.tasksServiceAccount,
});
const prices: readonly PriceTable[] = [
  priceFor(environment.modelId),
];
const cognition = new ProviderCognitionService({
  provider: geminiFromEnv(process.env),
  audit: new FirestoreModelAuditStore(database),
  durableSpend: new FirestoreSpendReservationStore(database),
  modelId: environment.modelId,
  prices,
  limits: {
    dailyMicros: usdToMicros(environment.dailySpendUsd),
    totalMicros: usdToMicros(environment.totalSpendUsd),
  },
  dayKey: new Date().toISOString().slice(0, 10),
});
const worker = createTurnWorker({
  turn: {
    eventStore: canonical,
    stateStore: canonical,
    atomicStore: canonical,
    idempotency: new FirestoreIdempotencyStore(database, randomUUID()),
    clock,
    cognition,
    provenance: {
      sourceCommit: environment.sourceCommit,
      deployedDigest: environment.deployedDigest,
    },
  },
  scheduler: {
    eventStore: canonical,
    stateStore: canonical,
    queue,
  },
  expectedQueueName: environment.tasksQueue,
});

const server = createServer(async (request, response) => {
  if (request.url === "/healthz" && request.method === "GET") {
    send(response, 200, { ok: true, status: "ready" });
    return;
  }
  if (request.url !== "/turn") {
    send(response, 404, { ok: false, status: "not-found" });
    return;
  }
  try {
    const body = await readJsonBody(request);
    const result = await worker(asWorkerRequest(request, body));
    send(response, result.status, result.body);
  } catch {
    send(response, 400, { ok: false, status: "invalid-json" });
  }
});

server.listen(environment.port, "0.0.0.0", () => {
  process.stdout.write(`turn worker listening on port ${environment.port}\n`);
});

function asWorkerRequest(request: IncomingMessage, body: unknown): TurnWorkerHttpRequest {
  return {
    method: request.method ?? "",
    headers: {
      get(name) {
        const value = request.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] ?? null : value ?? null;
      },
    },
    json: async () => body,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function requiredEnvironment(source: NodeJS.ProcessEnv) {
  const modelId = resolveModelRouting(source).routine;
  if (modelId !== "gemini-3.5-flash-lite" && modelId !== "gemini-3.6-flash") {
    throw new Error(`No verified price table is bundled for configured model ${modelId}`);
  }
  return {
    projectId: required(source, "GOOGLE_CLOUD_PROJECT"),
    tasksLocation: required(source, "AG_TASKS_LOCATION"),
    tasksQueue: required(source, "AG_TASKS_QUEUE"),
    workerUrl: required(source, "AG_TURN_WORKER_URL"),
    tasksServiceAccount: required(source, "AG_TASKS_SERVICE_ACCOUNT"),
    sourceCommit: required(source, "AG_SOURCE_COMMIT"),
    deployedDigest: required(source, "AG_DEPLOYED_DIGEST"),
    modelId,
    dailySpendUsd: required(source, "AG_SPEND_LIMIT_DAILY_USD"),
    totalSpendUsd: required(source, "AG_SPEND_LIMIT_TOTAL_USD"),
    port: parsePort(source["PORT"] ?? "8080"),
  };
}

function priceFor(modelId: string): PriceTable {
  if (modelId === "gemini-3.6-flash") {
    return {
      modelId,
      inputMicrosPerMillionTokens: 1_500_000,
      outputMicrosPerMillionTokens: 7_500_000,
      verifiedOn: "2026-07-30",
    };
  }
  return {
    modelId,
    inputMicrosPerMillionTokens: 300_000,
    outputMicrosPerMillionTokens: 2_500_000,
    verifiedOn: "2026-07-28",
  };
}

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return port;
}
