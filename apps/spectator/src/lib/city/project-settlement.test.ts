// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { SettlementProjectionSource } from "./project-settlement";
import { projectSettlementAt, rasterizeTravel } from "./project-settlement";

const source: SettlementProjectionSource = {
  map: {
    tiles: [
      { x: 0, y: 0, terrain: "forest", fertility: 0.5, deposit: { resource: "wood", remaining: 10 } },
      { x: 1, y: 0, terrain: "plains", fertility: 0.2 },
    ],
    structures: [{
      id: "STR-1",
      name: "Store",
      kind: "store",
      at: { x: 1, y: 0 },
      ownerId: "INH-1",
      ownerKind: "inhabitant",
      builtAt: 20,
      builtByEvent: "EV-2",
      condition: 0.4,
      capacity: 20,
    }],
  },
  events: [
    { sequence: 1, simTime: 10, type: "move", location: { x: 1, y: 0 }, resolution: "applied", inputs: { fromX: 0, fromY: 0, toX: 1, toY: 0 } },
    { sequence: 2, simTime: 15, type: "gather", location: { x: 0, y: 0 }, resolution: "applied", inputs: { resource: "wood", quantity: 3 } },
    { sequence: 3, simTime: 25, type: "structure.damaged", location: { x: 1, y: 0 }, resolution: "applied", inputs: { structureId: "STR-1", condition: 0.7 } },
    { sequence: 4, simTime: 30, type: "stockpile.deposit", location: { x: 1, y: 0 }, resolution: "applied", inputs: { structureId: "STR-1", resources: { wood: 2 } } },
    { sequence: 5, simTime: 40, type: "move", location: { x: 1, y: 0 }, resolution: "rejected", inputs: { fromX: 0, fromY: 0, toX: 1, toY: 0 } },
  ],
};

describe("historical settlement projection", () => {
  it("does not leak future structures or current condition backwards", () => {
    expect(projectSettlementAt(source, 19).structures).toEqual([]);
    const built = projectSettlementAt(source, 22).structures[0];
    expect(built?.projectedCondition).toBeNull();
    expect(projectSettlementAt(source, 25).structures[0]?.projectedCondition).toBe(0.7);
  });

  it("reconstructs applied travel frequency and ignores rejected movement", () => {
    const projection = projectSettlementAt(source, 100);
    expect(projection.roads.map((road) => [road.at, road.traversals])).toEqual([
      [{ x: 0, y: 0 }, 1],
      [{ x: 1, y: 0 }, 1],
    ]);
    expect(rasterizeTravel({ x: 0, y: 0 }, { x: 2, y: 2 })).toEqual([
      { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 },
    ]);
  });

  it("rewinds the materialised deposit using canonical gathers after the requested tick", () => {
    expect(projectSettlementAt(source, 14).resourceSites[0]?.remaining).toEqual({ wood: 13 });
    expect(projectSettlementAt(source, 15).resourceSites[0]).toMatchObject({
      extracted: { wood: 3 },
      initial: { wood: 13 },
      remaining: { wood: 10 },
    });
  });

  it("reports stockpile deltas without claiming an unknown absolute balance", () => {
    const stockpile = projectSettlementAt(source, 30).stockpiles[0];
    expect(stockpile).toMatchObject({
      structureId: "STR-1",
      recordedNet: { wood: 2 },
      completeBalanceKnown: false,
    });
  });

  it("is pure and deterministic", () => {
    expect(projectSettlementAt(source, 30)).toEqual(projectSettlementAt(source, 30));
    expect(source.map.structures[0]?.condition).toBe(0.4);
  });
});
