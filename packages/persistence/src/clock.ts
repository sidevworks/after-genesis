// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Clocks (§4A, §16).
 *
 * The engine performs no I/O and reads no wall clock. Real timestamps exist on
 * events for forensics only and are never an input to a rule, which is why the
 * clock is a port: in production it is the system clock, in tests and replay it
 * is a fixed value, and the resulting events are byte-identical either way.
 */
import type { Clock } from "@after-genesis/core";

/** The real clock. The only implementation permitted in production. */
export class SystemClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
}

/**
 * A clock that does not move unless told to.
 *
 * Tests that append events need `realTimestamp` to be stable, otherwise every
 * run produces different event hashes and nothing can be asserted about them.
 * `advance` exists for TTL tests (see `MemoryIdempotencyStore`) where time must
 * pass without the test actually sleeping.
 */
export class FixedClock implements Clock {
  #epochMillis: number;

  constructor(iso: string | number | Date = "2026-01-01T00:00:00.000Z") {
    this.#epochMillis = FixedClock.#toMillis(iso);
  }

  nowIso(): string {
    return new Date(this.#epochMillis).toISOString();
  }

  /** Milliseconds since the Unix epoch, for arithmetic that ISO strings make awkward. */
  nowMillis(): number {
    return this.#epochMillis;
  }

  /** Jump to an absolute instant. */
  set(iso: string | number | Date): void {
    this.#epochMillis = FixedClock.#toMillis(iso);
  }

  /** Move forward by a number of milliseconds. Negative values are refused: a
   * clock that runs backwards would let an expired idempotency claim come back
   * to life. */
  advance(millis: number): void {
    if (!Number.isFinite(millis) || millis < 0) {
      throw new RangeError(`FixedClock.advance requires a non-negative number, received ${millis}`);
    }
    this.#epochMillis += millis;
  }

  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1000);
  }

  static #toMillis(value: string | number | Date): number {
    const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (!Number.isFinite(millis)) {
      throw new RangeError(`FixedClock received an unparseable instant: ${String(value)}`);
    }
    return millis;
  }
}

/**
 * Read a `Clock` as milliseconds since the epoch.
 *
 * The `Clock` port deliberately exposes only an ISO string — a numeric `now()`
 * invites arithmetic on real time inside the engine. TTL bookkeeping genuinely
 * needs the number, so the conversion is explicit and lives here.
 */
export function clockMillis(clock: Clock): number {
  const millis = Date.parse(clock.nowIso());
  if (!Number.isFinite(millis)) {
    throw new RangeError(`Clock returned an unparseable ISO timestamp: ${clock.nowIso()}`);
  }
  return millis;
}
