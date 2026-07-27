/**
 * Simulated time.
 *
 * World time is an integer count of simulated minutes since Genesis. It is not a
 * wall-clock timestamp and has no timezone, no leap seconds and no relationship
 * to real time beyond the scheduler's pacing. Integer minutes keep §15's "world
 * time cannot move backwards" and "sequence numbers are unique and monotonic"
 * cheap to enforce and impossible to violate through rounding.
 *
 * Real timestamps are recorded separately on every event for operational
 * forensics, and are explicitly *not* an input to any rule — a resolver that
 * read the wall clock would be non-replayable.
 */

/** Simulated minutes since Genesis. Always a non-negative safe integer. */
export type SimTime = number & { readonly __brand: "SimTime" };

/** A duration in simulated minutes. May be zero, never negative. */
export type Duration = number & { readonly __brand: "Duration" };

export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
export const MINUTES_PER_DAY = MINUTES_PER_HOUR * HOURS_PER_DAY; // 1440
export const DAYS_PER_YEAR = 365;
export const MINUTES_PER_YEAR = MINUTES_PER_DAY * DAYS_PER_YEAR;

/** The instant of Genesis: day 0, 00:00. */
export const GENESIS_TIME = 0 as SimTime;

export function simTime(minutes: number): SimTime {
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new RangeError(`SimTime must be a non-negative safe integer, received ${minutes}`);
  }
  return minutes as SimTime;
}

export function duration(minutes: number): Duration {
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new RangeError(`Duration must be a non-negative safe integer, received ${minutes}`);
  }
  return minutes as Duration;
}

export const addDuration = (t: SimTime, d: Duration): SimTime => simTime(t + d);
export const minutes = (n: number): Duration => duration(n);
export const hours = (n: number): Duration => duration(n * MINUTES_PER_HOUR);
export const days = (n: number): Duration => duration(n * MINUTES_PER_DAY);

/** Calendar-style breakdown of a simulated instant. */
export interface WorldClock {
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly year: number;
  readonly dayOfYear: number;
}

export function clockOf(t: SimTime): WorldClock {
  const day = Math.floor(t / MINUTES_PER_DAY);
  const withinDay = t % MINUTES_PER_DAY;
  return {
    day,
    hour: Math.floor(withinDay / MINUTES_PER_HOUR),
    minute: withinDay % MINUTES_PER_HOUR,
    year: Math.floor(day / DAYS_PER_YEAR),
    dayOfYear: day % DAYS_PER_YEAR,
  };
}

/** Stable display form, e.g. `Day 42 09:00`. Used in the spectator UI and logs. */
export function formatSimTime(t: SimTime): string {
  const c = clockOf(t);
  const hh = String(c.hour).padStart(2, "0");
  const mm = String(c.minute).padStart(2, "0");
  return `Day ${c.day} ${hh}:${mm}`;
}

/** True during the world's defined night, when rest is cheaper and travel slower. */
export function isNight(t: SimTime): boolean {
  const { hour } = clockOf(t);
  return hour >= 22 || hour < 6;
}
