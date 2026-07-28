/**
 * Sampling — reading a Chronicle at one instant.
 *
 * ## Why this file is written the way it is
 *
 * `sampleFrame` runs once per animation frame, and `sampleActor` runs once per
 * actor per frame. At 60fps with a full settlement that is thousands of calls a
 * second against tracks of five hundred segments each, so two properties are not
 * negotiable:
 *
 *   - **Lookup is logarithmic.** `segmentAt` binary-searches on `startTick`.
 *     A linear scan would be O(segments) per actor per frame and would degrade
 *     as the world's history grows, which is the wrong direction for a world
 *     designed to run for years.
 *   - **Sampling is pure and allocates as little as it can.** Nothing here reads
 *     or writes module state, and a stationary actor's `position` reuses the
 *     segment's own frozen `Vec2` rather than allocating a new one — a moving
 *     actor is the only case that must.
 *
 * Purity matters for more than speed. A sampler that carried state between calls
 * would make the picture depend on playback history: scrubbing backwards would
 * show something different from playing forwards through the same tick. Every
 * value below is a function of `(chronicle, tick)` alone, which is why `facing`
 * is recovered by walking back through the record rather than remembered.
 *
 * This file imports nothing but the Chronicle contract. It has no write path
 * (claude.md §17) and no way to signal the world it is watching (claude.md §20).
 */

import { MINUTES_PER_DAY } from "./types";
import type {
  ActorSample,
  Chronicle,
  ChronicleSegment,
  ChronicleTrack,
  Tick,
  Vec2,
  WorldFrame,
} from "./types";

/** Facing when the record has never given a direction: along +x. */
const DEFAULT_FACING = 0;

/**
 * The index of the segment covering `tick`, or -1.
 *
 * Half-open by construction: a segment covers `[startTick, endTick)`. Because
 * the track is gapless — `previous.endTick === next.startTick` — a tick landing
 * exactly on a boundary belongs to the *next* segment, which is what makes a
 * scrub to a cut show the activity that starts there rather than the one that
 * just finished. The single closed end is the last segment's `endTick`: without
 * it the final instant of the exported world would sample to nothing.
 *
 * The search finds the last segment whose `startTick <= tick`. Zero-length
 * segments (a canonical activity widened to nothing by the overlap clamp in
 * chronicle.ts) share a `startTick` with their successor and are correctly
 * skipped, because the search takes the last such index rather than the first.
 */
function indexAt(track: ChronicleTrack, tick: Tick): number {
  const segments = track.segments;
  let low = 0;
  let high = segments.length - 1;
  let found = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (segment === undefined) break;
    if (segment.startTick <= tick) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (found < 0) return -1;
  const segment = segments[found];
  if (segment === undefined) return -1;
  if (tick < segment.endTick) return found;
  // Past this segment's end. Only the very end of the track is still covered:
  // any earlier segment would have a successor whose startTick is <= tick, and
  // the search would have returned that instead.
  return found === segments.length - 1 && tick === segment.endTick ? found : -1;
}

/** The segment covering `tick`, or null when the track does not reach it. */
export function segmentAt(track: ChronicleTrack, tick: Tick): ChronicleSegment | null {
  const index = indexAt(track, tick);
  return index < 0 ? null : (track.segments[index] ?? null);
}

/**
 * The direction a segment establishes, or null when it establishes none.
 *
 * Travel wins over focus: an inhabitant walking toward a tile they are also
 * looking at is facing where they are going. A focus that coincides with the
 * actor's own position establishes nothing — there is no direction from a point
 * to itself — and falls through, which is the common case for a `gather` taken
 * from the tile underfoot.
 */
function establishedFacing(segment: ChronicleSegment): number | null {
  const { from, to, focus } = segment;
  if (to.x !== from.x || to.y !== from.y) {
    return Math.atan2(to.y - from.y, to.x - from.x);
  }
  if (focus !== null && (focus.x !== to.x || focus.y !== to.y)) {
    return Math.atan2(focus.y - to.y, focus.x - to.x);
  }
  return null;
}

/**
 * Facing at a segment, holding the last direction the record established.
 *
 * An inhabitant who walks east and then rests does not spin to face north; they
 * keep the heading the record last gave them. Rather than carrying that heading
 * in mutable state — which would make the picture depend on how the viewer got
 * to this tick — it is recovered by walking backwards to the nearest segment
 * that establishes one. The walk is short in practice: every `move` and every
 * activity with an off-tile focus terminates it, and a track that establishes no
 * direction at all is one whose inhabitant has never been recorded moving, in
 * which case the default is reached and the answer is the same at every tick.
 */
function facingAt(track: ChronicleTrack, index: number): number {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const segment = track.segments[cursor];
    if (segment === undefined) break;
    const facing = establishedFacing(segment);
    if (facing !== null) return facing;
  }
  return DEFAULT_FACING;
}

/**
 * One inhabitant at one fractional tick, or null when the track does not cover
 * it.
 *
 * `present` and coverage are different questions. A track covers every tick from
 * birth to the end of the exported world, including the stretch after a death —
 * claude.md §8 requires that death remove an inhabitant from the world's
 * activity without removing anything from its history. Those ticks still sample;
 * they report `present: false`, and the renderer draws nothing.
 */
export function sampleActor(track: ChronicleTrack, tick: Tick): ActorSample | null {
  const index = indexAt(track, tick);
  if (index < 0) return null;
  const segment = track.segments[index];
  if (segment === undefined) return null;

  const duration = segment.endTick - segment.startTick;
  // A widened-to-nothing segment cannot be divided through. Progress 0 is the
  // honest answer: no measurable time passes inside it.
  const progress =
    duration > 0 ? Math.min(Math.max((tick - segment.startTick) / duration, 0), 1) : 0;

  const { from, to } = segment;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const interpolated = dx !== 0 || dy !== 0;
  const route = segment.route;
  let routeDistance = 0;
  if (route !== undefined) {
    for (let cursor = 1; cursor < route.length; cursor += 1) {
      const previous = route[cursor - 1];
      const next = route[cursor];
      if (previous !== undefined && next !== undefined) {
        routeDistance += Math.hypot(next.x - previous.x, next.y - previous.y);
      }
    }
  }
  let localFacing: number | null = null;
  // Stationary actors reuse the segment's own coordinate. Vec2 is readonly, so
  // sharing it is safe, and it removes an allocation from the hot path.
  let position: Vec2 = from;
  if (interpolated && route !== undefined && route.length > 1 && routeDistance > 0) {
    let remaining = progress * routeDistance;
    for (let cursor = 1; cursor < route.length; cursor += 1) {
      const previous = route[cursor - 1];
      const next = route[cursor];
      if (previous === undefined || next === undefined) continue;
      const length = Math.hypot(next.x - previous.x, next.y - previous.y);
      if (remaining <= length || cursor === route.length - 1) {
        const along = length > 0 ? Math.min(Math.max(remaining / length, 0), 1) : 0;
        position = {
          x: previous.x + (next.x - previous.x) * along,
          y: previous.y + (next.y - previous.y) * along,
        };
        localFacing = Math.atan2(next.y - previous.y, next.x - previous.x);
        break;
      }
      remaining -= length;
    }
  } else if (interpolated) {
    position = { x: from.x + dx * progress, y: from.y + dy * progress };
  }

  return {
    inhabitantId: track.inhabitantId,
    displayName: track.displayName,
    refId: track.refId,
    position,
    facing: localFacing ?? facingAt(track, index),
    speed:
      interpolated && duration > 0
        ? (routeDistance > 0 ? routeDistance : Math.hypot(dx, dy)) / duration
        : 0,
    activityState: segment.activityState,
    actionType: segment.actionType,
    progress,
    disclosure: segment.disclosure,
    segment,
    present: tick >= track.bornTick && (track.diedTick === null || tick <= track.diedTick),
    interpolated,
  };
}

/**
 * Every inhabitant the chronicle covers at `tick`, plus the world clock.
 *
 * Tracks that do not reach `tick` are omitted rather than represented by a
 * placeholder: before an inhabitant's birth the record does not merely say they
 * were absent, it says nothing about them at all.
 */
export function sampleFrame(chronicle: Chronicle, tick: Tick): WorldFrame {
  const actors: ActorSample[] = [];
  for (const track of chronicle.tracks) {
    const actor = sampleActor(track, tick);
    if (actor !== null) actors.push(actor);
  }
  return {
    tick,
    day: Math.floor(tick / MINUTES_PER_DAY) + 1,
    dayFraction: (tick % MINUTES_PER_DAY) / MINUTES_PER_DAY,
    actors,
  };
}
