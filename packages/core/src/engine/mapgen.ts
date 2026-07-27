/**
 * Deterministic terrain generation (§5).
 *
 * "Every map must be deterministically generated from a published Genesis
 * seed." The seed is public, so anybody can regenerate the map and confirm the
 * world was not hand-placed to favour a particular outcome. That makes this file
 * part of the audit surface, not a convenience.
 *
 * The generator produces *coherent* terrain rather than white noise, because a
 * per-tile independent roll would make travel, settlement and territory
 * meaningless — every tile would be adjacent to every terrain type and no
 * location would be worth more than another. Coherence comes from two layers of
 * fractal value noise (elevation and moisture) followed by a majority-vote
 * cellular-automaton smoothing pass.
 *
 * Every intermediate value is an integer. The only division is `Math.trunc(a/b)`
 * over small safe integers, where the IEEE-754 result is exact and the
 * truncation is fully specified — no platform-dependent rounding can occur.
 *
 * CONSTITUTIONAL: the algorithm and its constants are fixed at Genesis (§23).
 */
import type { Coord, ResourceBundle, Terrain } from "../schema/primitives.js";
import { coordKey } from "../schema/primitives.js";
import { Rng } from "../util/rng.js";
import type { DepositMap, WorldMap } from "./state.js";
import { idiv } from "./state.js";

export const DEFAULT_MAP_WIDTH = 32;
export const DEFAULT_MAP_HEIGHT = 32;

/** Noise values live in 0..`NOISE_MAX`. */
const NOISE_MAX = 255;

/**
 * Octaves as (cell size in tiles, weight). Large cells give continents; small
 * cells give texture. Weights are integers so the blend needs no float.
 */
const OCTAVES: readonly (readonly [number, number])[] = [
  [16, 8],
  [8, 4],
  [4, 2],
];
const OCTAVE_WEIGHT_TOTAL = OCTAVES.reduce((sum, [, w]) => sum + w, 0);

/** Classification thresholds against elevation `e` and moisture `m`, 0..255. */
const SEA_LEVEL = 62;
const MOUNTAIN_LEVEL = 200;
const FOREST_MOISTURE = 160;
const FOREST_MAX_ELEVATION = 170;
const FERTILE_MOISTURE = 118;
const BARREN_MOISTURE = 72;

/** Passes of majority smoothing. Two is enough to erase single-tile speckle. */
const SMOOTHING_PASSES = 2;
/** A tile adopts a neighbouring terrain only with at least this many votes. */
const SMOOTHING_MAJORITY = 5;

/**
 * A fixed neighbour order. Iteration order must never depend on anything but
 * this constant, or two runs could break a tie differently (law 5).
 */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/** Terrain order used for deterministic tie-breaking in the smoothing pass. */
const TERRAIN_ORDER: readonly Terrain[] = [
  "water",
  "barren",
  "plains",
  "fertile",
  "forest",
  "stone_deposit",
];

/**
 * A lattice of random integer corner values for one octave.
 *
 * Values are drawn in a fixed row-major order from a stream derived for
 * (seed, field, cellSize), so adding a third octave later cannot shift the
 * numbers the first two see.
 */
function makeLattice(
  seed: string,
  field: string,
  cellSize: number,
  width: number,
  height: number,
): { readonly cols: number; readonly values: readonly number[] } {
  const cols = idiv(width - 1, cellSize) + 2;
  const rows = idiv(height - 1, cellSize) + 2;
  const rng = Rng.derive(seed, "mapgen", field, `cell${cellSize}`);
  const values: number[] = [];
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) values.push(rng.nextBelow(NOISE_MAX + 1));
  }
  return { cols, values };
}

/**
 * Integer smoothstep: maps `f` in [0, size] to [0, size] with zero slope at both
 * ends, so octaves blend without visible lattice seams.
 *
 * `3f²·size - 2f³` divided by `size²`. With size <= 16 and f <= 16 the largest
 * intermediate is 3·16²·16 = 12288, exact in a double.
 */
function smoothStep(f: number, size: number): number {
  return idiv(3 * f * f * size - 2 * f * f * f, size * size);
}

function lerp(a: number, b: number, weight: number, size: number): number {
  return a + idiv((b - a) * weight, size);
}

/** One octave of value noise sampled at a tile. */
function sampleOctave(
  lattice: { readonly cols: number; readonly values: readonly number[] },
  cellSize: number,
  x: number,
  y: number,
): number {
  const gx = idiv(x, cellSize);
  const gy = idiv(y, cellSize);
  const fx = x - gx * cellSize;
  const fy = y - gy * cellSize;
  const i = (cx: number, cy: number): number => lattice.values[cy * lattice.cols + cx] ?? 0;
  const v00 = i(gx, gy);
  const v10 = i(gx + 1, gy);
  const v01 = i(gx, gy + 1);
  const v11 = i(gx + 1, gy + 1);
  const wx = smoothStep(fx, cellSize);
  const wy = smoothStep(fy, cellSize);
  const top = lerp(v00, v10, wx, cellSize);
  const bottom = lerp(v01, v11, wx, cellSize);
  return lerp(top, bottom, wy, cellSize);
}

/** A full fractal field, one integer 0..255 per tile, row-major. */
function fractalField(seed: string, field: string, width: number, height: number): number[] {
  const lattices = OCTAVES.map(([cellSize]) =>
    makeLattice(seed, field, cellSize, width, height),
  );
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let o = 0; o < OCTAVES.length; o++) {
        const octave = OCTAVES[o] as readonly [number, number];
        const lattice = lattices[o];
        /* c8 ignore next */
        if (lattice === undefined) continue;
        sum += sampleOctave(lattice, octave[0], x, y) * octave[1];
      }
      out.push(idiv(sum, OCTAVE_WEIGHT_TOTAL));
    }
  }
  return out;
}

/**
 * Classify one tile.
 *
 * Order matters: water is decided first because elevation dominates, then
 * mountains, then the moisture bands. The result is contiguous lakes, wooded
 * belts on the wet side of high ground, and deserts in the dry lowlands.
 */
function classify(elevation: number, moisture: number): Terrain {
  if (elevation < SEA_LEVEL) return "water";
  if (elevation >= MOUNTAIN_LEVEL) return "stone_deposit";
  if (moisture >= FOREST_MOISTURE && elevation < FOREST_MAX_ELEVATION) return "forest";
  if (moisture >= FERTILE_MOISTURE) return "fertile";
  if (moisture < BARREN_MOISTURE) return "barren";
  return "plains";
}

/**
 * Majority smoothing. A tile surrounded by at least `SMOOTHING_MAJORITY`
 * neighbours of one other terrain adopts it. Ties break by `TERRAIN_ORDER`, so
 * the pass is a pure function of its input.
 */
function smooth(terrain: readonly Terrain[], width: number, height: number): Terrain[] {
  const out: Terrain[] = [...terrain];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const votes = new Map<Terrain, number>();
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const t = terrain[ny * width + nx] as Terrain;
        votes.set(t, (votes.get(t) ?? 0) + 1);
      }
      let best: Terrain | null = null;
      let bestVotes = 0;
      // Iterate TERRAIN_ORDER, not the Map, so key insertion order is irrelevant.
      for (const candidate of TERRAIN_ORDER) {
        const count = votes.get(candidate) ?? 0;
        if (count > bestVotes) {
          bestVotes = count;
          best = candidate;
        }
      }
      if (best !== null && bestVotes >= SMOOTHING_MAJORITY) out[y * width + x] = best;
    }
  }
  return out;
}

/**
 * Generate a map from a published seed.
 *
 * The same `(seed, width, height)` always produces a byte-identical grid, on
 * every machine and every Node version.
 */
export function generateMap(
  seed: string,
  width: number = DEFAULT_MAP_WIDTH,
  height: number = DEFAULT_MAP_HEIGHT,
): WorldMap {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError(`map width must be a positive safe integer, received ${width}`);
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError(`map height must be a positive safe integer, received ${height}`);
  }

  const elevation = fractalField(seed, "elevation", width, height);
  const moisture = fractalField(seed, "moisture", width, height);

  let terrain: Terrain[] = [];
  for (let index = 0; index < width * height; index++) {
    terrain.push(classify(elevation[index] ?? 0, moisture[index] ?? 0));
  }
  for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
    terrain = smooth(terrain, width, height);
  }

  // A world with nowhere to stand is not a world. If the noise happens to
  // flood everything, the lowest-index tile becomes plains. Deterministic, and
  // recorded here rather than hidden in a retry loop with a different seed.
  if (!terrain.some((t) => t !== "water")) terrain[0] = "plains";

  return { width, height, terrain: Object.freeze(terrain) };
}

/**
 * Base deposit size per terrain, before the per-tile roll.
 *
 * Deposits are the world's finite stock, not a spawner: gathering moves units
 * out of a deposit and into an inventory, conserving the total (see
 * `ResourceLedger`). When a tile is exhausted it stays exhausted unless a
 * declared regeneration rule is added — which would be a constitutional change.
 */
const DEPOSIT_TABLE: Readonly<Record<Terrain, { readonly kind: keyof ResourceBundle | null; readonly base: number; readonly spread: number }>> =
  Object.freeze({
    forest: { kind: "wood", base: 40, spread: 40 },
    stone_deposit: { kind: "stone", base: 40, spread: 40 },
    water: { kind: "water", base: 200, spread: 100 },
    fertile: { kind: "food", base: 30, spread: 30 },
    plains: { kind: "food", base: 8, spread: 8 },
    barren: { kind: null, base: 0, spread: 0 },
  });

/**
 * Generate the initial deposits for a map.
 *
 * Kept separate from `generateMap` because §5 requires terrain to be stored
 * separately from everything that occupies it: terrain never changes, deposits
 * deplete.
 */
export function generateDeposits(map: WorldMap, seed: string): DepositMap {
  const rng = Rng.derive(seed, "mapgen", "deposits");
  const out: Record<string, ResourceBundle> = {};
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const terrain = map.terrain[y * map.width + x] as Terrain;
      const entry = DEPOSIT_TABLE[terrain];
      // The roll happens for every tile, including barren ones, so that the
      // stream position depends only on the grid size — never on the terrain
      // mix, which would couple this stream to the classification thresholds.
      const roll = rng.nextBelow(entry.spread + 1);
      if (entry.kind === null) continue;
      const amount = entry.base + roll;
      if (amount <= 0) continue;
      out[coordKey({ x, y })] = { [entry.kind]: amount };
    }
  }
  return out;
}

/** Which resource a tile of this terrain yields when gathered, if any. */
export function terrainYields(terrain: Terrain): keyof ResourceBundle | null {
  return DEPOSIT_TABLE[terrain].kind;
}

/** Convenience for tests and the Genesis command. */
export function generateWorldTerrain(
  seed: string,
  width: number = DEFAULT_MAP_WIDTH,
  height: number = DEFAULT_MAP_HEIGHT,
): { readonly map: WorldMap; readonly deposits: DepositMap } {
  const map = generateMap(seed, width, height);
  return { map, deposits: generateDeposits(map, seed) };
}

/**
 * The first passable tile in row-major order, or `null` if none exists.
 * Used by Genesis to place the founder without a random draw.
 */
export function firstPassableTile(map: WorldMap): Coord | null {
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.terrain[y * map.width + x] !== "water") return { x, y };
    }
  }
  /* c8 ignore next */
  return null;
}
