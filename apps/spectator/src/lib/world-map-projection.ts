// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import type { Coord, Structure, WorldMap } from "./world-types";

/** Every closed-union construction kind the engine can currently create. */
export const CANONICAL_STRUCTURE_KINDS = [
  "assembly",
  "shelter",
  "storehouse",
  "workshop",
  "hall",
  "wall",
  "enclosure",
  "monument",
  "road",
  "smelter",
  "reinforced_vault",
] as const;

/** Legacy read-only fixtures also contain these historical physical kinds. */
const LEGACY_STRUCTURE_KINDS = ["well", "bridge", "store", "granary", "forge", "house", "cairn"] as const;

export function hasDedicatedStructureVisual(kind: string): boolean {
  const normalized = kind.trim().toLowerCase();
  return [...CANONICAL_STRUCTURE_KINDS, ...LEGACY_STRUCTURE_KINDS].includes(normalized as never);
}

export interface ProjectedTilePosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ProjectedInhabitant {
  readonly id: string;
  readonly name: string;
  readonly at: Coord;
  readonly position: ProjectedTilePosition;
  readonly status: WorldMap["occupants"][number]["status"];
  readonly generation: number;
}

export interface ProjectedStructure {
  readonly id: string;
  readonly kind: string;
  readonly at: Coord;
  readonly position: ProjectedTilePosition;
  readonly condition: number;
  readonly structure: Structure;
}

/**
 * The sole coordinate conversion for the 3D map. A canonical tile remains
 * exactly one world unit wide; its centre is never inferred from a camera,
 * mesh bound, or display-name ordering.
 */
export function tilePosition(map: Pick<WorldMap, "width" | "height">, at: Coord): ProjectedTilePosition {
  return {
    x: at.x - (map.width - 1) / 2,
    y: 0,
    z: at.y - (map.height - 1) / 2,
  };
}

export function isCoordinateOnMap(
  map: Pick<WorldMap, "width" | "height">,
  at: Coord,
): boolean {
  return Number.isInteger(at.x) && Number.isInteger(at.y) && at.x >= 0 && at.x < map.width && at.y >= 0 && at.y < map.height;
}

/**
 * Converts one immutable map snapshot into its render plan. Invalid location
 * records are rejected rather than silently appearing at an invented origin.
 */
export function projectWorldMap(map: WorldMap): {
  readonly inhabitants: readonly ProjectedInhabitant[];
  readonly structures: readonly ProjectedStructure[];
} {
  const assertOnMap = (id: string, at: Coord, kind: "inhabitant" | "structure") => {
    if (!isCoordinateOnMap(map, at)) {
      throw new Error(`${kind} ${id} has an out-of-bounds canonical tile (${at.x},${at.y})`);
    }
  };

  return {
    inhabitants: map.occupants.map((inhabitant) => {
      assertOnMap(inhabitant.id, inhabitant.at, "inhabitant");
      return { ...inhabitant, position: tilePosition(map, inhabitant.at) };
    }),
    structures: map.structures.map((structure) => {
      assertOnMap(structure.id, structure.at, "structure");
      return {
        id: structure.id,
        kind: structure.kind,
        at: structure.at,
        position: tilePosition(map, structure.at),
        condition: Math.min(1, Math.max(0, structure.condition)),
        structure,
      };
    }),
  };
}
