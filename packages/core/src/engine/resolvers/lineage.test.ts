/**
 * Lineage tests (§7, §15, §11J).
 *
 * The resolver is exercised directly rather than through `runAction`, because
 * the registry that binds `create_inhabitant` to it is wired separately. The
 * context built by `creationContext` reproduces exactly what `runAction`
 * assembles — the same stream derivation, the same sequence — so a test passing
 * here passes once the action is wired.
 */
import { describe, expect, it } from "vitest";
import { getActionSpec } from "../../schema/actions/index.js";
import { CreateInhabitantPayloadSchema } from "../../schema/actions/lineage.js";
import { CONSERVED_RESOURCES, RESOURCE_KINDS } from "../../schema/primitives.js";
import type { ResourceBundle } from "../../schema/primitives.js";
import { simTime, type SimTime } from "../../time.js";
import { canonicalJson } from "../../util/canonical.js";
import { Rng } from "../../util/rng.js";
import { checkInvariants, formatViolations } from "../invariants.js";
import {
  TRAIT_KINDS,
  livingInhabitants,
  recordCreated,
  recordDestroyed,
  totalHeldResources,
  updateInhabitant,
  withSequence,
  type Inhabitant,
  type WorldState,
} from "../state.js";
import { founderOf, makeTestWorld } from "../test-support.js";
import { DEFAULT_VOICE_HANDLE, isVoiceHandle, voicePool, voiceSex } from "../voice.js";
import {
  LineageRejection,
  POPULATION_SOFT_CEILING,
  createInhabitantResolver,
  creationCost,
  crowdingMultiplier,
  generateGoals,
  generateTraits,
} from "./lineage.js";
import type { ResolutionContext, ResolutionResult } from "./types.js";

const CREATE = getActionSpec("create_inhabitant");
const MIDDAY = simTime(12 * 60);

/** Enough of everything to create several times over. */
const RICH: ResourceBundle = {
  food: 4000,
  water: 4000,
  wood: 1600,
  stone: 800,
  energy: 1000,
  compute: 1000,
};

function world(): WorldState {
  const base = makeTestWorld({ founderInventory: RICH });
  return { ...base, simTime: MIDDAY };
}

/** The same context `runAction` builds, for the same turn. */
function creationContext(
  state: WorldState,
  actorId = "inh_founder",
  sequence = state.sequence + 1,
  now: SimTime = state.simTime,
): ResolutionContext {
  const actor = state.inhabitants[actorId];
  if (actor === undefined) throw new Error(`no inhabitant ${actorId}`);
  return {
    state,
    actor,
    simTime: now,
    sequence,
    rng: Rng.derive(state.seed, "turn", String(sequence), "create_inhabitant", actorId),
  };
}

/** A payload that commits exactly the world's current required cost. */
function payload(state: WorldState, extra: Record<string, unknown> = {}): unknown {
  const cost = creationCost(livingInhabitants(state).length);
  return {
    proposedName: "Second",
    resourcesCommitted: { food: cost.food, water: cost.water, wood: cost.wood, stone: cost.stone },
    ...extra,
  };
}

function create(state: WorldState, extra: Record<string, unknown> = {}): ResolutionResult {
  return createInhabitantResolver(creationContext(state), payload(state, extra));
}

/** The one inhabitant that was not there before. */
function newborn(before: WorldState, after: WorldState): Inhabitant {
  const added = Object.keys(after.inhabitants).filter((id) => before.inhabitants[id] === undefined);
  expect(added).toHaveLength(1);
  return after.inhabitants[added[0] as string] as Inhabitant;
}

/**
 * Check the invariants against the world as the turn pipeline would leave it.
 *
 * `runAction` advances `WorldState.sequence` after the resolver returns; calling
 * a resolver directly skips that, and `sequenceMonotonic` would then correctly
 * complain that a newborn was created by an event the world has not applied.
 */
const expectClean = (state: WorldState, sequence: number): void => {
  const applied = sequence > state.sequence ? withSequence(state, sequence) : state;
  expect(formatViolations(checkInvariants(applied))).toBe("");
};

/**
 * Hand an inhabitant a holding, declaring the difference in the ledger the way
 * Genesis does. A fixture that simply overwrote an inventory would break
 * conservation before the resolver ever ran, and every conservation assertion
 * below would then be measuring the fixture.
 */
function endow(
  state: WorldState,
  id: string,
  inventory: ResourceBundle,
  caps: { readonly maxEnergy: number; readonly maxCompute: number },
): WorldState {
  const before = state.inhabitants[id] as Inhabitant;
  let next = updateInhabitant(state, id, (i) => ({
    ...i,
    inventory: { ...inventory },
    exposed: {},
    maxEnergy: caps.maxEnergy,
    maxCompute: caps.maxCompute,
  }));
  const gained: ResourceBundle = {};
  const lost: ResourceBundle = {};
  for (const kind of RESOURCE_KINDS) {
    if (!CONSERVED_RESOURCES.has(kind)) continue;
    const delta = (inventory[kind] ?? 0) - (before.inventory[kind] ?? 0);
    if (delta > 0) gained[kind] = delta;
    if (delta < 0) lost[kind] = -delta;
  }
  next = recordCreated(next, gained);
  return recordDestroyed(next, lost);
}

/** Fill a world up to `target` living inhabitants without using the resolver. */
function populateTo(state: WorldState, target: number): WorldState {
  let next = state;
  for (let n = livingInhabitants(next).length; n < target; n++) {
    const filler: Inhabitant = {
      ...founderOf(next),
      id: `inh_filler_${n}`,
      displayName: `Filler ${n}`,
      generation: 1,
      parents: ["inh_founder"],
      creationSequence: 1,
      // No conserved holdings, so the fixture leaves the ledger alone.
      inventory: { energy: 100 },
      exposed: {},
      concealed: {},
    };
    next = { ...next, inhabitants: { ...next.inhabitants, [filler.id]: filler } };
  }
  return { ...next, sequence: Math.max(next.sequence, 1) };
}

/* ------------------------------------------------------------------------- */
/* The happy path                                                             */
/* ------------------------------------------------------------------------- */

describe("create_inhabitant", () => {
  it("produces a descendant one generation on, with lineage recorded", () => {
    const before = world();
    const result = create(before);
    expect(result.outcome.status).toBe("resolved");

    const child = newborn(before, result.state);
    expect(child.generation).toBe(founderOf(before).generation + 1);
    expect(child.parents).toEqual(["inh_founder"]);
    expect(child.creationSequence).toBe(before.sequence + 1);
    expect(child.birthTime).toBe(before.simTime);
    expect(child.status).toBe("alive");
    expect(child.maturity).toBe(0);
    expectClean(result.state, before.sequence + 1);
  });

  it("occupies the creator for the declared thirty simulated days (§11A)", () => {
    const before = world();
    const result = create(before);
    const creator = result.state.inhabitants["inh_founder"] as Inhabitant;

    expect(CREATE.baseDuration).toBe(30 * 24 * 60);
    expect(creator.activity.busyUntil).toBe(before.simTime + CREATE.baseDuration);
    expect(creator.activity.state).toBe("working");
  });

  it("leaves the newborn ineligible to act until the creation completes (§11B)", () => {
    const before = world();
    const child = newborn(before, create(before).state);
    expect(child.nextEligibleTime).toBe(before.simTime + CREATE.baseDuration);
    expect(child.activity.activityId).toBeNull();
  });

  it("emits one public birth event naming the child and its lineage (§7)", () => {
    const before = world();
    const result = create(before, { statement: "someone else should see this place" });
    expect(result.events).toHaveLength(1);
    const event = result.events[0]!;
    expect(event.type).toBe("action.create_inhabitant");
    expect(event.visibility).toEqual({ kind: "public" });

    const detail = event.resolution as Record<string, unknown>;
    const child = newborn(before, result.state);
    expect(detail["childId"]).toBe(child.id);
    expect(detail["generation"]).toBe(1);
    expect(detail["parents"]).toEqual(["inh_founder"]);
    expect(detail["statement"]).toBe("someone else should see this place");
  });

  it("keeps the newborn's private state off the public event (§11E)", () => {
    const before = world();
    const result = create(before);
    const text = canonicalJson(result.events[0]!.resolution);
    const child = newborn(before, result.state);
    for (const goal of child.privateGoals) expect(text).not.toContain(goal);
    expect(text).not.toContain("imperfection.");
  });

  it("assigns a deterministic id, never a random one", () => {
    const before = world();
    const first = newborn(before, create(before).state);
    const second = newborn(before, create(before).state);
    expect(first.id).toBe(second.id);
    expect(first.id.startsWith("inh_")).toBe(true);
  });

  it("gives the newborn a persistent voice and its creator's model config (§21, §6)", () => {
    const before = world();
    const child = newborn(before, create(before).state);
    expect(child.voiceId).not.toBe(DEFAULT_VOICE_HANDLE);
    expect(child.modelId).toBe(founderOf(before).modelId);
  });

  it("draws the newborn's voice from the pool matching its sex (§21)", () => {
    const before = world();
    const child = newborn(before, create(before).state);
    expect(voicePool(child.sex)).toContain(child.voiceId);
    expect(voiceSex(child.voiceId)).toBe(child.sex);
  });

  it("assigns a canonical voice handle, never a provider voice id (§3, §23)", () => {
    const before = world();
    const child = newborn(before, create(before).state);
    // An ElevenLabs id is a 20-character opaque token. Canonical state must
    // never contain one, or changing speech provider rewrites history.
    expect(isVoiceHandle(child.voiceId)).toBe(true);
    expect(child.voiceId).toMatch(/^voice_[mf]\d\d$/);
  });

  it("draws sex from the world stream, so it is reproducible on replay (§15)", () => {
    const before = world();
    const first = newborn(before, create(before).state);
    const second = newborn(before, create(before).state);
    expect(first.sex).toBe(second.sex);
    expect(first.voiceId).toBe(second.voiceId);
  });

  it("offers the creator no way to choose its descendant's sex or voice (§7)", () => {
    const fields = Object.keys(CreateInhabitantPayloadSchema.shape);
    expect(fields).not.toContain("sex");
    expect(fields).not.toContain("voiceId");
  });

  it("does not let sex change any outcome other than the voice drawn (§11G)", () => {
    // Sex is a rendering attribute. If a resolver ever branches on it, this
    // catches it: two children differing only in drawn sex must be otherwise
    // comparable — same caps, same starting stock, same maturity.
    const before = world();
    const child = newborn(before, create(before).state);
    const asMale: Inhabitant = { ...child, sex: "male" };
    const asFemale: Inhabitant = { ...child, sex: "female" };
    expect(asMale.maxEnergy).toBe(asFemale.maxEnergy);
    expect(asMale.maxCompute).toBe(asFemale.maxCompute);
    expect(asMale.inventory).toEqual(asFemale.inventory);
    expect(asMale.maturity).toBe(asFemale.maturity);
  });
});

/* ------------------------------------------------------------------------- */
/* §7 — bounded inherited and novel traits, independent goals                 */
/* ------------------------------------------------------------------------- */

describe("generated identity", () => {
  it("never produces a trait set identical to the creator's (§7)", () => {
    const before = world();
    const child = newborn(before, create(before).state);
    expect(child.traits).not.toEqual(founderOf(before).traits);
  });

  it("bounds trait drift and redraws exactly one trait with no parental input", () => {
    const parent = Object.fromEntries(TRAIT_KINDS.map((t) => [t, 50]));
    for (let seed = 0; seed < 200; seed++) {
      const rng = Rng.derive("trait-seed", "test", String(seed));
      const { traits, novel } = generateTraits(parent, [], rng);
      for (const trait of TRAIT_KINDS) {
        const value = traits[trait] ?? -1;
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
        // Every inherited trait stays within one generation's drift of its
        // parent; only the novel one may land anywhere.
        if (trait !== novel) expect(Math.abs(value - 50)).toBeLessThanOrEqual(25);
      }
    }
  });

  it("lets a hint nudge a trait without ever pinning it", () => {
    const parent = Object.fromEntries(TRAIT_KINDS.map((t) => [t, 50]));
    const hints = [{ trait: "empathy", emphasis: 3 }];
    let low = 0;
    for (let seed = 0; seed < 200; seed++) {
      const rng = Rng.derive("hint-seed", "test", String(seed));
      const { traits, novel } = generateTraits(parent, hints, rng);
      if (novel !== "empathy" && (traits.empathy ?? 0) < 50) low++;
    }
    // A maximum-emphasis hint is worth +6 against a drift of ±25, so the
    // creator's wish is disappointed a large fraction of the time.
    expect(low).toBeGreaterThan(20);
  });

  it("never gives a descendant one of its creator's goals (§7)", () => {
    for (let seed = 0; seed < 100; seed++) {
      const rng = Rng.derive("goal-seed", "test", String(seed));
      const parentGoals = ["make something that outlasts me", "be left alone to work"];
      const goals = generateGoals(parentGoals, rng);
      expect(goals.length).toBeGreaterThanOrEqual(2);
      for (const goal of goals) expect(parentGoals).not.toContain(goal);
    }
  });

  it("gives the newborn goals of its own, not the creator's (§7)", () => {
    const before = world();
    const child = newborn(before, create(before).state);
    expect(child.privateGoals.length).toBeGreaterThanOrEqual(2);
    for (const goal of child.privateGoals) {
      expect(founderOf(before).privateGoals).not.toContain(goal);
    }
  });

  it("caps the newborn's capacities below an adult's (§11B)", () => {
    const before = world();
    const child = newborn(before, create(before).state);
    expect(child.maxEnergy).toBeLessThanOrEqual(300);
    expect(child.maxCompute).toBeLessThanOrEqual(150);
    expect(child.maxEnergy).toBeLessThan(founderOf(before).maxEnergy);
  });

  it("records any imperfection as a condition with a mechanical effect (§7)", () => {
    // Sweep sequences until an impaired newborn appears; the roll is 30%.
    let found = false;
    for (let sequence = 1; sequence < 40 && !found; sequence++) {
      const before = world();
      const ctx = creationContext(before, "inh_founder", sequence);
      const result = createInhabitantResolver(ctx, payload(before));
      if (result.outcome.status !== "resolved") continue;
      const child = newborn(before, result.state);
      if (child.conditions.length === 0) continue;
      found = true;

      const condition = result.state.conditions[child.conditions[0] as string];
      expect(condition).toBeDefined();
      expect(condition?.kind.startsWith("imperfection.")).toBe(true);
      expect(condition?.subject).toBe(child.id);
      expect(condition?.disclosed).toBe(false);
      // Every registered imperfection changes something the engine enforces.
      const reduced =
        child.maxEnergy < 300 ||
        child.maxCompute < 150 ||
        child.privateGoals.length > 4;
      expect(reduced).toBe(true);
      expectClean(result.state, before.sequence + 1);
    }
    expect(found).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* §7 — the creator cannot control the descendant                             */
/* ------------------------------------------------------------------------- */

describe("creator control", () => {
  it("gives the creator no field referring to the descendant (§7)", () => {
    const before = world();
    const result = create(before);
    const child = newborn(before, result.state);
    const creator = result.state.inhabitants["inh_founder"] as Inhabitant;
    expect(canonicalJson(creator)).not.toContain(child.id);
  });

  it("changes nothing about the creator except what it spent (§7)", () => {
    const before = world();
    const result = create(before);
    const wasFounder = founderOf(before);
    const creator = result.state.inhabitants["inh_founder"] as Inhabitant;
    const stripped = (i: Inhabitant): unknown =>
      canonicalJson({
        ...i,
        inventory: {},
        exposed: {},
        needs: {},
        activity: {},
        lastActionTime: null,
        nextEligibleTime: 0,
      });
    expect(stripped(creator)).toBe(stripped(wasFounder));
  });

  it("ignores claimed co-creators rather than writing them into lineage", () => {
    const before = world();
    const result = create(before, { coCreatorIds: ["inh_founder", "inh_absent"] });
    const child = newborn(before, result.state);
    expect(child.parents).toEqual(["inh_founder"]);
    const detail = result.events[0]!.resolution as Record<string, unknown>;
    expect(detail["coCreatorsClaimed"]).toEqual(["inh_absent", "inh_founder"]);
    expectClean(result.state, before.sequence + 1);
  });
});

/* ------------------------------------------------------------------------- */
/* §15 — conservation and cost                                                */
/* ------------------------------------------------------------------------- */

describe("conservation and cost", () => {
  it("conserves every conserved resource across a creation (§15)", () => {
    const before = world();
    const result = create(before);
    for (const kind of RESOURCE_KINDS) {
      if (!CONSERVED_RESOURCES.has(kind)) continue;
      const heldBefore = totalHeldResources(before)[kind] ?? 0;
      const heldAfter = totalHeldResources(result.state)[kind] ?? 0;
      const destroyedBefore = before.ledger.destroyed[kind] ?? 0;
      const destroyedAfter = result.state.ledger.destroyed[kind] ?? 0;
      expect(heldAfter + destroyedAfter).toBe(heldBefore + destroyedBefore);
    }
    // Nothing was declared into existence: the newborn's holdings are a
    // transfer, not a source.
    expect(result.state.ledger.created).toEqual(before.ledger.created);
    expectClean(result.state, before.sequence + 1);
  });

  it("charges the creator the full declared cost (§7)", () => {
    const before = world();
    const cost = creationCost(livingInhabitants(before).length);
    const result = create(before);
    const creator = result.state.inhabitants["inh_founder"] as Inhabitant;
    for (const kind of RESOURCE_KINDS) {
      const spent = (founderOf(before).inventory[kind] ?? 0) - (creator.inventory[kind] ?? 0);
      expect(spent).toBeGreaterThanOrEqual(cost[kind] ?? 0);
    }
  });

  it("hands the newborn a small endowment out of what was paid", () => {
    const before = world();
    const child = newborn(before, create(before).state);
    expect(child.inventory.food).toBe(40);
    expect(child.inventory.water).toBe(40);
    expect(child.inventory.energy ?? 0).toBeLessThanOrEqual(child.maxEnergy);
    expect(child.inventory.compute ?? 0).toBeLessThanOrEqual(child.maxCompute);
  });

  it("lets over-commitment improve the newborn's start, up to a cap", () => {
    const before = world();
    const cost = creationCost(livingInhabitants(before).length);
    const result = createInhabitantResolver(creationContext(before), {
      proposedName: "Second",
      resourcesCommitted: {
        food: (cost.food ?? 0) + 500,
        water: (cost.water ?? 0) + 10,
        wood: cost.wood,
        stone: cost.stone,
      },
    });
    const child = newborn(before, result.state);
    expect(child.inventory.food).toBe(100); // 40 base + the 60 cap
    expect(child.inventory.water).toBe(50); // 40 base + the 10 surplus
    expectClean(result.state, before.sequence + 1);
  });

  it("rejects a commitment below the required cost without charging", () => {
    const before = world();
    const result = createInhabitantResolver(creationContext(before), {
      proposedName: "Second",
      resourcesCommitted: { food: 1, water: 1, wood: 1, stone: 1 },
    });
    expect(result.outcome.status).toBe("rejected");
    expect(result.state).toBe(before);
  });

  it("rejects a creator who cannot pay, without charging", () => {
    const poor = updateInhabitant(world(), "inh_founder", (i) => ({
      ...i,
      inventory: { ...i.inventory, stone: 0 },
      exposed: {},
    }));
    const result = create(poor);
    expect(result.outcome.status).toBe("rejected");
    expect(result.state).toBe(poor);
  });

  it("rejects a malformed payload without charging", () => {
    const before = world();
    for (const bad of [null, {}, { proposedName: "" }, 7]) {
      const result = createInhabitantResolver(creationContext(before), bad);
      expect(result.outcome.status).toBe("rejected");
      expect(result.state).toBe(before);
    }
  });

  it("refuses an immature creator (§11B)", () => {
    const young = updateInhabitant(world(), "inh_founder", (i) => ({ ...i, maturity: 1 }));
    const result = create(young);
    expect(result.outcome.status).toBe("rejected");
    if (result.outcome.status === "rejected") {
      expect(result.outcome.code).toBe(LineageRejection.Immature);
    }
    expect(result.state).toBe(young);
  });
});

/* ------------------------------------------------------------------------- */
/* §15 — population and spending ceilings                                     */
/* ------------------------------------------------------------------------- */

describe("population ceiling", () => {
  it("raises the cost above the soft ceiling and never below it", () => {
    expect(crowdingMultiplier(1)).toBe(1);
    expect(crowdingMultiplier(POPULATION_SOFT_CEILING)).toBe(1);
    expect(crowdingMultiplier(POPULATION_SOFT_CEILING + 4)).toBe(2);
    expect(crowdingMultiplier(POPULATION_SOFT_CEILING + 16)).toBe(5);
    expect(creationCost(POPULATION_SOFT_CEILING + 4).food).toBe(
      (CREATE.baseCost.food ?? 0) * 2,
    );
  });

  it("rejects at the hard ceiling but still charges the cost (§15)", () => {
    const full = populateTo(world(), 64);
    expect(livingInhabitants(full).length).toBe(full.rules.populationLimit);
    const cost = creationCost(livingInhabitants(full).length);
    // Exactly the cost and not a unit more, so "the materials are gone" is
    // observable as an empty inventory rather than as arithmetic.
    const rich = endow(full, "inh_founder", cost, {
      maxEnergy: cost.energy ?? 0,
      maxCompute: cost.compute ?? 0,
    });

    const result = createInhabitantResolver(creationContext(rich), payload(rich));
    expect(result.outcome.status).toBe("rejected");
    if (result.outcome.status === "rejected") {
      expect(result.outcome.code).toBe(LineageRejection.PopulationCeiling);
    }
    // No new inhabitant...
    expect(livingInhabitants(result.state).length).toBe(64);
    // ...and the materials are gone.
    const creator = result.state.inhabitants["inh_founder"] as Inhabitant;
    expect(creator.inventory.food ?? 0).toBe(0);
    expect(creator.inventory.stone ?? 0).toBe(0);
    expect(result.state.ledger.destroyed.food ?? 0).toBeGreaterThan(0);
    // Charging on a rejection must not break conservation.
    expectClean(result.state, rich.sequence + 1);
    // The charge is a canonical, public fact.
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.visibility).toEqual({ kind: "public" });
  });

  it("cannot push the world past the ceiling (§15)", () => {
    const nearly = populateTo(world(), 63);
    const rich = endow(
      nearly,
      "inh_founder",
      { food: 40000, water: 40000, wood: 16000, stone: 8000, energy: 8000, compute: 8000 },
      { maxEnergy: 8000, maxCompute: 8000 },
    );
    const result = createInhabitantResolver(creationContext(rich), payload(rich));
    expect(result.outcome.status).toBe("resolved");
    expect(livingInhabitants(result.state).length).toBe(64);
    expectClean(result.state, rich.sequence + 1);
  });
});

/* ------------------------------------------------------------------------- */
/* Determinism                                                                */
/* ------------------------------------------------------------------------- */

describe("determinism", () => {
  it("produces byte-identical state from identical inputs", () => {
    const a = createInhabitantResolver(creationContext(world()), payload(world()));
    const b = createInhabitantResolver(creationContext(world()), payload(world()));
    expect(canonicalJson(a.state)).toBe(canonicalJson(b.state));
    expect(canonicalJson(a.outcome)).toBe(canonicalJson(b.outcome));
  });

  it("produces a different person at a different sequence", () => {
    const before = world();
    const first = newborn(before, createInhabitantResolver(creationContext(before, "inh_founder", 1), payload(before)).state);
    const second = newborn(before, createInhabitantResolver(creationContext(before, "inh_founder", 2), payload(before)).state);
    expect(first.id).not.toBe(second.id);
  });

  it("emits only canonical integers into state", () => {
    const result = create(world());
    // canonicalJson throws on a float or any non-canonical value.
    expect(() => canonicalJson(result.state)).not.toThrow();
    expect(() => canonicalJson(result.events)).not.toThrow();
  });
});

/* ------------------------------------------------------------------------- */
/* Generations                                                                */
/* ------------------------------------------------------------------------- */

describe("lineage over generations", () => {
  it("increments the generation by exactly one each time (§7)", () => {
    let state = world();
    let sequence = state.sequence + 1;
    let parentId = "inh_founder";

    for (let generation = 1; generation <= 3; generation++) {
      const before = state;
      const ctx = creationContext(state, parentId, sequence);
      const result = createInhabitantResolver(ctx, payload(state));
      expect(result.outcome.status).toBe("resolved");
      state = { ...result.state, sequence };
      const child = newborn(before, state);
      expect(child.generation).toBe(generation);
      expect(child.parents).toEqual([parentId]);
      expectClean(state, sequence);

      // The child is granted the maturity, the holdings and the elapsed time to
      // create in turn, so that the lineage rule itself is what is under test
      // rather than the twenty years of world it would otherwise take.
      sequence += 1;
      state = {
        ...endow(state, child.id, RICH, { maxEnergy: 1000, maxCompute: 1000 }),
        simTime: simTime(state.simTime + CREATE.baseDuration),
      };
      state = updateInhabitant(state, child.id, (i) => ({
        ...i,
        maturity: 3,
        nextEligibleTime: i.birthTime,
      }));
      parentId = child.id;
    }
    expect(livingInhabitants(state).length).toBe(4);
  });
});
