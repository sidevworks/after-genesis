/**
 * Shared effects used by every resolver.
 *
 * These functions are where the world's physics actually live: time passing,
 * energy draining, needs rising, an activity opening and closing. They are kept
 * in one place so that no resolver can invent its own version of "how tired you
 * get", which would make the same elapsed minute cost different amounts
 * depending on what you spent it on.
 *
 * Everything here is pure and integer-only.
 */
import type { ActionType, ActivityState, InterruptionPolicy } from "../../schema/action-spec.js";
import type { Coord, ResourceBundle } from "../../schema/primitives.js";
import { addBundles, bundleTotal, coordKey, subtractBundles } from "../../schema/primitives.js";
import { deriveActivityId } from "../../ids.js";
import { addDuration, duration, isNight, type SimTime } from "../../time.js";
import type { Rng } from "../../util/rng.js";
import { advanceHealth } from "../health.js";
import type { DerivedEvent } from "./types.js";
import {
  IDLE_ACTIVITY,
  MAX_SKILL,
  NEED_CEILING,
  clampInt,
  idiv,
  insertSorted,
  normaliseBundle,
  putActivity,
  recordDestroyed,
  sortedValues,
  updateInhabitant,
  type ActivityRecord,
  type Inhabitant,
  type Needs,
  type SkillKind,
  type WorldRules,
  type WorldState,
} from "../state.js";

/* ------------------------------------------------------------------------- */
/* Needs                                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Advance an inhabitant's needs by elapsed simulated minutes (§11B).
 *
 * Needs rise with the clock, not with the action. Waiting is not free: an hour
 * spent idle costs the same hunger as an hour spent gathering. That is what
 * makes "time and attention are scarce canonical resources" (§11A) true rather
 * than decorative.
 */
export function advanceNeeds(needs: Needs, minutes: number, rules: WorldRules): Needs {
  return {
    hunger: clampInt(needs.hunger + idiv(minutes, rules.minutesPerHunger), 0, NEED_CEILING),
    thirst: clampInt(needs.thirst + idiv(minutes, rules.minutesPerThirst), 0, NEED_CEILING),
    fatigue: clampInt(needs.fatigue + idiv(minutes, rules.minutesPerFatigue), 0, NEED_CEILING),
    social: clampInt(needs.social + idiv(minutes, rules.minutesPerSocial), 0, NEED_CEILING),
  };
}

export function withNeed(needs: Needs, key: keyof Needs, delta: number): Needs {
  return { ...needs, [key]: clampInt(needs[key] + delta, 0, NEED_CEILING) };
}

/* ------------------------------------------------------------------------- */
/* Holdings                                                                   */
/* ------------------------------------------------------------------------- */

/** Energy currently held. Energy is the `energy` kind inside `inventory`. */
export const energyOf = (inhabitant: Inhabitant): number => inhabitant.inventory.energy ?? 0;

/**
 * Spend resources from an inventory, or return `null` if they are not all
 * there. Never produces a negative balance (§15) — insufficiency must be
 * handled by the caller as a rejection, not absorbed.
 */
export function spend(inhabitant: Inhabitant, cost: ResourceBundle): Inhabitant | null {
  const remaining = subtractBundles(inhabitant.inventory, cost);
  if (remaining === null) return null;
  // Displayed items must stay backed by what is actually held (§11J).
  const exposed = clampExposed(remaining, inhabitant.exposed);
  return { ...inhabitant, inventory: remaining, exposed };
}

/** Add resources to an inventory. */
export function receive(inhabitant: Inhabitant, gain: ResourceBundle): Inhabitant {
  return { ...inhabitant, inventory: addBundles(inhabitant.inventory, gain) };
}

/**
 * Trim the displayed bundle so it never claims more than is held.
 *
 * Spending down to below what you were openly carrying should reduce what
 * others see, not create a phantom display — see `exposedIsBackedByInventory`.
 */
export function clampExposed(inventory: ResourceBundle, exposed: ResourceBundle): ResourceBundle {
  const out: ResourceBundle = {};
  for (const kind of Object.keys(exposed) as (keyof ResourceBundle)[]) {
    const shown = exposed[kind] ?? 0;
    const held = inventory[kind] ?? 0;
    const value = shown < held ? shown : held;
    if (value > 0) out[kind] = value;
  }
  return normaliseBundle(out);
}

/**
 * The conserved goods that occupy space in a pack.
 *
 * Energy and compute are deliberately absent: they are capacities of a body,
 * not things carried in it, and they have their own ceilings.
 */
export const CARRIED_KINDS: readonly (keyof ResourceBundle)[] = ["food", "water", "wood", "stone"];

/** Total material an inhabitant is carrying, against `rules.carryCapacity`. */
export function carriedTotal(inventory: ResourceBundle): number {
  let total = 0;
  for (const kind of CARRIED_KINDS) total += inventory[kind] ?? 0;
  return total;
}

/** How much more material this inhabitant could pick up. Never negative. */
export function remainingCapacity(inhabitant: Inhabitant, rules: WorldRules): number {
  const free = rules.carryCapacity - carriedTotal(inhabitant.inventory);
  return free > 0 ? free : 0;
}

/**
 * Spoilage of carried food (§5: every resource needs declared sinks).
 *
 * Applied on interval boundaries derived from absolute simulated time rather
 * than from a per-inhabitant timer, so it needs no new field on `Inhabitant`,
 * survives a world resumed from a snapshot, and is a pure function of
 * `(before, now)` — which is what replay requires.
 *
 * Loss is `food / foodSpoilDivisor` per pass under integer division, so a
 * holding smaller than the divisor loses nothing at all. Small stocks keep;
 * large ones do not. Nothing here decides that hoarding is wrong — food simply
 * behaves the way food behaves, and what to do about that is the experiment.
 */
export function spoilCarriedFood(
  state: WorldState,
  before: SimTime,
  now: SimTime,
): { readonly state: WorldState; readonly destroyed: ResourceBundle } {
  const interval = state.rules.minutesPerFoodSpoil;
  if (interval <= 0 || now <= before) return { state, destroyed: {} };
  const passes = idiv(now, interval) - idiv(before, interval);
  if (passes <= 0) return { state, destroyed: {} };

  let next = state;
  let lost = 0;
  for (const inhabitant of sortedValues(state.inhabitants)) {
    if (inhabitant.status !== "alive") continue;
    let food = inhabitant.inventory.food ?? 0;
    for (let pass = 0; pass < passes && food > 0; pass += 1) {
      food -= idiv(food, state.rules.foodSpoilDivisor);
    }
    const spoiled = (inhabitant.inventory.food ?? 0) - food;
    if (spoiled <= 0) continue;
    lost += spoiled;
    next = updateInhabitant(next, inhabitant.id, (current) => ({
      ...current,
      inventory: normaliseBundle({ ...current.inventory, food }),
      exposed: clampExposed(normaliseBundle({ ...current.inventory, food }), current.exposed),
    }));
  }
  if (lost === 0) return { state: next, destroyed: {} };
  return { state: recordDestroyed(next, { food: lost }), destroyed: { food: lost } };
}

/**
 * Spend a cost from what an inhabitant carries, drawing on stores at its feet
 * for whatever will not fit in a pack.
 *
 * Some costs are simply larger than a body: `create_inhabitant` requires 500
 * food, 500 water, 200 wood and 100 stone, and the carrying capacity is 150.
 * Without this, the heaviest and most consequential action in the world would be
 * arithmetically impossible for anyone, forever — which is exactly the class of
 * bug that leaves a world looking alive while being unable to do anything.
 *
 * Reaching a store requires standing on it, so the materials are somewhere real
 * and someone could have taken them first. Structures are drawn in a fixed
 * sorted order so two replays empty the same store first.
 *
 * Returns `null` if hand and stores together fall short, and mutates nothing in
 * that case: a cost is paid entirely or not at all (§15).
 */
export function spendFromHandAndStores(
  state: WorldState,
  inhabitant: Inhabitant,
  cost: ResourceBundle,
): { readonly state: WorldState; readonly inhabitant: Inhabitant } | null {
  const direct = spend(inhabitant, cost);
  if (direct !== null) return { state, inhabitant: direct };

  let owing: ResourceBundle = {};
  for (const kind of Object.keys(cost) as (keyof ResourceBundle)[]) {
    const short = (cost[kind] ?? 0) - (inhabitant.inventory[kind] ?? 0);
    if (short > 0) owing[kind] = short;
  }

  let next = state;
  for (const structure of sortedValues(state.structures)) {
    if (bundleTotal(owing) === 0) break;
    if (
      structure.integrity <= 0 ||
      structure.location.x !== inhabitant.location.x ||
      structure.location.y !== inhabitant.location.y
    ) {
      continue;
    }
    const taken: ResourceBundle = {};
    for (const kind of Object.keys(owing) as (keyof ResourceBundle)[]) {
      const want = owing[kind] ?? 0;
      const have = structure.storage[kind] ?? 0;
      const amount = want < have ? want : have;
      if (amount > 0) taken[kind] = amount;
    }
    if (bundleTotal(taken) === 0) continue;
    const remaining = subtractBundles(structure.storage, taken);
    /* c8 ignore next */
    if (remaining === null) continue;
    next = {
      ...next,
      structures: {
        ...next.structures,
        [structure.id]: { ...structure, storage: normaliseBundle(remaining) },
      },
    };
    owing = subtractBundles(owing, taken) ?? {};
  }

  if (bundleTotal(owing) > 0) return null;

  // Everything drawn from a store is spent immediately, so it never passes
  // through the pack and never has to fit in it.
  const paid = spend(inhabitant, subtractBundles(cost, missingPart(cost, inhabitant)) ?? {});
  /* c8 ignore next */
  if (paid === null) return null;
  return { state: next, inhabitant: paid };
}

/** The part of a cost the inhabitant could not cover from its own inventory. */
function missingPart(cost: ResourceBundle, inhabitant: Inhabitant): ResourceBundle {
  const out: ResourceBundle = {};
  for (const kind of Object.keys(cost) as (keyof ResourceBundle)[]) {
    const short = (cost[kind] ?? 0) - (inhabitant.inventory[kind] ?? 0);
    if (short > 0) out[kind] = short;
  }
  return out;
}

/** Cap energy at the inhabitant's ceiling. Capacity is never created (§11B). */
export function capEnergy(inhabitant: Inhabitant): Inhabitant {
  const energy = energyOf(inhabitant);
  if (energy <= inhabitant.maxEnergy) return inhabitant;
  return {
    ...inhabitant,
    inventory: { ...inhabitant.inventory, energy: inhabitant.maxEnergy },
  };
}

/* ------------------------------------------------------------------------- */
/* Skills                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Practice a skill (§9: "Define skills that improve through practice").
 *
 * Improvement is probabilistic and slows as the skill rises, so expertise is
 * earned by repetition rather than granted by a single lucky action. The draw
 * comes from the turn's stream, so it replays identically.
 */
export function practise(inhabitant: Inhabitant, skill: SkillKind, rng: Rng): Inhabitant {
  const level = inhabitant.skills[skill] ?? 0;
  if (level >= MAX_SKILL) return inhabitant;
  // Chance of a point falls from 1/2 at level 0 to about 1/12 at level 100.
  if (!rng.chance(1, 2 + idiv(level, 10))) return inhabitant;
  return { ...inhabitant, skills: { ...inhabitant.skills, [skill]: level + 1 } };
}

/* ------------------------------------------------------------------------- */
/* Activities                                                                 */
/* ------------------------------------------------------------------------- */

export interface BeginActivityInput {
  readonly state: WorldState;
  readonly sequence: number;
  readonly activityState: ActivityState;
  readonly actionType: ActionType;
  /** Every participant's time is consumed, not just the initiator's (§11J). */
  readonly participants: readonly string[];
  readonly location: Coord;
  readonly startedAt: SimTime;
  readonly minutes: number;
  readonly interruption: InterruptionPolicy;
  readonly resourceCost: ResourceBundle;
}

/**
 * Open a primary activity and place every participant in it (§11A).
 *
 * This is the single mechanism enforcing "an inhabitant cannot occupy two
 * primary activities simultaneously": the turn pipeline refuses to start an
 * action for anyone whose `busyUntil` is in the future, and this function is
 * the only thing that sets `busyUntil`.
 */
export function beginActivity(input: BeginActivityInput): {
  readonly state: WorldState;
  readonly activity: ActivityRecord;
} {
  const endsAt = addDuration(input.startedAt, duration(input.minutes));
  const id = deriveActivityId(input.state.worldId, input.sequence);
  const activity: ActivityRecord = {
    id,
    state: input.activityState,
    actionType: input.actionType,
    participants: [...input.participants].sort(),
    location: { x: input.location.x, y: input.location.y },
    startedAt: input.startedAt,
    endsAt,
    interruption: input.interruption,
    resourceCost: normaliseBundle(input.resourceCost),
    open: true,
    sequence: input.sequence,
  };

  let state = putActivity(input.state, activity);
  for (const participant of activity.participants) {
    state = updateInhabitant(state, participant, (inhabitant) => ({
      ...inhabitant,
      activity: { state: activity.state, activityId: activity.id, busyUntil: endsAt },
      lastActionTime: input.startedAt,
      nextEligibleTime: endsAt,
    }));
  }
  return { state, activity };
}

/**
 * Close every activity whose end time has passed and return its participants to
 * idle.
 *
 * Called before each turn resolves. Without it, finished activities would stay
 * open forever and the single-primary-activity invariant would fire on the
 * second action anyone took.
 */
export function closeExpiredActivities(state: WorldState, now: SimTime): WorldState {
  let next = state;
  for (const activity of sortedValues(state.activities)) {
    if (!activity.open || activity.endsAt > now) continue;
    next = putActivity(next, { ...activity, open: false });
    for (const participant of [...activity.participants].sort()) {
      next = updateInhabitant(next, participant, (inhabitant) =>
        inhabitant.activity.activityId === activity.id
          ? { ...inhabitant, activity: { ...IDLE_ACTIVITY, busyUntil: activity.endsAt } }
          : inhabitant,
      );
    }
  }
  return next;
}

/**
 * Everything the world does to itself at the start of a turn, before the actor
 * acts (§11A, §8).
 *
 * There are exactly three such things, and the order between them matters:
 *
 * 1. Finished activities close, so nobody is killed while still nominally
 *    holding a task they had in fact completed.
 * 2. Carried food spoils, before health is advanced — so an inhabitant that
 *    starves does so against the stock it actually still has, not against one
 *    that had already rotted.
 * 3. Health advances for **every living inhabitant**, not only the actor.
 *
 * Point 2 is the reason this hook exists at all. `advanceNeeds` runs inside a
 * resolver, which means it only ever touches whoever is taking the turn. Decline
 * and death cannot work that way: an inhabitant the scheduler never reaches
 * would be immortal, and mortality would become a function of queue depth. The
 * tick is the one place in the engine that iterates the whole population, and it
 * is deliberately the *only* one — a second such loop elsewhere would be a
 * second, unaudited set of physics.
 *
 * `sequence` is the sequence number the current turn will occupy. Conditions and
 * deaths raised here are recorded against it, which keeps them inside the same
 * atomic state transition as the action that follows — the turn is one event, so
 * everything it caused must share its sequence number.
 *
 * Determinism: pure in `(state, now, sequence)`. No RNG is consulted, so the
 * numbers a resolver draws from `ctx.rng` are unaffected by whether anybody
 * happened to fall ill this turn.
 */
export function worldTick(
  state: WorldState,
  now: SimTime,
  sequence: number = state.sequence + 1,
): { readonly state: WorldState; readonly events: readonly DerivedEvent[] } {
  const settled = closeExpiredActivities(state, now);
  const spoiled = spoilCarriedFood(settled, state.simTime, now);
  return advanceHealth(spoiled.state, now, sequence);
}

/**
 * The world tick, keeping the name and signature every existing caller uses.
 *
 * The derived events are dropped on this path. That is a real limitation and is
 * stated rather than hidden: a death resolved here still changes canonical state
 * — `status`, `deathTime`, `deathSequence` and the causing condition all land in
 * the world and therefore in the turn's `postStateChecksum` and its hash chain —
 * but the death's own `DerivedEvent` reaches the log only once the turn pipeline
 * calls `worldTick` directly and threads the events into the turn's resolution.
 * Nothing is lost from the replayable record either way; what is lost is the
 * human-readable "X died of dehydration" line in the event's `derived` array.
 */
export function settleExpiredActivities(state: WorldState, now: SimTime): WorldState {
  return worldTick(state, now).state;
}

/* ------------------------------------------------------------------------- */
/* Perception bookkeeping                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Record that an inhabitant now knows a set of tiles (§11E: information enters
 * knowledge through observation). Kept sorted so the checksum is stable.
 */
export function learnLocations(
  inhabitant: Inhabitant,
  coords: readonly Coord[],
): Inhabitant {
  let known = inhabitant.knownLocations;
  for (const coord of coords) known = insertSorted(known, coordKey(coord));
  return known === inhabitant.knownLocations ? inhabitant : { ...inhabitant, knownLocations: known };
}

/* ------------------------------------------------------------------------- */
/* Time of day                                                                */
/* ------------------------------------------------------------------------- */

/** Night slows travel and deepens rest. Re-exported so resolvers share one source. */
export const isNightAt = (t: SimTime): boolean => isNight(t);

/**
 * Everything an inhabitant can lay hands on without moving: its pack plus the
 * stores standing on its own tile.
 *
 * Used where a rule asks "can this be afforded?" rather than "is this carried?".
 * The two questions became different the moment carrying capacity existed, and
 * conflating them is what would make a creator with a full storehouse count as
 * destitute.
 */
export function reachableHoldings(state: WorldState, inhabitant: Inhabitant): ResourceBundle {
  let total = inhabitant.inventory;
  for (const structure of sortedValues(state.structures)) {
    if (
      structure.integrity > 0 &&
      structure.location.x === inhabitant.location.x &&
      structure.location.y === inhabitant.location.y
    ) {
      total = addBundles(total, structure.storage);
    }
  }
  return total;
}
