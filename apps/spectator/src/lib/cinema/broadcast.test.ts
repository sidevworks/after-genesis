// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { ActorSample } from "./types";
import { broadcastStoryFor, processStageAt, readableAction } from "./broadcast";

const actor = {
  inhabitantId: "inh_1",
  displayName: "Aleth",
  actionType: "create_artifact",
  activityState: "crafting",
  progress: 0.52,
  disclosure: "disclosed",
  segment: { caption: "Aleth created a tool." },
} as ActorSample;

describe("broadcast presentation", () => {
  it("maps physical progress onto stable process stages", () => {
    expect(processStageAt("build", 0)).toBe("Approach");
    expect(processStageAt("build", 0.52)).toBe("Work");
    expect(processStageAt("build", 1)).toBe("Complete");
    expect(processStageAt("communicate", 0.5)).toBeNull();
  });

  it("builds a large-label story without inventing withheld details", () => {
    expect(broadcastStoryFor(actor)).toMatchObject({
      actor: "Aleth",
      action: "Create Artifact",
      story: "Aleth created a tool.",
      processStage: "Work",
      disclosed: true,
    });
    expect(broadcastStoryFor({ ...actor, disclosure: "envelope_only" })).toMatchObject({
      action: "Occupied · details withheld",
      processStage: null,
      disclosed: false,
    });
  });

  it("normalises canonical action labels for small screens", () => {
    expect(readableAction("structure.built")).toBe("Structure Built");
  });
});

