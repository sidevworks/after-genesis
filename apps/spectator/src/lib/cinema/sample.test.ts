/**
 * What sampling promises, as tests.
 *
 * Two properties get most of the attention here because they are the ones a
 * renderer silently depends on and a reader cannot check by eye:
 *
 *   - `segmentAt` is a binary search, so it is verified against an exhaustive
 *     linear scan over the real 600-turn track rather than against a handful of
 *     chosen ticks. If the two ever disagree at any tick, the suite says so.
 *   - Sampling is pure, so the same tick sampled twice — and sampled after a
 *     scrub in either direction — must produce the same frame.
 */

import { describe, expect, it } from "vitest";
import runFixture from "../../fixtures/observatory-run.json";
import type { ObservatoryRun } from "../observatory-types";
import { buildChronicle } from "./chronicle";
import { sampleActor, sampleFrame, segmentAt } from "./sample";
import { MINUTES_PER_DAY } from "./types";
import type { ChronicleTrack } from "./types";

const run = runFixture as unknown as ObservatoryRun;
const chronicle = buildChronicle(run);

function trackOf(id: string): ChronicleTrack {
  const track = chronicle.byInhabitant.get(id);
  if (!track) throw new Error(`no track for ${id}`);
  return track;
}

/** The definition `segmentAt` must match: half-open, closed at the very end. */
function linearSegmentAt(track: ChronicleTrack, tick: number) {
  for (const segment of track.segments) {
    if (tick >= segment.startTick && tick < segment.endTick) return segment;
  }
  const last = track.segments[track.segments.length - 1];
  return last && tick === last.endTick ? last : null;
}

/* -------------------------------------------------------------------------- */
/* segmentAt                                                                   */
/* -------------------------------------------------------------------------- */

describe("segmentAt", () => {
  it("agrees with an exhaustive scan at every segment boundary of every track", () => {
    for (const track of chronicle.tracks) {
      for (const segment of track.segments) {
        for (const tick of [
          segment.startTick - 1,
          segment.startTick,
          segment.startTick + 0.5,
          segment.endTick - 0.5,
          segment.endTick,
          segment.endTick + 1,
        ]) {
          expect(segmentAt(track, tick)?.id ?? null, `tick ${tick}`).toBe(
            linearSegmentAt(track, tick)?.id ?? null,
          );
        }
      }
    }
  });

  it("agrees with an exhaustive scan across the whole run at a fine step", () => {
    const track = trackOf("inh_lumen");
    for (let tick = -100; tick <= chronicle.endTick + 100; tick += 7) {
      expect(segmentAt(track, tick)?.id ?? null, `tick ${tick}`).toBe(
        linearSegmentAt(track, tick)?.id ?? null,
      );
    }
  });

  it("gives a boundary tick to the segment that starts there", () => {
    const track = trackOf("inh_ember");
    for (let index = 0; index + 1 < track.segments.length; index += 1) {
      const previous = track.segments[index]!;
      const next = track.segments[index + 1]!;
      expect(next.startTick).toBe(previous.endTick);
      expect(segmentAt(track, previous.endTick)?.id).toBe(next.id);
    }
  });

  it("closes the very last boundary so the final instant still samples", () => {
    const track = trackOf("inh_lumen");
    const last = track.segments[track.segments.length - 1]!;
    expect(segmentAt(track, last.endTick)?.id).toBe(last.id);
    expect(segmentAt(track, last.endTick + 0.0001)).toBeNull();
  });

  it("returns nothing before the track begins", () => {
    const track = trackOf("inh_ember");
    expect(segmentAt(track, track.bornTick - 1)).toBeNull();
    expect(segmentAt(track, track.bornTick)).toBe(track.segments[0]);
  });

  it("skips a zero-length segment rather than returning it", () => {
    // Two activities starting on the same tick: the first is clamped to zero
    // width and can never be the answer, but the search must not stall on it.
    const built = buildChronicle({
      ...run,
      activities: [
        {
          id: "act_1",
          sequence: 1,
          actionType: "wait",
          activityState: "idle",
          participants: ["inh_ember"],
          location: { x: 1, y: 1 },
          startedAt: 100,
          endsAt: 100,
          interruption: "partial_progress_kept",
          open: false,
          contentsDisclosed: false,
        },
        {
          id: "act_2",
          sequence: 2,
          actionType: "wait",
          activityState: "idle",
          participants: ["inh_ember"],
          location: { x: 1, y: 1 },
          startedAt: 100,
          endsAt: 160,
          interruption: "partial_progress_kept",
          open: false,
          contentsDisclosed: false,
        },
      ],
      events: [],
    });
    const track = built.byInhabitant.get("inh_ember")!;
    expect(track.segments.some((segment) => segment.startTick === segment.endTick)).toBe(true);
    expect(segmentAt(track, 100)?.activityId).toBe("act_2");
    expect(segmentAt(track, 159.9)?.activityId).toBe("act_2");
  });

  it("returns null for a track with no segments at all", () => {
    const empty: ChronicleTrack = {
      inhabitantId: "inh_x",
      displayName: "X",
      refId: null,
      bornTick: 0,
      diedTick: null,
      segments: [],
    };
    expect(segmentAt(empty, 0)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* sampleActor                                                                 */
/* -------------------------------------------------------------------------- */

describe("sampleActor", () => {
  const lumen = trackOf("inh_lumen");
  const move = lumen.segments.find((segment) => segment.sequence === 18)!;

  it("interpolates a move linearly between its canonical endpoints", () => {
    expect(move.from).toEqual({ x: 4, y: 0 });
    expect(move.to).toEqual({ x: 5, y: 0 });

    const start = sampleActor(lumen, move.startTick)!;
    const middle = sampleActor(lumen, (move.startTick + move.endTick) / 2)!;
    const end = sampleActor(lumen, move.endTick - 0.0001)!;

    expect(start.position).toEqual({ x: 4, y: 0 });
    expect(middle.position.x).toBeCloseTo(4.5, 10);
    expect(middle.position.y).toBeCloseTo(0, 10);
    expect(end.position.x).toBeCloseTo(5, 3);
    expect(middle.progress).toBeCloseTo(0.5, 10);
  });

  it("follows a disclosed canonical route piece by piece", () => {
    const routed: ChronicleTrack = {
      ...lumen,
      segments: [
        {
          ...move,
          startTick: 100,
          endTick: 140,
          from: { x: 0, y: 0 },
          to: { x: 2, y: 2 },
          route: [
            { x: 0, y: 0 },
            { x: 2, y: 0 },
            { x: 2, y: 2 },
          ],
        },
      ],
    };

    const firstLeg = sampleActor(routed, 110)!;
    const corner = sampleActor(routed, 120)!;
    const secondLeg = sampleActor(routed, 130)!;
    expect(firstLeg.position).toEqual({ x: 1, y: 0 });
    expect(corner.position).toEqual({ x: 2, y: 0 });
    expect(secondLeg.position).toEqual({ x: 2, y: 1 });
    expect(firstLeg.facing).toBeCloseTo(0, 10);
    expect(secondLeg.facing).toBeCloseTo(Math.PI / 2, 10);
    expect(firstLeg.speed).toBeCloseTo(0.1, 10);
  });

  it("marks a sample interpolated only when the endpoints differ", () => {
    expect(sampleActor(lumen, move.startTick + 1)!.interpolated).toBe(true);
    for (const track of chronicle.tracks) {
      for (const segment of track.segments) {
        const sample = sampleActor(track, segment.startTick + (segment.endTick - segment.startTick) / 2);
        if (!sample) continue;
        const moves = segment.from.x !== segment.to.x || segment.from.y !== segment.to.y;
        expect(sample.interpolated, segment.id).toBe(moves);
        if (!moves) expect(sample.position).toEqual(segment.to);
      }
    }
  });

  it("reports speed in tiles per minute along the segment", () => {
    const sample = sampleActor(lumen, move.startTick + 1)!;
    expect(sample.speed).toBeCloseTo(1 / (move.endTick - move.startTick), 10);
    // A stationary segment has no speed at all.
    const idle = lumen.segments.find((segment) => segment.sequence === null)!;
    expect(sampleActor(lumen, idle.startTick)!.speed).toBe(0);
  });

  it("faces the direction of travel while moving", () => {
    const sample = sampleActor(lumen, move.startTick + 1)!;
    expect(sample.facing).toBeCloseTo(Math.atan2(0, 1), 10);
  });

  it("holds the last established facing while stationary", () => {
    const index = lumen.segments.indexOf(move);
    const after = lumen.segments[index + 1]!;
    expect(after.from).toEqual(after.to);
    // Same heading as the move that preceded it, recovered from the record
    // rather than remembered between calls.
    expect(sampleActor(lumen, after.startTick + 0.5)!.facing).toBeCloseTo(
      sampleActor(lumen, move.startTick + 1)!.facing,
      10,
    );
  });

  it("faces a focus tile that differs from the actor's own tile", () => {
    const built = buildChronicle({
      ...run,
      activities: [
        {
          id: "act_1",
          sequence: 1,
          actionType: "gather",
          activityState: "gathering",
          participants: ["inh_ember"],
          location: { x: 5, y: 5 },
          startedAt: 100,
          endsAt: 160,
          interruption: "partial_progress_kept",
          open: false,
          contentsDisclosed: true,
        },
      ],
      events: [
        {
          sequence: 1,
          simTime: 100,
          realTimestamp: "",
          canonicalType: "action.gather",
          actorId: "inh_ember",
          visibility: "local",
          location: { x: 5, y: 5 },
          outcomeStatus: "resolved",
          detail: { resource: "water", amount: 1, from: { x: 5, y: 6 }, terrain: "water" },
          hash: "",
          prevHash: "",
        },
      ],
    });
    const track = built.byInhabitant.get("inh_ember")!;
    const sample = sampleActor(track, 120)!;
    expect(sample.position).toEqual({ x: 5, y: 5 });
    expect(sample.interpolated).toBe(false);
    // Facing +y, toward the tile the water came from.
    expect(sample.facing).toBeCloseTo(Math.atan2(1, 0), 10);
  });

  it("keeps progress inside 0..1 everywhere on every track", () => {
    for (const track of chronicle.tracks) {
      for (const segment of track.segments) {
        for (const tick of [segment.startTick, (segment.startTick + segment.endTick) / 2]) {
          const sample = sampleActor(track, tick);
          if (!sample) continue;
          expect(sample.progress).toBeGreaterThanOrEqual(0);
          expect(sample.progress).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("copies the segment's activity, action type and disclosure verbatim", () => {
    for (const tick of [500, 12_000, 40_000, 70_000]) {
      for (const track of chronicle.tracks) {
        const sample = sampleActor(track, tick);
        if (!sample) continue;
        expect(sample.activityState).toBe(sample.segment.activityState);
        expect(sample.actionType).toBe(sample.segment.actionType);
        expect(sample.disclosure).toBe(sample.segment.disclosure);
        expect(sample.inhabitantId).toBe(track.inhabitantId);
        expect(sample.displayName).toBe(track.displayName);
        expect(sample.refId).toBe(track.refId);
      }
    }
  });

  it("returns null outside the track and reports presence inside it", () => {
    const ember = trackOf("inh_ember");
    expect(sampleActor(ember, -1)).toBeNull();
    expect(sampleActor(ember, chronicle.endTick + 1)).toBeNull();
    expect(sampleActor(ember, 0)!.present).toBe(true);
    expect(sampleActor(ember, chronicle.endTick)!.present).toBe(true);
  });

  it("reports a dead inhabitant as absent while still sampling their track", () => {
    const dead = buildChronicle({
      ...run,
      inhabitants: run.inhabitants.map((inhabitant) =>
        inhabitant.id === "inh_ember" ? { ...inhabitant, status: "dead" } : inhabitant,
      ),
    });
    const track = dead.byInhabitant.get("inh_ember")!;
    expect(track.diedTick).toBe(71_045);
    expect(sampleActor(track, 71_000)!.present).toBe(true);
    const after = sampleActor(track, 72_000)!;
    expect(after.present).toBe(false);
    // History is intact: the segment is still there to be read (claude.md §8).
    expect(after.segment.startTick).toBe(71_045);
  });
});

/* -------------------------------------------------------------------------- */
/* sampleFrame                                                                 */
/* -------------------------------------------------------------------------- */

describe("sampleFrame", () => {
  it("computes the world clock from the tick alone", () => {
    expect(sampleFrame(chronicle, 0).day).toBe(1);
    expect(sampleFrame(chronicle, 0).dayFraction).toBe(0);
    expect(sampleFrame(chronicle, 720).dayFraction).toBeCloseTo(0.5, 10);
    expect(sampleFrame(chronicle, MINUTES_PER_DAY).day).toBe(2);
    expect(sampleFrame(chronicle, MINUTES_PER_DAY).dayFraction).toBe(0);
    expect(sampleFrame(chronicle, 72_000).day).toBe(51);
    expect(sampleFrame(chronicle, 12_345).tick).toBe(12_345);
  });

  it("includes every inhabitant the record covers at that tick", () => {
    const frame = sampleFrame(chronicle, 20_000);
    expect(frame.actors).toHaveLength(3);
    expect(frame.actors.map((actor) => actor.displayName)).toEqual(["Ember", "Aster", "Lumen"]);
    for (const actor of frame.actors) expect(actor.present).toBe(true);
  });

  it("never leaves the world blank inside the exported run", () => {
    // Half of every track is settlement idle rather than a hole, so there is no
    // tick at which the Observatory has nothing to show.
    for (let tick = 0; tick <= chronicle.endTick; tick += 431) {
      const frame = sampleFrame(chronicle, tick);
      expect(frame.actors, `tick ${tick}`).toHaveLength(3);
      for (const actor of frame.actors) {
        expect(actor.disclosure, `tick ${tick}`).not.toBe("unrecorded");
      }
    }
  });

  it("orders actors the same way on every call", () => {
    const first = sampleFrame(chronicle, 33_333).actors.map((actor) => actor.inhabitantId);
    const second = sampleFrame(chronicle, 33_333).actors.map((actor) => actor.inhabitantId);
    expect(first).toEqual(second);
    expect(first).toEqual(chronicle.tracks.map((track) => track.inhabitantId));
  });
});

/* -------------------------------------------------------------------------- */
/* Purity                                                                      */
/* -------------------------------------------------------------------------- */

describe("sampling is pure", () => {
  it("returns equal frames for equal ticks regardless of what was sampled before", () => {
    const forwards = [10_000, 10_500, 11_000, 33_333].map((tick) => sampleFrame(chronicle, tick));
    const backwards = [33_333, 11_000, 10_500, 10_000]
      .map((tick) => sampleFrame(chronicle, tick))
      .reverse();
    expect(JSON.stringify(forwards)).toBe(JSON.stringify(backwards));
  });

  it("does not mutate the chronicle it samples", () => {
    const before = JSON.stringify(chronicle.tracks);
    for (let tick = 0; tick <= chronicle.endTick; tick += 997) sampleFrame(chronicle, tick);
    expect(JSON.stringify(chronicle.tracks)).toBe(before);
  });
});
