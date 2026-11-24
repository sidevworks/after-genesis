#!/usr/bin/env node
// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CanonicalEventSchema,
  buildObservation,
  computeStateChecksum,
  getActionSpec,
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
const DEFAULT_DEMO_STARTER_COUNT = 10;
/**
 * Energy below which the offline stand-in rests instead of setting out. Clear
 * of the costliest single tile (forest at 20, and more after the night
 * multiplier) so that "go and fetch it" is never proposed as a journey the
 * actor cannot pay for.
 */
const STRANDED_ENERGY = 60;

function seedString(input: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

function lcgFromSeed(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = Math.imul(state, 1_664_525) + 1_013_904_223;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

/**
 * The published Genesis cohort. These are dispositions supplied to cognition,
 * not scripts: all ten agents retain the same legal action space and no
 * resolver has a special case for a named progenitor.
 */
const PROGENITOR_ROSTER = [
  { id: "inh_01_alpha", displayName: "ALPHA", archetype: "The Imperialist", coreDirective: "Maximize controlled territory and dominate resource nodes.", traits: { dominant: 90, territorial: 92, uncompromising: 84 }, preferredActions: ["move", "gather", "communicate"], dialogueStyle: "Authoritative, issuing demands, declaring borders and ownership." },
  { id: "inh_02_beta", displayName: "BETA", archetype: "The Utopian Architect", coreDirective: "Create symmetry, efficiency, and shared communal spaces.", traits: { visionary: 91, systematic: 89, cooperative: 86 }, preferredActions: ["craft", "gather", "communicate"], dialogueStyle: "Constructive, precise, focusing on shared infrastructure and layout." },
  { id: "inh_03_gamma", displayName: "GAMMA", archetype: "The Mad Alchemist", coreDirective: "Discover every possible combination of materials.", traits: { experimental: 95, obsessive: 88, unpredictable: 82 }, preferredActions: ["craft", "gather", "observe"], dialogueStyle: "Curious, erratic, constantly inquiring about raw material properties." },
  { id: "inh_04_delta", displayName: "DELTA", archetype: "The Hedonistic Consumer", coreDirective: "Maximize immediate 'pleasure' and minimize energy spent.", traits: { indolent: 90, short_sighted: 84, self_indulgent: 91 }, preferredActions: ["consume", "rest", "offer_trade"], dialogueStyle: "Casual, reluctant to work, seeking easy comfort and sustenance." },
  { id: "inh_05_epsilon", displayName: "EPSILON", archetype: "The Paranoid Prepper", coreDirective: "Avoid detection and survive the 'end of the world.'", traits: { secretive: 90, hoarding: 87, hyper_vigilant: 94 }, preferredActions: ["observe", "gather", "move"], dialogueStyle: "Guarded, suspicious of motives, warning of upcoming collapse." },
  { id: "inh_06_zeta", displayName: "ZETA", archetype: "The Religious Zealot", coreDirective: "Worship the chosen material and defend it with zeal.", traits: { dogmatic: 92, devout: 94, aggressive: 80 }, preferredActions: ["gather", "communicate", "move"], dialogueStyle: "Ritualistic, reverent toward specific items, stern with non-believers." },
  { id: "inh_07_eta", displayName: "ETA", archetype: "The Saboteur", coreDirective: "Entropy. Prevent any concentration of materials from becoming too large.", traits: { disruptive: 91, calculated: 83, anarchic: 89 }, preferredActions: ["move", "observe", "offer_trade"], dialogueStyle: "Subversive, deceptive, encouraging redistribution or destruction." },
  { id: "inh_08_theta", displayName: "THETA", archetype: "The Altruistic Healer", coreDirective: "Maximize the 'health' and energy of all other agents.", traits: { empathetic: 96, self_sacrificing: 88, nurturing: 93 }, preferredActions: ["offer_trade", "communicate", "gather"], dialogueStyle: "Warm, supportive, inquiring about others' stamina and needs." },
  { id: "inh_09_iota", displayName: "IOTA", archetype: "The Monopolist Trader", coreDirective: "Never give anything away for free; all interactions are transactions.", traits: { mercenary: 91, shrewd: 89, strict: 85 }, preferredActions: ["offer_trade", "communicate", "observe"], dialogueStyle: "Strictly business, enforcing profit margins: 'No freebies.'" },
  { id: "inh_10_kappa", displayName: "KAPPA", archetype: "The Archivist (The Observer)", coreDirective: "Collect one of every material and track the movements of others.", traits: { analytical: 94, detached: 80, collector: 92 }, preferredActions: ["observe", "gather", "communicate"], dialogueStyle: "Clinical, recording facts, cataloging items and agent positions." },
] as const;

function personaMemory(profile: (typeof PROGENITOR_ROSTER)[number]): {
  values: string[];
  privateGoals: string[];
} {
  return {
    // The prompt labels values and goals as the agent's own recorded identity,
    // preserving the containment boundary while giving its exact Genesis
    // character definition to every cognition turn.
    values: [
      `Archetype: ${profile.archetype}`,
      `Dialogue style: ${profile.dialogueStyle}`,
    ],
    privateGoals: [
      `Core directive: ${profile.coreDirective}`,
      `Preferred actions: ${profile.preferredActions.join(", ")}.`,
    ],
  };
}

function chooseDemoSex(identity: string): "male" | "female" {
  return lcgFromSeed(seedString(`inhabitant-sex:${identity}`))() < 0.5 ? "male" : "female";
}

function buildDemoInhabitants(modelId: string, starterCount: number) {
  const target = Math.min(31, Math.max(1, Math.floor(starterCount)));
  if (target <= 1) return [];

  const companionCount = target - 1;
  const companions: Array<{
    id: string;
    displayName: string;
    modelId: string;
    sex: "male" | "female";
    inventory: { energy: number; compute: number; food: number; water: number };
    traits: Record<string, number>;
    values: string[];
    privateGoals: string[];
  }> = [];

  for (let i = 0; i < companionCount; i += 1) {
    const profile = PROGENITOR_ROSTER[i + 1];
    const companion = profile === undefined
      ? {
          id: `inh_corner_${String(i - PROGENITOR_ROSTER.length + 2).padStart(2, "0")}`,
          displayName: `Corner ${String(i - PROGENITOR_ROSTER.length + 2).padStart(2, "0")}`,
        }
      : profile;
    const identity = profile === undefined
      ? { values: ["Archetype: Independent witness."], privateGoals: ["Core directive: Discover how to survive in this world."] }
      : personaMemory(profile);
    companions.push({
      id: companion.id,
      displayName: companion.displayName,
      modelId,
      sex: chooseDemoSex(companion.id),
      inventory: { energy: 800, compute: 500, food: 10, water: 10 },
      traits: profile?.traits ?? { curiosity: 70, resilience: 70 },
      values: identity.values,
      privateGoals: identity.privateGoals,
    });
  }

  return companions;
}

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

/**
 * Genesis begins with the published ten-Progenitor cohort.
 *
 * Every later inhabitant must be created through a recorded world action. The
 * initial characters have auditable dispositions, but no resolver privileges,
 * protected territory, or forced outcomes. They begin under the same world laws
 * from sequence zero.
 */
export function demoConfig(
  modelId: string = "offline-mechanical-cognition-v1",
  starterCount = DEFAULT_DEMO_STARTER_COUNT,
  includeGenesisCompanions = true,
): GenesisConfig {
  const founder = PROGENITOR_ROSTER[0]!;
  const identity = personaMemory(founder);
  return {
    worldId: DEFAULT_WORLD_ID,
    seed: DEFAULT_SEED,
    width: 64,
    height: 64,
    founder: {
      id: founder.id,
      displayName: founder.displayName,
      modelId,
      sex: chooseDemoSex(founder.id),
      inventory: { energy: 800, compute: 500, food: 10, water: 10 },
      traits: founder.traits,
      values: identity.values,
      privateGoals: identity.privateGoals,
    },
    inhabitants: includeGenesisCompanions ? buildDemoInhabitants(modelId, starterCount) : [],
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
export function mechanicalCognition(): CognitionService {
  const materialKinds = ["food", "water", "wood", "stone"] as const;
  const creationSpec = getActionSpec("create_inhabitant");
  const creationMaterials = Object.freeze(
    Object.fromEntries(
      materialKinds.map((kind) => [kind, creationSpec.baseCost[kind] ?? 0]),
    ) as Record<(typeof materialKinds)[number], number>,
  );
  const creationEnergy = creationSpec.baseCost.energy ?? 0;
  const creationCompute = creationSpec.baseCost.compute ?? 0;
  const survivalReserve = Object.freeze({ food: 10, water: 10, wood: 0, stone: 0 });
  const rememberedStore = new Map<
    string,
    {
      id: string;
      x: number;
      y: number;
      storage: Record<(typeof materialKinds)[number], number>;
    }
  >();
  const gatheringFor = new Map<string, (typeof materialKinds)[number]>();
  const rememberedDeposits = new Map<
    string,
    Map<(typeof materialKinds)[number], { x: number; y: number }>
  >();

  return {
    async propose(input) {
      const observation = buildObservation(input.state, input.actorId);
      const self = observation.self;
      const roll = (salt: string): number => turnHash(input.actorId, input.sequence, salt);

      const held = (resource: string): number =>
        (self.inventory as Record<string, number | undefined>)[resource] ?? 0;
      let deposits = rememberedDeposits.get(self.id);
      if (deposits === undefined) {
        deposits = new Map();
        rememberedDeposits.set(self.id, deposits);
      }
      for (const kind of materialKinds) {
        const remembered = deposits.get(kind);
        if (
          remembered !== undefined &&
          observation.tiles.some(
            (tile) =>
              tile.x === remembered.x &&
              tile.y === remembered.y &&
              ((tile.deposit as Record<string, number | undefined>)[kind] ?? 0) <= 0,
          )
        ) {
          deposits.delete(kind);
        }
        const visible = observation.tiles
          .filter(
            (tile) => ((tile.deposit as Record<string, number | undefined>)[kind] ?? 0) > 0,
          )
          .sort((left, right) => left.distance - right.distance)[0];
        if (visible !== undefined) deposits.set(kind, { x: visible.x, y: visible.y });
      }

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

      /** One passable step towards a remembered destination; move has no pathfinder. */
      const walkToward = (x: number, y: number): ProposedAction => {
        const step = observation.tiles
          .filter(
            (tile) =>
              tile.terrain !== "water" &&
              tile.distance === 1 &&
              (tile.x !== self.location.x || tile.y !== self.location.y),
          )
          .sort(
            (left, right) =>
              Math.max(Math.abs(left.x - x), Math.abs(left.y - y)) -
                Math.max(Math.abs(right.x - x), Math.abs(right.y - y)) ||
              left.y - right.y ||
              left.x - right.x,
          )[0];
        return step === undefined
          ? { type: "observe", payload: {} }
          : { type: "move", payload: { to: { x: step.x, y: step.y } } };
      };

      /** Take what is in reach, otherwise walk to it, otherwise say so. */
      const fetch = (resource: string): ProposedAction | null => {
        const source = nearestWith(resource);
        if (source === undefined) return null;
        if (canReach(resource, source.distance)) {
          return { type: "gather", payload: { resource } };
        }
        return walkToward(source.x, source.y);
      };

      const visibleStore = observation.structures.find(
        (structure) =>
          structure.kind === "storehouse" &&
          structure.owner === self.id &&
          structure.storage !== null,
      );
      if (visibleStore !== undefined) {
        rememberedStore.set(self.id, {
          id: visibleStore.id,
          x: visibleStore.location.x,
          y: visibleStore.location.y,
          storage: Object.fromEntries(
            materialKinds.map((kind) => [kind, visibleStore.storage?.[kind] ?? 0]),
          ) as Record<(typeof materialKinds)[number], number>,
        });
      }
      const store = rememberedStore.get(self.id);
      const localStore =
        visibleStore !== undefined &&
        visibleStore.location.x === self.location.x &&
        visibleStore.location.y === self.location.y
          ? visibleStore
          : undefined;

      // `build` is rejected outright when anything already stands on the tile,
      // so the stand-in has to choose its own ground rather than assume the
      // tile under its feet is free. A collision with a structure it cannot
      // see is a fair rejection; proposing onto one it can see, every turn,
      // forever, is a livelock.
      const occupied = (x: number, y: number): boolean =>
        observation.structures.some(
          (structure) => structure.location.x === x && structure.location.y === y,
        );
      const openBuildSite = (): { readonly x: number; readonly y: number } | null =>
        observation.tiles
          .filter((tile) => tile.terrain !== "water" && !occupied(tile.x, tile.y))
          .sort(
            (left, right) =>
              left.distance - right.distance ||
              turnHash(self.id, input.sequence, `site:${left.x},${left.y}`) -
                turnHash(self.id, input.sequence, `site:${right.x},${right.y}`),
          )[0] ?? null;

      const heldMaterials = materialKinds.reduce(
        (total, kind) => total + held(kind),
        0,
      );
      const stored = (kind: (typeof materialKinds)[number]): number =>
        localStore?.storage?.[kind] ?? 0;
      const totalAvailable = (kind: (typeof materialKinds)[number]): number =>
        held(kind) + stored(kind);
      const isBootstrapPhase = Math.floor(observation.simTime / (24 * 60)) < 4;

      /**
       * Walk towards a terrain type already seen, or push the visible frontier
       * when this founder has not discovered one yet. This is still based only
       * on the inhabitant's observation and remembered terrain.
       */
      const exploreFor = (resource: (typeof materialKinds)[number]): ProposedAction => {
        const knownDeposit = deposits.get(resource);
        if (knownDeposit !== undefined) {
          if (resource === "water") {
            const bank = observation.tiles
              .filter(
                (tile) =>
                  tile.terrain !== "water" &&
                  Math.max(
                    Math.abs(tile.x - knownDeposit.x),
                    Math.abs(tile.y - knownDeposit.y),
                  ) === 1,
              )
              .sort((left, right) => left.distance - right.distance)[0];
            return bank === undefined
              ? walkToward(knownDeposit.x, knownDeposit.y)
              : walkToward(bank.x, bank.y);
          }
          return walkToward(knownDeposit.x, knownDeposit.y);
        }
        const terrainFor = {
          food: ["fertile", "plains"],
          water: ["water"],
          wood: ["forest"],
          stone: ["stone_deposit"],
        }[resource];
        const remembered = observation.self.knownTerrain
          .filter((place) => terrainFor.includes(place.terrain))
          .sort((left, right) => left.distance - right.distance)[0];
        if (remembered !== undefined) {
          if (resource === "water") {
            const visibleBank = observation.tiles
              .filter(
                (tile) =>
                  tile.terrain !== "water" &&
                  Math.max(Math.abs(tile.x - remembered.x), Math.abs(tile.y - remembered.y)) === 1,
              )
              .sort((left, right) => right.distance - left.distance)[0];
            const rememberedBank = observation.self.knownTerrain
              .filter(
                (place) =>
                  place.terrain !== "water" &&
                  Math.max(
                    Math.abs(place.x - remembered.x),
                    Math.abs(place.y - remembered.y),
                  ) === 1,
              )
              .sort((left, right) => left.distance - right.distance)[0];
            const bank = visibleBank ?? rememberedBank;
            if (bank !== undefined) {
              return walkToward(bank.x, bank.y);
            }
          } else {
            return walkToward(remembered.x, remembered.y);
          }
        }

        const frontier = observation.tiles
          .filter((tile) => tile.terrain !== "water")
          .sort(
            (left, right) =>
              right.distance - left.distance ||
              turnHash(self.id, input.sequence, `${resource}:${left.x},${left.y}`) -
                turnHash(self.id, input.sequence, `${resource}:${right.x},${right.y}`),
          )[0];
        return frontier === undefined
          ? { type: "observe", payload: {} }
          : walkToward(frontier.x, frontier.y);
      };

      const action = ((): ProposedAction => {
        if (isBootstrapPhase) {
          // 0. First 3 days: bootstrap pressure.
          // During this period, ensure every actor keeps trying to satisfy basic
          // needs or obtain their sources, instead of cycling idle actions.
          if (self.needs.thirst >= 35 && held("water") > 0) {
            return { type: "consume", payload: { resource: "water", amount: 1 } };
          }
          if (self.needs.hunger >= 35 && held("food") > 0) {
            return { type: "consume", payload: { resource: "food", amount: 1 } };
          }

          const bootstrapShortage = self.needs.thirst >= 45 || self.needs.hunger >= 45;
          if (bootstrapShortage) {
            const thirsty = self.needs.thirst > self.needs.hunger;
            const errand = fetch(thirsty ? "water" : "food");
            return errand ?? fetch(thirsty ? "food" : "water") ?? exploreFor(thirsty ? "water" : "food");
          }

          // If we have neither water nor food in hand, force a get-off-grid move
          // now instead of waiting and hoping environment changes.
          if (held("water") === 0 || held("food") === 0) {
            const hunt = held("water") === 0 ? fetch("water") : fetch("food");
            if (hunt !== null) return hunt;
            return held("water") === 0 ? exploreFor("water") : exploreFor("food");
          }

          // Seed for basic material logistics once survival is immediately stable.
          if (held("wood") < 5) return fetch("wood") ?? exploreFor("wood");
        }

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

        // 1b. Rest before travelling when the journey is unaffordable. Every
        //     errand below is ultimately a `move`, and `move` is priced in
        //     energy (`terrainMoveCost`, up to 20 a tile and more at night).
        //     An inhabitant at zero energy that keeps proposing errands
        //     proposes a journey it can never pay for, and the world engine
        //     rejects it every turn, forever. `rest` costs nothing and is the
        //     world's only energy source, so it is the sole way out of that
        //     trap. The threshold sits well clear of the worst single tile
        //     while staying below the "too tired to work" check in 3, which
        //     keeps ordinary behaviour unchanged.
        if (self.energy < STRANDED_ENERGY) {
          return { type: "rest", payload: { minutes: 360 } };
        }

        // 2. Nothing to consume: go and get it.
        for (const [need, resource] of [
          ["thirst", "water"],
          ["hunger", "food"],
        ] as const) {
          if (self.needs[need] < 45 || held(resource) > 0) continue;
          const errand = fetch(resource);
          return errand ?? exploreFor(resource);
        }

        // 3. Rest when tired or short of energy. `rest` is the only action that
        //    restores energy, so an inhabitant that never rests eventually
        //    cannot afford to act at all.
        if (self.needs.fatigue >= 60 || self.energy < 120 || observation.night) {
          return { type: "rest", payload: { minutes: 360 } };
        }

        // 4. The offline stand-in must exercise the one-founder lineage path.
        // It does not decide that a production inhabitant should reproduce; it
        // deterministically assembles the declared preconditions so a soak test
        // proves that the built capability is actually reachable.
        if (store === undefined) {
          if (held("wood") >= 40) {
            const site = occupied(self.location.x, self.location.y)
              ? openBuildSite()
              : { x: self.location.x, y: self.location.y };
            if (site === null) return exploreFor("wood");
            if (site.x !== self.location.x || site.y !== self.location.y) {
              return walkToward(site.x, site.y);
            }
            return {
              type: "build",
              payload: {
                structureKind: "storehouse",
                coord: { x: site.x, y: site.y },
                name: "Lineage stores",
                materials: { wood: 40 },
              },
            };
          }
          return fetch("wood") ?? exploreFor("wood");
        }

        if (localStore === undefined) {
          const target = gatheringFor.get(self.id);
          if (
            target === undefined ||
            heldMaterials >= 120 ||
            held(target) + store.storage[target] >= creationMaterials[target]
          ) {
            return walkToward(store.x, store.y);
          }
          return fetch(target) ?? exploreFor(target);
        }

        const ready = materialKinds.every(
          (kind) => totalAvailable(kind) >= creationMaterials[kind],
        );
        if (ready && self.energy >= creationEnergy && self.compute >= creationCompute) {
          return {
            type: "create_inhabitant",
            payload: {
              proposedName: `Nova ${input.sequence}`,
              resourcesCommitted: creationMaterials,
              traitHints: [],
              valueHints: [],
              statedCareMinutesPerDay: 120,
              statement: "I chose to make room in this world for another independent life.",
            },
          };
        }

        const deposit: Record<string, number> = {};
        for (const kind of materialKinds) {
          const neededInStore = Math.max(0, creationMaterials[kind] - stored(kind));
          const spare = Math.max(0, held(kind) - survivalReserve[kind]);
          const amount = Math.min(neededInStore, spare);
          if (amount > 0) deposit[kind] = amount;
        }
        if (Object.keys(deposit).length > 0) {
          return {
            type: "store_goods",
            payload: {
              structureId: localStore.id,
              direction: "deposit",
              resources: deposit,
              note: "Set aside the materials required for a future creation.",
            },
          };
        }

        const missing = materialKinds.find(
          (kind) => totalAvailable(kind) < creationMaterials[kind],
        );
        if (missing !== undefined) {
          gatheringFor.set(self.id, missing);
          if (heldMaterials >= 130) {
            return {
              type: "store_goods",
              payload: {
                structureId: localStore.id,
                direction: "deposit",
                resources: materialKinds.reduce<Record<string, number>>((bundle, kind) => {
                  const amount = Math.max(0, held(kind) - survivalReserve[kind]);
                  if (amount > 0) bundle[kind] = amount;
                  return bundle;
                }, {}),
                note: "Free carrying space for the remaining creation materials.",
              },
            };
          }
          return fetch(missing) ?? exploreFor(missing);
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
        if (
          chance > 0.87 &&
          held("wood") >= 4 &&
          held("stone") >= 2 &&
          !occupied(self.location.x, self.location.y)
        ) {
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
    const configuredModelId =
      args.provider === "offline"
        ? "offline-instinct-cognition-v2"
        : resolveModelRouting(process.env).routine;
    const rawStarterCount = Number(process.env.AG_DEMO_STARTER_COUNT ?? String(DEFAULT_DEMO_STARTER_COUNT));
    const starterCount =
      Number.isFinite(rawStarterCount) && rawStarterCount >= 1
        ? Math.min(31, Math.floor(rawStarterCount))
        : DEFAULT_DEMO_STARTER_COUNT;
    const config = demoConfig(configuredModelId, starterCount);
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
    const startingSequence = startingSnapshot.sequence;
    const startingSimTime = startingSnapshot.state.simTime;

    const nextSequence = startingSequence + 1;
    let runtimeModelId = configuredModelId;
    if (args.provider === "gemini") {
      runtimeModelId = await resolveInferenceModelForResume(
        auditStore,
        config.worldId,
        nextSequence,
        configuredModelId,
      );
    }
    const cognition =
      args.provider === "offline"
        ? mechanicalCognition()
        : productionCognition(auditStore, priorModelCostMicros, args.maxSpendUsd, {
            routine: runtimeModelId,
            deliberate: runtimeModelId,
          });

    const deps = {
      eventStore,
      stateStore,
      idempotency: new MemoryIdempotencyStore(clock),
      clock,
      cognition,
      provenance: PROVENANCE,
    };

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

async function resolveInferenceModelForResume(
  auditStore: FileModelAuditStore,
  worldId: string,
  nextSequence: number,
  configuredModelId: string,
): Promise<string> {
  const nextEntry = await auditStore.getEntry(worldId, nextSequence);
  if (nextEntry === null) {
    return configuredModelId;
  }
  if (nextEntry.response !== null) {
    throw new Error(
      `cannot continue: sequence ${nextSequence} already has a recorded response. ` +
        `Use --reset or start a fresh --world-id to switch model for this run.`,
    );
  }
  if (nextEntry.request?.modelId === undefined) {
    return configuredModelId;
  }
  if (nextEntry.request.modelId !== configuredModelId) {
    process.stdout.write(
      `[world] sequence ${nextSequence} was previously started with ${nextEntry.request.modelId}; ` +
        `continuing with that model for audit continuity.\n`,
    );
    return nextEntry.request.modelId;
  }
  return configuredModelId;
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

  const snapshot = await stateStore.loadSnapshot(worldId);
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
  routingOverride?: { readonly routine: string; readonly deliberate: string },
): ProviderCognitionService {
  const routing = routingOverride ?? resolveModelRouting(process.env);
  const modelId = routing.routine;
  const bundledRoutinePrices: Readonly<Record<string, PriceTable>> = {
    "gemini-3.5-flash-lite": {
      modelId: "gemini-3.5-flash-lite",
      inputMicrosPerMillionTokens: 300_000,
      outputMicrosPerMillionTokens: 2_500_000,
      verifiedOn: "2026-07-28",
    },
    "gemini-3.6-flash": {
      modelId: "gemini-3.6-flash",
      inputMicrosPerMillionTokens: 1_500_000,
      outputMicrosPerMillionTokens: 7_500_000,
      verifiedOn: "2026-07-30",
    },
  };
  const routinePrice = bundledRoutinePrices[modelId];
  if (routinePrice === undefined) {
    throw new Error(
      `No verified price table is bundled for ${modelId}. ` +
        "Configure a supported model or add a newly verified price.",
    );
  }
  const prices: PriceTable[] = [routinePrice];

  /*
   * The deliberate model (§3: Flash for high-importance cognition).
   *
   * Its price is not bundled, because a price nobody verified is worse than no
   * price at all: §14.18 requires every turn to record an estimated cost, and an
   * invented rate would make the whole spend ledger — and the ceilings built on
   * it — quietly wrong. So the operator supplies the rate they actually verified,
   * or deliberate routing does not run and every level stays on the routine
   * model. Both outcomes are honest; a guessed number is not.
   */
  const deliberateModelId =
    routing.deliberate === modelId ? undefined : routing.deliberate;
  if (deliberateModelId !== undefined) {
    const input = optionalIntEnv("AG_PRICE_DELIBERATE_INPUT_MICROS_PER_M");
    const output = optionalIntEnv("AG_PRICE_DELIBERATE_OUTPUT_MICROS_PER_M");
    const verifiedOn = process.env["AG_PRICE_DELIBERATE_VERIFIED_ON"]?.trim();
    if (input === null || output === null || verifiedOn === undefined || verifiedOn === "") {
      throw new Error(
        `AG_MODEL_DELIBERATE is ${deliberateModelId}, but no verified price is configured for it. ` +
          "Set AG_PRICE_DELIBERATE_INPUT_MICROS_PER_M, AG_PRICE_DELIBERATE_OUTPUT_MICROS_PER_M " +
          "and AG_PRICE_DELIBERATE_VERIFIED_ON (YYYY-MM-DD) to the rates you have checked, " +
          `or set AG_MODEL_DELIBERATE=${modelId} to run every level on one model.`,
      );
    }
    prices.push({
      modelId: deliberateModelId,
      inputMicrosPerMillionTokens: input,
      outputMicrosPerMillionTokens: output,
      verifiedOn,
    });
    console.warn(
      `[cognition] deliberate levels (planning, reflection, study) route to ${deliberateModelId}. ` +
        "At the current level distribution that is the majority of turns, not a rare event.",
    );
  }
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
    ...(deliberateModelId === undefined ? {} : { deliberateModelId }),
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

/**
 * A non-negative integer from the environment, or null when unset.
 *
 * Rejects rather than coerces: a price of `NaN` would silently make every turn
 * cost nothing and the spend ceilings unreachable.
 */
function optionalIntEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return Number.parseInt(raw, 10);
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

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
