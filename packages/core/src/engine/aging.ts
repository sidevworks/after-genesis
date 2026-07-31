/**
 * Lifespan and elder efficiency are deterministic world physics.
 *
 * Age is deliberately derived from `birthTime` rather than persisted as a
 * second counter. A saved `ageDays` field could drift from elapsed simulation
 * time after a replay or a delayed scheduler; elapsed simulated minutes cannot.
 */
import { Rng } from "../util/rng.js";
import { MINUTES_PER_DAY, type SimTime } from "../time.js";
import { terminateInhabitant } from "./lifecycle.js";
import { idiv, idivCeil, sortedValues, updateInhabitant, type Inhabitant, type WorldState } from "./state.js";
import type { DerivedEvent } from "./resolvers/types.js";

export const MIN_LIFESPAN_DAYS = 40;
export const MAX_LIFESPAN_DAYS = 48;
export const ELDER_THRESHOLD_PERCENT = 85;

/** Elder bodies need 25% more energy for physical work. */
export const ELDER_ENERGY_NUMERATOR = 5;
export const ELDER_ENERGY_DENOMINATOR = 4;
/** Elder gathering output is 75% of the normal output, rounded down but nonzero. */
export const ELDER_YIELD_NUMERATOR = 3;
export const ELDER_YIELD_DENOMINATOR = 4;

/** A birth draw isolated from turn/action RNG streams, so it is replay-stable. */
export function lifespanForBirth(seed: string, inhabitantId: string, sequence: number): number {
  return Rng.derive(seed, "lifespan", inhabitantId, String(sequence)).nextInt(
    MIN_LIFESPAN_DAYS,
    MAX_LIFESPAN_DAYS,
  );
}

/** Safe reader for pre-lifespan development snapshots during the schema transition. */
export function lifespanDaysOf(inhabitant: Inhabitant): number {
  if (
    Number.isSafeInteger(inhabitant.lifecycle?.maxLifespanTicks) &&
    inhabitant.lifecycle.maxLifespanTicks >= MIN_LIFESPAN_DAYS * MINUTES_PER_DAY &&
    inhabitant.lifecycle.maxLifespanTicks <= MAX_LIFESPAN_DAYS * MINUTES_PER_DAY
  ) {
    return idiv(inhabitant.lifecycle.maxLifespanTicks, MINUTES_PER_DAY);
  }
  return Number.isSafeInteger(inhabitant.maxLifespanDays) &&
    inhabitant.maxLifespanDays >= MIN_LIFESPAN_DAYS &&
    inhabitant.maxLifespanDays <= MAX_LIFESPAN_DAYS
    ? inhabitant.maxLifespanDays
    : 44;
}

/** Completed calendar days of life at a canonical instant. */
export function ageDaysAt(inhabitant: Inhabitant, now: SimTime): number {
  return idiv(Math.max(0, now - (inhabitant.lifecycle?.birthTick ?? inhabitant.birthTime)), MINUTES_PER_DAY);
}

/** Whether an alive inhabitant has crossed the 85% elder threshold. */
export function isElderAt(inhabitant: Inhabitant, now: SimTime): boolean {
  if (inhabitant.status !== "alive") return false;
  const ageMinutes = Math.max(0, now - (inhabitant.lifecycle?.birthTick ?? inhabitant.birthTime));
  const lifespanTicks = inhabitant.lifecycle?.maxLifespanTicks ?? lifespanDaysOf(inhabitant) * MINUTES_PER_DAY;
  return ageMinutes * 100 >= lifespanTicks * ELDER_THRESHOLD_PERCENT;
}

export function elderEnergyCost(inhabitant: Inhabitant, now: SimTime, baseEnergy: number): number {
  if (!isElderAt(inhabitant, now) || baseEnergy <= 0) return baseEnergy;
  return idivCeil(baseEnergy * ELDER_ENERGY_NUMERATOR, ELDER_ENERGY_DENOMINATOR);
}

export function elderGatherYield(inhabitant: Inhabitant, now: SimTime, baseYield: number): number {
  if (!isElderAt(inhabitant, now) || baseYield <= 0) return baseYield;
  return Math.max(1, idiv(baseYield * ELDER_YIELD_NUMERATOR, ELDER_YIELD_DENOMINATOR));
}

/** Apply mandatory age expiry before the next model-selected action. */
export function advanceAging(
  state: WorldState,
  now: SimTime,
  sequence: number,
): { readonly state: WorldState; readonly events: readonly DerivedEvent[] } {
  let next = state;
  const events: DerivedEvent[] = [];
  for (const inhabitant of sortedValues(state.inhabitants)) {
    if (inhabitant.status !== "alive") continue;
    const elder = isElderAt(inhabitant, now);
    if (elder && !inhabitant.lifecycle.isElder) {
      next = updateInhabitant(next, inhabitant.id, (current) => ({
        ...current,
        lifecycle: { ...current.lifecycle, isElder: true },
      }));
      events.push({
        type: "inhabitant.became_elder",
        actor: inhabitant.id,
        simTime: now,
        inputs: {},
        resolution: { ageDays: ageDaysAt(inhabitant, now), maxLifespanDays: lifespanDaysOf(inhabitant) },
        visibility: { kind: "public" },
      });
    }
    const lifespanTicks = inhabitant.lifecycle.maxLifespanTicks;
    if (now - inhabitant.lifecycle.birthTick < lifespanTicks) continue;
    const terminated = terminateInhabitant(next, inhabitant.id, now, sequence);
    if (terminated === null) continue;
    next = terminated.state;
    events.push({
      type: "inhabitant.died",
      actor: inhabitant.id,
      simTime: now,
      inputs: { cause: "age_expiry" },
      resolution: {
        cause: "age_expiry",
        ageDays: ageDaysAt(inhabitant, now),
        maxLifespanDays: lifespanDaysOf(inhabitant),
        deathTime: now,
        deathSequence: sequence,
        remainsId: terminated.remainsId,
        location: terminated.location,
      },
      visibility: { kind: "local", x: terminated.location.x, y: terminated.location.y },
    });
  }
  return { state: next, events };
}

/** Fill missing lifespan values on legacy snapshots using the same birth draw. */
export function normaliseLifespans(state: WorldState): WorldState {
  let next = state;
  for (const inhabitant of sortedValues(state.inhabitants)) {
    const validLifecycle = Number.isSafeInteger(inhabitant.lifecycle?.birthTick) &&
      Number.isSafeInteger(inhabitant.lifecycle?.maxLifespanTicks) &&
      inhabitant.lifecycle.maxLifespanTicks >= MIN_LIFESPAN_DAYS * MINUTES_PER_DAY &&
      inhabitant.lifecycle.maxLifespanTicks <= MAX_LIFESPAN_DAYS * MINUTES_PER_DAY;
    if (validLifecycle) continue;
    const days = lifespanForBirth(state.seed, inhabitant.id, inhabitant.creationSequence);
    next = updateInhabitant(next, inhabitant.id, (current) => ({
      ...current,
      maxLifespanDays: days,
      lifecycle: {
        birthTick: current.birthTime,
        maxLifespanTicks: days * MINUTES_PER_DAY,
        isElder: isElderAt(current, state.simTime),
      },
    }));
  }
  return next;
}
