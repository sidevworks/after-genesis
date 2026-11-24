// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import type { Coord, ResourceKind, Structure, Tile, WorldEvent } from "../world-types";
import type {
  HistoricalStructure,
  ProjectedResourceBundle,
  ResourceSite,
  RoadTile,
  SettlementProjection,
  StockpileSite,
} from "./types";

const RESOURCES: readonly ResourceKind[] = [
  "food", "water", "wood", "stone", "energy", "compute", "land_rights", "storage",
];

type EventLike = Pick<WorldEvent, "sequence" | "simTime" | "type" | "location" | "resolution"> & {
  readonly inputs: Readonly<Record<string, unknown>>;
};

export interface SettlementProjectionSource {
  readonly map: {
    readonly tiles: readonly Tile[];
    readonly structures: readonly Structure[];
  };
  readonly events: readonly EventLike[];
}

const keyOf = (coord: Coord) => `${coord.x},${coord.y}`;

function numberAt(record: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function idAt(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bundleAt(record: Readonly<Record<string, unknown>>, key: string): ProjectedResourceBundle {
  const nested = record[key];
  const source =
    typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? nested as Readonly<Record<string, unknown>>
      : record;
  const bundle: ProjectedResourceBundle = {};
  for (const resource of RESOURCES) {
    const value = numberAt(source, resource);
    if (value !== null && value !== 0) bundle[resource] = value;
  }
  return bundle;
}

function addBundle(
  target: ProjectedResourceBundle,
  delta: ProjectedResourceBundle,
  sign = 1,
) {
  for (const resource of RESOURCES) {
    const amount = delta[resource] ?? 0;
    if (amount !== 0) target[resource] = (target[resource] ?? 0) + amount * sign;
  }
}

/** Integer grid cells crossed by a movement, including both recorded endpoints. */
export function rasterizeTravel(from: Coord, to: Coord): Coord[] {
  const cells: Coord[] = [];
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  const sx = x < to.x ? 1 : -1;
  const sy = y < to.y ? 1 : -1;
  let error = dx - dy;
  while (true) {
    cells.push({ x, y });
    if (x === to.x && y === to.y) break;
    const doubled = error * 2;
    if (doubled > -dy) {
      error -= dy;
      x += sx;
    }
    if (doubled < dx) {
      error += dx;
      y += sy;
    }
  }
  return cells;
}

function movementEndpoints(event: EventLike): { from: Coord; to: Coord } | null {
  if (event.type !== "move" && event.type !== "action.move") return null;
  const fromX = numberAt(event.inputs, "fromX");
  const fromY = numberAt(event.inputs, "fromY");
  const toX = numberAt(event.inputs, "toX");
  const toY = numberAt(event.inputs, "toY");
  if (fromX === null || fromY === null || toX === null || toY === null) return null;
  return { from: { x: fromX, y: fromY }, to: { x: toX, y: toY } };
}

function projectStructures(
  structures: readonly Structure[],
  events: readonly EventLike[],
  tick: number,
): HistoricalStructure[] {
  return structures
    .filter((structure) => structure.builtAt <= tick)
    .map((structure) => {
      const readings = events.filter((event) =>
        event.simTime <= tick &&
        event.resolution === "applied" &&
        idAt(event.inputs, "structureId") === structure.id &&
        (numberAt(event.inputs, "condition") !== null ||
          numberAt(event.inputs, "integrity") !== null)
      );
      const latest = readings.at(-1);
      return {
        ...structure,
        at: { ...structure.at },
        projectedCondition:
          latest === undefined
            ? null
            : numberAt(latest.inputs, "condition") ?? numberAt(latest.inputs, "integrity"),
        conditionEventSequence: latest?.sequence ?? null,
      };
    });
}

function projectRoads(events: readonly EventLike[], tick: number): RoadTile[] {
  const counts = new Map<string, { at: Coord; traversals: number }>();
  for (const event of events) {
    if (event.simTime > tick || event.resolution !== "applied") continue;
    const movement = movementEndpoints(event);
    if (movement === null) continue;
    for (const at of rasterizeTravel(movement.from, movement.to)) {
      const key = keyOf(at);
      const current = counts.get(key);
      counts.set(key, { at, traversals: (current?.traversals ?? 0) + 1 });
    }
  }
  const maximum = Math.max(0, ...[...counts.values()].map((value) => value.traversals));
  return [...counts.values()]
    .map((value) => ({ ...value, frequency: maximum === 0 ? 0 : value.traversals / maximum }))
    .sort((left, right) => right.traversals - left.traversals || keyOf(left.at).localeCompare(keyOf(right.at)));
}

function projectResources(
  tiles: readonly Tile[],
  events: readonly EventLike[],
  tick: number,
): ResourceSite[] {
  const gatheredByTile = new Map<string, Array<{ tick: number; resource: ResourceKind; amount: number }>>();
  for (const event of events) {
    if (
      event.resolution !== "applied" ||
      (event.type !== "gather" && event.type !== "action.gather") ||
      event.location === undefined
    ) continue;
    const resource = event.inputs["resource"];
    const amount = numberAt(event.inputs, "quantity") ?? numberAt(event.inputs, "amount");
    if (typeof resource !== "string" || !RESOURCES.includes(resource as ResourceKind) || amount === null) continue;
    const records = gatheredByTile.get(keyOf(event.location)) ?? [];
    records.push({ tick: event.simTime, resource: resource as ResourceKind, amount });
    gatheredByTile.set(keyOf(event.location), records);
  }

  // world.json's map is the materialised state at export time. Rewind future
  // gathers to obtain the balance at `tick`; add every gather to obtain Genesis.
  return tiles.flatMap((tile) => {
    const gathered = gatheredByTile.get(keyOf(tile)) ?? [];
    if (tile.deposit === undefined && gathered.length === 0) return [];
    const final: ProjectedResourceBundle =
      tile.deposit === undefined ? {} : { [tile.deposit.resource]: tile.deposit.remaining };
    const initial = { ...final };
    const remaining = { ...final };
    const extracted: ProjectedResourceBundle = {};
    for (const record of gathered) {
      initial[record.resource] = (initial[record.resource] ?? 0) + record.amount;
      if (record.tick <= tick) {
        extracted[record.resource] = (extracted[record.resource] ?? 0) + record.amount;
      } else {
        remaining[record.resource] = (remaining[record.resource] ?? 0) + record.amount;
      }
    }
    return [{ at: { x: tile.x, y: tile.y }, initial, remaining, extracted }];
  });
}

function projectStockpiles(
  structures: readonly HistoricalStructure[],
  events: readonly EventLike[],
  tick: number,
): StockpileSite[] {
  return structures.flatMap((structure) => {
    const net: ProjectedResourceBundle = {};
    let completeBalanceKnown = false;
    let observed = structure.kind === "store";
    for (const event of events) {
      if (event.simTime > tick || event.resolution !== "applied") continue;
      const targetId =
        idAt(event.inputs, "structureId") ??
        idAt(event.inputs, "stockpileId") ??
        idAt(event.inputs, "targetStructureId");
      if (targetId !== structure.id) continue;
      observed = true;
      if (event.type.includes("created") || event.type.includes("opened")) completeBalanceKnown = true;
      const bundle = bundleAt(event.inputs, "resources");
      const directResource = event.inputs["resource"];
      const directQuantity = numberAt(event.inputs, "quantity");
      if (
        typeof directResource === "string" &&
        RESOURCES.includes(directResource as ResourceKind) &&
        directQuantity !== null
      ) {
        bundle[directResource as ResourceKind] =
          (bundle[directResource as ResourceKind] ?? 0) + directQuantity;
      }
      const withdrawal = event.type.includes("withdraw") || event.type.includes("remove");
      addBundle(net, bundle, withdrawal ? -1 : 1);
    }
    if (!observed) return [];
    return [{
      structureId: structure.id,
      at: { ...structure.at },
      recordedNet: net,
      completeBalanceKnown,
    }];
  });
}

export function projectSettlementAt(
  source: SettlementProjectionSource,
  tick: number,
): SettlementProjection {
  const safeTick = Math.max(0, Math.floor(tick));
  const events = [...source.events].sort(
    (left, right) => left.simTime - right.simTime || left.sequence - right.sequence,
  );
  const structures = projectStructures(source.map.structures, events, safeTick);
  return {
    tick: safeTick,
    structures,
    roads: projectRoads(events, safeTick),
    resourceSites: projectResources(source.map.tiles, events, safeTick),
    stockpiles: projectStockpiles(structures, events, safeTick),
  };
}
