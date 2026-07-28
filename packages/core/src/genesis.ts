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

const GenesisInhabitantSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).max(80),
  modelId: z.string().min(1),
  inventory: ResourceBundleSchema,
  traits: z.record(z.string(), z.number().int().min(0).max(100)).default({}),
  values: z.array(z.string().min(1)).default([]),
  privateGoals: z.array(z.string().min(1)).default([]),
});

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

  let populated = empty;
  for (const inhabitant of [config.founder, ...(config.inhabitants ?? [])]) {
    populated = addGenesisInhabitant(
      populated,
      makeInhabitant({
        id: inhabitant.id,
        displayName: inhabitant.displayName,
        location,
        birthTime: GENESIS_TIME,
        creationSequence: 0,
        generation: 0,
        inventory: inhabitant.inventory,
        traits: inhabitant.traits,
        values: inhabitant.values,
        privateGoals: inhabitant.privateGoals,
        maturity: 3,
        modelId: inhabitant.modelId,
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
