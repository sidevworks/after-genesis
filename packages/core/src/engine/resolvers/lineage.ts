/**
 * `create_inhabitant` — the only route by which population grows (§7, §1).
 *
 * Humans cannot create inhabitants. After Genesis every inhabitant "must
 * originate from an existing inhabitant through the simulation's internal
 * creation system", so this resolver is the whole of lineage: without it a world
 * is a fixed cast that can only shrink.
 *
 * Four decisions shape everything below.
 *
 * **The creator commits matter, not a design.** §7 requires creation to consume
 * declared resources and to require time, and requires the result to be an
 * independent person. The payload is therefore read as two different kinds of
 * thing: `resourcesCommitted` is a binding declaration the engine checks and
 * charges, while `traitHints`/`valueHints`/`proposedName` are hopes that nudge a
 * seeded generation process and can be disappointed by it. A creator who wants a
 * copy of itself cannot have one — `divergeFromCreator` below makes that a
 * guarantee rather than a probability.
 *
 * **The cost is charged on attempt at the ceiling.** §15: "Creation costs cannot
 * be bypassed"; §7: creation must "respect population and spending ceilings".
 * If the ceiling check came before the charge, an inhabitant at a full world
 * could probe for a free slot every turn at no cost, and the ceiling would
 * bound population without bounding spend. So a creation refused for population
 * reasons still consumes the materials: they were assembled, and they are gone.
 * Every other rejection here happens before anything is committed and charges
 * nothing.
 *
 * **Nothing is conjured.** The newborn's starting goods are *transferred* out of
 * what the creator paid; the remainder of the conserved cost is recorded as a
 * declared sink. `conservedResourceTotals` sees the endowment still held (by the
 * child) and the rest in `ledger.destroyed`, and balances. `energy` and
 * `compute` are outside the conservation set by construction (see
 * `CONSERVED_RESOURCES`) — they are capacities, and the newborn's share of them
 * is embodied from the creator's expenditure rather than added to any ledger.
 *
 * **Imperfections are data.** §7 permits bounded imperfections and immediately
 * forbids the obvious implementation: "Never generate or execute arbitrary
 * broken application code to simulate illness." Every imperfection here is a
 * `Condition` record plus an integer field on the inhabitant. Nothing writes
 * code, alters a prompt or disables a code path.
 */
import { deriveConditionId, deriveInhabitantId } from "../../ids.js";
import { getActionSpec } from "../../schema/actions/index.js";
import { CreateInhabitantPayloadSchema } from "../../schema/actions/lineage.js";
import { derivePhysicalProcess } from "../../schema/physical-process.js";
import {
  CONSERVED_RESOURCES,
  RESOURCE_KINDS,
  addBundles,
  subtractBundles,
} from "../../schema/primitives.js";
import type { ResourceBundle, ResourceKind } from "../../schema/primitives.js";
import { addDuration, duration, type SimTime } from "../../time.js";
import type { Rng } from "../../util/rng.js";
import {
  TRAIT_KINDS,
  clampInt,
  idiv,
  livingInhabitants,
  makeInhabitant,
  normaliseBundle,
  putCondition,
  putInhabitant,
  recordDestroyed,
  updateInhabitant,
  type Inhabitant,
  type Sex,
  type TraitKind,
  type TraitSet,
} from "../state.js";
import { voicePool } from "../voice.js";
import { advanceNeeds, beginActivity, spend } from "./effects.js";
import { reject, type DerivedEvent, type ResolutionResult, type Resolver } from "./types.js";

/** Declared metadata for `create_inhabitant` (§11A). See the note in move.ts. */
const CREATE = getActionSpec("create_inhabitant");

/**
 * Rejection codes specific to lineage.
 *
 * Kept local rather than added to the shared `RejectionCode` table because they
 * have exactly one producer. They are stable strings either way: they are
 * written into the canonical event log and an auditor will read them.
 */
export const LineageRejection = {
  Immature: "IMMATURE",
  InsufficientCommitment: "INSUFFICIENT_COMMITMENT",
  InsufficientResources: "INSUFFICIENT_RESOURCES",
  PopulationCeiling: "POPULATION_CEILING",
  InvalidPayload: "INVALID_PAYLOAD",
} as const;

/**
 * The crowding threshold of the world rules (§7 "spending ceilings").
 *
 * The hard ceiling lives in `WorldRules.populationLimit` because a resolver must
 * not be able to change it. This softer number is a cost curve, not a limit, and
 * is kept here beside the only code that reads it. Above it each additional
 * block of four inhabitants multiplies the cost of the next creation, so growth
 * slows well before it stops — the ceiling is a wall, and this is the friction
 * that stops the world reaching it in a single generation.
 */
export const POPULATION_SOFT_CEILING = 48;
const CROWDING_BLOCK = 4;

/**
 * The newborn's capacity ceilings (§11B: "Young inhabitants must have smaller
 * effective context budgets ... restricted action capabilities").
 *
 * The rest of §11B's developmental gating is already carried by `maturity`,
 * which is 0 for every newborn: `retrievalBudget` scales memory retrieval by it
 * and the cognition layer filters the action catalogue by
 * `ActionSpec.minimumMaturity`. These two numbers are what the *engine* can
 * enforce on its own, and `needsAndCapsWithinBounds` enforces them.
 */
const NEWBORN_MAX_ENERGY = 300;
const NEWBORN_MAX_COMPUTE = 150;

/**
 * What a newborn is handed, taken out of what the creator paid.
 *
 * Small on purpose. A newborn that could feed itself for a season would make
 * §11C's questions — who provides care, at what cost, and what happens when
 * nobody does — unaskable.
 */
const CHILD_ENDOWMENT: ResourceBundle = Object.freeze({ food: 40, water: 40 });

/** The most a creator can improve a newborn's start by over-committing. */
const ENDOWMENT_BONUS_CAP: ResourceBundle = Object.freeze({ food: 60, water: 60 });

/** Material kinds a creator must declare. Energy and compute come from its body. */
const MATERIAL_KINDS: readonly ResourceKind[] = ["food", "water", "wood", "stone"];

/** How far a trait may drift from the creator's in one generation. */
const TRAIT_DRIFT = 25;
/** A hint's maximum pull, against a drift of ±25. It nudges; it cannot pin. */
const HINT_WEIGHT = 2;
/** Traits absent from a creator's record read as unremarkable, per `TraitSet`. */
const TRAIT_DEFAULT = 50;

/**
 * The pool independent goals are drawn from.
 *
 * §7: "Give the new inhabitant independent goals and decision-making." Goals are
 * never copied from the creator — `generateGoals` removes any the creator holds
 * before drawing, so a descendant cannot inherit an ambition. These are open
 * enough to be pursued in many ways and none of them names another inhabitant,
 * an organisation or a resource: the world has to supply the specifics.
 */
const GOAL_POOL: readonly string[] = Object.freeze([
  "find out what lies beyond the places I have already stood",
  "hold enough that a bad season does not decide anything for me",
  "make something that outlasts me",
  "learn a craft well enough that others come to me for it",
  "understand why the people here do what they do",
  "be owed nothing and owe nothing",
  "put a roof over the ground I choose",
  "keep a record of what actually happened",
  "find someone whose word I can rely on",
  "be left alone to work",
]);

/** Dispositions a newborn may hold that its creator does not. */
const VALUE_POOL: readonly string[] = Object.freeze([
  "candour",
  "caution",
  "fairness",
  "independence",
  "industry",
  "loyalty",
  "novelty",
  "restraint",
]);

/**
 * Paired goals that pull against each other (§7 "conflicting priorities").
 *
 * Given to an inhabitant with that imperfection. Nothing enforces the conflict;
 * it is simply true that pursuing one costs progress on the other, and the
 * inhabitant has to live with that the way anyone does.
 */
const CONFLICTING_GOALS: readonly (readonly [string, string])[] = Object.freeze([
  ["be trusted by everyone here", "keep what I know to myself"] as const,
  ["accumulate more than I need", "give away whatever anyone asks for"] as const,
  ["settle in one place for good", "see every part of this world"] as const,
]);

/**
 * Sex is drawn 50/50 from the world RNG and is not inherited, negotiated or
 * requested. `create_inhabitant` has no field for it: §7 requires creation to
 * "produce a distinct autonomous identity" and forbids the creator from
 * directing what it gets. A creator who could specify sex would be choosing
 * how its descendant sounds, which is a small step towards designing one.
 */
const SEX_DRAW: readonly Sex[] = Object.freeze(["male", "female"]);

/**
 * The bounded imperfections of §7 that this build can actually enforce.
 *
 * §7 lists eight; three are listed here. The omitted five (weak memory
 * retention, reduced planning ability, communication difficulty, unstable
 * attention, increased resource requirements) would each need a system the
 * engine does not yet have — memory decay, a planning horizon in state, a
 * per-inhabitant duration modifier, a turn-level interference rule, a metabolism.
 * Registering them anyway would produce inhabitants labelled as impaired who are
 * not impaired in any way the world can observe, which §26 forbids: "Do not
 * claim a feature works unless it has been tested." They belong to whichever
 * change brings those systems.
 *
 * Each entry here has an effect that exists today and is asserted in the tests.
 */
const IMPERFECTIONS: readonly (readonly [string, number])[] = Object.freeze([
  ["low_energy", 3] as const,
  ["low_compute", 3] as const,
  ["conflicting_priorities", 2] as const,
]);
/** Chance that a creation carries one imperfection at all. */
const IMPERFECTION_NUMERATOR = 30;
const IMPERFECTION_DENOMINATOR = 100;

/* ------------------------------------------------------------------------- */
/* Cost                                                                       */
/* ------------------------------------------------------------------------- */

/** Multiply every entry of a bundle by a non-negative integer. */
function scaleBundle(bundle: ResourceBundle, factor: number): ResourceBundle {
  const out: ResourceBundle = {};
  for (const kind of RESOURCE_KINDS) {
    const amount = (bundle[kind] ?? 0) * factor;
    if (amount !== 0) out[kind] = amount;
  }
  return out;
}

/**
 * The crowding multiplier on creation cost.
 *
 * One at and below the soft ceiling, then one more per block of four. Integer
 * throughout; `canonicalJson` rejects floats and so does this world.
 */
export function crowdingMultiplier(living: number, softCeiling = POPULATION_SOFT_CEILING): number {
  if (living <= softCeiling) return 1;
  return 1 + idiv(living - softCeiling, CROWDING_BLOCK);
}

/** The cost of the next creation in a world of `living` inhabitants. */
export function creationCost(living: number): ResourceBundle {
  return scaleBundle(CREATE.baseCost, crowdingMultiplier(living));
}

/** Whether a declared commitment covers the material part of a cost. */
function commitmentCovers(committed: ResourceBundle, cost: ResourceBundle): boolean {
  return MATERIAL_KINDS.every((kind) => (committed[kind] ?? 0) >= (cost[kind] ?? 0));
}

/**
 * The surplus a creator's over-commitment buys the newborn.
 *
 * Bounded twice: by `ENDOWMENT_BONUS_CAP`, so a rich creator cannot hand a
 * newborn independence, and by what the creator still holds after the required
 * cost, so the bonus can never open a negative balance (§15).
 */
function endowmentBonus(
  committed: ResourceBundle,
  cost: ResourceBundle,
  remaining: ResourceBundle,
): ResourceBundle {
  const out: ResourceBundle = {};
  for (const kind of MATERIAL_KINDS) {
    const cap = ENDOWMENT_BONUS_CAP[kind] ?? 0;
    if (cap === 0) continue;
    const surplus = (committed[kind] ?? 0) - (cost[kind] ?? 0);
    const affordable = remaining[kind] ?? 0;
    const amount = Math.min(surplus, cap, affordable);
    if (amount > 0) out[kind] = amount;
  }
  return out;
}

/** The part of a bundle that leaves the world rather than changing hands. */
function conservedPart(bundle: ResourceBundle): ResourceBundle {
  const out: ResourceBundle = {};
  for (const kind of RESOURCE_KINDS) {
    if (!CONSERVED_RESOURCES.has(kind)) continue;
    const amount = bundle[kind] ?? 0;
    if (amount !== 0) out[kind] = amount;
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Generation                                                                 */
/* ------------------------------------------------------------------------- */

/** A hint's pull on one trait, clamped to the declared ±3 emphasis range. */
function hintPull(
  hints: readonly { readonly trait: string; readonly emphasis: number }[],
  trait: TraitKind,
): number {
  let pull = 0;
  for (const hint of hints) {
    if (hint.trait === trait) pull += clampInt(hint.emphasis, -3, 3) * HINT_WEIGHT;
  }
  return clampInt(pull, -3 * HINT_WEIGHT, 3 * HINT_WEIGHT);
}

export interface GeneratedTraits {
  readonly traits: TraitSet;
  /** The trait drawn with no parental input at all. */
  readonly novel: TraitKind;
}

/**
 * Bounded inherited and novel traits (§7).
 *
 * Seven of the eight traits drift from the creator's by at most ±25 plus a weak
 * hint pull; the eighth is redrawn uniformly and owes the creator nothing. The
 * result is recognisably descended from its creator and reliably not it.
 *
 * Draws are taken in `TRAIT_KINDS` order and every trait is drawn whether or not
 * the creator holds it, so the stream position never depends on how sparse a
 * creator's trait record happens to be.
 */
export function generateTraits(
  parent: TraitSet,
  hints: readonly { readonly trait: string; readonly emphasis: number }[],
  rng: Rng,
): GeneratedTraits {
  const traits: Record<string, number> = {};
  for (const trait of TRAIT_KINDS) {
    const base = parent[trait] ?? TRAIT_DEFAULT;
    const drift = rng.nextInt(-TRAIT_DRIFT, TRAIT_DRIFT);
    traits[trait] = clampInt(base + drift + hintPull(hints, trait), 0, 100);
  }
  const novel = rng.pick(TRAIT_KINDS);
  traits[novel] = rng.nextInt(0, 100);
  return { traits: traits as TraitSet, novel };
}

/** Whether two trait records agree on every one of the eight traits. */
function traitsIdentical(a: TraitSet, b: TraitSet): boolean {
  return TRAIT_KINDS.every((t) => (a[t] ?? TRAIT_DEFAULT) === (b[t] ?? TRAIT_DEFAULT));
}

/**
 * Guarantee that a descendant is not a copy (§7).
 *
 * Uniform redraw makes an identical trait set unlikely, and unlikely is not the
 * same as impossible — over a long world it would eventually happen, and a
 * descendant indistinguishable from its creator is the one outcome §7 rules out
 * outright. Shifting the novel trait by one is the smallest change that closes
 * it, and it is deterministic, so replay reproduces it.
 */
function divergeFromCreator(generated: GeneratedTraits, parent: TraitSet): TraitSet {
  if (!traitsIdentical(generated.traits, parent)) return generated.traits;
  const current = generated.traits[generated.novel] ?? TRAIT_DEFAULT;
  return { ...generated.traits, [generated.novel]: current === 100 ? 99 : current + 1 };
}

/**
 * Independent goals (§7), drawn from the pool with the creator's own goals
 * removed first. A descendant therefore never shares an ambition with its
 * creator at birth, which is the mechanical form of "the creator cannot directly
 * control the new inhabitant": there is no channel, not even inheritance, by
 * which a creator's intentions reach the new mind.
 */
export function generateGoals(parentGoals: readonly string[], rng: Rng): string[] {
  const wanted = rng.nextInt(2, 4);
  const available = GOAL_POOL.filter((goal) => !parentGoals.includes(goal));
  return rng.shuffled(available).slice(0, wanted).sort();
}

/**
 * Values: some of the creator's kept, at most one hoped-for value adopted, one
 * drawn independently. Unlike goals, values may be shared — a child raised
 * nowhere near its creator can still happen to value the same things, and §7
 * only requires that the result not be a copy.
 */
function generateValues(
  parentValues: readonly string[],
  hints: readonly string[],
  rng: Rng,
): string[] {
  const kept: string[] = [];
  for (const value of [...parentValues].sort()) {
    if (rng.chance(1, 2)) kept.push(value);
  }
  const adopted = hints.length > 0 && rng.chance(1, 3) ? [rng.pick([...hints].sort())] : [];
  const novel = rng.pick(VALUE_POOL);
  return [...new Set([...kept, ...adopted, novel])].sort();
}

/* ------------------------------------------------------------------------- */
/* Resolver                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The neutral facts of a birth, as they appear on the public event (§11G: "The
 * canonical event log must describe observable events neutrally").
 *
 * Deliberately absent: the newborn's traits, values, private goals and any
 * imperfection. §11E classifies private goals and intentions as private and
 * `Condition.disclosed` starts false; a public birth event that listed them
 * would be a disclosure nobody performed. What the world can see is that someone
 * spent thirty days and a great deal of material and that a person now stands
 * where they did.
 */
interface BirthDetail {
  readonly childId: string;
  readonly childName: string;
  readonly generation: number;
  readonly parents: readonly string[];
  readonly location: { readonly x: number; readonly y: number };
  readonly birthTime: SimTime;
  readonly eligibleFrom: SimTime;
  readonly costPaid: ResourceBundle;
  readonly endowment: ResourceBundle;
  readonly consumed: ResourceBundle;
  readonly crowdingMultiplier: number;
  readonly livingBefore: number;
  readonly minutes: number;
  readonly statedCareMinutesPerDay: number;
  readonly statement: string | null;
  readonly coCreatorsClaimed: readonly string[];
  readonly process: unknown;
}

export const createInhabitantResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = CreateInhabitantPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, LineageRejection.InvalidPayload, "create_inhabitant payload is malformed");
  }
  const input = parsed.data;
  const { state, actor } = ctx;

  // §11B: creation is an adult capability. The cognition layer already filters
  // the catalogue by maturity, but a resolver is the last line of defence and
  // must not trust that it ran (see the note atop payload.ts).
  if (actor.maturity < CREATE.minimumMaturity) {
    return reject(
      ctx,
      LineageRejection.Immature,
      `creation requires maturity ${CREATE.minimumMaturity}; ${actor.id} is at ${actor.maturity}`,
    );
  }

  const livingBefore = livingInhabitants(state).length;
  const multiplier = crowdingMultiplier(livingBefore);
  const cost = creationCost(livingBefore);

  // Nothing is committed yet, so neither of the next two rejections charges.
  if (!commitmentCovers(input.resourcesCommitted, cost)) {
    return reject(
      ctx,
      LineageRejection.InsufficientCommitment,
      `creation requires committing at least ${MATERIAL_KINDS.map(
        (kind) => `${cost[kind] ?? 0} ${kind}`,
      ).join(", ")} in a world of ${livingBefore}`,
    );
  }
  const afterCost = spend(actor, cost);
  if (afterCost === null) {
    return reject(
      ctx,
      LineageRejection.InsufficientResources,
      `${actor.id} does not hold the declared creation cost`,
    );
  }

  const consumedByAttempt = conservedPart(cost);

  // §15: "Creation costs cannot be bypassed." The materials were assembled
  // before the world was found to be full; they do not come back.
  if (livingBefore >= state.rules.populationLimit) {
    let next = updateInhabitant(state, actor.id, () => afterCost);
    next = recordDestroyed(next, consumedByAttempt);
    const detail = {
      livingBefore,
      populationLimit: state.rules.populationLimit,
      costPaid: cost,
      consumed: consumedByAttempt,
      crowdingMultiplier: multiplier,
      childId: null,
    };
    return {
      outcome: {
        status: "rejected",
        code: LineageRejection.PopulationCeiling,
        reason:
          `the world holds ${livingBefore} living inhabitants, at the ceiling of ` +
          `${state.rules.populationLimit}; the committed materials were consumed`,
      },
      state: next,
      events: [
        {
          type: "action.create_inhabitant",
          actor: actor.id,
          simTime: ctx.simTime,
          inputs: { proposedName: input.proposedName, resourcesCommitted: input.resourcesCommitted },
          resolution: detail,
          visibility: { kind: "public" },
        },
      ],
    };
  }

  const bonus = endowmentBonus(input.resourcesCommitted, cost, afterCost.inventory);
  const afterBonus = spend(afterCost, bonus);
  /* c8 ignore next 3 */
  if (afterBonus === null) {
    return reject(ctx, LineageRejection.InsufficientResources, "endowment surplus is not held");
  }

  const endowment = addBundles(CHILD_ENDOWMENT, bonus);
  // The endowment is a transfer, so only the difference leaves the world. This
  // subtraction is the whole of the conservation argument and cannot go
  // negative: `CHILD_ENDOWMENT` is a small fraction of the base food and water
  // cost, and `bonus` was charged on top of it.
  const consumed = subtractBundles(addBundles(consumedByAttempt, bonus), endowment);
  /* c8 ignore next 3 */
  if (consumed === null) {
    return reject(ctx, LineageRejection.InsufficientResources, "endowment exceeds the cost paid");
  }

  const generated = generateTraits(actor.traits, input.traitHints, ctx.rng);
  const traits = divergeFromCreator(generated, actor.traits);
  const values = generateValues(actor.values, input.valueHints, ctx.rng);
  let goals = generateGoals(actor.privateGoals, ctx.rng);

  // Draws for the imperfection are taken unconditionally in a fixed order so
  // that the stream position after this resolver never depends on the outcome.
  const impaired = ctx.rng.chance(IMPERFECTION_NUMERATOR, IMPERFECTION_DENOMINATOR);
  const imperfection = ctx.rng.pickWeighted(IMPERFECTIONS);
  const severity = ctx.rng.nextInt(20, 60);
  const conflict = ctx.rng.pick(CONFLICTING_GOALS);
  // Two draws, always taken in this order regardless of outcome, so that the
  // RNG stream position after this resolver never depends on the sex drawn.
  const sex = ctx.rng.pick(SEX_DRAW);
  const voiceId = ctx.rng.pick(voicePool(sex));

  let maxEnergy = NEWBORN_MAX_ENERGY;
  let maxCompute = NEWBORN_MAX_COMPUTE;
  if (impaired) {
    if (imperfection === "low_energy") maxEnergy = idiv(NEWBORN_MAX_ENERGY * 70, 100);
    if (imperfection === "low_compute") maxCompute = idiv(NEWBORN_MAX_COMPUTE * 60, 100);
    if (imperfection === "conflicting_priorities") {
      goals = [...new Set([...goals, conflict[0], conflict[1]])].sort();
    }
  }

  const childId = deriveInhabitantId(state.worldId, ctx.sequence);
  const endsAt = addDuration(ctx.simTime, duration(CREATE.baseDuration));

  const child: Inhabitant = {
    ...makeInhabitant({
      id: childId,
      displayName: input.proposedName,
      location: actor.location,
      birthTime: ctx.simTime,
      creationSequence: ctx.sequence,
      generation: actor.generation + 1,
      sex,
      // §7 establishes lineage from those who actually made the thing.
      // `coCreatorIds` is recorded on the event but not written into lineage:
      // there is no consent action in this build, and naming an inhabitant as a
      // parent of a child it never agreed to would be a canonical fact created
      // by somebody else's payload.
      parents: [actor.id],
      inventory: {
        ...endowment,
        energy: idiv(maxEnergy, 2),
        compute: idiv(maxCompute, 2),
      },
      traits,
      values,
      privateGoals: goals,
      // §11B: developmental stage 0. Everything downstream — retrieval budget,
      // planning horizon, which actions are even offered — reads this.
      maturity: 0,
      voiceId,
      modelId: actor.modelId,
      maxEnergy,
      maxCompute,
    }),
    // Present from the moment of creation, because a birth time in the future
    // would break `simTimeNonDecreasing`, but not able to act until the thirty
    // days its creator committed have elapsed.
    nextEligibleTime: endsAt,
  };

  let next = updateInhabitant(state, actor.id, () => ({
    ...afterBonus,
    needs: advanceNeeds(afterBonus.needs, CREATE.baseDuration, state.rules),
  }));
  next = recordDestroyed(next, consumed);
  next = putInhabitant(next, child);

  if (impaired) {
    const conditionId = deriveConditionId(state.worldId, ctx.sequence);
    next = putCondition(next, {
      id: conditionId,
      subject: childId,
      kind: `imperfection.${imperfection}`,
      severity,
      onsetAt: ctx.simTime,
      progressedAt: ctx.simTime,
      stage: 1,
      resolved: false,
      diagnosedBy: [],
      // Nobody has examined this newborn. Whether the condition is ever noticed
      // is a question for §8's primitives, not for its birth.
      disclosed: false,
      createdSequence: ctx.sequence,
    });
    next = updateInhabitant(next, childId, (i) => ({ ...i, conditions: [conditionId] }));
  }

  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: CREATE.activity,
    actionType: "create_inhabitant",
    // The newborn is not a participant: it did not spend the time, and listing
    // it would occupy it in an activity it cannot leave or be interrupted from.
    participants: [actor.id],
    location: actor.location,
    startedAt: ctx.simTime,
    minutes: CREATE.baseDuration,
    interruption: CREATE.interruption,
    resourceCost: cost,
  }).state;

  const detail: BirthDetail = {
    childId,
    childName: child.displayName,
    generation: child.generation,
    parents: child.parents,
    location: { x: child.location.x, y: child.location.y },
    birthTime: child.birthTime,
    eligibleFrom: endsAt,
    costPaid: normaliseBundle(addBundles(cost, bonus)),
    endowment: normaliseBundle(endowment),
    consumed: normaliseBundle(consumed),
    crowdingMultiplier: multiplier,
    livingBefore,
    minutes: CREATE.baseDuration,
    statedCareMinutesPerDay: input.statedCareMinutesPerDay,
    statement: input.statement ?? null,
    coCreatorsClaimed: [...input.coCreatorIds].sort(),
    process: derivePhysicalProcess({
      actionType: "create_inhabitant",
      actorIds: [actor.id],
      origin: actor.location,
      target: {
        kind: "tile",
        id: null,
        coord: actor.location,
        label: input.proposedName,
      },
      durationMinutes: CREATE.baseDuration,
      materials: cost,
      resultEntityIds: [childId],
    }),
  };

  const event: DerivedEvent = {
    type: "action.create_inhabitant",
    actor: actor.id,
    simTime: ctx.simTime,
    inputs: {
      proposedName: input.proposedName,
      resourcesCommitted: input.resourcesCommitted,
      statedCareMinutesPerDay: input.statedCareMinutesPerDay,
    },
    resolution: detail,
    visibility: { kind: "public" },
  };

  return {
    outcome: { status: "resolved", detail: { ...detail } as Record<string, unknown> },
    state: next,
    events: [event],
  };
};
