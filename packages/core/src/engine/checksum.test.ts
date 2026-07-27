import { describe, expect, it } from "vitest";
import { simTime } from "../time.js";
import { canonicalJson } from "../util/canonical.js";
import { computeStateChecksum, normaliseState } from "./checksum.js";
import { generateWorldTerrain } from "./mapgen.js";
import {
  addGenesisInhabitant,
  createWorldState,
  makeInhabitant,
  putInhabitant,
  setDeposit,
  withForensics,
  type WorldState,
} from "./state.js";
import { addTestInhabitant, founderOf, makeTestWorld, passableNear } from "./test-support.js";

const { map, deposits } = generateWorldTerrain("checksum-seed", 8, 8);

function emptyWorld(): WorldState {
  return createWorldState({ worldId: "w", seed: "checksum-seed", map, deposits });
}

function person(id: string, x: number, y: number) {
  return makeInhabitant({
    id,
    displayName: id,
    location: { x, y },
    birthTime: simTime(0),
    creationSequence: 0,
    inventory: { food: 3, energy: 100 },
  });
}

describe("computeStateChecksum", () => {
  it("is stable across repeated computation", () => {
    const state = makeTestWorld();
    const first = computeStateChecksum(state);
    for (let i = 0; i < 5; i++) expect(computeStateChecksum(state)).toBe(first);
  });

  it("is a lowercase 64-character hex digest", () => {
    expect(computeStateChecksum(makeTestWorld())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on the order inhabitants were inserted", () => {
    const a = putInhabitant(
      putInhabitant(putInhabitant(emptyWorld(), person("inh_a", 0, 0)), person("inh_b", 1, 0)),
      person("inh_c", 2, 0),
    );
    const b = putInhabitant(
      putInhabitant(putInhabitant(emptyWorld(), person("inh_c", 2, 0)), person("inh_a", 0, 0)),
      person("inh_b", 1, 0),
    );
    expect(Object.keys(a.inhabitants)).not.toEqual(Object.keys(b.inhabitants));
    expect(computeStateChecksum(a)).toBe(computeStateChecksum(b));
  });

  it("does not depend on the order deposits were written", () => {
    const base = emptyWorld();
    const a = setDeposit(setDeposit(base, { x: 1, y: 1 }, { wood: 5 }), { x: 2, y: 2 }, { stone: 7 });
    const b = setDeposit(setDeposit(base, { x: 2, y: 2 }, { stone: 7 }), { x: 1, y: 1 }, { wood: 5 });
    expect(computeStateChecksum(a)).toBe(computeStateChecksum(b));
  });

  it("does not depend on the property order inside an inhabitant", () => {
    const forwards = person("inh_a", 0, 0);
    // Rebuild the same inhabitant with keys assigned in reverse order.
    const reversed = Object.fromEntries(
      Object.entries(forwards).reverse(),
    ) as typeof forwards;
    const a = putInhabitant(emptyWorld(), forwards);
    const b = putInhabitant(emptyWorld(), reversed);
    expect(computeStateChecksum(a)).toBe(computeStateChecksum(b));
  });

  it("does not depend on the order of unordered arrays", () => {
    const base = person("inh_a", 0, 0);
    const a = putInhabitant(emptyWorld(), {
      ...base,
      knownLocations: ["0,0", "1,1", "2,2"],
      parents: [],
    });
    const b = putInhabitant(emptyWorld(), {
      ...base,
      knownLocations: ["2,2", "0,0", "1,1"],
      parents: [],
    });
    expect(computeStateChecksum(a)).toBe(computeStateChecksum(b));
  });

  it("treats a zero-valued bundle entry as absent", () => {
    const a = putInhabitant(emptyWorld(), { ...person("inh_a", 0, 0), inventory: { food: 3, energy: 100 } });
    const b = putInhabitant(emptyWorld(), {
      ...person("inh_a", 0, 0),
      inventory: { food: 3, energy: 100, wood: 0, stone: 0 },
    });
    expect(computeStateChecksum(a)).toBe(computeStateChecksum(b));
  });

  it("EXCLUDES forensics: wall-clock and event hashes cannot change the world", () => {
    const state = makeTestWorld();
    const stamped = withForensics(state, {
      lastRealTimestamp: "2026-07-28T00:00:00.000Z",
      lastEventHash: "ab".repeat(32),
    });
    expect(computeStateChecksum(stamped)).toBe(computeStateChecksum(state));
    expect(canonicalJson(normaliseState(stamped))).not.toContain("2026-07-28");
  });

  describe("material changes always move the checksum", () => {
    const base = makeTestWorld();
    const before = computeStateChecksum(base);

    const mutations: readonly (readonly [string, (s: WorldState) => WorldState])[] = [
      ["simTime", (s) => ({ ...s, simTime: simTime(60) })],
      ["sequence", (s) => ({ ...s, sequence: s.sequence + 1 })],
      ["worldId", (s) => ({ ...s, worldId: "other" })],
      ["seed", (s) => ({ ...s, seed: "other" })],
      [
        "a single inventory unit",
        (s) =>
          putInhabitant(s, {
            ...founderOf(s),
            inventory: { ...founderOf(s).inventory, food: (founderOf(s).inventory.food ?? 0) + 1 },
          }),
      ],
      [
        "a location",
        (s) => putInhabitant(s, { ...founderOf(s), location: passableNear(s, { x: 5, y: 5 }) }),
      ],
      [
        "a need",
        (s) =>
          putInhabitant(s, { ...founderOf(s), needs: { ...founderOf(s).needs, hunger: 1 } }),
      ],
      ["a deposit", (s) => setDeposit(s, { x: 0, y: 0 }, { wood: 1 })],
      ["a new inhabitant", (s) => addTestInhabitant(s, { id: "inh_x", location: founderOf(s).location })],
      [
        "one terrain tile",
        (s) => ({
          ...s,
          map: {
            ...s.map,
            terrain: s.map.terrain.map((t, i) =>
              i === 0 ? (t === "fertile" ? ("forest" as const) : ("fertile" as const)) : t,
            ),
          },
        }),
      ],
      ["the ledger", (s) => ({ ...s, ledger: { ...s.ledger, destroyed: { food: 1 } } })],
      ["the rules checksum", (s) => ({ ...s, rulesChecksum: computeStateChecksum(s) })],
    ];

    for (const [label, mutate] of mutations) {
      it(`changing ${label} changes the checksum`, () => {
        expect(computeStateChecksum(mutate(base))).not.toBe(before);
      });
    }
  });

  it("gives two worlds built by different routes the same checksum", () => {
    const founder = makeInhabitant({
      id: "inh_founder",
      displayName: "Founder",
      location: { x: 0, y: 0 },
      birthTime: simTime(0),
      creationSequence: 0,
      inventory: { food: 1 },
    });
    const other = makeInhabitant({
      id: "inh_other",
      displayName: "Other",
      location: { x: 1, y: 0 },
      birthTime: simTime(0),
      creationSequence: 0,
      inventory: { water: 2 },
    });
    const forwards = addGenesisInhabitant(addGenesisInhabitant(emptyWorld(), founder), other);
    const backwards = addGenesisInhabitant(addGenesisInhabitant(emptyWorld(), other), founder);
    expect(computeStateChecksum(forwards)).toBe(computeStateChecksum(backwards));
  });

  it("normaliseState round-trips through canonical JSON", () => {
    expect(() => canonicalJson(normaliseState(makeTestWorld()))).not.toThrow();
  });
});
