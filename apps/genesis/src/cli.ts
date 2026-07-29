#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  type SpendEnforcement,
  type PriceTable,
} from "@after-genesis/cognition";
import {
  ProviderCognitionService,
  commitGenesis,
  executeTurn,
  type CognitionService,
} from "@after-genesis/runtime";
import {
  bootstrapStagingWorld,
  teardownStagingWorld,
} from "./staging-bootstrap.js";

const DEFAULT_OUTPUT = ".worlds/vertical-slice";
const DEFAULT_WORLD_ID = "after-genesis-demo";
const DEFAULT_SEED = "after-genesis-public-demo-seed-v1";
const PROVENANCE = { sourceCommit: "local-uncommitted", deployedDigest: "local" };

interface ParsedArgs {
  readonly command: "demo" | "replay" | "bootstrap-staging" | "teardown-staging";
  readonly output: string;
  readonly turns: number;
  readonly turnDelayMs: number;
  readonly provider: "offline" | "gemini";
  readonly resume: boolean;
  readonly reset: boolean;
  readonly maxSpendUsd: string | null;
  readonly worldId: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0];
  if (
    command !== "demo" &&
    command !== "replay" &&
    command !== "bootstrap-staging" &&
    command !== "teardown-staging"
  ) {
    throw new Error(
      "usage: npm run world -- <demo|replay|bootstrap-staging|teardown-staging> [--output <directory>] " +
        "[--world-id <id>] [--turns <n>] [--days <n>] [--day-duration <1s|10s|1m|10m|1h>] " +
        "[--provider <offline|gemini>] [--resume] [--reset] [--max-spend-usd <amount>]",
    );
  }
  let output = DEFAULT_OUTPUT;
  let turns = 6;
  let turnDelayMs = 0;
  let provider: "offline" | "gemini" = "offline";
  let resume = false;
  let reset = false;
  let maxSpendUsd: string | null = null;
  let worldId = "staging-test-fixture";
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--output requires a directory");
      output = value;
    } else if (arg === "--world-id") {
      const value = argv[++i];
      if (value === undefined || value.trim().length === 0) {
        throw new Error("--world-id requires a non-empty string");
      }
      worldId = value.trim();
    } else if (arg === "--turns") {
      const value = Number(argv[++i]);
      if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
        throw new Error("--turns must be an integer from 0 to 10000");
      }
      turns = value;
    } else if (arg === "--days") {
      const value = Number(argv[++i]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 833) {
        throw new Error("--days must be an integer from 1 to 833");
      }
      turns = value * 12;
    } else if (arg === "--day-duration") {
      const value = argv[++i];
      if (value === "1s") {
        turnDelayMs = 83;
      } else if (value === "10s") {
        turnDelayMs = 833;
      } else if (value === "1m") {
        turnDelayMs = 5_000;
      } else if (value === "10m") {
        turnDelayMs = 50_000;
      } else if (value === "1h") {
        turnDelayMs = 300_000;
      } else {
        throw new Error("--day-duration must be one of: 1s, 10s, 1m, 10m, 1h");
      }
    } else if (arg === "--provider") {
      const value = argv[++i];
      if (value !== "offline" && value !== "gemini") {
        throw new Error("--provider must be offline or gemini");
      }
      provider = value;
    } else if (arg === "--resume") {
      resume = true;
    } else if (arg === "--reset") {
      reset = true;
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
  if (reset && resume) {
    throw new Error("--reset cannot be used with --resume");
  }

  return {
    command,
    output: resolve(output),
    turns,
    turnDelayMs,
    provider,
    resume,
    reset,
    maxSpendUsd,
    worldId,
  };
}

function demoConfig(
  modelId: string = "offline-instinct-cognition-v2",
  mechanicalTest = true,
): GenesisConfig {
  return {
    worldId: DEFAULT_WORLD_ID,
    seed: DEFAULT_SEED,
    width: 32,
    height: 32,
    founder: {
      id: "inh_founder",
      displayName: "Aster",
      modelId,
      sex: "female",
      inventory: { energy: 800, compute: 500, food: 10, water: 10 },
      traits: mechanicalTest ? { curiosity: 75, patience: 60 } : {},
      values: mechanicalTest ? ["curiosity", "continuity"] : [],
      privateGoals: mechanicalTest
        ? ["remain alive and decide through experience what matters"]
        : [],
    },
    inhabitants: mechanicalTest
      ? [
          {
            id: "inh_ember",
            displayName: "Ember",
            modelId,
            sex: "male",
            inventory: { energy: 800, compute: 500, food: 10, water: 10 },
            traits: { curiosity: 55, patience: 80 },
            values: ["continuity", "patience"],
            privateGoals: ["understand nearby beings through their voluntary actions"],
          },
          {
            id: "inh_lumen",
            displayName: "Lumen",
            modelId,
            sex: "female",
            inventory: { energy: 800, compute: 500, food: 10, water: 10 },
            traits: { curiosity: 85, patience: 45 },
            values: ["experimentation", "independence"],
            privateGoals: ["test ideas against observable consequences"],
          },
        ]
      : [],
  };
}

/**
 * A deterministic 0..1 from a turn's identity. Never `Math.random()`: the
 * offline provider has to be replayable like everything else, or an offline run
 * could not be used to test replay.
 */
function turnHash(actorId: string, sequence: number, salt: string): number {
  let hash = 0x811c9dc5;
  const input = `${actorId}:${sequence}:${salt}`;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0) / 0x100000000;
}

/**
 * Offline cognition: an instinct-driven stand-in for a model.
 *
 * ## Why the previous version was not good enough
 *
 * It cycled four hardcoded proposals — `observe`, `wait`, `observe`, `rest` —
 * regardless of what the inhabitant could see or needed. A 365-simulated-day
 * run using it completed with all three inhabitants standing on their spawn
 * tile, hunger and thirst pinned at the ceiling, having never eaten, drunk,
 * moved or spoken. It verified the event chain and the replay, and it exercised
 * almost nothing else. An offline provider that cannot starve an inhabitant
 * cannot test the rules that decide whether starving matters.
 *
 * ## What this does instead
 *
 * A priority ladder over the inhabitant's **own legitimate observation** — the
 * same `buildObservation` boundary a real model gets, with no privileged read of
 * world state. Needs first, because they are the only pressure the world applies
 * on its own; then work; then, occasionally, the social and creative actions
 * that only matter once survival is handled.
 *
 * It is emphatically **not** a model and makes no attempt to be one. It has no
 * goals, no memory and no strategy, and it will never produce a civilisation.
 * Its job is to drive the engine hard enough, and broadly enough, that the rules
 * are exercised at zero API cost — including the rejection paths, which is why
 * it will occasionally propose an action the build may not implement.
 *
 * Deterministic by construction: every branch is a function of the observation
 * and a hash of `(actorId, sequence)`, so an offline run replays exactly.
 */
function mechanicalCognition(): CognitionService {
  return {
    async propose(input) {
      const observation = buildObservation(input.state, input.actorId);
      const self = observation.self;
      const roll = (salt: string): number => turnHash(input.actorId, input.sequence, salt);

      const held = (resource: string): number =>
        (self.inventory as Record<string, number | undefined>)[resource] ?? 0;

      /** Deposits within reach, nearest first, for a chosen resource. */
      const nearestWith = (resource: string) =>
        observation.tiles
          .filter((tile) => ((tile.deposit as Record<string, number | undefined>)[resource] ?? 0) > 0)
          .sort((left, right) => left.distance - right.distance)[0];

      /**
       * NOTE: payload shapes follow what each resolver **actually reads**, which
       * is not always what its declared zod schema says.
       *
       * There are two generations of resolver in this engine. The newer ones
       * (`communicate`, `create_artifact`, `build`) call `Schema.safeParse` and
       * so match their declared payload. The older ones (`move`, `gather`,
       * `consume`, `rest`, `wait`, `announce`) hand-parse with `asObject` /
       * `readEnum` / `readCoord` and use *different key names*:
       *
       *   move     schema `destination`     resolver `to`
       *   consume  schema `items[]`         resolver `resource` + `amount`
       *   rest     schema `intendedHours`   resolver `minutes`
       *   wait     schema `durationMinutes` resolver `minutes`
       *   gather   schema `targetQuantity`  resolver ignores it
       *
       * Those declared schemas are never parsed anywhere, so they are currently
       * documentation that disagrees with the code. Matching the resolver is the
       * only way to produce an accepted action until that is reconciled.
       *
       * Gather reaches the tile underfoot, and reaches an *adjacent* tile only
       * for water — you stand on the bank, not in the channel. See
       * `REACHABLE_FROM_ADJACENT` in `engine/resolvers/gather.ts`. Proposing a
       * gather from further away is simply rejected, so the planner walks first.
       */
      const canReach = (resource: string, distance: number): boolean =>
        distance === 0 || (resource === "water" && distance <= 1);

      /** Take what is in reach, otherwise walk to it, otherwise say so. */
      const fetch = (resource: string): ProposedAction | null => {
        const source = nearestWith(resource);
        if (source === undefined) return null;
        if (canReach(resource, source.distance)) {
          return { type: "gather", payload: { resource } };
        }
        return { type: "move", payload: { to: { x: source.x, y: source.y } } };
      };

      const action = ((): ProposedAction => {
        // 1. Drink and eat before anything else. Thirst kills faster than
        //    hunger, so it is checked first — and both are checked before work,
        //    because an inhabitant who works through starvation is not being
        //    frugal, it is being badly simulated.
        if (self.needs.thirst >= 55 && held("water") > 0) {
          return { type: "consume", payload: { resource: "water", amount: 1 } };
        }
        if (self.needs.hunger >= 55 && held("food") > 0) {
          return { type: "consume", payload: { resource: "food", amount: 1 } };
        }

        // 2. Nothing to consume: go and get it.
        for (const [need, resource] of [
          ["thirst", "water"],
          ["hunger", "food"],
        ] as const) {
          if (self.needs[need] < 45 || held(resource) > 0) continue;
          const errand = fetch(resource);
          if (errand !== null) return errand;
        }

        // 3. Rest when tired or short of energy. `rest` is the only action that
        //    restores energy, so an inhabitant that never rests eventually
        //    cannot afford to act at all.
        if (self.needs.fatigue >= 60 || self.energy < 120 || observation.night) {
          return { type: "rest", payload: { minutes: 360 } };
        }

        // 4. Occasional non-survival behaviour. Kept rare so runs stay
        //    productive, and deliberately including actions this build may not
        //    resolve — a rejected proposal is a canonical no-op and exercising
        //    that path is part of the point.
        const chance = roll("ambition");
        const neighbour = observation.inhabitants.find(
          (other) => other.status === "alive" && other.distance <= 2,
        );
        const pulse = input.sequence % 36;

        if (pulse === 5 && neighbour !== undefined) {
          return {
            type: "communicate",
            payload: {
              recipients: [neighbour.id],
              message: `I can see ${neighbour.displayName} nearby.`,
              intendedMinutes: 15,
            },
          };
        }
        if (pulse === 17 || pulse === 23) {
          return {
            type: "create_artifact",
            payload: {
              kind: "research_note",
              title: `Field note ${input.sequence}`,
              content: `Recorded a visible change at minute ${observation.simTime}.`,
              collaboratorIds: [],
              materials: {},
              derivedFromArtifactId: null,
              organisationId: null,
              revisesArtifactId: null,
            },
          };
        }
        if (chance > 0.94 && neighbour !== undefined) {
          return {
            type: "communicate",
            payload: {
              recipients: [neighbour.id],
              message: `I am at (${self.location.x}, ${self.location.y}).`,
              intendedMinutes: 15,
            },
          };
        }
        if (chance > 0.9) {
          return {
            type: "create_artifact",
            payload: {
              kind: "research_note",
              title: `Record ${input.sequence}`,
              content: `Observed ${observation.tiles.length} tiles at minute ${observation.simTime}.`,
              collaboratorIds: [],
              materials: {},
              derivedFromArtifactId: null,
              organisationId: null,
              revisesArtifactId: null,
            },
          };
        }
        if (chance > 0.87 && held("wood") >= 4 && held("stone") >= 2) {
          return {
            type: "build",
            payload: {
              structureKind: "shelter",
              coord: { x: self.location.x, y: self.location.y },
              name: `Shelter ${input.sequence}`,
              materials: { wood: 4, stone: 2 },
            },
          };
        }
        // 5. Otherwise stock up on whatever is nearest, and look around when
        //    there is nothing within reach.
        for (const resource of ["water", "food", "wood", "stone"]) {
          if (held(resource) >= 30) continue;
          const errand = fetch(resource);
          if (errand !== null) return errand;
        }
        return { type: "observe", payload: {} };
      })();

      return {
        action,
        modelId: "offline-instinct-cognition-v2",
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
  const auditDirectory = resolve(args.output, "model-audit");
  if (args.reset) {
    await rm(eventsDirectory, { recursive: true, force: true });
    await rm(statesDirectory, { recursive: true, force: true });
    await rm(auditDirectory, { recursive: true, force: true });
    await rm(resolve(args.output, "public-snapshot.json"), { force: true });
    await rm(resolve(args.output, "audit-report.json"), { force: true });
  }
  const eventStore = await FileEventStore.open(eventsDirectory);
  const stateStore = await FileStateStore.open<WorldState>(statesDirectory, {
    checksum: computeStateChecksum,
  });
  const clock = args.resume
    ? new SystemClock()
    : new FixedClock("2026-01-01T00:00:00.000Z");
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
        ? "offline-instinct-cognition-v2"
        : resolveModelRouting(process.env).routine;
    const config = demoConfig(modelId, true);
    if (!args.resume) {
      await commitGenesis(
        { eventStore, stateStore, clock, provenance: PROVENANCE },
        config,
      );
    } else {
      await repairStateFromEventLog(eventsDirectory, stateStore, config.worldId);
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

    const startingSequence = startingSnapshot.sequence;
    const startingSimTime = startingSnapshot.state.simTime;
    for (let offset = 1; offset <= args.turns; offset++) {
      if (args.turnDelayMs > 0 && offset > 1) await sleep(args.turnDelayMs);
      if (clock instanceof FixedClock) clock.advanceSeconds(1);
      const current = await stateStore.load(config.worldId);
      if (current === null) throw new Error(`world ${config.worldId} has no state`);
      const actorIds = Object.values(current.state.inhabitants)
        .filter((inhabitant) => inhabitant.status === "alive")
        .map((inhabitant) => inhabitant.id)
        .sort();
      if (actorIds.length === 0) {
        process.stdout.write(`[dev-clock] no living inhabitants remain after ${offset - 1} turn(s)\n`);
        break;
      }
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
      if (args.turnDelayMs > 0 && offset % 12 === 0) {
        process.stdout.write(
          `[dev-clock] simulated day ${offset / 12}; ` +
            `${offset}/${args.turns} turns; sequence ${sequence}\n`,
        );
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

async function repairStateFromEventLog(
  eventsDirectory: string,
  stateStore: FileStateStore<WorldState>,
  worldId: string,
): Promise<void> {
  const eventsPath = resolve(eventsDirectory, `${worldId}.jsonl`);
  if (!existsSync(eventsPath)) return;

  const events = await readEvents(eventsPath);
  if (events.length === 0) return;

  const replay = replayHistory(events);
  if (!replay.ok || replay.state === null || replay.finalChecksum === null) {
    throw new Error(
      `cannot resume ${worldId}: event log replay failed; first mismatch ` +
        `${JSON.stringify(replay.mismatches[0] ?? null)}`,
    );
  }

  const snapshot = await stateStore.load(worldId);
  const head = events.at(-1)!;
  if (snapshot?.sequence === head.sequence && snapshot.checksum === replay.finalChecksum) return;

  await stateStore.save(worldId, replay.state, head.sequence, replay.finalChecksum);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  /*
   * Spend enforcement (see `SpendEnforcement` in @after-genesis/cognition).
   *
   * This repository is a disposable testbed: the intent is to discard it and
   * rebuild a sealed world before Genesis. In that setting a mid-run freeze is
   * more expensive than an unexpected bill, because it invalidates the run
   * rather than the budget. So the default here is "observe" — every charge is
   * still priced, recorded and reported, and none of them is ever refused.
   *
   * `assertSealedWorldPolicy` (called by the Genesis command) refuses to seal a
   * world in this mode, so the setting cannot travel into a real world silently.
   * Set AG_SPEND_ENFORCEMENT=freeze to restore the constitutional behaviour.
   */
  const enforcement: SpendEnforcement =
    process.env.AG_SPEND_ENFORCEMENT === "freeze" ? "freeze" : "observe";

  if (enforcement === "freeze" && (remainingTotal <= 0 || remainingDaily <= 0)) {
    throw new Error(
      `Paid inference is frozen: prior audited cost $${(priorModelCostMicros / 1_000_000).toFixed(6)} ` +
        "has reached the configured cumulative ceiling.",
    );
  }
  if (enforcement === "observe") {
    console.warn(
      `[spend] enforcement=observe — no ceiling will stop this run. ` +
        `Prior audited cost $${(priorModelCostMicros / 1_000_000).toFixed(6)}. ` +
        `Stated ceilings: daily $${(configuredDaily / 1_000_000).toFixed(2)}, ` +
        `total $${(hardLifetimeCeiling / 1_000_000).toFixed(2)}.`,
    );
  }

  return new ProviderCognitionService({
    provider: geminiFromEnv(process.env),
    audit,
    modelId,
    prices,
    enforcement,
    limits: {
      // Under "observe" these are reporting thresholds, not brakes. They are
      // still passed so the meter can say when a stated ceiling was passed.
      dailyMicros: Math.max(remainingDaily, 0),
      totalMicros: Math.max(remainingTotal, 0),
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

async function runBootstrapStaging(args: ParsedArgs): Promise<void> {
  const result = await bootstrapStagingWorld({
    worldId: args.worldId,
    outputDir: args.output,
  });
  process.stdout.write(
    `[staging-bootstrap] Bootstrapped staging world "${result.worldId}"\n` +
      `  Seed: ${result.seed}\n` +
      `  Founder: ${result.founderName} (${result.founderId})\n` +
      `  Checksum: ${result.stateChecksum}\n` +
      `  Output: ${result.outputDir}\n`,
  );
}

async function runTeardownStaging(args: ParsedArgs): Promise<void> {
  await teardownStagingWorld(args.worldId, args.output);
  process.stdout.write(`[staging-teardown] Purged staging world "${args.worldId}" from ${args.output}\n`);
}

async function main(): Promise<void> {
  // Local developer convenience only. Node's built-in loader does not override
  // variables already injected by a shell, CI, or secret manager.
  if (existsSync(".env")) process.loadEnvFile(".env");
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "demo") await runDemo(args);
  else if (args.command === "replay") await runReplay(args);
  else if (args.command === "bootstrap-staging") await runBootstrapStaging(args);
  else if (args.command === "teardown-staging") await runTeardownStaging(args);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
