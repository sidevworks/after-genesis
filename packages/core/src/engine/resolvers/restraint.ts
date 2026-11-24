// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/** Neutral physical restraint and release. Neither action implies legitimacy. */
import { deriveConfinementId } from "../../ids.js";
import { getActionSpec } from "../../schema/actions/index.js";
import {
  ReleasePayloadSchema,
  RestrainPayloadSchema,
} from "../../schema/actions/neutral.js";
import { addDuration, duration } from "../../time.js";
import {
  putConfinement,
  putStructure,
  updateInhabitant,
} from "../state.js";
import { advanceNeeds, beginActivity, spend } from "./effects.js";
import { RejectionCode, reject, type ResolutionResult, type Resolver } from "./types.js";

const RESTRAIN = getActionSpec("restrain");
const RELEASE = getActionSpec("release");

export const restrainResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = RestrainPayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.targetId === ctx.actor.id) {
    return reject(ctx, RejectionCode.InvalidPayload, "restrain payload is malformed");
  }
  const input = parsed.data;
  const target = ctx.state.inhabitants[input.targetId];
  const structure = ctx.state.structures[input.structureId];
  if (
    target === undefined ||
    target.status !== "alive" ||
    target.confinementId !== null ||
    structure === undefined ||
    structure.integrity <= 0 ||
    target.location.x !== ctx.actor.location.x ||
    target.location.y !== ctx.actor.location.y ||
    structure.location.x !== ctx.actor.location.x ||
    structure.location.y !== ctx.actor.location.y ||
    structure.occupants.length >= structure.capacity
  ) {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      "target and usable enclosure must be present with capacity",
    );
  }
  const paid = spend(ctx.actor, RESTRAIN.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy");
  }
  const id = deriveConfinementId(ctx.state.worldId, ctx.sequence);
  const endsAt = addDuration(ctx.simTime, duration(input.durationMinutes));
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({
    ...paid,
    needs: advanceNeeds(paid.needs, RESTRAIN.baseDuration, ctx.state.rules),
  }));
  next = updateInhabitant(next, target.id, (current) => ({ ...current, confinementId: id }));
  next = putStructure(next, {
    ...structure,
    occupants: [...structure.occupants, target.id].sort(),
  });
  next = putConfinement(next, {
    id,
    subject: target.id,
    imposedBy: [ctx.actor.id],
    organisation: null,
    structureId: structure.id,
    startedAt: ctx.simTime,
    endsAt,
    grounds: "unspecified",
    upkeepPayer: ctx.actor.id,
    upkeepPaid: {},
    guardMinutes: RESTRAIN.baseDuration,
    memoryCountAtStart: Object.values(ctx.state.memories).filter(
      (memory) => memory.owner === target.id,
    ).length,
    released: false,
    createdSequence: ctx.sequence,
  });
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: RESTRAIN.activity,
    actionType: "restrain",
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: RESTRAIN.baseDuration,
    interruption: RESTRAIN.interruption,
    resourceCost: RESTRAIN.baseCost,
  }).state;
  const detail = {
    confinementId: id,
    targetId: target.id,
    structureId: structure.id,
    intendedEndAt: endsAt,
    message: input.message,
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [{
      type: "action.restrain",
      actor: ctx.actor.id,
      simTime: ctx.simTime,
      inputs: detail,
      resolution: detail,
      visibility: { kind: "local", x: ctx.actor.location.x, y: ctx.actor.location.y },
    }],
  };
};

export const releaseResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = ReleasePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "release payload is malformed");
  }
  const target = ctx.state.inhabitants[parsed.data.targetId];
  const confinement =
    target?.confinementId == null ? undefined : ctx.state.confinements[target.confinementId];
  const structure =
    confinement === undefined ? undefined : ctx.state.structures[confinement.structureId];
  if (
    target === undefined ||
    confinement === undefined ||
    confinement.released ||
    structure === undefined ||
    target.location.x !== ctx.actor.location.x ||
    target.location.y !== ctx.actor.location.y ||
    structure.location.x !== ctx.actor.location.x ||
    structure.location.y !== ctx.actor.location.y
  ) {
    return reject(ctx, RejectionCode.InvalidPayload, "active nearby restraint was not found");
  }
  const paid = spend(ctx.actor, RELEASE.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy");
  }
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({
    ...paid,
    needs: advanceNeeds(paid.needs, RELEASE.baseDuration, ctx.state.rules),
  }));
  next = updateInhabitant(next, target.id, (current) => ({ ...current, confinementId: null }));
  next = putConfinement(next, { ...confinement, released: true });
  next = putStructure(next, {
    ...structure,
    occupants: structure.occupants.filter((id) => id !== target.id),
  });
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: RELEASE.activity,
    actionType: "release",
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: RELEASE.baseDuration,
    interruption: RELEASE.interruption,
    resourceCost: RELEASE.baseCost,
  }).state;
  const detail = {
    confinementId: confinement.id,
    targetId: target.id,
    structureId: structure.id,
    message: parsed.data.message,
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [{
      type: "action.release",
      actor: ctx.actor.id,
      simTime: ctx.simTime,
      inputs: detail,
      resolution: detail,
      visibility: { kind: "local", x: ctx.actor.location.x, y: ctx.actor.location.y },
    }],
  };
};
