// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { computeStateChecksum } from "./engine/checksum.js";
import {
  DEFAULT_MAP_HEIGHT,
  DEFAULT_MAP_WIDTH,
  generateWorldTerrain,
} from "./engine/mapgen.js";
import {
  addGenesisInhabitant,
  createWorldState,
  makeInhabitant,
  SEXES,
  type WorldState,
} from "./engine/state.js";
import { voiceAt } from "./engine/voice.js";
import { lifespanForBirth } from "./engine/aging.js";
import type { Coord } from "./schema/primitives.js";
import { ResourceBundleSchema } from "./schema/primitives.js";
import { GENESIS_TIME } from "./time.js";
import type { Sha256Hex } from "./util/hash.js";

const GenesisInhabitantSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).max(80),
  modelId: z.string().min(1),
  /**
   * Declared, not drawn. Every later inhabitant's sex comes from the world RNG
   * (see `resolvers/lineage.ts`), but Genesis has no history to draw from and
   * §22 requires the complete Genesis configuration to be published before the
   * first event. A founder attribute that appeared from nowhere would not be
   * reproducible from the published config.
   */
  sex: z.enum(SEXES),
  inventory: ResourceBundleSchema,
  traits: z.record(z.string(), z.number().int().min(0).max(100)).default({}),
  values: z.array(z.string().min(1)).default([]),
  privateGoals: z.array(z.string().min(1)).default([]),
});

/**
 * How many inhabitants a sealed experiment starts with.
 *
 * §1 fixes the founding cohort at ten — the Progenitors — and publishes their
 * identities in the Genesis manifest. The number is constitutional: it decides
 * whether social structure has to be built from one lineage or is possible from
 * the first instant, and it cannot be revised once a world is live.
 *
 * The config schema below still accepts one to thirty-two, because development
 * runs, rehearsals and fixtures legitimately seed other sizes — a three-founder
 * soak test is cheaper and proves the same mechanics. What must not happen is a
 * run *labelled sealed* that quietly seeds some other number, so the constraint
 * is enforced against the sealed classification in `commitGenesis`, not here.
 */
export const FOUNDING_COHORT_SIZE = 10;

export const GenesisConfigSchema = z.object({
  worldId: z.string().min(1),
  seed: z.string().min(1),
  width: z.number().int().min(4).max(256).default(DEFAULT_MAP_WIDTH),
  height: z.number().int().min(4).max(256).default(DEFAULT_MAP_HEIGHT),
  founder: GenesisInhabitantSchema.extend({
    id: z.string().min(1).default("inh_founder"),
  }),
  /** Additional independent inhabitants present from the first instant. */
  inhabitants: z.array(GenesisInhabitantSchema).max(31).optional(),
}).superRefine((config, ctx) => {
  const ids = [config.founder.id, ...(config.inhabitants ?? []).map((item) => item.id)];
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Genesis inhabitant ids must be unique" });
  }
});
export type GenesisConfig = z.infer<typeof GenesisConfigSchema>;

export interface BuiltGenesis {
  readonly config: GenesisConfig;
  readonly emptyStateChecksum: Sha256Hex;
  readonly state: WorldState;
  readonly stateChecksum: Sha256Hex;
}

function chooseSpawnLocations(map: {
  readonly width: number;
  readonly height: number;
  readonly terrain: readonly string[];
}, count: number): readonly Coord[] {
  const passable: Coord[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.terrain[y * map.width + x] !== "water") passable.push({ x, y });
    }
  }
  if (passable.length === 0) throw new Error("Genesis map has no passable tile");

  const safeCount = Math.max(1, Math.min(count, passable.length));
  const stride = Math.max(1, Math.floor(passable.length / safeCount));
  return Array.from({ length: safeCount }, (_, index) => {
    const slot = (index * stride) % passable.length;
    return passable[slot]!;
  });
}

/** Pure Genesis construction shared by the live command and public replay. */
export function buildGenesis(raw: GenesisConfig): BuiltGenesis {
  const config = GenesisConfigSchema.parse(raw);
  const generated = generateWorldTerrain(config.seed, config.width, config.height);
  const empty = createWorldState({
    worldId: config.worldId,
    seed: config.seed,
    map: generated.map,
    deposits: generated.deposits,
  });
  const spawnLocations = chooseSpawnLocations(generated.map, 1 + (config.inhabitants?.length ?? 0));

  let populated = empty;
  const roster = [config.founder, ...(config.inhabitants ?? [])];
  for (const [index, inhabitant] of roster.entries()) {
    // Assigned by roster position rather than randomly: reproducible from the
    // published config alone, and distinct for the first ten of each sex.
    populated = addGenesisInhabitant(
      populated,
      makeInhabitant({
        id: inhabitant.id,
        displayName: inhabitant.displayName,
        sex: inhabitant.sex,
        voiceId: voiceAt(inhabitant.sex, index),
        location: spawnLocations[index] ?? spawnLocations[0] ?? { x: 0, y: 0 },
        birthTime: GENESIS_TIME,
        creationSequence: 0,
        generation: 0,
        inventory: inhabitant.inventory,
        traits: inhabitant.traits,
        values: inhabitant.values,
        privateGoals: inhabitant.privateGoals,
        maturity: 3,
        modelId: inhabitant.modelId,
        maxLifespanDays: lifespanForBirth(config.seed, inhabitant.id, 0),
      }),
    );
  }
  const state = { ...populated, sequence: 0 };
  return {
    config,
    emptyStateChecksum: computeStateChecksum(empty),
    state,
    stateChecksum: computeStateChecksum(state),
  };
}
