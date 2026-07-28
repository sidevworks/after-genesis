/**
 * The director's contract.
 *
 * A shot plan is an *edit* laid over canonical history, so the properties worth
 * pinning are the ones that keep it from becoming a claim:
 *
 *   - it is deterministic, so two spectators watching the same run see the same
 *     film and a description of one describes the other;
 *   - it covers its window exactly, with no strobing and no gaps;
 *   - the camera stays above the ground and outside the subject;
 *   - it never pushes in on an interval the record does not cover.
 *
 * The plan is exercised against the real 600-turn export wherever the export has
 * the shape needed. Two shapes it does not have — multi-participant activities
 * and unrecorded intervals — are covered synthetically, and that gap is
 * deliberately visible here rather than hidden.
 */
import { describe, expect, it } from "vitest";
import runFixture from "../../fixtures/observatory-run.json";
import type { ObservatoryRun } from "../observatory-types";
import { buildChronicle } from "./chronicle";
import {
  MIN_CAMERA_HEIGHT,
  MIN_SHOT_MINUTES,
  planShots,
  resolvePose,
  shotAt,
  twoShotDistance,
} from "./director";
import { sampleFrame } from "./sample";
import type {
  Chronicle,
  ChronicleSegment,
  ChronicleTrack,
  ShotPlan,
  Tick,
} from "./types";

const run = runFixture as unknown as ObservatoryRun;
const chronicle = buildChronicle(run);
const subjectId = run.inhabitants[0]!.id;

/* -------------------------------------------------------------------------- */
/* Synthetic chronicles, for shapes the real export does not contain           */
/* -------------------------------------------------------------------------- */

function segment(
  overrides: Partial<ChronicleSegment> & Pick<ChronicleSegment, "startTick" | "endTick">,
): ChronicleSegment {
  return {
    id: `seg-${overrides.startTick}`,
    inhabitantId: "a",
    activityId: "act-1",
    sequence: 1,
    actionType: "gather",
    activityState: "gathering",
    from: { x: 4, y: 4 },
    to: { x: 4, y: 4 },
    focus: null,
    participants: ["a"],
    disclosure: "disclosed",
    visibility: "local",
    outcomeStatus: "resolved",
    detail: null,
    caption: "caption",
    ...overrides,
  };
}

function track(inhabitantId: string, segments: ChronicleSegment[]): ChronicleTrack {
  return {
    inhabitantId,
    displayName: inhabitantId.toUpperCase(),
    refId: null,
    bornTick: segments[0]?.startTick ?? 0,
    diedTick: null,
    segments,
  };
}

function chronicleOf(tracks: ChronicleTrack[], endTick: Tick): Chronicle {
  return {
    worldId: "W-TEST",
    startTick: 0,
    endTick,
    tracks,
    byInhabitant: new Map(tracks.map((item) => [item.inhabitantId, item])),
    beats: [],
    cutTicks: tracks.flatMap((item) => item.segments.map((s) => s.startTick)).sort((l, r) => l - r),
  };
}

/* -------------------------------------------------------------------------- */

function assertWellFormed(plan: ShotPlan, startTick: Tick, endTick: Tick): void {
  expect(plan.shots.length).toBeGreaterThan(0);
  expect(plan.shots[0]!.startTick).toBe(startTick);
  expect(plan.shots[plan.shots.length - 1]!.endTick).toBe(endTick);

  for (let index = 0; index < plan.shots.length; index += 1) {
    const shot = plan.shots[index]!;
    expect(shot.endTick).toBeGreaterThan(shot.startTick);
    if (index > 0) {
      // Contiguous and non-overlapping: each shot begins where the last ended.
      expect(shot.startTick).toBe(plan.shots[index - 1]!.endTick);
    }
  }
}

describe("a subject plan over the real run", () => {
  const plan = planShots({
    chronicle,
    subjectId,
    startTick: chronicle.startTick,
    endTick: chronicle.endTick,
  });

  it("covers the whole window contiguously", () => {
    assertWellFormed(plan, chronicle.startTick, chronicle.endTick);
  });

  it("never strobes", () => {
    // The final shot may be short only because the window itself ran out.
    const short = plan.shots
      .slice(0, -1)
      .filter((shot) => shot.endTick - shot.startTick < MIN_SHOT_MINUTES);
    expect(short.map((shot) => shot.id)).toEqual([]);
  });

  it("opens on an establishing shot", () => {
    expect(plan.shots[0]!.kind).toBe("ESTABLISH");
  });

  it("states a canonical reason for every shot", () => {
    for (const shot of plan.shots) {
      expect(shot.reason.length).toBeGreaterThan(0);
    }
  });

  it("is byte-identical across two independent plans", () => {
    const again = planShots({
      chronicle,
      subjectId,
      startTick: chronicle.startTick,
      endTick: chronicle.endTick,
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(plan));
  });

  it("resolves exactly one shot at every probe tick", () => {
    const step = (chronicle.endTick - chronicle.startTick) / 500;
    for (let tick = chronicle.startTick; tick <= chronicle.endTick; tick += step) {
      const shot = shotAt(plan, tick);
      expect(shot, `no shot at tick ${tick}`).not.toBeNull();
    }
  });
});

describe("a world-feed plan over the real run", () => {
  const plan = planShots({
    chronicle,
    subjectId: null,
    startTick: chronicle.startTick,
    endTick: chronicle.endTick,
  });

  it("covers the whole window contiguously", () => {
    assertWellFormed(plan, chronicle.startTick, chronicle.endTick);
  });

  it("is deterministic", () => {
    const again = planShots({
      chronicle,
      subjectId: null,
      startTick: chronicle.startTick,
      endTick: chronicle.endTick,
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(plan));
  });

  it("visits more than one inhabitant", () => {
    const subjects = new Set(plan.shots.map((shot) => shot.subjectId));
    expect(subjects.size).toBeGreaterThan(1);
  });
});

describe("resolvePose keeps the camera physically sane", () => {
  const plan = planShots({
    chronicle,
    subjectId,
    startTick: chronicle.startTick,
    endTick: chronicle.endTick,
  });

  it("never descends into the ground, anywhere in the run", () => {
    const step = (chronicle.endTick - chronicle.startTick) / 800;
    for (let tick = chronicle.startTick; tick <= chronicle.endTick; tick += step) {
      const pose = resolvePose(plan, sampleFrame(chronicle, tick), tick);
      expect(pose.position.y).toBeGreaterThanOrEqual(MIN_CAMERA_HEIGHT);
    }
  });

  it("never ends up inside its own subject", () => {
    const step = (chronicle.endTick - chronicle.startTick) / 800;
    for (let tick = chronicle.startTick; tick <= chronicle.endTick; tick += step) {
      const pose = resolvePose(plan, sampleFrame(chronicle, tick), tick);
      const distance = Math.hypot(
        pose.position.x - pose.target.x,
        pose.position.y - pose.target.y,
        pose.position.z - pose.target.z,
      );
      expect(distance).toBeGreaterThan(1);
    }
  });

  it("produces a finite pose at every probe tick", () => {
    const step = (chronicle.endTick - chronicle.startTick) / 400;
    for (let tick = chronicle.startTick; tick <= chronicle.endTick; tick += step) {
      const pose = resolvePose(plan, sampleFrame(chronicle, tick), tick);
      for (const value of [
        pose.position.x,
        pose.position.y,
        pose.position.z,
        pose.target.x,
        pose.target.y,
        pose.target.z,
        pose.fov,
      ]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it("is pure — the same tick always resolves the same pose", () => {
    const frame = sampleFrame(chronicle, 30_000);
    expect(resolvePose(plan, frame, 30_000)).toEqual(resolvePose(plan, frame, 30_000));
  });

  it("raises the cut flag only at the very start of a cut shot", () => {
    const cutShot = plan.shots.find((shot) => shot.transition === "CUT" && shot.startTick > 0);
    expect(cutShot).toBeDefined();
    const start = cutShot!.startTick;
    const atStart = resolvePose(plan, sampleFrame(chronicle, start), start);
    const later = resolvePose(
      plan,
      sampleFrame(chronicle, start + 10),
      start + 10,
    );
    expect(atStart.cut).toBe(true);
    expect(later.cut).toBe(false);
  });
});

describe("unrecorded intervals are framed at a distance", () => {
  // The real export contains no unrecorded segment — every gap between
  // activities is canonically idle. This shape has to be built by hand.
  const unrecorded = chronicleOf(
    [
      track("a", [
        segment({ startTick: 0, endTick: 600, actionType: "gather", activityState: "gathering" }),
        segment({
          id: "seg-gap",
          startTick: 600,
          endTick: 2400,
          actionType: "unrecorded",
          activityState: "unrecorded",
          disclosure: "unrecorded",
          activityId: null,
          sequence: null,
          visibility: null,
          outcomeStatus: null,
          caption: "No canonical record covers this interval.",
        }),
      ]),
    ],
    2400,
  );

  it("never pushes in on an interval the record does not cover", () => {
    const plan = planShots({
      chronicle: unrecorded,
      subjectId: "a",
      startTick: 0,
      endTick: 2400,
    });
    const overGap = plan.shots.filter(
      (shot) => shot.startTick >= 600 && shot.endTick <= 2400,
    );
    expect(overGap.length).toBeGreaterThan(0);
    for (const shot of overGap) {
      expect(shot.kind).not.toBe("CLOSE");
      // Distant framing, not an intimate one: closeness must not read as though
      // it were revealing something the record withholds.
      expect(shot.framing.distance).toBeGreaterThan(15);
    }
  });
});

describe("twoShotDistance frames both participants", () => {
  it("grows with the separation between them", () => {
    expect(twoShotDistance(6, 38)).toBeGreaterThan(twoShotDistance(2, 38));
  });

  it("grows as the lens gets longer", () => {
    // A narrower field of view needs more distance to hold the same width.
    expect(twoShotDistance(4, 20)).toBeGreaterThan(twoShotDistance(4, 60));
  });

  it("stays finite and positive for a zero separation", () => {
    const distance = twoShotDistance(0, 38);
    expect(Number.isFinite(distance)).toBe(true);
    expect(distance).toBeGreaterThan(0);
  });
});

describe("degenerate windows do not produce a broken plan", () => {
  it("returns no shots when the window is empty", () => {
    const plan = planShots({ chronicle, subjectId, startTick: 500, endTick: 500 });
    expect(plan.shots).toEqual([]);
  });

  it("falls back to a reference view when no shot covers the tick", () => {
    const plan = planShots({ chronicle, subjectId, startTick: 500, endTick: 500 });
    const pose = resolvePose(plan, sampleFrame(chronicle, 500), 500);
    expect(pose.kind).toBe("FALLBACK_REFERENCE");
    expect(pose.position.y).toBeGreaterThanOrEqual(MIN_CAMERA_HEIGHT);
  });
});
