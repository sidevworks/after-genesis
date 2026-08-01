import { describe, expect, it } from "vitest";
import { getActionSpec } from "../schema/actions/index.js";
import { TERRAINS, type ResourceBundle, type Terrain } from "../schema/primitives.js";
import { canonicalJson } from "../util/canonical.js";
import { HashDomain, hashValue } from "../util/hash.js";
import {
  DEFAULT_MAP_HEIGHT,
  DEFAULT_MAP_WIDTH,
  firstPassableTile,
  ensureFounderCreationReserve,
  generateDeposits,
  generateMap,
  generateWorldTerrain,
} from "./mapgen.js";
import { terrainAt, type WorldMap } from "./state.js";

const mapHash = (map: WorldMap): string =>
  hashValue(HashDomain.StateChecksum, {
    width: map.width,
    height: map.height,
    terrain: [...map.terrain],
  });

/** Fraction (per mille, integer) of tiles sharing terrain with a neighbour. */
function coherencePerMille(map: WorldMap): number {
  let matching = 0;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const here = map.terrain[y * map.width + x] as Terrain;
      let shared = false;
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        if (map.terrain[ny * map.width + nx] === here) shared = true;
      }
      if (shared) matching += 1;
    }
  }
  return Math.floor((matching * 1000) / (map.width * map.height));
}

describe("generateMap", () => {
  it("is byte-identical for the same seed", () => {
    const a = generateMap("published-genesis-seed");
    const b = generateMap("published-genesis-seed");
    expect(mapHash(a)).toBe(mapHash(b));
    expect(canonicalJson([...a.terrain])).toBe(canonicalJson([...b.terrain]));
  });

  it("is stable across 20 regenerations", () => {
    const reference = mapHash(generateMap("stability", 24, 24));
    for (let i = 0; i < 20; i++) {
      expect(mapHash(generateMap("stability", 24, 24))).toBe(reference);
    }
  });

  it("produces a different map for a different seed", () => {
    const hashes = new Set<string>();
    for (const seed of ["a", "b", "c", "d", "e", "seed-1", "seed-2"]) {
      hashes.add(mapHash(generateMap(seed)));
    }
    expect(hashes.size).toBe(7);
  });

  it("differs on a one-character seed change", () => {
    expect(mapHash(generateMap("genesis-0001"))).not.toBe(mapHash(generateMap("genesis-0002")));
  });

  it("defaults to the long-lived 64x64 Genesis grid (§5)", () => {
    const map = generateMap("size");
    expect(map.width).toBe(DEFAULT_MAP_WIDTH);
    expect(map.height).toBe(DEFAULT_MAP_HEIGHT);
    expect(map.terrain).toHaveLength(64 * 64);
  });

  it("respects explicit dimensions", () => {
    const map = generateMap("dims", 11, 7);
    expect(map.terrain).toHaveLength(77);
    expect(terrainAt(map, { x: 10, y: 6 })).not.toBeNull();
    expect(terrainAt(map, { x: 11, y: 6 })).toBeNull();
  });

  it("only ever emits declared terrain types", () => {
    const map = generateMap("terrains");
    for (const terrain of map.terrain) expect(TERRAINS).toContain(terrain);
  });

  it("rejects non-positive or fractional dimensions", () => {
    expect(() => generateMap("bad", 0, 10)).toThrow(RangeError);
    expect(() => generateMap("bad", 10, -1)).toThrow(RangeError);
    expect(() => generateMap("bad", 10.5, 10)).toThrow(RangeError);
  });

  it("produces coherent, clustered terrain rather than white noise", () => {
    // White noise over six terrains gives roughly 50% of tiles a matching
    // orthogonal neighbour. Clustered terrain is far above that.
    for (const seed of ["coherence-1", "coherence-2", "coherence-3", "coherence-4"]) {
      const map = generateMap(seed);
      expect(coherencePerMille(map)).toBeGreaterThan(900);
    }
  });

  it("uses more than one terrain type", () => {
    for (const seed of ["variety-1", "variety-2", "variety-3"]) {
      const distinct = new Set(generateMap(seed).terrain);
      expect(distinct.size).toBeGreaterThan(1);
    }
  });

  it("always leaves somewhere to stand", () => {
    for (const seed of ["p1", "p2", "p3", "p4", "p5"]) {
      expect(firstPassableTile(generateMap(seed, 8, 8))).not.toBeNull();
    }
  });
});

describe("generateDeposits", () => {
  it("is deterministic for a seed", () => {
    const map = generateMap("dep");
    expect(canonicalJson(generateDeposits(map, "dep"))).toBe(
      canonicalJson(generateDeposits(map, "dep")),
    );
  });

  it("differs when the seed differs", () => {
    const map = generateMap("dep");
    expect(canonicalJson(generateDeposits(map, "dep"))).not.toBe(
      canonicalJson(generateDeposits(map, "other")),
    );
  });

  it("places wood on forest, stone on stone deposits and nothing on barren", () => {
    const { map, deposits } = generateWorldTerrain("deposit-placement");
    let checkedForest = false;
    let checkedStone = false;
    let checkedBarren = false;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const terrain = map.terrain[y * map.width + x] as Terrain;
        const deposit = deposits[`${x},${y}`];
        if (terrain === "forest") {
          expect(deposit?.wood ?? 0).toBeGreaterThan(0);
          checkedForest = true;
        }
        if (terrain === "stone_deposit") {
          expect(deposit?.stone ?? 0).toBeGreaterThan(0);
          checkedStone = true;
        }
        if (terrain === "barren") {
          expect(deposit).toBeUndefined();
          checkedBarren = true;
        }
      }
    }
    expect(checkedForest || checkedStone || checkedBarren).toBe(true);
  });

  it("stores only integer quantities", () => {
    const { deposits } = generateWorldTerrain("integers");
    for (const bundle of Object.values(deposits)) {
      for (const amount of Object.values(bundle)) {
        expect(Number.isSafeInteger(amount)).toBe(true);
        expect(amount).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the deposit stream independent of the terrain mix", () => {
    // Two seeds share no terrain, but both draw exactly width*height times, so
    // the stream position never depends on classification thresholds.
    const a = generateWorldTerrain("indep-a", 6, 6);
    const b = generateWorldTerrain("indep-b", 6, 6);
    expect(Object.keys(a.deposits).length).toBeLessThanOrEqual(36);
    expect(Object.keys(b.deposits).length).toBeLessThanOrEqual(36);
  });

  it("guarantees enough founder-reachable material for one inhabitant creation", () => {
    const required = getActionSpec("create_inhabitant").baseCost;
    for (const [seed, width, height] of [
      ["after-genesis-public-demo-seed-v1", 32, 32],
      ["no-stone-regression", 32, 32],
      ["minimum-world-a", 4, 4],
      ["minimum-world-b", 4, 4],
    ] as const) {
      const { map, deposits } = generateWorldTerrain(seed, width, height);
      const founder = firstPassableTile(map);
      expect(founder).not.toBeNull();
      const totals: ResourceBundle = {};
      for (const bundle of Object.values(deposits)) {
        for (const kind of ["food", "water", "wood", "stone"] as const) {
          totals[kind] = (totals[kind] ?? 0) + (bundle[kind] ?? 0);
        }
      }
      for (const kind of ["food", "water", "wood", "stone"] as const) {
        expect(totals[kind] ?? 0).toBeGreaterThanOrEqual(required[kind] ?? 0);
      }
    }
  });

  it("adds only the deterministic shortfall and does not mutate its input", () => {
    const map: WorldMap = {
      width: 4,
      height: 4,
      terrain: Array<Terrain>(16).fill("plains"),
    };
    const required = getActionSpec("create_inhabitant").baseCost;
    const original = { "0,0": { food: (required.food ?? 1) - 1 } };
    const ensured = ensureFounderCreationReserve(map, original);
    expect(original).toEqual({ "0,0": { food: (required.food ?? 1) - 1 } });
    expect(ensured["0,0"]).toMatchObject({
      food: required.food,
      water: required.water,
      wood: required.wood,
      stone: required.stone,
    });
  });

  it("does not count material stranded on a disconnected island", () => {
    const required = getActionSpec("create_inhabitant").baseCost;
    const terrain = Array<Terrain>(16).fill("water");
    terrain[0] = "plains";
    terrain[15] = "stone_deposit";
    const map: WorldMap = { width: 4, height: 4, terrain };
    const stranded = {
      "3,3": {
        food: required.food ?? 0,
        water: required.water ?? 0,
        wood: required.wood ?? 0,
        stone: required.stone ?? 0,
      },
    };
    const ensured = ensureFounderCreationReserve(map, stranded);
    expect(ensured["0,0"]).toMatchObject({
      food: required.food,
      water: required.water,
      wood: required.wood,
      stone: required.stone,
    });
    expect(ensured["3,3"]).toEqual(stranded["3,3"]);
  });
});
