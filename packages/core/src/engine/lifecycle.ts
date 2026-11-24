// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/** Canonical termination and physical remains shared by every death path. */
import { addBundles, CONSERVED_RESOURCES, type ResourceBundle, type ResourceKind } from "../schema/primitives.js";
import type { SimTime } from "../time.js";
import {
  IDLE_ACTIVITY,
  putActivity,
  putInhabitant,
  putRemains,
  sortedValues,
  type Inhabitant,
  type WorldState,
} from "./state.js";

export interface TerminationResult {
  readonly state: WorldState;
  readonly remainsId: string;
  readonly location: { readonly x: number; readonly y: number };
}

function conserved(bundle: ResourceBundle): ResourceBundle {
  const result: ResourceBundle = {};
  for (const [kind, amount] of Object.entries(bundle)) {
    if (CONSERVED_RESOURCES.has(kind as ResourceKind) && (amount ?? 0) > 0) {
      result[kind as ResourceKind] = amount as number;
    }
  }
  return result;
}

/**
 * Terminate a living inhabitant without deleting its historical entity.
 *
 * Dead inhabitants remain in the canonical population history, but no longer
 * count as living. Their conserved pack and concealed holdings move exactly
 * once into a location-bound remains container, which makes recovery possible
 * without creating or destroying material.
 */
export function terminateInhabitant(
  state: WorldState,
  subjectId: string,
  now: SimTime,
  sequence: number,
): TerminationResult | null {
  const subject = state.inhabitants[subjectId];
  if (subject === undefined || subject.status !== "alive") return null;

  let next = state;
  let location = subject.location;
  for (const activity of sortedValues(state.activities)) {
    if (!activity.open || !activity.participants.includes(subjectId)) continue;
    next = putActivity(next, { ...activity, open: false });
    for (const participantId of [...activity.participants].sort()) {
      const participant = next.inhabitants[participantId];
      if (participant === undefined || participant.activity.activityId !== activity.id) continue;
      next = putInhabitant(next, {
        ...participant,
        activity: { ...IDLE_ACTIVITY, busyUntil: activity.endsAt },
      });
    }
    location = activity.location;
  }

  const dying = next.inhabitants[subjectId] as Inhabitant;
  const remainsId = `rem_${subjectId}`;
  const inventory = addBundles(conserved(dying.inventory), conserved(dying.concealed));
  next = putInhabitant(next, {
    ...dying,
    status: "dead",
    integrity: 0,
    inventory: {},
    exposed: {},
    concealed: {},
    activity: { ...IDLE_ACTIVITY, busyUntil: now },
    nextEligibleTime: now,
    deathTime: now,
    deathSequence: sequence,
  });
  next = putRemains(next, {
    id: remainsId,
    deceasedId: subjectId,
    location: { x: location.x, y: location.y },
    inventory,
    createdAt: now,
    createdSequence: sequence,
    disposedAt: null,
    disposalMethod: null,
  });
  return { state: next, remainsId, location: { x: location.x, y: location.y } };
}
