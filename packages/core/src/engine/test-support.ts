/**
 * Fixtures for the engine's own tests.
 *
 * Not exported from `engine/index.ts` and never used by production code. It
 * lives beside the engine rather than in a test directory so that it compiles
 * under the same strict settings as everything it builds — a fixture that
 * cheats past `exactOptionalPropertyTypes` would let a test pass on state the
 * engine could never actually produce.
 *
 * Everything here is deterministic. No fixture takes a random seed of its own.
 */
import type { Coord, ResourceBundle } from "../schema/primitives.js";
import { GENESIS_TIME, simTime, type SimTime } from "../time.js";
import { generateWorldTerrain, firstPassableTile } from "./mapgen.js";
import {
  addGenesisInhabitant,
  createWorldState,
  makeInhabitant,
  terrainAt,
  type Inhabitant,
  type WorldState,
} from "./state.js";

export const TEST_WORLD_ID = "world_test";
export const TEST_SEED = "genesis-seed-0001";

/** A passable tile at or near `preferred`, searched in a fixed order. */
export function passableNear(state: WorldState, preferred: Coord): Coord {
  for (let radius = 0; radius < Math.max(state.map.width, state.map.height); radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const coord = { x: preferred.x + dx, y: preferred.y + dy };
        const terrain = terrainAt(state.map, coord);
        if (terrain !== null && terrain !== "water") return coord;
      }
    }
  }
  /* c8 ignore next */
  throw new Error("no passable tile on this map");
}

export interface TestWorldOptions {
  readonly seed?: string;
  readonly worldId?: string;
  readonly width?: number;
  readonly height?: number;
  readonly founderInventory?: ResourceBundle;
}

/**
 * A world with one founder standing on the first passable tile, at Genesis.
 *
 * The returned state satisfies every invariant, which is the point: a test that
 * expects a violation must create it explicitly, so it cannot pass by accident
 * on a fixture that was already broken.
 */
export function makeTestWorld(options: TestWorldOptions = {}): WorldState {
  const seed = options.seed ?? TEST_SEED;
  const { map, deposits } = generateWorldTerrain(
    seed,
    options.width ?? 32,
    options.height ?? 32,
  );
  const base = createWorldState({
    worldId: options.worldId ?? TEST_WORLD_ID,
    seed,
    map,
    deposits,
  });
  const start = firstPassableTile(map);
  /* c8 ignore next */
  if (start === null) throw new Error("generated map has no passable tile");

  const founder = makeInhabitant({
    id: "inh_founder",
    displayName: "Founder",
    location: start,
    birthTime: GENESIS_TIME,
    creationSequence: 0,
    generation: 0,
    inventory: {
      energy: 800,
      compute: 500,
      food: 10,
      water: 10,
      ...(options.founderInventory ?? {}),
    },
    skills: { gathering: 10 },
    values: ["curiosity"],
    privateGoals: ["understand this place"],
    maturity: 3,
    modelId: "test-model",
  });

  // Sequence 0 is the Genesis event that created the founder.
  return { ...addGenesisInhabitant(base, founder), sequence: 0 };
}

export interface AddInhabitantOptions {
  readonly id: string;
  readonly displayName?: string;
  readonly location: Coord;
  readonly parents?: readonly string[];
  readonly creationSequence?: number;
  readonly birthTime?: SimTime;
  readonly inventory?: ResourceBundle;
  readonly concealed?: ResourceBundle;
  readonly exposed?: ResourceBundle;
  readonly privateGoals?: readonly string[];
}

/**
 * Add a descendant. Resources are moved from nowhere via the Genesis creation
 * path, which keeps the conservation invariant satisfied without needing a
 * `create_inhabitant` resolver that does not exist yet.
 */
export function addTestInhabitant(
  state: WorldState,
  options: AddInhabitantOptions,
): WorldState {
  const inhabitant = makeInhabitant({
    id: options.id,
    displayName: options.displayName ?? options.id,
    location: options.location,
    birthTime: options.birthTime ?? simTime(state.simTime),
    creationSequence: options.creationSequence ?? Math.max(state.sequence, 1),
    generation: 1,
    parents: options.parents ?? ["inh_founder"],
    inventory: { energy: 500, ...(options.inventory ?? {}) },
    concealed: { ...(options.concealed ?? {}) },
    exposed: { ...(options.exposed ?? {}) },
    privateGoals: [...(options.privateGoals ?? [])],
  });
  return addGenesisInhabitant(state, inhabitant);
}

/** Overwrite one inhabitant wholesale. For constructing invariant violations. */
export function forceInhabitant(state: WorldState, inhabitant: Inhabitant): WorldState {
  return { ...state, inhabitants: { ...state.inhabitants, [inhabitant.id]: inhabitant } };
}

/** The first tile of a given terrain in row-major order, or `null`. */
export function firstTileOf(state: WorldState, terrain: string): Coord | null {
  for (let y = 0; y < state.map.height; y++) {
    for (let x = 0; x < state.map.width; x++) {
      if (state.map.terrain[y * state.map.width + x] === terrain) return { x, y };
    }
  }
  return null;
}

/** Stand an inhabitant on the first tile of `terrain`. Returns `null` if none exists. */
export function standOn(
  state: WorldState,
  id: string,
  terrain: string,
): { readonly state: WorldState; readonly coord: Coord } | null {
  const coord = firstTileOf(state, terrain);
  if (coord === null) return null;
  const inhabitant = state.inhabitants[id];
  /* c8 ignore next */
  if (inhabitant === undefined) return null;
  return {
    state: forceInhabitant(state, {
      ...inhabitant,
      location: coord,
      knownLocations: [`${coord.x},${coord.y}`],
    }),
    coord,
  };
}

export const founderOf = (state: WorldState): Inhabitant => {
  const founder = state.inhabitants["inh_founder"];
  /* c8 ignore next */
  if (founder === undefined) throw new Error("fixture has no founder");
  return founder;
};
