import { describe, expect, it } from "vitest";
import { ACTION_TYPES, type ActionType } from "../../schema/action-spec.js";
import { ACTION_CATALOGUE, getActionSpec } from "../../schema/actions/index.js";
import { CONSERVED_RESOURCES, RESOURCE_KINDS } from "../../schema/primitives.js";
import { simTime, type SimTime } from "../../time.js";
import { canonicalJson } from "../../util/canonical.js";
import { checkInvariants, formatViolations } from "../invariants.js";
import {
  depositAt,
  putArtifact,
  putConfinement,
  putStructure,
  recordCreated,
  setDeposit,
  totalHeldResources,
  updateInhabitant,
  type WorldState,
} from "../state.js";
import {
  addTestInhabitant,
  founderOf,
  makeTestWorld,
  passableNear,
  standOn,
} from "../test-support.js";
import {
  BLOCKED_WHILE_CONFINED,
  IMPLEMENTED_ACTIONS,
  RESOLVERS,
  notYetImplemented,
  runAction,
  type ResolutionResult,
} from "./index.js";

const MIDDAY = simTime(12 * 60);

/** A world at midday, so day/night effects are predictable. */
function world(): WorldState {
  return { ...makeTestWorld(), simTime: MIDDAY };
}

function act(
  state: WorldState,
  type: ActionType,
  payload: unknown,
  when: SimTime = state.simTime,
  actorId = "inh_founder",
): ResolutionResult {
  return runAction({
    state,
    actorId,
    action: { type, payload },
    simTime: when,
    sequence: state.sequence + 1,
  });
}

/** The `detail` of a resolved outcome. Fails the test if the action was rejected. */
function detailNumber(result: ResolutionResult, key: string): number {
  const outcome = result.outcome;
  if (outcome.status !== "resolved" && outcome.status !== "partial") {
    throw new Error(`expected a resolved outcome, received ${outcome.status}`);
  }
  const value = outcome.detail[key];
  if (typeof value !== "number") {
    throw new Error(`detail.${key} is ${String(value)}, not a number`);
  }
  return value;
}

const expectClean = (state: WorldState): void => {
  const violations = checkInvariants(state);
  expect(formatViolations(violations)).toBe("");
};

/* ------------------------------------------------------------------------- */
/* Registry completeness                                                      */
/* ------------------------------------------------------------------------- */

describe("resolver registry", () => {
  it("registers a resolver for every declared action type", () => {
    expect(ACTION_TYPES).toHaveLength(65);
    for (const type of ACTION_TYPES) {
      expect(typeof RESOLVERS[type]).toBe("function");
    }
    expect(Object.keys(RESOLVERS).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it("implements the physical slice, neutral public speech, exchange and lineage", () => {
    expect([...IMPLEMENTED_ACTIONS].sort()).toEqual(
      [
        "accept_trade",
        "announce",
        "communicate",
        "consume",
        "copy_artifact",
        "create_artifact",
        "create_currency",
        "create_inhabitant",
        "build",
        "gather",
        "store_goods",
        "guard_location",
        "move",
        "observe",
        "offer_trade",
        "publish",
        "reject_trade",
        "release",
        "rest",
        "restrain",
        "transfer_currency",
        "transfer_property",
        "wait",
      ].sort(),
    );
  });

  // `transfer` resolves but is not offered: it is a narrow early slice of
  // `transfer_property`, kept registered so recorded history still replays.
  it("keeps a resolver for transfer without offering it", () => {
    expect(IMPLEMENTED_ACTIONS).not.toContain("transfer");
    expect(RESOLVERS.transfer).not.toBe(notYetImplemented);
  });

  it("every unimplemented action rejects with NOT_IMPLEMENTED and never fakes success", () => {
    const base = world();
    const unimplemented = ACTION_TYPES.filter(
      (t) => !IMPLEMENTED_ACTIONS.includes(t) && t !== "transfer",
    );
    expect(unimplemented).toHaveLength(41);

    for (const type of unimplemented) {
      expect(RESOLVERS[type]).toBe(notYetImplemented);
      const result = act(base, type, {});
      expect(result.outcome.status).toBe("rejected");
      if (result.outcome.status === "rejected") {
        // Confinement is checked before dispatch, so a blocked action can
        // legitimately reject for that reason instead.
        expect(["NOT_IMPLEMENTED", "CONFINED"]).toContain(result.outcome.code);
      }
      expect(result.events).toHaveLength(0);
    }
  });

  it("takes its activity and interruption metadata from the published catalogue", () => {
    // The engine must not hold a private opinion about what an action is. Each
    // resolved slice action's activity state has to match ACTION_CATALOGUE.
    const state = world();
    const cases: readonly (readonly [ActionType, unknown])[] = [
      ["observe", {}],
      ["rest", { minutes: 60 }],
      ["wait", { minutes: 60 }],
      ["consume", { resource: "food", amount: 1 }],
      ["announce", { message: "I found water.", scope: "local" }],
    ];
    for (const [type, payload] of cases) {
      const result = act(state, type, payload);
      expect(result.outcome.status, type).toBe("resolved");
      const activity = Object.values(result.state.activities).find((a) => a.actionType === type);
      expect(activity?.state, type).toBe(ACTION_CATALOGUE[type].activity);
      expect(activity?.interruption, type).toBe(ACTION_CATALOGUE[type].interruption);
    }
  });

  it("derives confinement restrictions from the catalogue, not a private list", () => {
    for (const type of ACTION_TYPES) {
      expect(BLOCKED_WHILE_CONFINED.has(type)).toBe(!ACTION_CATALOGUE[type].allowedWhileConfined);
    }
    // §11H names these explicitly as restricted.
    for (const blocked of ["move", "gather", "create_inhabitant"] as const) {
      expect(BLOCKED_WHILE_CONFINED.has(blocked)).toBe(true);
    }
    // §11H names these explicitly as retained.
    for (const allowed of ["communicate", "attempt_escape", "appeal_decision"] as const) {
      expect(BLOCKED_WHILE_CONFINED.has(allowed)).toBe(false);
    }
  });

  it("a malformed action leaves physical state untouched and records the failed attempt", () => {
    const before = world();
    const after = act(before, "build", { kind: "hut" }).state;
    const { memories, sequence: _sequence, ...physicalAfter } = after;
    const { memories: _beforeMemories, sequence: _beforeSequence, ...physicalBefore } = before;
    expect(canonicalJson(physicalAfter)).toBe(canonicalJson(physicalBefore));
    expect(Object.values(memories)[0]?.summary).toContain("build payload is malformed");
  });
});

describe("neutral artifacts and transfer", () => {
  it("creates inert authored content, publishes it, and transfers possession atomically", () => {
    let state = world();
    const founder = founderOf(state);
    state = addTestInhabitant(state, {
      id: "inh_receiver",
      location: founder.location,
      inventory: { compute: 100 },
    });

    const created = act(state, "create_artifact", {
      kind: "other",
      title: "Ridge Mark",
      content: "Each mark represents one day of labour.",
      materials: {},
    });
    expect(created.outcome.status).toBe("resolved");
    const artifact = Object.values(created.state.artifacts)[0];
    expect(artifact).toMatchObject({
      title: "Ridge Mark",
      content: "Each mark represents one day of labour.",
      owner: "inh_founder",
      published: false,
    });

    const published = act(
      created.state,
      "publish",
      { artifactId: artifact!.id },
      simTime(MIDDAY + 360),
    );
    expect(published.outcome.status).toBe("resolved");
    expect(published.state.artifacts[artifact!.id]?.published).toBe(true);

    const transferred = act(
      published.state,
      "transfer",
      {
        toInhabitantId: "inh_receiver",
        resources: { food: 2 },
        artifactIds: [artifact!.id],
      },
      simTime(MIDDAY + 400),
    );
    expect(transferred.outcome.status).toBe("resolved");
    expect(transferred.state.artifacts[artifact!.id]?.owner).toBe("inh_receiver");
    expect(transferred.state.inhabitants.inh_receiver?.inventory.food).toBe(2);
    expectClean(transferred.state);
  });
});

/* ------------------------------------------------------------------------- */
/* Shared preconditions                                                       */
/* ------------------------------------------------------------------------- */

describe("runAction preconditions", () => {
  it("rejects an unknown actor", () => {
    const result = act(world(), "wait", {}, MIDDAY, "inh_nobody");
    expect(result.outcome).toMatchObject({ status: "rejected", code: "UNKNOWN_ACTOR" });
  });

  it("rejects a dead actor (§15 inhabitants cannot act after death)", () => {
    let state = world();
    state = updateInhabitant(state, "inh_founder", (i) => ({
      ...i,
      status: "dead",
      deathTime: simTime(0),
      deathSequence: 0,
      nextEligibleTime: simTime(0),
    }));
    const result = act(state, "wait", {});
    expect(result.outcome).toMatchObject({ status: "rejected", code: "DEAD" });
  });

  it("rejects a second action while the first is still running (§11A)", () => {
    const state = world();
    const first = act(state, "rest", { minutes: 120 });
    expect(first.outcome.status).toBe("resolved");
    const second = runAction({
      state: first.state,
      actorId: "inh_founder",
      action: { type: "wait", payload: {} },
      simTime: MIDDAY,
      sequence: first.state.sequence + 1,
    });
    expect(second.outcome).toMatchObject({ status: "rejected", code: "BUSY" });
  });

  it("rejects a turn that would move world time backwards (§15)", () => {
    const state = world();
    const result = runAction({
      state,
      actorId: "inh_founder",
      action: { type: "wait", payload: {} },
      simTime: simTime(60),
      sequence: state.sequence + 1,
    });
    expect(result.outcome).toMatchObject({ status: "rejected", code: "TIME_TRAVEL" });
    expect(result.state).toBe(state);
  });

  it("rejects a stale or replayed sequence number (§15 unique and monotonic)", () => {
    const state = world();
    const result = runAction({
      state,
      actorId: "inh_founder",
      action: { type: "wait", payload: {} },
      simTime: MIDDAY,
      sequence: state.sequence,
    });
    expect(result.outcome).toMatchObject({ status: "rejected", code: "STALE_SEQUENCE" });
    expect(result.state).toBe(state);
  });

  it("blocks a confined inhabitant from moving and gathering but not from resting (§11H)", () => {
    let state = world();
    const founder = founderOf(state);
    state = putStructure(state, {
      id: "str_cell",
      kind: "cell",
      location: founder.location,
      owner: null,
      ownerOrganisation: null,
      integrity: 100,
      capacity: 4,
      storage: {},
      ownershipPublic: true,
      storagePublic: true,
      secured: true,
      occupants: ["inh_founder"],
      createdSequence: 0,
      createdAt: simTime(0),
    });
    state = putConfinement(state, {
      id: "cnf_1",
      subject: "inh_founder",
      imposedBy: ["inh_other"],
      organisation: null,
      structureId: "str_cell",
      startedAt: simTime(0),
      endsAt: simTime(10_000),
      grounds: "dispute",
      upkeepPayer: "inh_founder",
      upkeepPaid: { food: 1 },
      guardMinutes: 120,
      memoryCountAtStart: 0,
      released: false,
      createdSequence: 0,
    });
    state = updateInhabitant(state, "inh_founder", (i) => ({ ...i, confinementId: "cnf_1" }));

    expect(act(state, "move", { to: passableNear(state, { x: 3, y: 3 }) }).outcome).toMatchObject({
      status: "rejected",
      code: "CONFINED",
    });
    expect(act(state, "gather", {}).outcome).toMatchObject({
      status: "rejected",
      code: "CONFINED",
    });
    // §11H: a confined inhabitant retains the ability to think and recover.
    expect(act(state, "rest", { minutes: 60 }).outcome.status).toBe("resolved");
    expect(act(state, "observe", {}).outcome.status).toBe("resolved");
  });

  it("advances the sequence even when the action is rejected", () => {
    const state = world();
    const result = act(state, "move", { to: { x: -1, y: 0 } });
    expect(result.outcome.status).toBe("rejected");
    expect(result.state.sequence).toBe(state.sequence + 1);
  });
});

/* ------------------------------------------------------------------------- */
/* observe                                                                    */
/* ------------------------------------------------------------------------- */

describe("observe", () => {
  it("costs energy and time and records what was in view", () => {
    const state = world();
    const before = founderOf(state).inventory.energy ?? 0;
    const result = act(state, "observe", {});
    expect(result.outcome.status).toBe("resolved");
    const after = founderOf(result.state);
    expect(after.inventory.energy).toBe(before - state.rules.observeEnergyCost);
    expect(after.activity.state).toBe(getActionSpec("observe").activity);
    expect(after.activity.busyUntil).toBe(MIDDAY + state.rules.observeDurationMinutes);
    expect(after.knownLocations.length).toBeGreaterThan(1);
    expectClean(result.state);
  });

  it("emits a private event — one inhabitant's view is not public record (§11E)", () => {
    const result = act(world(), "observe", {});
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.visibility).toEqual({ kind: "private", owner: "inh_founder" });
  });

  it("rejects cleanly when there is no energy to spend", () => {
    let state = world();
    state = updateInhabitant(state, "inh_founder", (i) => ({
      ...i,
      inventory: { ...i.inventory, energy: 0 },
    }));
    expect(act(state, "observe", {}).outcome).toMatchObject({
      status: "rejected",
      code: "INSUFFICIENT_ENERGY",
    });
  });
});

/* ------------------------------------------------------------------------- */
/* move                                                                       */
/* ------------------------------------------------------------------------- */

describe("move", () => {
  it("moves to an adjacent passable tile, spending energy and time", () => {
    const state = world();
    const founder = founderOf(state);
    const target = passableNear(state, { x: founder.location.x + 1, y: founder.location.y });
    const result = act(state, "move", { to: target });
    expect(result.outcome.status).toBe("resolved");
    const after = founderOf(result.state);
    expect(after.location).toEqual(target);
    expect(after.activity.state).toBe("travelling");
    expect(after.activity.busyUntil).toBeGreaterThan(MIDDAY);
    expect(after.inventory.energy ?? 0).toBeLessThan(founder.inventory.energy ?? 0);
    expectClean(result.state);
  });

  it("rejects a malformed payload", () => {
    const state = world();
    for (const payload of [null, 42, "north", [], {}, { to: 5 }, { to: { x: 1 } }, { to: { x: 1.5, y: 0 } }]) {
      expect(act(state, "move", payload).outcome.status).toBe("rejected");
    }
  });

  it("rejects a destination off the map", () => {
    expect(act(world(), "move", { to: { x: 999, y: 999 } }).outcome).toMatchObject({
      status: "rejected",
      code: "OUT_OF_BOUNDS",
    });
  });

  it("rejects water (§5 impassable terrain)", () => {
    const placed = standOn(world(), "inh_founder", "water");
    // Water tiles are never valid standing ground, so instead put the founder
    // beside one and try to walk in.
    const state = world();
    const waterTile = (() => {
      for (let y = 0; y < state.map.height; y++) {
        for (let x = 0; x < state.map.width; x++) {
          if (state.map.terrain[y * state.map.width + x] === "water") return { x, y };
        }
      }
      return null;
    })();
    expect(placed).not.toBeNull();
    if (waterTile === null) return; // this seed produced no water; nothing to assert
    const beside = passableNear(state, waterTile);
    const moved = updateInhabitant(state, "inh_founder", (i) => ({ ...i, location: beside }));
    expect(act(moved, "move", { to: waterTile }).outcome).toMatchObject({
      status: "rejected",
      code: "IMPASSABLE",
    });
  });

  it("rejects moving to where it already stands", () => {
    const state = world();
    expect(act(state, "move", { to: founderOf(state).location }).outcome).toMatchObject({
      status: "rejected",
      code: "ALREADY_THERE",
    });
  });

  it("rejects a destination beyond one move's reach", () => {
    const state = world();
    const founder = founderOf(state);
    const far = {
      x: Math.min(founder.location.x + state.rules.maxMoveDistance + 3, state.map.width - 1),
      y: founder.location.y,
    };
    const result = act(state, "move", { to: far });
    expect(result.outcome.status).toBe("rejected");
    if (result.outcome.status === "rejected") {
      expect(["TOO_FAR", "IMPASSABLE", "OUT_OF_BOUNDS", "NO_ROUTE"]).toContain(result.outcome.code);
    }
  });

  it("rejects when there is not enough energy for the journey", () => {
    let state = world();
    const founder = founderOf(state);
    const target = passableNear(state, { x: founder.location.x + 1, y: founder.location.y });
    state = updateInhabitant(state, "inh_founder", (i) => ({
      ...i,
      inventory: { ...i.inventory, energy: 0 },
    }));
    expect(act(state, "move", { to: target }).outcome).toMatchObject({
      status: "rejected",
      code: "INSUFFICIENT_ENERGY",
    });
  });

  it("takes longer at night than by day (§5 day/night)", () => {
    const day = world();
    const founder = founderOf(day);
    const target = passableNear(day, { x: founder.location.x + 1, y: founder.location.y });
    const dayResult = act(day, "move", { to: target });
    const night: WorldState = { ...day, simTime: simTime(23 * 60) };
    const nightResult = act(night, "move", { to: target }, simTime(23 * 60));

    expect(detailNumber(nightResult, "minutes")).toBeGreaterThan(
      detailNumber(dayResult, "minutes"),
    );
  });

  it("costs more to cross difficult terrain than plains", () => {
    const state = world();
    expect(state.rules.terrainMoveCost.forest).toBeGreaterThan(state.rules.terrainMoveCost.plains);
    expect(state.rules.terrainMoveCost.stone_deposit).toBeGreaterThan(
      state.rules.terrainMoveCost.plains,
    );
  });

  it("never leaves an inhabitant standing on water", () => {
    let state = world();
    for (let i = 0; i < 20; i++) {
      const founder = founderOf(state);
      const target = { x: founder.location.x + 1, y: founder.location.y };
      const result = act(state, "move", { to: target }, simTime(state.simTime + 600));
      state = result.state;
      expectClean(state);
    }
  });
});

/* ------------------------------------------------------------------------- */
/* gather                                                                     */
/* ------------------------------------------------------------------------- */

describe("gather", () => {
  function forestWorld(): WorldState | null {
    const placed = standOn(world(), "inh_founder", "forest");
    return placed === null ? null : placed.state;
  }

  it("takes wood from a forest tile and depletes the deposit by exactly that much", () => {
    const state = forestWorld();
    if (state === null) return;
    const founder = founderOf(state);
    const depositBefore = depositAt(state, founder.location).wood ?? 0;
    expect(depositBefore).toBeGreaterThan(0);

    const result = act(state, "gather", { resource: "wood" });
    expect(result.outcome.status).toBe("resolved");
    const amount = detailNumber(result, "amount");
    const after = founderOf(result.state);

    expect(after.inventory.wood ?? 0).toBe((founder.inventory.wood ?? 0) + amount);
    expect(depositAt(result.state, founder.location).wood ?? 0).toBe(depositBefore - amount);
    expect(after.activity.state).toBe("gathering");
    expectClean(result.state);
  });

  it("conserves resources exactly — a gather moves units, it does not create them", () => {
    const state = forestWorld();
    if (state === null) return;
    const before = totalHeldResources(state);
    const result = act(state, "gather", { resource: "wood" });
    const after = totalHeldResources(result.state);
    for (const kind of RESOURCE_KINDS) {
      if (!CONSERVED_RESOURCES.has(kind)) continue;
      expect(after[kind] ?? 0).toBe(before[kind] ?? 0);
    }
  });

  it("yields more for a skilled gatherer", () => {
    const state = forestWorld();
    if (state === null) return;
    const unskilled = updateInhabitant(state, "inh_founder", (i) => ({ ...i, skills: {} }));
    const skilled = updateInhabitant(state, "inh_founder", (i) => ({
      ...i,
      skills: { gathering: 100 },
    }));
    const a = detailNumber(act(unskilled, "gather", { resource: "wood" }), "amount");
    const b = detailNumber(act(skilled, "gather", { resource: "wood" }), "amount");
    expect(b).toBeGreaterThan(a);
  });

  it("practises the gathering skill", () => {
    const state = forestWorld();
    if (state === null) return;
    let current = updateInhabitant(state, "inh_founder", (i) => ({ ...i, skills: {} }));
    let improved = false;
    for (let i = 0; i < 12; i++) {
      const result = act(current, "gather", { resource: "wood" }, simTime(current.simTime + 600));
      current = result.state;
      if ((founderOf(current).skills.gathering ?? 0) > 0) improved = true;
    }
    expect(improved).toBe(true);
  });

  it("rejects an ungatherable resource", () => {
    const state = forestWorld();
    if (state === null) return;
    expect(act(state, "gather", { resource: "compute" }).outcome).toMatchObject({
      status: "rejected",
      code: "NOT_GATHERABLE",
    });
    expect(act(state, "gather", { resource: "not_a_resource" }).outcome).toMatchObject({
      status: "rejected",
      code: "INVALID_PAYLOAD",
    });
  });

  it("rejects when the tile holds nothing of what was asked for", () => {
    let state = forestWorld();
    if (state === null) return;
    const founder = founderOf(state);
    // Strip every deposit within reach.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        state = setDeposit(state, { x: founder.location.x + dx, y: founder.location.y + dy }, {});
      }
    }
    expect(act(state, "gather", {}).outcome).toMatchObject({
      status: "rejected",
      code: "NOTHING_TO_GATHER",
    });
  });

  it("exhausts a deposit and then refuses to keep producing", () => {
    let state = forestWorld();
    if (state === null) return;
    const founder = founderOf(state);
    state = setDeposit(state, founder.location, { wood: 3 });
    // Clear the neighbourhood so the only source is the tile underfoot.
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        state = setDeposit(state, { x: founder.location.x + dx, y: founder.location.y + dy }, {});
      }
    }
    const first = act(state, "gather", { resource: "wood" });
    expect(first.outcome.status).toBe("resolved");
    expect(depositAt(first.state, founder.location).wood ?? 0).toBe(0);

    const second = act(first.state, "gather", { resource: "wood" }, simTime(first.state.simTime + 600));
    expect(second.outcome).toMatchObject({ status: "rejected", code: "NOTHING_TO_GATHER" });
  });

  it("can draw water from an adjacent water tile without standing in it", () => {
    const state = world();
    let waterTile: { x: number; y: number } | null = null;
    for (let y = 0; y < state.map.height && waterTile === null; y++) {
      for (let x = 0; x < state.map.width; x++) {
        if (state.map.terrain[y * state.map.width + x] === "water") {
          waterTile = { x, y };
          break;
        }
      }
    }
    if (waterTile === null) return;
    const bank = passableNear(state, waterTile);
    if (Math.max(Math.abs(bank.x - waterTile.x), Math.abs(bank.y - waterTile.y)) > 1) return;
    const placed = updateInhabitant(state, "inh_founder", (i) => ({ ...i, location: bank }));
    const result = act(placed, "gather", { resource: "water" });
    expect(result.outcome.status).toBe("resolved");
    expectClean(result.state);
  });

  it("rejects when there is not enough energy", () => {
    let state = forestWorld();
    if (state === null) return;
    state = updateInhabitant(state, "inh_founder", (i) => ({
      ...i,
      inventory: { ...i.inventory, energy: 1 },
    }));
    expect(act(state, "gather", {}).outcome).toMatchObject({
      status: "rejected",
      code: "INSUFFICIENT_ENERGY",
    });
  });
});

/* ------------------------------------------------------------------------- */
/* consume                                                                    */
/* ------------------------------------------------------------------------- */

describe("consume", () => {
  it("eats food, relieves hunger, restores energy and destroys the units (§5 sink)", () => {
    let state = world();
    state = updateInhabitant(state, "inh_founder", (i) => ({
      ...i,
      needs: { ...i.needs, hunger: 60 },
      inventory: { ...i.inventory, energy: 100 },
    }));
    const before = founderOf(state);
    const result = act(state, "consume", { resource: "food", amount: 2 });
    expect(result.outcome.status).toBe("resolved");

    const after = founderOf(result.state);
    expect(after.inventory.food ?? 0).toBe((before.inventory.food ?? 0) - 2);
    expect(after.needs.hunger).toBeLessThan(before.needs.hunger);
    expect(after.inventory.energy ?? 0).toBeGreaterThan(before.inventory.energy ?? 0);
    expect(result.state.ledger.destroyed.food).toBe(2);
    expect(after.activity.state).toBe(getActionSpec("consume").activity);
    expectClean(result.state);
  });

  it("drinking relieves thirst", () => {
    let state = world();
    state = updateInhabitant(state, "inh_founder", (i) => ({
      ...i,
      needs: { ...i.needs, thirst: 80 },
    }));
    const result = act(state, "consume", { resource: "water", amount: 1 });
    expect(result.outcome.status).toBe("resolved");
    expect(founderOf(result.state).needs.thirst).toBeLessThan(80);
  });

  it("refuses to eat what is not food", () => {
    for (const resource of ["wood", "stone", "energy", "compute", "land_use_rights"]) {
      expect(act(world(), "consume", { resource, amount: 1 }).outcome).toMatchObject({
        status: "rejected",
        code: "NOT_CONSUMABLE",
      });
    }
  });

  it("refuses to consume more than is held", () => {
    expect(act(world(), "consume", { resource: "food", amount: 20 }).outcome).toMatchObject({
      status: "rejected",
      code: "INSUFFICIENT_RESOURCES",
    });
  });

  it("rejects a nonsensical amount", () => {
    for (const amount of [0, -1, 1.5, 10_000, "two"]) {
      expect(act(world(), "consume", { resource: "food", amount }).outcome.status).toBe("rejected");
    }
  });

  it("never pushes energy above the cap", () => {
    let state = world();
    state = updateInhabitant(state, "inh_founder", (i) => ({
      ...i,
      inventory: { ...i.inventory, energy: i.maxEnergy },
    }));
    const result = act(state, "consume", { resource: "food", amount: 5 });
    expect(result.outcome.status).toBe("resolved");
    const after = founderOf(result.state);
    expect(after.inventory.energy).toBe(after.maxEnergy);
    expectClean(result.state);
  });
});

/* ------------------------------------------------------------------------- */
/* rest and wait                                                              */
/* ------------------------------------------------------------------------- */

describe("rest", () => {
  it("restores energy, relieves fatigue and occupies the whole period", () => {
    let state = world();
    state = updateInhabitant(state, "inh_founder", (i) => ({
      ...i,
      inventory: { ...i.inventory, energy: 100 },
      needs: { ...i.needs, fatigue: 80 },
    }));
    const result = act(state, "rest", { minutes: 240 });
    expect(result.outcome.status).toBe("resolved");
    const after = founderOf(result.state);
    expect(after.inventory.energy ?? 0).toBeGreaterThan(100);
    expect(after.needs.fatigue).toBeLessThan(80);
    expect(after.activity.state).toBe("sleeping");
    expect(after.activity.busyUntil).toBe(MIDDAY + 240);
    expectClean(result.state);
  });

  it("restores more per minute at night (§5)", () => {
    let day = world();
    day = updateInhabitant(day, "inh_founder", (i) => ({
      ...i,
      inventory: { ...i.inventory, energy: 0 },
    }));
    const night: WorldState = { ...day, simTime: simTime(23 * 60) };
    const dayGain = detailNumber(act(day, "rest", { minutes: 120 }), "energyGained");
    const nightGain = detailNumber(
      act(night, "rest", { minutes: 120 }, simTime(23 * 60)),
      "energyGained",
    );
    expect(nightGain).toBeGreaterThan(dayGain);
  });

  it("uses a default duration when none is given", () => {
    const state = world();
    const result = act(state, "rest", {});
    expect(result.outcome.status).toBe("resolved");
    expect(founderOf(result.state).activity.busyUntil).toBe(MIDDAY + state.rules.restDefaultMinutes);
  });

  it("rejects an out-of-range duration", () => {
    for (const minutes of [0, -60, 100_000, 2.5]) {
      expect(act(world(), "rest", { minutes }).outcome).toMatchObject({
        status: "rejected",
        code: "INVALID_PAYLOAD",
      });
    }
  });

  it("still lets hunger rise while asleep", () => {
    const state = world();
    const result = act(state, "rest", { minutes: 600 });
    expect(founderOf(result.state).needs.hunger).toBeGreaterThan(0);
  });
});

describe("wait", () => {
  it("is not free: it books time and advances needs (§11A)", () => {
    const state = world();
    const result = act(state, "wait", { minutes: 600 });
    expect(result.outcome.status).toBe("resolved");
    const after = founderOf(result.state);
    expect(after.activity.busyUntil).toBe(MIDDAY + 600);
    expect(after.needs.hunger).toBeGreaterThan(0);
    expect(after.needs.thirst).toBeGreaterThan(0);
    expectClean(result.state);
  });

  it("keeps the reported activity state idle", () => {
    const result = act(world(), "wait", { minutes: 30 });
    expect(founderOf(result.state).activity.state).toBe("idle");
    expectClean(result.state);
  });

  it("rejects a bad duration", () => {
    expect(act(world(), "wait", { minutes: -5 }).outcome.status).toBe("rejected");
  });
});

describe("neutral emergent-world actions", () => {
  it("builds only from held material and records a physical structure", () => {
    let state = updateInhabitant(world(), "inh_founder", (inhabitant) => ({
      ...inhabitant,
      inventory: { ...inhabitant.inventory, wood: 5 },
    }));
    state = recordCreated(state, { wood: 5 });
    const location = founderOf(state).location;
    const result = act(state, "build", {
      structureKind: "shelter",
      coord: location,
      name: "Windbreak",
      materials: { wood: 3 },
    });
    expect(result.outcome.status).toBe("resolved");
    expect(Object.values(result.state.structures)[0]).toMatchObject({
      kind: "shelter",
      location,
      owner: "inh_founder",
    });
    expect(founderOf(result.state).inventory.wood).toBe(2);
    expectClean(result.state);
  });

  it("copies readable symbolic content without treating it as true", () => {
    let state = putArtifact(world(), {
      id: "art_source",
      title: "A Claim",
      kind: "written_work",
      creators: ["inh_founder"],
      owner: "inh_founder",
      ownerOrganisation: null,
      contentRef: "",
      content: "The ridge belongs to whoever lights the first fire.",
      published: true,
      provenance: ["inh_founder"],
      revision: 0,
      location: founderOf(world()).location,
      createdSequence: 0,
      createdAt: simTime(0),
    });
    const result = act(state, "copy_artifact", { sourceArtifactId: "art_source" });
    expect(result.outcome.status).toBe("resolved");
    const copy = Object.values(result.state.artifacts).find((artifact) => artifact.id !== "art_source");
    expect(copy).toMatchObject({
      content: "The ridge belongs to whoever lights the first fire.",
      owner: "inh_founder",
      published: false,
    });
    expectClean(result.state);
  });

  it("records restraint as costly conduct and allows a nearby inhabitant to release it", () => {
    let state = world();
    const location = founderOf(state).location;
    state = addTestInhabitant(state, { id: "inh_other", location });
    state = putStructure(state, {
      id: "str_enclosure",
      kind: "enclosure",
      location,
      owner: null,
      ownerOrganisation: null,
      integrity: 100,
      capacity: 2,
      storage: {},
      ownershipPublic: true,
      storagePublic: false,
      secured: true,
      occupants: [],
      createdSequence: 0,
      createdAt: simTime(0),
    });
    const restrained = act(state, "restrain", {
      targetId: "inh_other",
      structureId: "str_enclosure",
      durationMinutes: 120,
      message: "Stay here.",
    });
    expect(restrained.outcome.status).toBe("resolved");
    expect(restrained.state.inhabitants.inh_other?.confinementId).not.toBeNull();
    expect(Object.values(restrained.state.confinements)[0]).toMatchObject({
      grounds: "unspecified",
      imposedBy: ["inh_founder"],
      guardMinutes: 30,
    });
    expectClean(restrained.state);

    const released = act(
      restrained.state,
      "release",
      { targetId: "inh_other", message: "You can leave." },
      simTime(restrained.state.simTime + 30),
      "inh_founder",
    );
    expect(released.outcome.status).toBe("resolved");
    expect(released.state.inhabitants.inh_other?.confinementId).toBeNull();
    expect(Object.values(released.state.confinements)[0]?.released).toBe(true);
    expectClean(released.state);
  });
});

/* ------------------------------------------------------------------------- */
/* Activity lifecycle                                                         */
/* ------------------------------------------------------------------------- */

describe("activity lifecycle (§11A, §11J)", () => {
  it("closes a finished activity and returns the inhabitant to idle", () => {
    const state = world();
    const first = act(state, "rest", { minutes: 120 });
    expect(founderOf(first.state).activity.state).toBe("sleeping");

    const later = simTime(MIDDAY + 120);
    const second = act(first.state, "wait", { minutes: 30 }, later);
    expect(second.outcome.status).toBe("resolved");

    const activities = Object.values(second.state.activities);
    const openCount = activities.filter((a) => a.open).length;
    expect(openCount).toBe(1);
    expectClean(second.state);
  });

  it("never lets one inhabitant hold two open activities", () => {
    let state = world();
    let when = MIDDAY;
    for (let i = 0; i < 15; i++) {
      when = simTime(when + 500);
      state = act(state, "wait", { minutes: 60 }, when).state;
      const open = Object.values(state.activities).filter(
        (a) => a.open && a.participants.includes("inh_founder"),
      );
      expect(open.length).toBeLessThanOrEqual(1);
      expectClean(state);
    }
  });

  it("records every action's participants, location, duration and cost (§11A)", () => {
    const result = act(world(), "observe", {});
    const activity = Object.values(result.state.activities)[0];
    expect(activity).toBeDefined();
    expect(activity?.participants).toEqual(["inh_founder"]);
    expect(activity?.endsAt).toBeGreaterThan(activity?.startedAt ?? 0);
    expect(activity?.actionType).toBe("observe");
    expect(activity?.interruption).toBeTruthy();
  });
});

/* ------------------------------------------------------------------------- */
/* Purity                                                                     */
/* ------------------------------------------------------------------------- */

describe("resolver purity (§15 failed transactions cannot partially alter state)", () => {
  it("does not mutate the input state", () => {
    const state = world();
    const snapshot = canonicalJson(state);
    act(state, "observe", {});
    act(state, "gather", {});
    act(state, "move", { to: { x: 0, y: 0 } });
    act(state, "consume", { resource: "food", amount: 1 });
    act(state, "rest", { minutes: 60 });
    act(state, "wait", { minutes: 60 });
    expect(canonicalJson(state)).toBe(snapshot);
  });

  it("a rejection changes no physical state but is remembered by the actor", () => {
    const state = world();
    const rejected = act(state, "consume", { resource: "food", amount: 9999 });
    expect(rejected.outcome.status).toBe("rejected");
    const { memories, sequence: _sequence, ...physicalAfter } = rejected.state;
    const { memories: _beforeMemories, sequence: _beforeSequence, ...physicalBefore } = state;
    expect(canonicalJson(physicalAfter)).toBe(canonicalJson(physicalBefore));
    expect(Object.values(memories)).toHaveLength(1);
    expect(Object.values(memories)[0]?.summary).toContain("rejected");
  });

  it("produces canonically encodable state and events for every action type", () => {
    const state = world();
    for (const type of ACTION_TYPES) {
      const result = act(state, type, {});
      expect(() => canonicalJson(result.state)).not.toThrow();
      for (const event of result.events) expect(() => canonicalJson(event)).not.toThrow();
    }
  });

  it("no resolver throws on hostile payloads", () => {
    const state = world();
    const hostile: unknown[] = [
      null,
      undefined,
      0,
      -1,
      Number.NaN,
      "",
      "'; DROP TABLE inhabitants; --",
      [],
      [1, 2, 3],
      {},
      { to: { x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER } },
      { resource: "food", amount: Number.MAX_SAFE_INTEGER },
      { minutes: Number.MIN_SAFE_INTEGER },
      { __proto__: { evil: true } },
    ];
    for (const type of ACTION_TYPES) {
      for (const payload of hostile) {
        expect(() => act(state, type, payload)).not.toThrow();
      }
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Multi-inhabitant                                                           */
/* ------------------------------------------------------------------------- */

describe("multiple inhabitants", () => {
  it("each acts on its own clock without disturbing the other", () => {
    let state = world();
    const founder = founderOf(state);
    state = addTestInhabitant(state, {
      id: "inh_second",
      location: passableNear(state, { x: founder.location.x + 1, y: founder.location.y }),
    });

    const a = act(state, "rest", { minutes: 120 });
    const b = runAction({
      state: a.state,
      actorId: "inh_second",
      action: { type: "wait", payload: { minutes: 60 } },
      simTime: MIDDAY,
      sequence: a.state.sequence + 1,
    });
    expect(b.outcome.status).toBe("resolved");
    expect(a.state.inhabitants["inh_founder"]?.activity.state).toBe("sleeping");
    expect(b.state.inhabitants["inh_second"]?.activity.state).toBe("idle");
    expectClean(b.state);
  });
});
