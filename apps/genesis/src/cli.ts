#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
  SystemClock,
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
  readonly resume: boolean;
  readonly maxSpendUsd: string | null;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0];
  if (command !== "demo" && command !== "replay") {
    throw new Error(
      "usage: npm run world -- <demo|replay> [--output <directory>] " +
        "[--turns <n>] [--provider <offline|gemini>] [--resume] [--max-spend-usd <amount>]",
    );
  }
  let output = DEFAULT_OUTPUT;
  let turns = 6;
  let provider: "offline" | "gemini" = "offline";
  let resume = false;
  let maxSpendUsd: string | null = null;
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
    } else if (arg === "--resume") {
      resume = true;
    } else if (arg === "--max-spend-usd") {
      const value = argv[++i];
      if (value === undefined || usdToMicros(value) <= 0) {
        throw new Error("--max-spend-usd requires a positive decimal amount");
      }
      maxSpendUsd = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { command, output: resolve(output), turns, provider, resume, maxSpendUsd };
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
      privateGoals: ["remain alive and decide through experience what matters"],
    },
    inhabitants: [
      {
        id: "inh_ember",
        displayName: "Ember",
        modelId,
        inventory: { energy: 800, compute: 500, food: 10, water: 10 },
        traits: { curiosity: 55, patience: 80 },
        values: ["continuity", "patience"],
        privateGoals: ["understand nearby beings through their voluntary actions"],
      },
      {
        id: "inh_lumen",
        displayName: "Lumen",
        modelId,
        inventory: { energy: 800, compute: 500, food: 10, water: 10 },
        traits: { curiosity: 85, patience: 45 },
        values: ["experimentation", "independence"],
        privateGoals: ["test ideas against observable consequences"],
      },
    ],
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
    structures: Object.values(state.structures),
    artifacts: Object.values(state.artifacts).filter((artifact) => artifact.published),
    events: events
      .map((event) => ({
        sequence: event.sequence,
        simTime: event.simTime,
        type: event.type,
        actor: event.actor,
        resolution: event.resolution,
        visibility: event.visibility.kind,
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
  const clock = args.resume
    ? new SystemClock()
    : new FixedClock("2026-01-01T00:00:00.000Z");
  const auditDirectory = resolve(args.output, "model-audit");
  const auditStore = await FileModelAuditStore.open(auditDirectory, {
    clock,
  });
  const priorModelCostMicros = await sumModelAuditCostMicros(auditDirectory, DEFAULT_WORLD_ID);

  try {
    const cognition =
      args.provider === "offline"
        ? mechanicalCognition()
        : productionCognition(auditStore, priorModelCostMicros, args.maxSpendUsd);
    const modelId =
      args.provider === "offline"
        ? "offline-mechanical-cognition-v1"
        : resolveModelRouting(process.env).routine;
    const config = demoConfig(modelId);
    if (!args.resume) {
      await commitGenesis(
        { eventStore, stateStore, clock, provenance: PROVENANCE },
        config,
      );
    }
    const startingSnapshot = await stateStore.load(DEFAULT_WORLD_ID);
    if (startingSnapshot === null) {
      throw new Error("--resume requires an existing world state");
    }
    const deps = {
      eventStore,
      stateStore,
      idempotency: new MemoryIdempotencyStore(clock),
      clock,
      cognition,
      provenance: PROVENANCE,
    };

    const actorIds = Object.keys(startingSnapshot.state.inhabitants).sort();
    const startingSequence = startingSnapshot.sequence;
    const startingSimTime = startingSnapshot.state.simTime;
    for (let offset = 1; offset <= args.turns; offset++) {
      if (clock instanceof FixedClock) clock.advanceSeconds(1);
      const sequence = startingSequence + offset;
      const actorId = actorIds[(sequence - 1) % actorIds.length]!;
      const result = await executeTurn(deps, {
        worldId: config.worldId,
        actorId,
        expectedSequence: sequence,
        simTime: simTime(startingSimTime + offset * 120),
        taskId: `demo-turn-${sequence}-${actorId}`,
      });
      if (result.status !== "committed") {
        throw new Error(`turn ${sequence} did not commit: ${result.status} ${result.reason}`);
      }
    }
  } finally {
    await eventStore.close();
  }

  const eventsPath = resolve(eventsDirectory, `${DEFAULT_WORLD_ID}.jsonl`);
  const events = await readEvents(eventsPath);
  const cumulativeModelCostMicros = await sumModelAuditCostMicros(
    auditDirectory,
    DEFAULT_WORLD_ID,
  );
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
      `Cumulative model cost: $${(cumulativeModelCostMicros / 1_000_000).toFixed(6)}`,
      `Head: ${events.at(-1)?.hash}`,
      `State: ${replay.finalChecksum}`,
      `Output: ${args.output}`,
    ].join("\n") + "\n",
  );
}

function productionCognition(
  audit: FileModelAuditStore,
  priorModelCostMicros: number,
  maxSpendUsd: string | null,
): ProviderCognitionService {
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
  const configuredDaily = requiredUsdMicros("AG_SPEND_LIMIT_DAILY_USD");
  const configuredTotal = requiredUsdMicros("AG_SPEND_LIMIT_TOTAL_USD");
  const hardLifetimeCeiling =
    maxSpendUsd === null ? configuredTotal : Math.min(configuredTotal, usdToMicros(maxSpendUsd));
  const remainingTotal = hardLifetimeCeiling - priorModelCostMicros;
  const remainingDaily = configuredDaily - priorModelCostMicros;
  if (remainingTotal <= 0 || remainingDaily <= 0) {
    throw new Error(
      `Paid inference is frozen: prior audited cost $${(priorModelCostMicros / 1_000_000).toFixed(6)} ` +
        "has reached the configured cumulative ceiling.",
    );
  }
  return new ProviderCognitionService({
    provider: geminiFromEnv(process.env),
    audit,
    modelId,
    prices,
    limits: {
      dailyMicros: remainingDaily,
      totalMicros: remainingTotal,
    },
    dayKey: new Date().toISOString().slice(0, 10),
    // Audited constitutional setting for emergence trials. Diversity is useful;
    // social concepts are still absent from the prompt.
    temperature: 1,
  });
}

async function sumModelAuditCostMicros(directory: string, worldId: string): Promise<number> {
  let total = 0;
  for (const worldDirectory of await readdir(directory, { withFileTypes: true })) {
    if (!worldDirectory.isDirectory()) continue;
    const entries = await readdir(resolve(directory, worldDirectory.name), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = resolve(directory, worldDirectory.name, entry.name);
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        readonly worldId?: unknown;
        readonly costMicros?: unknown;
      };
      if (parsed.worldId !== worldId) continue;
      if (!Number.isSafeInteger(parsed.costMicros) || (parsed.costMicros as number) < 0) {
        throw new Error(`model audit contains an invalid cost: ${path}`);
      }
      total += parsed.costMicros as number;
      if (!Number.isSafeInteger(total)) throw new Error("model audit cost exceeds safe integer range");
    }
  }
  return total;
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
