import { describe, expect, it } from "vitest";
import type { ActorSample, ChronicleSegment } from "../cinema/types";
import { constructionBlockCount, processVisualFor } from "./processes";

function actor(overrides: Partial<ActorSample> = {}): ActorSample {
  const segment: ChronicleSegment = {
    id: "seg-1", inhabitantId: "inh-1", activityId: "act-1", sequence: 1,
    actionType: "build", activityState: "construction", startTick: 10, endTick: 20,
    from: { x: 2, y: 3 }, to: { x: 2, y: 3 }, focus: null, participants: ["inh-1"],
    disclosure: "disclosed", visibility: "public", outcomeStatus: "applied",
    detail: {}, caption: "Canonical build recorded.",
  };
  return {
    inhabitantId: "inh-1", displayName: "One", refId: null,
    position: { x: 2, y: 3 }, facing: 0, speed: 0, activityState: "construction",
    actionType: "build", progress: 0.5, disclosure: "disclosed", segment,
    present: true, interpolated: false, ...overrides,
  };
}

describe("physical process projection", () => {
  it("turns disclosed construction progress into a derived site", () => {
    expect(processVisualFor(actor())).toEqual({
      key: "act-1", kind: "construction", progress: 0.5,
      x: 2, z: 3, resource: null, derived: true,
    });
  });

  it("never depicts a withheld activity's contents", () => {
    expect(processVisualFor(actor({ disclosure: "envelope_only" }))).toBeNull();
  });

  it("reveals construction blocks monotonically and clamps progress", () => {
    expect(constructionBlockCount(-1, 18)).toBe(1);
    expect(constructionBlockCount(0.5, 18)).toBe(9);
    expect(constructionBlockCount(2, 18)).toBe(18);
  });

  it("uses a disclosed gather focus as the resource source", () => {
    const base = actor();
    const segment = {
      ...base.segment, actionType: "gather", activityState: "gathering",
      focus: { x: 5, y: 7 },
    };
    expect(processVisualFor(actor({
      actionType: "gather", activityState: "gathering", segment,
    }))).toMatchObject({ kind: "gathering", x: 5, z: 7 });
  });
});
