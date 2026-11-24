// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Editorial playback rules for turning simulation time into watchable time.
 *
 * The canonical duration remains unchanged. This only controls how quickly the
 * spectator playhead traverses it: a five-minute action must not flash past in
 * 83 ms merely because the surrounding month is playing at 60×.
 */
export interface PlaybackInterval {
  readonly start: number;
  readonly end: number;
}

/** Every recorded physical process receives at least this much screen time. */
export const MIN_ACTION_SCREEN_SECONDS = 3;

export function effectivePlaybackRate(
  tick: number,
  requestedRate: number,
  intervals: readonly PlaybackInterval[],
): number {
  const active = intervals.find((interval) => tick >= interval.start && tick < interval.end);
  if (active === undefined) return requestedRate;
  const duration = Math.max(active.end - active.start, 1);
  return Math.min(requestedRate, duration / MIN_ACTION_SCREEN_SECONDS);
}
