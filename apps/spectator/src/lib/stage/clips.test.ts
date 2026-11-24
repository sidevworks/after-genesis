// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * The clip suite.
 *
 * Animation is the part of this renderer a reader judges instantly and a test
 * usually cannot. So this suite does not try to assert that a walk looks good;
 * it asserts the properties that, if broken, would make it look *wrong* in a
 * way nobody notices until it ships:
 *
 *   - every clip in the cinema contract exists,
 *   - every clip closes its loop, so nothing snaps once per cycle,
 *   - every clip is continuous, so nothing teleports mid-cycle,
 *   - every joint stays inside a stated anatomical range, so no body inverts,
 *   - every clip is deterministic, so the same sim minute always looks the same.
 *
 * And one assertion that is not about looks at all: the `undisclosed` posture
 * has no shape. That is the privacy requirement from claude.md §11E and §12
 * written down as a test, because a comment asking a future editor not to give
 * withheld time a readable body would not survive a tuning pass.
 */

import { describe, expect, it } from "vitest";
import type { ClipName } from "../cinema/types";
import {
  CLIP_NAMES,
  JOINT_LIMITS,
  LIMIT_OF,
  REFERENCE_WALK_SPEED,
  poseFor,
  strideCount,
  wrapPhase,
  type ActorPose,
  type Joint,
} from "./clips";

/**
 * The clip list, copied from `cinema/types.ts` by hand on purpose. If someone
 * adds a clip to the contract, this literal is what notices.
 */
const CONTRACT_CLIPS: readonly ClipName[] = [
  "idle",
  "walk",
  "harvest",
  "drink",
  "eat",
  "sleep",
  "sit",
  "talk",
  "listen",
  "build",
  "craft",
  "write",
  "read",
  "teach",
  "study",
  "examine",
  "carry",
  "reach",
  "perform",
  "guard",
  "restrained",
  "undisclosed",
  "unknown",
];

const JOINT_KEYS = [
  "root",
  "rootTilt",
  "hips",
  "torso",
  "head",
  "armL",
  "armR",
  "legL",
  "legR",
] as const;

type JointKey = (typeof JOINT_KEYS)[number];

/** Speeds worth exercising: stationary, ordinary walk, and hurrying. */
const SPEEDS = [0, REFERENCE_WALK_SPEED / 2, REFERENCE_WALK_SPEED, REFERENCE_WALK_SPEED * 3];

function channels(pose: ActorPose): number[] {
  const out: number[] = [];
  for (const key of JOINT_KEYS) {
    const j: Joint = pose[key];
    out.push(j.x, j.y, j.z);
  }
  return out;
}

function sample(clip: ClipName, steps: number, speed: number): ActorPose[] {
  const frames: ActorPose[] = [];
  for (let i = 0; i <= steps; i += 1) frames.push(poseFor(clip, i / steps, speed));
  return frames;
}

describe("the clip table covers the cinema contract", () => {
  it("implements exactly the clips the contract declares", () => {
    expect([...CLIP_NAMES].sort()).toEqual([...CONTRACT_CLIPS].sort());
  });

  it("returns a pose for every clip at every speed", () => {
    for (const clip of CONTRACT_CLIPS) {
      for (const speed of SPEEDS) {
        for (const value of channels(poseFor(clip, 0.37, speed))) {
          expect(Number.isFinite(value), `${clip} produced a non-finite channel`).toBe(true);
        }
      }
    }
  });
});

describe("every clip is a closed, continuous, deterministic loop", () => {
  it("returns the same pose for the same arguments", () => {
    for (const clip of CONTRACT_CLIPS) {
      const a = channels(poseFor(clip, 0.413, REFERENCE_WALK_SPEED));
      const b = channels(poseFor(clip, 0.413, REFERENCE_WALK_SPEED));
      expect(b, `${clip} is not deterministic`).toEqual(a);
    }
  });

  it("ends a cycle where it began", () => {
    for (const clip of CONTRACT_CLIPS) {
      for (const speed of SPEEDS) {
        const start = channels(poseFor(clip, 0, speed));
        const end = channels(poseFor(clip, 1, speed));
        for (let i = 0; i < start.length; i += 1) {
          expect(
            Math.abs(end[i]! - start[i]!),
            `${clip} channel ${i} jumps ${start[i]} → ${end[i]} across the wrap`,
          ).toBeLessThan(1e-9);
        }
      }
    }
  });

  it("never jumps between adjacent frames", () => {
    // 1/512 of a cycle is a far finer step than playback ever takes, so a
    // discontinuity of more than a tenth of a radian here is a genuine break
    // rather than a fast motion. Violations are collected rather than asserted
    // one at a time: the sweep is a million channel comparisons wide.
    const steps = 512;
    const breaks: string[] = [];
    for (const clip of CONTRACT_CLIPS) {
      for (const speed of SPEEDS) {
        const frames = sample(clip, steps, speed);
        for (let f = 1; f < frames.length; f += 1) {
          const previous = channels(frames[f - 1]!);
          const current = channels(frames[f]!);
          for (let i = 0; i < current.length; i += 1) {
            if (Math.abs(current[i]! - previous[i]!) >= 0.1) {
              breaks.push(`${clip}@${speed} channel ${i} jumps at phase ${f / steps}`);
            }
          }
        }
      }
    }
    expect(breaks.slice(0, 8)).toEqual([]);
  });

  it("treats phase as periodic outside 0..1", () => {
    expect(wrapPhase(1.25)).toBeCloseTo(0.25, 12);
    expect(wrapPhase(-0.25)).toBeCloseTo(0.75, 12);
    expect(wrapPhase(Number.NaN)).toBe(0);
    for (const clip of CONTRACT_CLIPS) {
      expect(channels(poseFor(clip, 3.25, REFERENCE_WALK_SPEED))).toEqual(
        channels(poseFor(clip, 0.25, REFERENCE_WALK_SPEED)),
      );
    }
  });
});

describe("no clip poses a body outside its stated range", () => {
  it("keeps every channel inside JOINT_LIMITS", () => {
    const violations: string[] = [];
    for (const clip of CONTRACT_CLIPS) {
      for (const speed of SPEEDS) {
        for (const pose of sample(clip, 128, speed)) {
          for (const key of JOINT_KEYS) {
            const limit = JOINT_LIMITS[LIMIT_OF[key as JointKey]]!;
            const j: Joint = pose[key];
            for (const axis of ["x", "y", "z"] as const) {
              if (j[axis] < limit[axis][0] || j[axis] > limit[axis][1]) {
                violations.push(
                  `${clip}.${key}.${axis} = ${j[axis]} outside ${limit[axis].join("..")}`,
                );
              }
            }
          }
        }
      }
    }
    expect(violations.slice(0, 8)).toEqual([]);
  });
});

describe("walk is a real gait", () => {
  it("swings each arm opposite the leg on the same side", () => {
    // Contralateral swing is the single feature that separates a walk from a
    // marching toy. Sampled off the zero crossings so both are clearly signed.
    for (const phase of [0.1, 0.2, 0.35, 0.6, 0.85]) {
      const pose = poseFor("walk", phase, REFERENCE_WALK_SPEED);
      expect(Math.sign(pose.armL.x)).toBe(-Math.sign(pose.legL.x));
      expect(Math.sign(pose.armR.x)).toBe(-Math.sign(pose.legR.x));
      expect(Math.sign(pose.legL.x)).toBe(-Math.sign(pose.legR.x));
    }
  });

  it("takes more strides per cycle as speed rises, in whole strides", () => {
    const counts = SPEEDS.map((s) => strideCount(s));
    for (const count of counts) expect(Number.isInteger(count)).toBe(true);
    expect(strideCount(0)).toBe(1);
    expect(strideCount(REFERENCE_WALK_SPEED)).toBeGreaterThan(strideCount(0));
    expect(strideCount(REFERENCE_WALK_SPEED * 10)).toBe(4);
    // A fractional stride count would leave the legs mid-swing at the wrap.
    expect(strideCount(REFERENCE_WALK_SPEED * 0.37)).toBe(Math.round(strideCount(REFERENCE_WALK_SPEED * 0.37)));
  });

  it("swings wider when moving faster", () => {
    const slow = Math.max(...sample("walk", 64, REFERENCE_WALK_SPEED / 4).map((p) => Math.abs(p.legL.x)));
    const fast = Math.max(...sample("walk", 64, REFERENCE_WALK_SPEED * 2).map((p) => Math.abs(p.legL.x)));
    expect(fast).toBeGreaterThan(slow);
  });

  it("bobs the hips upward only", () => {
    for (const pose of sample("walk", 64, REFERENCE_WALK_SPEED)) {
      expect(pose.root.y).toBeGreaterThanOrEqual(0);
      expect(pose.root.y).toBeLessThan(0.08);
    }
  });
});

describe("task clips have the shape their action implies", () => {
  it("harvest crouches at mid-cycle and stands at the ends", () => {
    const low = poseFor("harvest", 0.5, 0);
    expect(low.root.y).toBeLessThan(-0.2);
    expect(low.armL.x).toBeGreaterThan(1);
    expect(low.torso.x).toBeGreaterThan(0.1);
    expect(poseFor("harvest", 0, 0).root.y).toBeCloseTo(0, 6);
  });

  it("sleep lies the figure down and rests it on the ground", () => {
    const pose = poseFor("sleep", 0.25, 0);
    expect(pose.rootTilt.x).toBeLessThan(-1.5);
    expect(pose.root.y).toBeLessThan(-0.5);
  });

  it("sit lifts the thighs forward without lifting the figure", () => {
    const pose = poseFor("sit", 0.5, 0);
    expect(pose.legL.x).toBeGreaterThan(1);
    expect(pose.legR.x).toBeGreaterThan(1);
    expect(pose.root.y).toBeLessThan(-0.2);
  });

  it("talk gestures more than listen, and both stay subtle", () => {
    const armRange = (clip: ClipName): number => {
      const values = sample(clip, 128, 0).map((p) => p.armR.x);
      return Math.max(...values) - Math.min(...values);
    };
    expect(armRange("talk")).toBeGreaterThan(armRange("listen"));
    // "Subtle" is the requirement for both: neither may throw the arm around.
    expect(armRange("talk")).toBeLessThan(0.8);
    for (const pose of sample("listen", 64, 0)) {
      expect(Math.abs(pose.head.y)).toBeLessThan(0.2);
    }
  });

  it("build drives a swing down through the whole body", () => {
    const raised = poseFor("build", 0, 0);
    const struck = poseFor("build", 0.5, 0);
    expect(raised.armL.x).toBeLessThan(-1);
    expect(struck.armL.x).toBeGreaterThan(0);
    expect(struck.torso.x).toBeGreaterThan(raised.torso.x);
  });

  it("reach extends and withdraws one arm", () => {
    expect(poseFor("reach", 0.5, 0).armR.x).toBeGreaterThan(poseFor("reach", 0, 0).armR.x + 0.5);
  });
});

/* -------------------------------------------------------------------------- */
/* The privacy assertion                                                       */
/* -------------------------------------------------------------------------- */

describe("undisclosed depicts occupancy and nothing else", () => {
  const PHASES = Array.from({ length: 257 }, (_, i) => i / 256);

  it("holds every joint at exactly zero at every phase", () => {
    // claude.md §11E, §12: withheld contents may not be given a readable body.
    // Any non-zero joint here would be the renderer guessing at an activity the
    // canonical record deliberately did not disclose.
    for (const phase of PHASES) {
      for (const speed of SPEEDS) {
        const pose = poseFor("undisclosed", phase, speed);
        for (const key of JOINT_KEYS) {
          if (key === "root") continue;
          const j: Joint = pose[key];
          expect([j.x, j.y, j.z], `undisclosed.${key} moved at phase ${phase}`).toEqual([0, 0, 0]);
        }
      }
    }
  });

  it("moves only vertically, and only by about a centimetre", () => {
    for (const phase of PHASES) {
      const pose = poseFor("undisclosed", phase, 0);
      expect(pose.root.x).toBe(0);
      expect(pose.root.z).toBe(0);
      expect(pose.root.y).toBeGreaterThanOrEqual(0);
      expect(pose.root.y).toBeLessThanOrEqual(0.02);
    }
  });

  it("never puts anything in the hands", () => {
    for (const phase of PHASES) {
      expect(poseFor("undisclosed", phase, 0).showProp).toBe(false);
    }
    // `unknown` withholds the prop too: an unrecorded interval is no more
    // licence to depict an object than a withheld one is.
    expect(poseFor("unknown", 0.3, 0).showProp).toBe(false);
    expect(poseFor("idle", 0.3, 0).showProp).toBe(true);
  });

  it("is distinguishable from every other clip", () => {
    // Each other clip must articulate *something* at some phase, or it would be
    // indistinguishable on screen from withheld time — which would quietly
    // upgrade `envelope_only` into a depiction, the exact confusion the
    // disclosure levels exist to prevent.
    for (const clip of CONTRACT_CLIPS) {
      if (clip === "undisclosed") continue;
      const articulates = PHASES.some((phase) => {
        const pose = poseFor(clip, phase, REFERENCE_WALK_SPEED);
        return JOINT_KEYS.some((key) => {
          if (key === "root") return false;
          const j: Joint = pose[key];
          return Math.abs(j.x) > 1e-6 || Math.abs(j.y) > 1e-6 || Math.abs(j.z) > 1e-6;
        });
      });
      expect(articulates, `${clip} is posturally identical to undisclosed`).toBe(true);
    }
  });

  it("does not share a silhouette with unknown", () => {
    const withheld = channels(poseFor("undisclosed", 0.3, 0));
    const unrecorded = channels(poseFor("unknown", 0.3, 0));
    expect(unrecorded).not.toEqual(withheld);
  });
});
