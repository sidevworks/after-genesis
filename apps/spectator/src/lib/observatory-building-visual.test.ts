// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { SceneReference } from "./observatory-types";
import { buildingConstructionState } from "./observatory-building-visual";

const reference = (
  refId: string,
  activity: SceneReference["activity"] = null,
): SceneReference => ({
  refId: refId as SceneReference["refId"],
  transform: {
    position: { x: 2, y: 0, z: 3 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  },
  representation: {
    kind: "constructed_structure",
    visualSeed: "abc",
    componentRefs: [],
    material: "home",
  },
  activity,
  cameraAnchors: [],
  capabilities: {},
  epistemicLabel: "CANONICAL_FACT",
});

describe("Observatory building construction visuals", () => {
  it("treats an inactive structure as complete", () => {
    const building = reference("W001:OBJ:home");
    expect(buildingConstructionState(building, [building])).toEqual({
      active: false,
      progress: 1,
    });
  });

  it("reads clamped progress from an actor targeting the structure", () => {
    const building = reference("W001:OBJ:home");
    const builder = reference("W001:ENT:builder", {
      actionRef: "W001:ACT:build" as SceneReference["refId"],
      primitive: "build",
      targetRefs: [building.refId],
      progress: 1.4,
    });
    expect(buildingConstructionState(building, [building, builder])).toEqual({
      active: true,
      progress: 1,
    });
  });

  it("does not invent progress when an active build has none", () => {
    const building = reference("W001:OBJ:home", {
      actionRef: "W001:ACT:build" as SceneReference["refId"],
      primitive: "construction",
      targetRefs: [],
      progress: null,
    });
    expect(buildingConstructionState(building, [building])).toEqual({
      active: true,
      progress: 0,
    });
  });
});
