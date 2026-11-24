// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Wall-clock pacing for a deterministic simulated timeline.
 *
 * Canonical state never reads this clock. It only decides when to enqueue the
 * next turn; the turn itself still receives an integer `simTime` and remains
 * replayable without the original server clock.
 */
import { simTime, type SimTime } from "@after-genesis/core";

/** Four game hours per real hour: one game minute per fifteen real seconds. */
export const REAL_MILLISECONDS_PER_SIMULATED_MINUTE = 15_000;

export interface TimeScaleAnchor {
  /** Persisted wall-clock epoch for this world, in Unix milliseconds. */
  readonly realAnchorMs: number;
  /** Canonical simulated minute corresponding exactly to `realAnchorMs`. */
  readonly simAnchor: SimTime;
}

/**
 * Converts real time to game time from an immutable anchor.
 *
 * Flooring at the final conversion is intentional. It eliminates cumulative
 * rounding error: after a month, the result is still exactly the same as one
 * conversion from the original anchor rather than a sum of timer deltas.
 */
export class TimeScalingEngine {
  readonly #anchor: TimeScaleAnchor;

  constructor(anchor: TimeScaleAnchor) {
    if (!Number.isSafeInteger(anchor.realAnchorMs) || anchor.realAnchorMs < 0) {
      throw new RangeError("realAnchorMs must be a non-negative safe integer");
    }
    this.#anchor = anchor;
  }

  simulatedNow(realNowMs: number): SimTime {
    if (!Number.isSafeInteger(realNowMs)) throw new RangeError("realNowMs must be a safe integer");
    const elapsedRealMs = Math.max(0, realNowMs - this.#anchor.realAnchorMs);
    return simTime(this.#anchor.simAnchor + Math.floor(elapsedRealMs / REAL_MILLISECONDS_PER_SIMULATED_MINUTE));
  }

  /** The real instant at which a requested simulated minute becomes due. */
  realDueAt(simulatedTime: SimTime): number {
    if (simulatedTime <= this.#anchor.simAnchor) return this.#anchor.realAnchorMs;
    return this.#anchor.realAnchorMs +
      (simulatedTime - this.#anchor.simAnchor) * REAL_MILLISECONDS_PER_SIMULATED_MINUTE;
  }
}
