#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CanonicalEventSchema,
  buildObservation,
  computeStateChecksum,
  simTime,
  type CanonicalEvent,
  type GenesisConfig,
  type ProposedAction,
  type WorldState,
} from "@after-genesis/core";
import { parseJsonl, replayHistory, verifyExport } from "@after-genesis/audit";
import {
  FileEventStore,
  FileModelAuditStore,
  FileStateStore,
  FixedClock,
  MemoryIdempotencyStore,
} from "@after-genesis/persistence";
import {
  geminiFromEnv,
  resolveModelRouting,
  usdToMicros,
  type PriceTable,
} from "@after-genesis/cognition";
import {
  ProviderCognitionService,
  commitGenesis,
  executeTurn,
  type CognitionService,
} from "@after-genesis/runtime";

const DEFAULT_OUTPUT = ".worlds/vertical-slice";
const DEFAULT_WORLD_ID = "after-genesis-demo";
const DEFAULT_SEED = "after-genesis-public-demo-seed-v1";
const PROVENANCE = { sourceCommit: "local-uncommitted", deployedDigest: "local" };

interface ParsedArgs {
  readonly command: "demo" | "replay";
  readonly output: string;
  readonly turns: number;
  readonly provider: "offline" | "gemini";
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0];
  if (command !== "demo" && command !== "replay") {
    throw new Error(
      "usage: npm run world -- <demo|replay> [--output <directory>] " +
        "[--turns <n>] [--provider <offline|gemini>]",
    );
  }
  let output = DEFAULT_OUTPUT;
  let turns = 6;
  let provider: "offline" | "gemini" = "offline";
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--output requires a directory");
      output = value;
    } else if (arg === "--turns") {
      const value = Number(argv[++i]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
        throw new Error("--turns must be an integer from 1 to 10000");
      }
      turns = value;
    } else if (arg === "--provider") {
      const value = argv[++i];
      if (value !== "offline" && value !== "gemini") {
        throw new Error("--provider must be offline or gemini");
      }
      provider = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { command, output: resolve(output), turns, provider };
}

function demoConfig(modelId: string = "offline-mechanical-cognition-v1"): GenesisConfig {
  return {
    worldId: DEFAULT_WORLD_ID,
    seed: DEFAULT_SEED,
    width: 32,
    height: 32,
    founder: {
      id: "inh_founder",
      displayName: "Aster",
      modelId,
      inventory: { energy: 800, compute: 500, food: 10, water: 10 },
      traits: { curiosity: 75, patience: 60 },
      values: ["curiosity", "continuity"],
      privateGoals: ["understand the world through direct observation"],
    },
  };
}

/**
 * Offline cognition for the safe demo. It reads exactly the limited observation
 * available to the founder and emits one schema-shaped proposal. It never reads
 * global state fields outside `buildObservation`.
 */
function mechanicalCognition(): CognitionService {
  return {
    async propose(input) {
      const observation = buildObservation(input.state, input.actorId);
      const actions: readonly ProposedAction[] = [
        { type: "observe", payload: {} },
        { type: "wait", payload: { durationMinutes: 30 } },
        { type: "observe", payload: {} },
        { type: "rest", payload: { durationMinutes: 60 } },
      ];
      const action = actions[(input.sequence - 1) % actions.length]!;
      return {
        action,
        modelId: "offline-mechanical-cognition-v1",
        requestHash: null,
        responseHash: null,
        costMicros: 0,
        inputTokens: observation.tiles.length,
        outputTokens: 0,
      };
    },
  };
}

async function readEvents(path: string): Promise<CanonicalEvent[]> {
  const raw = await readFile(path, "utf8");
  const parsed = parseJsonl(raw);
  if (parsed.parseErrors.length > 0) {
    throw new Error(`event log contains invalid JSON: ${parsed.parseErrors[0]}`);
  }
  return parsed.values.map((value, index) => {
    const event = CanonicalEventSchema.safeParse(value);
    if (!event.success) throw new Error(`event ${index} is malformed`);
    return event.data;
  });
}

function publicSnapshot(state: WorldState, events: readonly CanonicalEvent[]): unknown {
  const head = events.at(-1);
  return {
    generatedBy: "apps/genesis/src/cli.ts",
    canonical: false,
    note: "Read-only projection. Canonical truth remains the hash-chained event log.",
    world: {
      worldId: state.worldId,
      seed: state.seed,
      simTime: state.simTime,
      sequence: state.sequence,
      stateChecksum: computeStateChecksum(state),
      chainHead: head?.hash ?? null,
    },
    map: {
      width: state.map.width,
      height: state.map.height,
      terrain: state.map.terrain,
      occupants: Object.values(state.inhabitants).map((inhabitant) => ({
        id: inhabitant.id,
        displayName: inhabitant.displayName,
        location: inhabitant.location,
        status: inhabitant.status,
        generation: inhabitant.generation,
      })),
    },
    events: events
      .filter((event) => event.visibility.kind === "public" || event.type === "genesis")
      .map((event) => ({
        sequence: event.sequence,
        simTime: event.simTime,
        type: event.type,
        actor: event.actor,
        resolution: event.resolution,
        hash: event.hash,
      })),
  };
}

async function runDemo(args: ParsedArgs): Promise<void> {
  await mkdir(args.output, { recursive: true });
  const eventsDirectory = resolve(args.output, "events");
  const statesDirectory = resolve(args.output, "state");
  const eventStore = await FileEventStore.open(eventsDirectory);
  const stateStore = await FileStateStore.open<WorldState>(statesDirectory, {
    checksum: computeStateChecksum,
  });
  const clock = new FixedClock("2026-01-01T00:00:00.000Z");
  const auditStore = await FileModelAuditStore.open(resolve(args.output, "model-audit"), {
    clock,
  });

  try {
    const cognition =
      args.provider === "offline"
        ? mechanicalCognition()
        : productionCognition(auditStore);
    const modelId =
      args.provider === "offline"
        ? "offline-mechanical-cognition-v1"
        : resolveModelRouting(process.env).routine;
    const config = demoConfig(modelId);
    await commitGenesis(
      { eventStore, stateStore, clock, provenance: PROVENANCE },
      config,
    );
    const deps = {
      eventStore,
      stateStore,
      idempotency: new MemoryIdempotencyStore(clock),
      clock,
      cognition,
      provenance: PROVENANCE,
    };

    for (let turn = 1; turn <= args.turns; turn++) {
      clock.advanceSeconds(1);
      const result = await executeTurn(deps, {
        worldId: config.worldId,
        actorId: config.founder.id,
        simTime: simTime(turn * 120),
        taskId: `demo-turn-${turn}`,
      });
      if (result.status !== "committed") {
        throw new Error(`turn ${turn} did not commit: ${result.status} ${result.reason}`);
      }
    }
  } finally {
    await eventStore.close();
  }

  const eventsPath = resolve(eventsDirectory, `${DEFAULT_WORLD_ID}.jsonl`);
  const events = await readEvents(eventsPath);
  const replay = replayHistory(events);
  const verification = verifyExport(events, {
    expectedWorldId: DEFAULT_WORLD_ID,
    ...(events.at(-1) === undefined ? {} : { expectedHeadHash: events.at(-1)!.hash }),
    requireGenesis: true,
  });
  if (!replay.ok || !verification.ok || replay.state === null) {
    throw new Error("generated history failed its own verification or replay");
  }

  await writeFile(
    resolve(args.output, "public-snapshot.json"),
    `${JSON.stringify(publicSnapshot(replay.state, events), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    resolve(args.output, "audit-report.json"),
    `${JSON.stringify({ verification, replay: { ...replay, state: undefined } }, null, 2)}\n`,
    "utf8",
  );

  process.stdout.write(
    [
      "VERTICAL SLICE VERIFIED",
      `World: ${DEFAULT_WORLD_ID}`,
      `Events: ${events.length}`,
      `Cognition: ${args.provider}`,
      `Head: ${events.at(-1)?.hash}`,
      `State: ${replay.finalChecksum}`,
      `Output: ${args.output}`,
    ].join("\n") + "\n",
  );
}

function productionCognition(audit: FileModelAuditStore): ProviderCognitionService {
  const modelId = resolveModelRouting(process.env).routine;
  if (modelId !== "gemini-3.5-flash-lite") {
    throw new Error(
      `No verified price table is bundled for ${modelId}. ` +
        "Set AG_MODEL_ROUTINE=gemini-3.5-flash-lite or add a newly verified price.",
    );
  }
  const prices: readonly PriceTable[] = [
    {
      modelId,
      inputMicrosPerMillionTokens: 300_000,
      outputMicrosPerMillionTokens: 2_500_000,
      verifiedOn: "2026-07-28",
    },
  ];
  return new ProviderCognitionService({
    provider: geminiFromEnv(process.env),
    audit,
    modelId,
    prices,
    limits: {
      dailyMicros: requiredUsdMicros("AG_SPEND_LIMIT_DAILY_USD"),
      totalMicros: requiredUsdMicros("AG_SPEND_LIMIT_TOTAL_USD"),
    },
    dayKey: new Date().toISOString().slice(0, 10),
  });
}

function requiredUsdMicros(name: string): number {
  const raw = process.env[name];
  if (raw === undefined) throw new Error(`${name} is required`);
  const value = usdToMicros(raw);
  if (value <= 0) {
    throw new Error(`${name} must be greater than zero`);
  }
  return value;
}

async function runReplay(args: ParsedArgs): Promise<void> {
  const eventsPath = resolve(args.output, "events", `${DEFAULT_WORLD_ID}.jsonl`);
  const events = await readEvents(eventsPath);
  const report = replayHistory(events);
  process.stdout.write(`${JSON.stringify({ ...report, state: undefined }, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  // Local developer convenience only. Node's built-in loader does not override
  // variables already injected by a shell, CI, or secret manager.
  if (existsSync(".env")) process.loadEnvFile(".env");
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "demo") await runDemo(args);
  else await runReplay(args);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
