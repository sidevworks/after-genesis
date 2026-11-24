// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { derivePhysicalProcess, PhysicalProcessSchema } from "./physical-process.js";

describe("physical process protocol", () => {
  it("derives stable contiguous stages and preserves the existing action name", () => {
    const input = {
      actionType: "craft",
      actorIds: ["inh_a"],
      origin: { x: 2, y: 3 },
      target: { kind: "artifact" as const, id: "art_1", coord: { x: 2, y: 3 }, label: "axe" },
      durationMinutes: 45,
      materials: { wood: 2, stone: 1 },
      resultEntityIds: ["art_1"],
    };
    const first = derivePhysicalProcess(input);
    const second = derivePhysicalProcess(input);

    expect(second).toEqual(first);
    expect(first.actionType).toBe("craft");
    expect(first.stages.map((stage) => stage.kind)).toEqual([
      "approach",
      "prepare",
      "work",
      "transfer_assemble",
      "complete",
    ]);
    expect(first.stages[0].startMinute).toBe(0);
    expect(first.stages.at(-1)?.endMinute).toBe(45);
    expect(first.stages.at(-1)?.progressTo).toBe(100);
    expect(PhysicalProcessSchema.parse(first)).toEqual(first);
  });

  it("copies input collections so later mutation cannot change the record", () => {
    const materials = { wood: 3 };
    const process = derivePhysicalProcess({
      actionType: "build",
      actorIds: ["inh_a"],
      origin: { x: 0, y: 0 },
      target: { kind: "structure", id: "str_1", coord: { x: 1, y: 0 }, label: "shelter" },
      durationMinutes: 60,
      materials,
    });
    materials.wood = 9;
    expect(process.materials).toEqual({ wood: 3 });
  });
});
