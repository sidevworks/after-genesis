// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import world from "./world.json";

const MONTH_END = 30 * 24 * 60;
const month = world.events.filter((event) => event.simTime < MONTH_END);

describe("thirty-day physical village fixture", () => {
  it("grows to five functional structures and several inhabitants", () => {
    const structures = world.map.structures.filter((structure) => structure.builtAt < MONTH_END);
    expect(structures.length).toBeGreaterThanOrEqual(5);
    expect(new Set(structures.map((structure) => structure.kind)).size).toBeGreaterThanOrEqual(5);
    expect(world.inhabitants.filter((inhabitant) => inhabitant.birthSimTime < MONTH_END).length)
      .toBeGreaterThanOrEqual(8);
  });

  it("records a repeated two-way logistics route", () => {
    const moves = month.filter((event) => event.type === "move");
    const outbound = moves.filter((event) =>
      event.inputs.fromX === 13 && event.inputs.fromY === 17 &&
      event.inputs.toX === 15 && event.inputs.toY === 16);
    const returns = moves.filter((event) =>
      event.inputs.fromX === 15 && event.inputs.fromY === 16 &&
      event.inputs.toX === 13 && event.inputs.toY === 17);
    expect(outbound.length).toBeGreaterThanOrEqual(4);
    expect(returns.length).toBeGreaterThanOrEqual(4);
  });

  it("contains a complete gather-deliver-stockpile-build-craft-trade chain", () => {
    const types = new Set(month.map((event) => event.type));
    for (const type of [
      "gather",
      "resource.delivered",
      "resource.stockpiled",
      "structure.built",
      "artifact.created",
      "transfer.executed",
    ]) {
      expect(types.has(type)).toBe(true);
    }
    expect(month.filter((event) => event.type === "resource.delivered").length)
      .toBeGreaterThanOrEqual(4);
  });
});
