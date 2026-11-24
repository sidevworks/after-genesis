// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import type { CameraPose, Chronicle, Vec2, WorldFrame } from "./types";

export interface SettlementBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly centre: Vec2;
  readonly span: number;
}

/** Persistent, canonical settlement extent at a replay tick. */
export function settlementBoundsAt(
  chronicle: Chronicle,
  frame: WorldFrame,
): SettlementBounds | null {
  const points: Vec2[] = frame.actors
    .filter((actor) => actor.present)
    .map((actor) => actor.position);
  const constructionKeys = new Set<string>();
  for (const track of chronicle.tracks) {
    for (const segment of track.segments) {
      if (
        segment.startTick > frame.tick ||
        segment.disclosure !== "disclosed" ||
        (segment.actionType !== "build" && segment.activityState !== "building")
      ) {
        continue;
      }
      const key = segment.activityId ?? segment.id;
      if (constructionKeys.has(key)) continue;
      constructionKeys.add(key);
      points.push(segment.focus ?? segment.to);
    }
  }
  if (points.length === 0) return null;

  let minX = points[0]!.x;
  let maxX = minX;
  let minY = points[0]!.y;
  let maxY = minY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    centre: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    span: Math.max(maxX - minX, maxY - minY, 1),
  };
}

/**
 * Growth-aware overview pose. The high oblique angle clears derived buildings
 * while retaining enough horizontal displacement to read streets and routes.
 */
export function frameSettlement(pose: CameraPose, bounds: SettlementBounds): CameraPose {
  const halfFov = (Math.max(pose.fov, 1) * Math.PI) / 360;
  const radius = bounds.span / 2 + 3;
  const distance = Math.max(14, radius / Math.tan(halfFov) * 1.2);
  const dx = pose.position.x - pose.target.x;
  const dz = pose.position.z - pose.target.z;
  const length = Math.hypot(dx, dz);
  const ux = length > 0 ? dx / length : Math.SQRT1_2;
  const uz = length > 0 ? dz / length : Math.SQRT1_2;
  return {
    ...pose,
    target: { x: bounds.centre.x, y: 0.8, z: bounds.centre.y },
    position: {
      x: bounds.centre.x + ux * distance,
      y: Math.max(9, radius * 1.15),
      z: bounds.centre.y + uz * distance,
    },
  };
}
