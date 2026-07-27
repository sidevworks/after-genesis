import { z } from "zod";
import { computeStateChecksum } from "./engine/checksum.js";
import {
  DEFAULT_MAP_HEIGHT,
  DEFAULT_MAP_WIDTH,
  firstPassableTile,
  generateWorldTerrain,
} from "./engine/mapgen.js";
import {
  addGenesisInhabitant,
  createWorldState,
  makeInhabitant,
  type WorldState,
} from "./engine/state.js";
import { ResourceBundleSchema } from "./schema/primitives.js";
import { GENESIS_TIME } from "./time.js";
import type { Sha256Hex } from "./util/hash.js";

export const GenesisConfigSchema = z.object({
  worldId: z.string().min(1),
  seed: z.string().min(1),
  width: z.number().int().min(4).max(256).default(DEFAULT_MAP_WIDTH),
  height: z.number().int().min(4).max(256).default(DEFAULT_MAP_HEIGHT),
  founder: z.object({
    id: z.string().min(1).default("inh_founder"),
    displayName: z.string().min(1).max(80),
    modelId: z.string().min(1),
    inventory: ResourceBundleSchema,
    traits: z.record(z.string(), z.number().int().min(0).max(100)).default({}),
    values: z.array(z.string().min(1)).default([]),
    privateGoals: z.array(z.string().min(1)).default([]),
  }),
});
export type GenesisConfig = z.infer<typeof GenesisConfigSchema>;

export interface BuiltGenesis {
  readonly config: GenesisConfig;
  readonly emptyStateChecksum: Sha256Hex;
  readonly state: WorldState;
  readonly stateChecksum: Sha256Hex;
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
  const location = firstPassableTile(generated.map);
  if (location === null) throw new Error("Genesis map has no passable founder tile");

  const founder = makeInhabitant({
    id: config.founder.id,
    displayName: config.founder.displayName,
    location,
    birthTime: GENESIS_TIME,
    creationSequence: 0,
    generation: 0,
    inventory: config.founder.inventory,
    traits: config.founder.traits,
    values: config.founder.values,
    privateGoals: config.founder.privateGoals,
    maturity: 3,
    modelId: config.founder.modelId,
  });
  const state = {
    ...addGenesisInhabitant(empty, founder),
    sequence: 0,
  };
  return {
    config,
    emptyStateChecksum: computeStateChecksum(empty),
    state,
    stateChecksum: computeStateChecksum(state),
  };
}
