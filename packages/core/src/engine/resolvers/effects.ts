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
import { addBundles, coordKey, subtractBundles } from "../../schema/primitives.js";
import { deriveActivityId } from "../../ids.js";
import { addDuration, duration, isNight, type SimTime } from "../../time.js";
import type { Rng } from "../../util/rng.js";
import {
  IDLE_ACTIVITY,
  MAX_SKILL,
  NEED_CEILING,
  clampInt,
  idiv,
  insertSorted,
  normaliseBundle,
  putActivity,
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
export function settleExpiredActivities(state: WorldState, now: SimTime): WorldState {
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
