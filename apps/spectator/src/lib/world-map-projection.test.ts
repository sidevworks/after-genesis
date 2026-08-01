import { describe, expect, it } from "vitest";
import {
  CANONICAL_STRUCTURE_KINDS,
  hasDedicatedStructureVisual,
  isCoordinateOnMap,
  projectWorldMap,
  tilePosition,
} from "./world-map-projection";
import type { WorldMap } from "./world-types";

const map = {
  width: 7,
  height: 5,
  occupants: [
    { id: "inh_01_alpha", name: "ALPHA", at: { x: 0, y: 0 }, status: "active", generation: 0 },
    { id: "inh_10_kappa", name: "KAPPA", at: { x: 6, y: 4 }, status: "active", generation: 0 },
  ],
  structures: [
    { id: "str_workshop", name: "workshop", kind: "workshop", at: { x: 3, y: 2 }, ownerId: "inh_01_alpha", ownerKind: "inhabitant", builtAt: 10, builtByEvent: "evt_1", condition: 0.7, capacity: 4 },
  ],
} as unknown as WorldMap;

describe("world-map 3D projection", () => {
  it("puts every canonical coordinate at exactly one tile centre", () => {
    const projection = projectWorldMap(map);
    expect(projection.inhabitants).toEqual([
      expect.objectContaining({ id: "inh_01_alpha", at: { x: 0, y: 0 }, position: { x: -3, y: 0, z: -2 } }),
      expect.objectContaining({ id: "inh_10_kappa", at: { x: 6, y: 4 }, position: { x: 3, y: 0, z: 2 } }),
    ]);
    expect(projection.structures).toEqual([
      expect.objectContaining({ id: "str_workshop", at: { x: 3, y: 2 }, position: { x: 0, y: 0, z: 0 }, condition: 0.7 }),
    ]);
  });

  it("never converts an invalid canonical coordinate into a made-up position", () => {
    expect(isCoordinateOnMap(map, { x: 7, y: 0 })).toBe(false);
    expect(() => projectWorldMap({ ...map, occupants: [{ ...map.occupants[0]!, at: { x: -1, y: 0 } }] } as WorldMap)).toThrow(
      "out-of-bounds canonical tile",
    );
  });

  it("keeps the origin at the middle tile for odd map dimensions", () => {
    expect(tilePosition(map, { x: 3, y: 2 })).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("has a dedicated visual category for every buildable canonical structure", () => {
    expect(CANONICAL_STRUCTURE_KINDS).toHaveLength(11);
    for (const kind of CANONICAL_STRUCTURE_KINDS) expect(hasDedicatedStructureVisual(kind)).toBe(true);
    expect(hasDedicatedStructureVisual("future_unclassified_structure")).toBe(false);
  });
});
