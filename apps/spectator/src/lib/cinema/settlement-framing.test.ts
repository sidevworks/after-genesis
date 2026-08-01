import { describe, expect, it } from "vitest";
import type { CameraPose, Chronicle, WorldFrame } from "./types";
import { frameSettlement, settlementBoundsAt } from "./settlement-framing";

const pose: CameraPose = {
  position: { x: 20, y: 10, z: 20 },
  target: { x: 0, y: 1, z: 0 },
  fov: 42,
  shotId: "overview",
  kind: "ESTABLISH",
  cut: false,
};

describe("settlement framing", () => {
  it("scales distance and clearance as a settlement grows", () => {
    const small = frameSettlement(pose, {
      minX: 0, maxX: 2, minY: 0, maxY: 2, centre: { x: 1, y: 1 }, span: 2,
    });
    const large = frameSettlement(pose, {
      minX: 0, maxX: 20, minY: 0, maxY: 14, centre: { x: 10, y: 7 }, span: 20,
    });
    expect(large.position.y).toBeGreaterThan(small.position.y);
    expect(Math.hypot(
      large.position.x - large.target.x,
      large.position.z - large.target.z,
    )).toBeGreaterThan(Math.hypot(
      small.position.x - small.target.x,
      small.position.z - small.target.z,
    ));
    expect(small.position.y).toBeGreaterThanOrEqual(9);
  });

  it("includes completed construction sites in persistent bounds", () => {
    const construction = {
      id: "build", inhabitantId: "a", activityId: "house", sequence: 1,
      actionType: "build", activityState: "building", startTick: 10, endTick: 20,
      canonicalMinutes: 2880,
      from: { x: 12, y: 8 }, to: { x: 12, y: 8 }, focus: null,
      participants: ["a"], disclosure: "disclosed" as const, visibility: "public",
      outcomeStatus: "resolved", detail: {}, caption: "Built.",
    };
    const chronicle = {
      worldId: "w", startTick: 0, endTick: 100,
      tracks: [{ inhabitantId: "a", displayName: "A", refId: null, bornTick: 0, diedTick: null, segments: [construction] }],
      byInhabitant: new Map(), beats: [], cutTicks: [],
    } satisfies Chronicle;
    const frame = {
      tick: 50, day: 1, dayFraction: 0.5,
      actors: [{ inhabitantId: "a", displayName: "A", refId: null, position: { x: 1, y: 1 }, facing: 0, speed: 0, activityState: "idle", actionType: "idle", progress: 0, disclosure: "disclosed", segment: construction, present: true, interpolated: false }],
    } satisfies WorldFrame;
    const bounds = settlementBoundsAt(chronicle, frame)!;
    expect(bounds.minX).toBe(1);
    expect(bounds.maxX).toBe(12);
    expect(bounds.maxY).toBe(8);
  });
});
