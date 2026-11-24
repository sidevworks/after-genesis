// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * `move` — travel across the grid (§13, §11A).
 *
 * Movement is the simplest place where the world's physics either are real or
 * are not. Three properties make them real here:
 *
 * - **Terrain matters.** Entering forest costs twice what entering plains does,
 *   and water cannot be entered at all. Geography therefore shapes settlement,
 *   trade routes and who can reach whom, without anybody scripting it.
 * - **Travel consumes the day.** The inhabitant is `travelling` for the whole
 *   journey and cannot do anything else during it (§11A). A long trip is a real
 *   decision, not a free teleport with a cosmetic delay.
 * - **Night is slower.** `isNight` stretches the journey by half again.
 *
 * The route is found with uniform-cost search over passable tiles. Ties break on
 * `coordKey`, so the chosen path is a pure function of the map — not of hash
 * iteration order.
 */
import { IMPASSABLE_TERRAIN, chebyshevDistance, coordKey } from "../../schema/primitives.js";
import type { Coord } from "../../schema/primitives.js";
import { getActionSpec } from "../../schema/actions/index.js";
import { elderEnergyCost, isElderAt } from "../aging.js";
import { isNight } from "../../time.js";
import {
  idiv,
  idivCeil,
  terrainAt,
  updateInhabitant,
  type WorldMap,
  type WorldRules,
} from "../state.js";
import { advanceNeeds, beginActivity, energyOf, learnLocations, spend } from "./effects.js";
import { asObject, readCoord } from "./payload.js";
import { RejectionCode, reject, type ResolutionResult, type Resolver } from "./types.js";

/**
 * Declared metadata for `move` (§11A): which activity it occupies and how it
 * responds to interruption. Read from the catalogue so the engine cannot
 * quietly disagree with the published action spec.
 */
const MOVE_SPEC = getActionSpec("move");

/** Fixed neighbour order. Never derived from a Map or object key order (law 5). */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

export interface Route {
  /** Tiles entered, in order, excluding the origin. */
  readonly path: readonly Coord[];
  /** Total travel minutes before the night modifier. */
  readonly baseMinutes: number;
}

export function isPassable(map: WorldMap, coord: Coord): boolean {
  const terrain = terrainAt(map, coord);
  return terrain !== null && !IMPASSABLE_TERRAIN.has(terrain);
}

/**
 * Cheapest route from `from` to `to` over passable tiles, or `null`.
 *
 * The search is confined to a box around the origin expanded by
 * `maxMoveDistance`, which bounds the work per turn and matches the rule that a
 * single `move` action cannot cross the world.
 */
export function findRoute(
  map: WorldMap,
  rules: WorldRules,
  from: Coord,
  to: Coord,
): Route | null {
  if (!isPassable(map, to) || !isPassable(map, from)) return null;
  if (from.x === to.x && from.y === to.y) return { path: [], baseMinutes: 0 };

  const reach = rules.maxMoveDistance;
  const minX = Math.max(0, Math.min(from.x, to.x) - reach);
  const maxX = Math.min(map.width - 1, Math.max(from.x, to.x) + reach);
  const minY = Math.max(0, Math.min(from.y, to.y) - reach);
  const maxY = Math.min(map.height - 1, Math.max(from.y, to.y) + reach);

  const dist = new Map<string, number>();
  const prev = new Map<string, Coord>();
  const settled = new Set<string>();
  const startKey = coordKey(from);
  dist.set(startKey, 0);
  const frontier: Coord[] = [from];

  const targetKey = coordKey(to);

  while (frontier.length > 0) {
    // Pick the cheapest frontier node; ties break on coordKey so the search is
    // a pure function of the map.
    let bestIndex = 0;
    let best = frontier[0] as Coord;
    let bestKey = coordKey(best);
    let bestDist = dist.get(bestKey) ?? Number.MAX_SAFE_INTEGER;
    for (let i = 1; i < frontier.length; i++) {
      const candidate = frontier[i] as Coord;
      const key = coordKey(candidate);
      const d = dist.get(key) ?? Number.MAX_SAFE_INTEGER;
      if (d < bestDist || (d === bestDist && key < bestKey)) {
        bestIndex = i;
        best = candidate;
        bestKey = key;
        bestDist = d;
      }
    }
    frontier.splice(bestIndex, 1);
    if (settled.has(bestKey)) continue;
    settled.add(bestKey);

    if (bestKey === targetKey) break;

    for (const [dx, dy] of NEIGHBOURS) {
      const next: Coord = { x: best.x + dx, y: best.y + dy };
      if (next.x < minX || next.x > maxX || next.y < minY || next.y > maxY) continue;
      if (!isPassable(map, next)) continue;
      const key = coordKey(next);
      if (settled.has(key)) continue;
      const terrain = terrainAt(map, next);
      /* c8 ignore next */
      if (terrain === null) continue;
      const stepCost = rules.terrainMoveCost[terrain];
      const candidate = bestDist + stepCost;
      const known = dist.get(key);
      if (known === undefined || candidate < known) {
        dist.set(key, candidate);
        prev.set(key, best);
        frontier.push(next);
      }
    }
  }

  const total = dist.get(targetKey);
  if (total === undefined || !settled.has(targetKey)) return null;

  const path: Coord[] = [];
  let cursor: Coord = to;
  let guard = 0;
  while (coordKey(cursor) !== startKey) {
    path.push(cursor);
    const parent = prev.get(coordKey(cursor));
    /* c8 ignore next */
    if (parent === undefined) return null;
    cursor = parent;
    /* c8 ignore next 2 */
    guard += 1;
    if (guard > map.width * map.height) return null;
  }
  path.reverse();
  return { path, baseMinutes: total };
}

/** Apply the night modifier to a journey. Integer arithmetic only. */
export function travelMinutes(baseMinutes: number, rules: WorldRules, night: boolean): number {
  if (!night) return baseMinutes;
  return idiv(baseMinutes * rules.nightTravelNumerator, rules.nightTravelDenominator);
}

export const moveResolver: Resolver = (ctx, payload): ResolutionResult => {
  const object = asObject(payload);
  if (object === null) {
    return reject(ctx, RejectionCode.InvalidPayload, "move payload must be an object");
  }
  const to = readCoord(object, "to");
  if (to === null) {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      'move requires a "to" coordinate of non-negative integers',
    );
  }

  const { state, actor, rules } = { state: ctx.state, actor: ctx.actor, rules: ctx.state.rules };
  const terrain = terrainAt(state.map, to);
  if (terrain === null) {
    return reject(ctx, RejectionCode.OutOfBounds, `(${to.x}, ${to.y}) is not on the map`);
  }
  if (IMPASSABLE_TERRAIN.has(terrain)) {
    return reject(ctx, RejectionCode.Impassable, `(${to.x}, ${to.y}) is ${terrain}`);
  }
  if (to.x === actor.location.x && to.y === actor.location.y) {
    return reject(ctx, RejectionCode.AlreadyThere, "already standing there");
  }

  const straightLine = chebyshevDistance(actor.location, to);
  if (straightLine > rules.maxMoveDistance) {
    return reject(
      ctx,
      RejectionCode.TooFar,
      `destination is ${straightLine} tiles away; one move covers at most ${rules.maxMoveDistance}`,
    );
  }

  const route = findRoute(state.map, rules, actor.location, to);
  if (route === null) {
    return reject(ctx, RejectionCode.NoRoute, "no passable route to that tile");
  }

  const night = isNight(ctx.simTime);
  const minutes = travelMinutes(route.baseMinutes, rules, night);
  const energyCost = elderEnergyCost(
    actor,
    ctx.simTime,
    idivCeil(minutes, rules.travelMinutesPerEnergy),
  );
  if (energyOf(actor) < energyCost) {
    return reject(
      ctx,
      RejectionCode.InsufficientEnergy,
      `the journey costs ${energyCost} energy and only ${energyOf(actor)} is available`,
    );
  }

  const paid = spend(actor, { energy: energyCost });
  /* c8 ignore next 3 */
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientEnergy, "energy could not be spent");
  }

  // The inhabitant arrives, and is occupied travelling for the whole journey.
  // Placing them at the destination immediately (rather than mid-path) keeps
  // location a single fact rather than a function of time; the cost of the trip
  // is paid in the exclusive `travelling` window that follows.
  const arrived = learnLocations(
    { ...paid, location: { x: to.x, y: to.y }, needs: advanceNeeds(paid.needs, minutes, rules) },
    [to, ...route.path],
  );

  let next = updateInhabitant(state, actor.id, () => arrived);
  const begun = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: MOVE_SPEC.activity,
    actionType: "move",
    participants: [actor.id],
    location: to,
    startedAt: ctx.simTime,
    minutes,
    interruption: MOVE_SPEC.interruption,
    resourceCost: { energy: energyCost },
  });
  next = begun.state;

  const detail = {
    from: { x: actor.location.x, y: actor.location.y },
    to: { x: to.x, y: to.y },
    // Canonical tiles entered, in order. Spectators can now replay the actual
    // terrain-respecting journey instead of inventing a straight line through
    // water, trees, or structures.
    path: route.path.map((point) => ({ x: point.x, y: point.y })),
    steps: route.path.length,
    minutes,
    night,
    energySpent: energyCost,
    elder: isElderAt(actor, ctx.simTime),
    terrain,
  };

  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.move",
        actor: actor.id,
        simTime: ctx.simTime,
        inputs: { to: { x: to.x, y: to.y } },
        resolution: detail,
        // Movement is physically observable by anyone present at either end.
        visibility: { kind: "local", x: to.x, y: to.y },
      },
    ],
  };
};
