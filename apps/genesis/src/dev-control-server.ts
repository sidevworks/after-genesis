#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
loadEnvFile(resolve(ROOT, ".env"));

const PORT = Number(process.env.AG_DEV_CONTROL_PORT ?? 8787);
const RUN_DIR = process.env.AG_DEV_RUN_DIR ?? ".worlds/dev-rehearsal";

/**
 * Where this controller publishes the world it drives. Untracked, and separate
 * from `apps/spectator/src/fixtures/` on purpose: those fixtures are the demo
 * the public pages render and the data the test suite asserts against, so a dev
 * reset must not be able to redefine them. See apps/spectator/src/lib/
 * dev-world-paths.ts, which is the reading half of this arrangement.
 */
const DEV_WORLD_DIR = "apps/spectator/.dev-world";
const DEV_WORLD_FILE = `${DEV_WORLD_DIR}/world.json`;
const DEV_OBSERVATORY_FILE = `${DEV_WORLD_DIR}/observatory-run.json`;

/** The reel this controller renders. Untracked: dev audio never ships. */
const DEV_VOICE_REEL = "month";
const DEV_VOICE_DIR = `apps/spectator/public/voice/${DEV_VOICE_REEL}`;

/**
 * Every path a dev run writes to. Reset removes all of them, so a reset world
 * is indistinguishable from one started in a fresh clone: no events, no state,
 * no model audit, no published snapshot, no rendered audio.
 *
 * Rehearsal is the reason. A world that inherited a previous run's residue
 * would not be testing the rules as they would actually run from Genesis, and
 * after Genesis nothing can be corrected.
 *
 * RUN_DIR is handled by the engine's own `--reset`, which erases its events,
 * state and model-audit directories.
 */
const GENERATED_BY_A_DEV_RUN: readonly string[] = [DEV_WORLD_DIR, DEV_VOICE_DIR];

type CognitionProvider = "gemini" | "offline";
type GeminiModel = "gemini-3.5-flash-lite";
type ModelSet = {
  routine: GeminiModel;
  deliberate: GeminiModel;
};

type Status = {
  running: boolean;
  provider: CognitionProvider;
  model: GeminiModel;
  deliberateModel: GeminiModel;
  voice: {
    enabled: boolean;
    state: "idle" | "stale" | "rendering" | "ready" | "error";
    lastPublishedAt: string | null;
    error: string | null;
  };
  lastCommand: string | null;
  lastExitCode: number | null;
  lastOutput: string;
  lastError: string | null;
  summary: {
    simTime: number;
    eventCount: number;
    living: number;
    total: number;
    chainHead: string;
  } | null;
  progress: {
    completedTurns: number;
    targetTurns: number;
    percent: number;
    simTime: number;
  } | null;
};

let jobRunning = false;
let childRunning = false;
let lastCommand: string | null = null;
let lastExitCode: number | null = null;
let lastOutput = "";
let lastError: string | null = null;
let currentChild: ChildProcess | null = null;
let stopRequested = false;
let activeProvider: CognitionProvider = "gemini";
let activeRoutineModel: GeminiModel = "gemini-3.5-flash-lite";
let activeDeliberateModel: GeminiModel = "gemini-3.5-flash-lite";
let activeVoiceEnabled = false;
let voiceState: Status["voice"]["state"] = "idle";
let voiceLastPublishedAt: string | null = null;
let voiceError: string | null = null;
let simulationProgress: {
  baseEventCount: number;
  targetTurns: number;
  startingSimTime: number;
} | null = null;
const DEFAULT_PUBLISH_EVERY_TURNS = 12;

const SPEEDS: Record<string, string> = {
  realtime: "1h",
  fast: "10m",
  max: "1m",
  turbo: "10s",
  instant: "1s",
};

const DAY_DURATION_MS: Record<string, number> = {
  realtime: 60 * 60 * 1000,
  fast: 10 * 60 * 1000,
  max: 60 * 1000,
  turbo: 10 * 1000,
  instant: 1000,
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "access-control-allow-origin": "http://localhost:3000",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(body, null, 2));
}

function notFound(res: ServerResponse): void {
  send(res, 404, { error: "not found" });
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<void> {
  if (childRunning) throw new Error("dev controller is already running a command");
  childRunning = true;
  lastCommand = [command, ...args].join(" ");
  lastExitCode = null;
  lastOutput = `${lastOutput}\n$ ${lastCommand}\n`.slice(-12_000);

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    currentChild = child;
    const append = (chunk: Buffer) => {
      lastOutput = `${lastOutput}${chunk.toString("utf8")}`.slice(-12_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("close", (code) => {
      childRunning = false;
      currentChild = null;
      lastExitCode = code;
      if (code === 0) resolvePromise();
      else if (stopRequested) reject(new Error("dev controller job stopped"));
      else reject(new Error(`${lastCommand} exited with ${code ?? "unknown"}`));
    });
    child.on("error", (error) => {
      childRunning = false;
      currentChild = null;
      lastExitCode = -1;
      reject(error);
    });
  });
}

function startJob(job: () => Promise<void>): void {
  if (jobRunning || childRunning) throw new Error("dev controller is already running a job");
  jobRunning = true;
  stopRequested = false;
  lastError = null;
  lastExitCode = null;
  lastOutput = "";
  void job()
    .catch((error) => {
      lastError = error instanceof Error ? error.message : String(error);
      lastOutput = `${lastOutput}\n[dev-control] ${lastError}\n`.slice(-12_000);
    })
    .finally(() => {
      jobRunning = false;
    });
}

function startProviderJob(
  provider: CognitionProvider,
  model: ModelSet,
  voiceEnabled: boolean,
  job: () => Promise<void>,
): void {
  if (jobRunning || childRunning) throw new Error("dev controller is already running a job");
  activeProvider = provider;
  activeRoutineModel = model.routine;
  activeDeliberateModel = model.deliberate;
  activeVoiceEnabled = voiceEnabled;
  startJob(job);
}

function cognitionEnv(provider: CognitionProvider, model: ModelSet): NodeJS.ProcessEnv {
  if (provider === "offline") return {};
  return {
    AG_SPEND_ENFORCEMENT: "freeze",
    AG_MODEL_ROUTINE: model.routine,
    AG_MODEL_DELIBERATE: model.deliberate,
  };
}

function stopJob(): void {
  stopRequested = true;
  lastOutput = `${lastOutput}\n[dev-control] stop requested\n`.slice(-12_000);
  currentChild?.kill("SIGTERM");
}

function parsePublishEvery(params: URLSearchParams): number {
  const raw = params.get("publishEvery");
  if (raw === null) return DEFAULT_PUBLISH_EVERY_TURNS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error("publishEvery must be an integer from 1 to 10000");
  }
  return value;
}

function parsePublishingEnabled(params: URLSearchParams): boolean {
  const raw = params.get("publish");
  if (raw === null) return true;
  if (raw === "off" || raw === "false" || raw === "0") return false;
  if (raw === "on" || raw === "true" || raw === "1") return true;
  throw new Error("publish must be on|off|true|false|1|0");
}

async function exportFixtures(): Promise<void> {
  await mkdir(resolve(ROOT, DEV_WORLD_DIR), { recursive: true });
  await run(
    "npx",
    ["vitest", "run", "apps/spectator/scripts/export-run-to-fixture.test.ts"],
    {
      AG_EXPORT_RUN_DIR: RUN_DIR,
      AG_EXPORT_OUTPUT_FILE: DEV_WORLD_FILE,
    },
  );
  await run(
    "node",
    [
      "--experimental-strip-types",
      "apps/spectator/src/fixtures/generate-observatory-export.mts",
      RUN_DIR,
    ],
    { AG_OBSERVATORY_OUTPUT_FILE: DEV_OBSERVATORY_FILE },
  );
}

async function publishVoice(): Promise<void> {
  voiceState = "rendering";
  voiceError = null;
  try {
    await run("npm", [
      "run",
      "voice:render",
      "--workspace=@after-genesis/spectator",
      "--",
      `--reel=${DEV_VOICE_REEL}`,
      "--live",
      `--input=${DEV_OBSERVATORY_FILE}`,
      "--limit=80",
    ]);
    voiceState = "ready";
    voiceLastPublishedAt = new Date().toISOString();
  } catch (error) {
    voiceState = "error";
    voiceError = error instanceof Error ? error.message : String(error);
    lastOutput = `${lastOutput}\n[voice] publish failed: ${voiceError}\n`.slice(-12_000);
  }
}

async function reset(): Promise<void> {
  simulationProgress = null;
  // `--reset` erases the run's events, state and model audit. Clear everything
  // published from the previous run too, so nothing the old world knew or said
  // survives into the new one — including on screen and in rendered audio.
  for (const path of GENERATED_BY_A_DEV_RUN) {
    await rm(resolve(ROOT, path), { recursive: true, force: true });
  }
  await run(
    "npm",
    [
      "run",
      "world",
      "--",
      "demo",
      "--reset",
      "--turns",
      "0",
      "--provider",
      activeProvider,
      "--output",
      RUN_DIR,
    ],
    cognitionEnv(activeProvider, {
      routine: activeRoutineModel,
      deliberate: activeDeliberateModel,
    }),
  );
  await exportFixtures();
  if (activeVoiceEnabled) await publishVoice();
  else {
    voiceState = "idle";
    voiceError = null;
    voiceLastPublishedAt = null;
  }
}

async function advance(params: URLSearchParams): Promise<void> {
  const days = Number(params.get("days") ?? "1");
  const speed = params.get("speed") ?? "realtime";
  const turnDurationMs = Math.max(1, Math.floor((DAY_DURATION_MS[speed] ?? 0) / 12));
  const publishEvery = parsePublishEvery(params);
  const publishWorld = parsePublishingEnabled(params);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365_000) {
    throw new Error("days must be an integer from 1 to 365000");
  }
  if (!SPEEDS[speed]) throw new Error("speed must be realtime, fast, max, turbo, or instant");
  const turns = days * 12;
  const startingEvents = await readLiveEvents();
  simulationProgress = {
    baseEventCount: startingEvents.count,
    targetTurns: turns,
    startingSimTime: startingEvents.simTime,
  };
  try {
    for (let turn = 1; turn <= turns; turn++) {
      if (stopRequested) throw new Error("dev controller job stopped");
      const started = Date.now();
      const isLastTurn = turn === turns;
      const shouldPublishTurn = isLastTurn || turn % publishEvery === 0;
      await run(
        "npm",
        [
          "run",
          "world",
          "--",
          "demo",
          "--resume",
          "--turns",
          "1",
          "--provider",
          activeProvider,
          "--output",
          RUN_DIR,
        ],
        cognitionEnv(activeProvider, {
          routine: activeRoutineModel,
          deliberate: activeDeliberateModel,
        }),
      );
      if (publishWorld && shouldPublishTurn) {
        await exportFixtures();
        if (activeVoiceEnabled) await publishVoice();
      }
      lastOutput = `${lastOutput}\n[dev-clock] published turn ${turn}/${turns}\n`.slice(-12_000);
      const remainingDelay = turnDurationMs - (Date.now() - started);
      if (turn < turns && remainingDelay > 0) await sleep(remainingDelay);
    }
  } finally {
    if (stopRequested) await finalizeStoppedRun();
  }
  if (!activeVoiceEnabled) {
    voiceState = "idle";
    voiceError = null;
    voiceLastPublishedAt = null;
  }
}

async function fastForward(params: URLSearchParams): Promise<void> {
  const days = Number(params.get("days") ?? "1");
  if (!Number.isSafeInteger(days) || days < 1 || days > 833) {
    throw new Error("fast-forward days must be an integer from 1 to 833");
  }

  const advanceParams = new URLSearchParams(params);
  if (!advanceParams.has("speed")) {
    advanceParams.set("speed", "instant");
  }
  await advance(advanceParams);
  lastOutput = `${lastOutput}\n[fast-forward] published ${days} simulated day(s)${
    activeVoiceEnabled ? "; voice published" : ""
  }\n`.slice(-12_000);
}

async function finalizeStoppedRun(): Promise<void> {
  lastOutput = `${lastOutput}\n[dev-control] publishing last committed turn after stop\n`.slice(
    -12_000,
  );
  await exportFixtures();
  if (activeVoiceEnabled) await publishVoice();
  else {
    voiceState = "idle";
    voiceError = null;
    voiceLastPublishedAt = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function status(): Promise<Status> {
  try {
    // The world this controller drives, not the committed demo — otherwise the
    // clock reports a world the dev controls cannot advance or reset.
    const raw = await readFile(resolve(ROOT, DEV_WORLD_FILE), "utf8");
    const world = JSON.parse(raw) as {
      summary?: {
        simTime?: number;
        eventCount?: number;
        chainHead?: string;
        population?: { living?: number; total?: number };
      };
    };
    const summary = {
      simTime: world.summary?.simTime ?? 0,
      eventCount: world.summary?.eventCount ?? 0,
      living: world.summary?.population?.living ?? 0,
      total: world.summary?.population?.total ?? 0,
      chainHead: world.summary?.chainHead ?? "",
    };
    let progress: Status["progress"] = null;
    if (simulationProgress !== null) {
      try {
        const liveEvents = await readLiveEvents();
        const targetTurns = simulationProgress.targetTurns;
        const completedTurns = Math.max(
          0,
          Math.min(targetTurns, liveEvents.count - simulationProgress.baseEventCount),
        );
        progress = {
          completedTurns,
          targetTurns,
          percent: Math.floor((completedTurns * 100) / targetTurns),
          simTime:
            completedTurns === 0
              ? simulationProgress.startingSimTime
              : liveEvents.simTime,
        };
      } catch {
        progress = null;
      }
    }
    return {
      running: jobRunning || childRunning,
      provider: activeProvider,
      model: activeRoutineModel,
      deliberateModel: activeDeliberateModel,
      voice: {
        enabled: activeVoiceEnabled,
        state: voiceState,
        lastPublishedAt: voiceLastPublishedAt,
        error: voiceError,
      },
      lastCommand,
      lastExitCode,
      lastOutput,
      lastError,
      summary,
      progress,
    };
  } catch {
    return {
      running: jobRunning || childRunning,
      provider: activeProvider,
      model: activeRoutineModel,
      deliberateModel: activeDeliberateModel,
      voice: {
        enabled: activeVoiceEnabled,
        state: voiceState,
        lastPublishedAt: voiceLastPublishedAt,
        error: voiceError,
      },
      lastCommand,
      lastExitCode,
      lastOutput,
      lastError,
      summary: null,
      progress: null,
    };
  }
}

async function readLiveEvents(): Promise<{ count: number; simTime: number }> {
  const eventRaw = await readFile(
    resolve(ROOT, RUN_DIR, "events", "after-genesis-demo.jsonl"),
    "utf8",
  );
  const lines = eventRaw.split("\n").filter((line) => line.trim() !== "");
  const last = JSON.parse(lines.at(-1) ?? "{}") as { simTime?: unknown };
  return {
    count: lines.length,
    simTime: typeof last.simTime === "number" ? last.simTime : 0,
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") return send(res, 200, { ok: true });
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/status") return send(res, 200, await status());
    if (req.method === "POST" && url.pathname === "/reset") {
      startProviderJob(
        parseProvider(url.searchParams),
        {
          routine: parseModel(url.searchParams, "model"),
          deliberate: parseModel(url.searchParams, "deliberateModel", activeDeliberateModel),
        },
        parseVoiceEnabled(url.searchParams),
        reset,
      );
      return send(res, 202, await status());
    }
    if (req.method === "POST" && url.pathname === "/advance") {
      startProviderJob(
        parseProvider(url.searchParams),
        {
          routine: parseModel(url.searchParams, "model"),
          deliberate: parseModel(url.searchParams, "deliberateModel", activeDeliberateModel),
        },
        parseVoiceEnabled(url.searchParams),
        () => advance(url.searchParams),
      );
      return send(res, 202, await status());
    }
    if (req.method === "POST" && url.pathname === "/fast-forward") {
      startProviderJob(
        parseProvider(url.searchParams),
        {
          routine: parseModel(url.searchParams, "model"),
          deliberate: parseModel(url.searchParams, "deliberateModel", activeDeliberateModel),
        },
        parseVoiceEnabled(url.searchParams),
        () => fastForward(url.searchParams),
      );
      return send(res, 202, await status());
    }
    if (req.method === "POST" && url.pathname === "/stop") {
      stopJob();
      return send(res, 202, await status());
    }
    if (req.method === "POST" && url.pathname === "/voice/retry") {
      startJob(publishVoice);
      return send(res, 202, await status());
    }
    return notFound(res);
  } catch (error) {
    return send(res, 500, {
      error: error instanceof Error ? error.message : String(error),
      ...(await status()),
    });
  }
}

function parseProvider(params: URLSearchParams): CognitionProvider {
  const provider = params.get("provider") ?? activeProvider;
  if (provider !== "gemini" && provider !== "offline") {
    throw new Error("provider must be gemini or offline");
  }
  return provider;
}

function parseModel(
  params: URLSearchParams,
  key: "model" | "deliberateModel",
  fallback?: GeminiModel,
): GeminiModel {
  const model = params.get(key) ?? fallback ?? activeRoutineModel;
  if (model !== "gemini-3.5-flash-lite") {
    throw new Error("model must be gemini-3.5-flash-lite");
  }
  return model;
}

function parseVoiceEnabled(params: URLSearchParams): boolean {
  const voice = params.get("voice");
  if (voice === null) return activeVoiceEnabled;
  if (voice === "on") return true;
  if (voice === "off") return false;
  throw new Error("voice must be on or off");
}

createServer((req, res) => {
  void handle(req, res);
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`[dev-control] listening on http://127.0.0.1:${PORT}\n`);
});
