/** Neutral construction and guarding. */
import { deriveStructureId } from "../../ids.js";
import { BuildPayloadSchema } from "../../schema/actions/construction.js";
import { GuardLocationPayloadSchema } from "../../schema/actions/security.js";
import { getActionSpec } from "../../schema/actions/index.js";
import { bundleTotal, chebyshevDistance } from "../../schema/primitives.js";
import { derivePhysicalProcess } from "../../schema/physical-process.js";
import {
  putStructure,
  recordDestroyed,
  terrainAt,
  updateInhabitant,
} from "../state.js";
import { advanceNeeds, beginActivity, spend } from "./effects.js";
import { RejectionCode, reject, type ResolutionResult, type Resolver } from "./types.js";

const BUILD = getActionSpec("build");
const GUARD = getActionSpec("guard_location");

export const buildResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = BuildPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "build payload is malformed");
  }
  const input = parsed.data;
  if (
    input.collaboratorIds.length > 0 ||
    input.organisationId != null ||
    input.continuesStructureId != null
  ) {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      "collaboration, association possession and extensions are not available in this slice",
    );
  }
  const terrain = terrainAt(ctx.state.map, input.coord);
  if (
    terrain === null ||
    terrain === "water" ||
    chebyshevDistance(ctx.actor.location, input.coord) > 1
  ) {
    return reject(ctx, RejectionCode.InvalidPayload, "build site must be adjacent passable land");
  }
  if (
    Object.values(ctx.state.structures).some(
      (structure) =>
        structure.location.x === input.coord.x && structure.location.y === input.coord.y,
    )
  ) {
    return reject(ctx, RejectionCode.InvalidPayload, "a structure already occupies that location");
  }
  const afterEffort = spend(ctx.actor, BUILD.baseCost);
  const paid = afterEffort === null ? null : spend(afterEffort, input.materials);
  if (paid === null || bundleTotal(input.materials) < 1) {
    return reject(ctx, RejectionCode.InsufficientResources, "building requires held materials");
  }
  const id = deriveStructureId(ctx.state.worldId, ctx.sequence);
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({
    ...paid,
    needs: advanceNeeds(paid.needs, BUILD.baseDuration, ctx.state.rules),
  }));
  next = recordDestroyed(next, input.materials);
  next = putStructure(next, {
    id,
    kind: input.structureKind,
    location: { ...input.coord },
    // Legacy field used only as current recorded possessor.
    owner: ctx.actor.id,
    ownerOrganisation: null,
    integrity: Math.min(100, 20 + bundleTotal(input.materials) * 5),
    capacity: Math.max(1, Math.min(32, bundleTotal(input.materials))),
    storage: {},
    ownershipPublic: true,
    storagePublic: false,
    secured: input.structureKind === "enclosure" || input.structureKind === "wall",
    occupants: [],
    createdSequence: ctx.sequence,
    createdAt: ctx.simTime,
  });
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: BUILD.activity,
    actionType: "build",
    participants: [ctx.actor.id],
    location: input.coord,
    startedAt: ctx.simTime,
    minutes: BUILD.baseDuration,
    interruption: BUILD.interruption,
    resourceCost: BUILD.baseCost,
  }).state;
  const detail = {
    structureId: id,
    kind: input.structureKind,
    location: input.coord,
    process: derivePhysicalProcess({
      actionType: "build",
      actorIds: [ctx.actor.id],
      origin: ctx.actor.location,
      target: {
        kind: "structure",
        id,
        coord: input.coord,
        label: input.structureKind,
      },
      durationMinutes: BUILD.baseDuration,
      materials: input.materials,
      resultEntityIds: [id],
    }),
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [{
      type: "action.build",
      actor: ctx.actor.id,
      simTime: ctx.simTime,
      inputs: { structureKind: input.structureKind, coord: input.coord, materials: input.materials },
      resolution: detail,
      visibility: { kind: "local", x: input.coord.x, y: input.coord.y },
    }],
  };
};

export const guardLocationResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = GuardLocationPayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.organisationId != null) {
    return reject(ctx, RejectionCode.InvalidPayload, "guard payload is malformed");
  }
  const coord = parsed.data.coord ?? ctx.actor.location;
  if (coord.x !== ctx.actor.location.x || coord.y !== ctx.actor.location.y) {
    return reject(ctx, RejectionCode.InvalidPayload, "guarding requires physical presence");
  }
  const paid = spend(ctx.actor, GUARD.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy to guard");
  }
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({
    ...paid,
    needs: advanceNeeds(paid.needs, parsed.data.durationMinutes, ctx.state.rules),
  }));
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: GUARD.activity,
    actionType: "guard_location",
    participants: [ctx.actor.id],
    location: coord,
    startedAt: ctx.simTime,
    minutes: parsed.data.durationMinutes,
    interruption: GUARD.interruption,
    resourceCost: GUARD.baseCost,
  }).state;
  const detail = {
    coord,
    durationMinutes: parsed.data.durationMinutes,
    statedSubjects: parsed.data.protectSubjectIds,
    statedArtifacts: parsed.data.protectArtifactIds,
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [{
      type: "action.guard_location",
      actor: ctx.actor.id,
      simTime: ctx.simTime,
      inputs: detail,
      resolution: detail,
      visibility: { kind: "local", x: coord.x, y: coord.y },
    }],
  };
};
