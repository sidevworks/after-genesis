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

type Status = {
  running: boolean;
  provider: CognitionProvider;
  voice: {
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
let voiceState: Status["voice"]["state"] = "idle";
let voiceLastPublishedAt: string | null = null;
let voiceError: string | null = null;

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

function startProviderJob(provider: CognitionProvider, job: () => Promise<void>): void {
  if (jobRunning || childRunning) throw new Error("dev controller is already running a job");
  activeProvider = provider;
  startJob(job);
}

function stopJob(): void {
  stopRequested = true;
  lastOutput = `${lastOutput}\n[dev-control] stop requested\n`.slice(-12_000);
  currentChild?.kill("SIGTERM");
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
  // `--reset` erases the run's events, state and model audit. Clear everything
  // published from the previous run too, so nothing the old world knew or said
  // survives into the new one — including on screen and in rendered audio.
  for (const path of GENERATED_BY_A_DEV_RUN) {
    await rm(resolve(ROOT, path), { recursive: true, force: true });
  }
  await run("npm", [
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
  ]);
  await exportFixtures();
  await publishVoice();
}

async function advance(params: URLSearchParams): Promise<void> {
  const days = Number(params.get("days") ?? "1");
  const speed = params.get("speed") ?? "realtime";
  const turnDurationMs = Math.max(1, Math.floor((DAY_DURATION_MS[speed] ?? 0) / 12));
  if (!Number.isSafeInteger(days) || days < 1 || days > 365_000) {
    throw new Error("days must be an integer from 1 to 365000");
  }
  if (!SPEEDS[speed]) throw new Error("speed must be realtime, fast, max, turbo, or instant");
  const turns = days * 12;
  for (let turn = 1; turn <= turns; turn++) {
    if (stopRequested) throw new Error("dev controller job stopped");
    const started = Date.now();
    await run("npm", [
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
    ]);
    await exportFixtures();
    await publishVoice();
    lastOutput = `${lastOutput}\n[dev-clock] published turn ${turn}/${turns}\n`.slice(-12_000);
    const remainingDelay = turnDurationMs - (Date.now() - started);
    if (turn < turns && remainingDelay > 0) await sleep(remainingDelay);
  }
}

async function fastForward(params: URLSearchParams): Promise<void> {
  const days = Number(params.get("days") ?? "1");
  if (!Number.isSafeInteger(days) || days < 1 || days > 833) {
    throw new Error("fast-forward days must be an integer from 1 to 833");
  }

  await run("npm", [
    "run",
    "world",
    "--",
    "demo",
    "--resume",
    "--days",
    String(days),
    "--provider",
    activeProvider,
    "--output",
    RUN_DIR,
  ]);
  await exportFixtures();

  // Fast-forward is for inspecting long-horizon canonical data. Rendering a
  // large historical audio backlog would hide completion behind provider work;
  // it remains an explicit, retryable derived-media step.
  voiceState = "stale";
  voiceError = null;
  lastOutput = `${lastOutput}\n[fast-forward] published ${days} simulated day(s); voice pending\n`.slice(
    -12_000,
  );
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
    return {
      running: jobRunning || childRunning,
      provider: activeProvider,
      voice: {
        state: voiceState,
        lastPublishedAt: voiceLastPublishedAt,
        error: voiceError,
      },
      lastCommand,
      lastExitCode,
      lastOutput,
      lastError,
      summary: {
        simTime: world.summary?.simTime ?? 0,
        eventCount: world.summary?.eventCount ?? 0,
        living: world.summary?.population?.living ?? 0,
        total: world.summary?.population?.total ?? 0,
        chainHead: world.summary?.chainHead ?? "",
      },
    };
  } catch {
    return {
      running: jobRunning || childRunning,
      provider: activeProvider,
      voice: {
        state: voiceState,
        lastPublishedAt: voiceLastPublishedAt,
        error: voiceError,
      },
      lastCommand,
      lastExitCode,
      lastOutput,
      lastError,
      summary: null,
    };
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") return send(res, 200, { ok: true });
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/status") return send(res, 200, await status());
    if (req.method === "POST" && url.pathname === "/reset") {
      startProviderJob(parseProvider(url.searchParams), reset);
      return send(res, 202, await status());
    }
    if (req.method === "POST" && url.pathname === "/advance") {
      startProviderJob(parseProvider(url.searchParams), () => advance(url.searchParams));
      return send(res, 202, await status());
    }
    if (req.method === "POST" && url.pathname === "/fast-forward") {
      startProviderJob(parseProvider(url.searchParams), () => fastForward(url.searchParams));
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

createServer((req, res) => {
  void handle(req, res);
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`[dev-control] listening on http://127.0.0.1:${PORT}\n`);
});
