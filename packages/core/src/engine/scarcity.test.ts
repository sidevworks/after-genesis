/**
 * Scarcity and construction (§5, §11A).
 *
 * These tests exist because of a specific failure. A hundred simulated days of
 * autonomous life produced an inhabitant carrying 681 food and 164 wood, which
 * it had gathered, could not use, could not lose, and had no reason to store,
 * protect, trade or build anything for. Nothing in the world was scarce except
 * time, and a structure — the one thing `build` produced — was written into
 * state and then read by no code at all.
 *
 * So four properties are asserted here:
 *
 *  1. A pack has a bottom. Gathering stops at it.
 *  2. Carried food spoils, so a surplus is not free to hold.
 *  3. A structure holds goods, and reaching one requires standing on it.
 *  4. A shelter changes what an hour of sleep is worth.
 *
 * Each is a reason to build something. None of them tells an inhabitant to.
 */
import { describe, expect, it } from "vitest";
import { simTime, type SimTime } from "../time.js";
import { checkInvariants, formatViolations } from "./invariants.js";
import { runAction, type ResolutionResult } from "./resolvers/index.js";
import { spoilCarriedFood } from "./resolvers/effects.js";
import { storageCapacityFor } from "./resolvers/physical.js";
import {
  putStructure,
  recordCreated,
  totalHeldResources,
  updateInhabitant,
  type WorldState,
} from "./state.js";
import { founderOf, makeTestWorld, standOn } from "./test-support.js";
import type { ResourceBundle } from "../schema/primitives.js";

const MIDDAY = simTime(12 * 60);

/**
 * A world whose founder carries exactly what the caller says.
 *
 * `makeTestWorld` hands out 10 food and 10 water by default; these tests count
 * carried material to the unit, so the default is cleared rather than merged.
 */
function world(inventory: ResourceBundle = {}): WorldState {
  return {
    ...makeTestWorld({
      founderInventory: { energy: 1000, compute: 1000, food: 0, water: 0, ...inventory },
    }),
    simTime: MIDDAY,
  };
}

function act(
  state: WorldState,
  type: Parameters<typeof runAction>[0]["action"]["type"],
  payload: unknown,
  when: SimTime = state.simTime,
): ResolutionResult {
  return runAction({
    state,
    actorId: "inh_founder",
    action: { type, payload },
    simTime: when,
    sequence: state.sequence + 1,
  });
}

const expectClean = (state: WorldState): void => {
  expect(formatViolations(checkInvariants(state))).toBe("");
};

/** Put a store on the founder's tile, declared in the ledger like Genesis does. */
function storeHere(state: WorldState, storage: ResourceBundle, capacity = 4000): WorldState {
  const founder = founderOf(state);
  const placed = putStructure(state, {
    id: "str_store",
    kind: "storehouse",
    location: { ...founder.location },
    owner: founder.id,
    ownerOrganisation: null,
    integrity: 100,
    capacity,
    storage: { ...storage },
    ownershipPublic: true,
    storagePublic: false,
    secured: false,
    occupants: [],
    createdSequence: 0,
    createdAt: state.simTime,
  });
  return recordCreated(placed, storage);
}

/* ------------------------------------------------------------------------- */
/* Carrying capacity                                                          */
/* ------------------------------------------------------------------------- */

describe("a pack has a bottom (§5 storage capacity)", () => {
  it("refuses to gather into a full pack", () => {
    const base = world();
    const capacity = base.rules.carryCapacity;
    const full = updateInhabitant(base, "inh_founder", (i) => ({
      ...i,
      inventory: { ...i.inventory, wood: capacity },
    }));
    const stocked = recordCreated(full, { wood: capacity });
    const placed = standOn(stocked, "inh_founder", "forest");
    expect(placed).not.toBeNull();

    const result = act(placed!.state, "gather", { resource: "wood" });
    expect(result.outcome.status).toBe("rejected");
    expectClean(result.state);
  });

  it("clamps a gather to what still fits rather than overflowing", () => {
    // Started just under the ceiling, so the next yield is larger than the room
    // left for it. The take is trimmed to the gap, not refused and not rounded up.
    // Set through `founderInventory`, so Genesis already declares it; a second
    // `recordCreated` here would double-count and break conservation.
    const nearlyFull = world({ wood: 145 });
    const placed = standOn(nearlyFull, "inh_founder", "forest");
    expect(placed).not.toBeNull();

    const result = act(placed!.state, "gather", { resource: "wood" });
    expect(result.outcome.status).toBe("resolved");
    const carried = founderOf(result.state).inventory.wood ?? 0;
    expect(carried).toBeGreaterThan(145);
    expect(carried).toBeLessThanOrEqual(result.state.rules.carryCapacity);
    expectClean(result.state);
  });
});

/* ------------------------------------------------------------------------- */
/* Spoilage                                                                   */
/* ------------------------------------------------------------------------- */

describe("carried food spoils (§5 declared sinks)", () => {
  it("takes a fraction of a hoard and none of a small stock", () => {
    const base = world({ food: 100 });
    const small = updateInhabitant(base, "inh_founder", (i) => ({
      ...i,
      inventory: { ...i.inventory, food: 10 },
    }));
    const interval = base.rules.minutesPerFoodSpoil;

    const hoard = spoilCarriedFood(base, simTime(0), simTime(interval));
    expect(hoard.destroyed.food).toBe(100 - (100 - Math.trunc(100 / base.rules.foodSpoilDivisor)));

    // Ten is below the divisor, so integer division takes nothing at all.
    const modest = spoilCarriedFood(small, simTime(0), simTime(interval));
    expect(modest.destroyed.food ?? 0).toBe(0);
  });

  it("records the loss as destruction so conservation still balances", () => {
    const base = world({ food: 100 });
    const heldBefore = totalHeldResources(base).food ?? 0;
    const after = spoilCarriedFood(base, simTime(0), simTime(base.rules.minutesPerFoodSpoil));
    const heldAfter = totalHeldResources(after.state).food ?? 0;

    expect(heldAfter).toBeLessThan(heldBefore);
    expect(after.state.ledger.destroyed.food ?? 0).toBe(heldBefore - heldAfter);
    expectClean(after.state);
  });

  it("does nothing when no interval boundary was crossed", () => {
    const base = world({ food: 100 });
    const after = spoilCarriedFood(base, simTime(0), simTime(10));
    expect(after.state).toBe(base);
  });

  it("is a pure function of the two times, so replay agrees", () => {
    const base = world({ food: 500 });
    const window = simTime(base.rules.minutesPerFoodSpoil * 3);
    const a = spoilCarriedFood(base, simTime(0), window);
    const b = spoilCarriedFood(base, simTime(0), window);
    expect(a.destroyed).toEqual(b.destroyed);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it("leaves stored food alone — that is what a store is for", () => {
    const stocked = storeHere(world(), { food: 2000 });
    const after = spoilCarriedFood(stocked, simTime(0), simTime(stocked.rules.minutesPerFoodSpoil * 5));
    expect(after.state.structures["str_store"]?.storage.food).toBe(2000);
    expect(after.destroyed.food ?? 0).toBe(0);
  });
});

/* ------------------------------------------------------------------------- */
/* store_goods                                                                */
/* ------------------------------------------------------------------------- */

describe("store_goods moves goods between a pack and a structure", () => {
  it("deposits, and the goods leave the pack without leaving the world", () => {
    const base = storeHere(world({ food: 100 }), {});
    const heldBefore = totalHeldResources(base).food ?? 0;

    const result = act(base, "store_goods", {
      structureId: "str_store",
      direction: "deposit",
      resources: { food: 80 },
    });
    expect(result.outcome.status).toBe("resolved");
    expect(founderOf(result.state).inventory.food ?? 0).toBe(20);
    expect(result.state.structures["str_store"]?.storage.food).toBe(80);
    // Conservation: moved, not created or destroyed.
    expect(totalHeldResources(result.state).food ?? 0).toBe(heldBefore);
    expectClean(result.state);
  });

  it("withdraws, and refuses a withdrawal that would overfill the pack", () => {
    const base = storeHere(world(), { food: 2000 });
    const tooMuch = act(base, "store_goods", {
      structureId: "str_store",
      direction: "withdraw",
      resources: { food: base.rules.carryCapacity + 1 },
    });
    expect(tooMuch.outcome.status).toBe("rejected");

    const fine = act(base, "store_goods", {
      structureId: "str_store",
      direction: "withdraw",
      resources: { food: 50 },
    });
    expect(fine.outcome.status).toBe("resolved");
    expect(founderOf(fine.state).inventory.food ?? 0).toBe(50);
    expectClean(fine.state);
  });

  it("refuses to reach a store the inhabitant is not standing on", () => {
    const base = storeHere(world({ food: 50 }), {});
    const founder = founderOf(base);
    const moved = putStructure(base, {
      ...base.structures["str_store"]!,
      location: { x: founder.location.x + 3, y: founder.location.y },
    });
    const result = act(moved, "store_goods", {
      structureId: "str_store",
      direction: "deposit",
      resources: { food: 10 },
    });
    expect(result.outcome.status).toBe("rejected");
  });

  it("refuses to exceed the structure's capacity", () => {
    const base = storeHere(world({ food: 100 }), {}, 10);
    const result = act(base, "store_goods", {
      structureId: "str_store",
      direction: "deposit",
      resources: { food: 100 },
    });
    expect(result.outcome.status).toBe("rejected");
  });

  it("refuses to pour energy into a building", () => {
    const base = storeHere(world(), {});
    const result = act(base, "store_goods", {
      structureId: "str_store",
      direction: "deposit",
      resources: { energy: 10 },
    });
    expect(result.outcome.status).toBe("rejected");
  });
});

/* ------------------------------------------------------------------------- */
/* Structures do something                                                    */
/* ------------------------------------------------------------------------- */

describe("a built structure has mechanical consequences", () => {
  it("gives a storehouse far more capacity than a wall", () => {
    expect(storageCapacityFor("storehouse", 100)).toBeGreaterThan(
      storageCapacityFor("hall", 100),
    );
    expect(storageCapacityFor("wall", 100)).toBe(0);
    // The old ceiling of 32 was below one inhabitant's carrying capacity, which
    // made every structure too small to be worth the walk.
    expect(storageCapacityFor("storehouse", 100)).toBeGreaterThan(150);
  });

  it("makes an hour of sleep under a shelter worth more than one in the open", () => {
    const open = world({ energy: 0 });
    const founder = founderOf(open);
    const roofed = putStructure(open, {
      id: "str_shelter",
      kind: "shelter",
      location: { ...founder.location },
      owner: founder.id,
      ownerOrganisation: null,
      integrity: 100,
      capacity: 40,
      storage: {},
      ownershipPublic: true,
      storagePublic: false,
      secured: false,
      occupants: [],
      createdSequence: 0,
      createdAt: open.simTime,
    });

    const inTheOpen = act(open, "rest", { minutes: 120 });
    const underCover = act(roofed, "rest", { minutes: 120 });
    const gainedOpen = inTheOpen.state.inhabitants["inh_founder"]?.inventory.energy ?? 0;
    const gainedRoofed = underCover.state.inhabitants["inh_founder"]?.inventory.energy ?? 0;

    expect(gainedRoofed).toBeGreaterThan(gainedOpen);
    expect(gainedRoofed).toBe(gainedOpen * open.rules.shelterRestMultiplier);
  });

  it("gets nothing from a ruined shelter", () => {
    const open = world({ energy: 0 });
    const founder = founderOf(open);
    const ruin = putStructure(open, {
      id: "str_ruin",
      kind: "shelter",
      location: { ...founder.location },
      owner: founder.id,
      ownerOrganisation: null,
      integrity: 0,
      capacity: 40,
      storage: {},
      ownershipPublic: true,
      storagePublic: false,
      secured: false,
      occupants: [],
      createdSequence: 0,
      createdAt: open.simTime,
    });
    const a = act(open, "rest", { minutes: 120 });
    const b = act(ruin, "rest", { minutes: 120 });
    expect(b.state.inhabitants["inh_founder"]?.inventory.energy).toBe(
      a.state.inhabitants["inh_founder"]?.inventory.energy,
    );
  });
});
