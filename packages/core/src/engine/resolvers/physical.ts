/** Neutral construction and guarding. */
import { deriveStructureId } from "../../ids.js";
import { BuildPayloadSchema } from "../../schema/actions/construction.js";
import { StoreGoodsPayloadSchema } from "../../schema/actions/resources.js";
import { GuardLocationPayloadSchema } from "../../schema/actions/security.js";
import { getActionSpec } from "../../schema/actions/index.js";
import { addBundles, bundleTotal, chebyshevDistance, subtractBundles } from "../../schema/primitives.js";
import type { ResourceBundle } from "../../schema/primitives.js";
import { derivePhysicalProcess } from "../../schema/physical-process.js";
import {
  normaliseBundle,
  putStructure,
  recordDestroyed,
  terrainAt,
  updateInhabitant,
  type Inhabitant,
} from "../state.js";
import {
  CARRIED_KINDS,
  advanceNeeds,
  beginActivity,
  carriedTotal,
  receive,
  spend,
} from "./effects.js";
import { RejectionCode, reject, type ResolutionResult, type Resolver } from "./types.js";

const BUILD = getActionSpec("build");
const GUARD = getActionSpec("guard_location");

/**
 * How much a finished structure can hold, from its kind and its materials.
 *
 * Integer arithmetic and a table rather than a formula with a coefficient
 * hidden in it: these numbers shape whether storing is worth the walk, which
 * makes them constitutional in effect, so they should be legible to an auditor
 * reading §5 rather than derived.
 */
const STORAGE_PER_MATERIAL: Readonly<Record<string, number>> = {
  // A neutral arrangement of matter. It persists and can hold a bounded amount
  // because arranged matter occupies volume; it gains no shelter or security
  // affordance merely because its maker gives it an ambitious name.
  assembly: 4,
  storehouse: 40,
  workshop: 8,
  hall: 6,
  shelter: 4,
  enclosure: 2,
  monument: 0,
  wall: 0,
  road: 0,
};

const MAX_STRUCTURE_CAPACITY = 4000;

export function storageCapacityFor(kind: string, materialTotal: number): number {
  const per = STORAGE_PER_MATERIAL[kind] ?? 1;
  const raw = materialTotal * per;
  return Math.max(0, Math.min(MAX_STRUCTURE_CAPACITY, raw));
}

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
    // What the structure can hold. A storehouse is a building whose whole
    // purpose is capacity, so its materials buy far more of it than the same
    // timber spent on a hall or a wall — otherwise every kind of building is
    // interchangeable and choosing between them means nothing.
    //
    // The old ceiling of 32 was below a single inhabitant's carrying capacity,
    // which made every structure in the world too small to be worth walking to.
    capacity: storageCapacityFor(input.structureKind, bundleTotal(input.materials)),
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
    builtBy: ctx.actor.id,
    builder: {
      id: ctx.actor.id,
      kind: "inhabitant" as const,
    },
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

/* ------------------------------------------------------------------------- */
/* store_goods                                                                */
/* ------------------------------------------------------------------------- */

const STORE = getActionSpec("store_goods");

/**
 * Move goods between a pack and a structure (§5 storage capacity).
 *
 * This is the action that makes the carrying limit survivable and construction
 * worth the materials. Neither of those was true before: an inventory was
 * unbounded, so nothing ever needed putting down, and a structure's `storage`
 * and `capacity` fields were written at construction and then read by nothing at
 * all.
 *
 * Conservation is untouched by design — `totalHeldResources` already counts
 * structure storage, so a deposit moves units between two places that are both
 * inside the equation. Nothing is created and nothing is destroyed here, which
 * is why there is no ledger call in this resolver.
 *
 * What this deliberately does not do:
 *
 * - It does not check possession. §11F's subject is *taking*, and taking from a
 *   store without consent is `attempt_transfer_without_consent`, which resolves
 *   against locks, guards, distance and witnesses. Making a store magically
 *   refuse a stranger's hand would decide, in the engine, a question the world
 *   is supposed to leave to locks and to politics.
 * - It does not make contents private. `storagePublic` already governs that.
 */
export const storeGoodsResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = StoreGoodsPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "store_goods payload is malformed");
  }
  const input = parsed.data;
  const { state, actor } = ctx;
  const rules = state.rules;

  const structure = state.structures[input.structureId];
  if (structure === undefined) {
    return reject(ctx, RejectionCode.InvalidPayload, `no structure ${input.structureId} exists`);
  }
  if (chebyshevDistance(actor.location, structure.location) > 0) {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      "a store can only be reached from the tile it stands on",
    );
  }
  if (structure.integrity <= 0) {
    return reject(ctx, RejectionCode.InvalidPayload, "the structure is ruined and holds nothing");
  }

  // Only conserved goods. Energy and compute are capacities of a body and
  // cannot be poured into a building.
  const moved = normaliseBundle(input.resources);
  for (const kind of Object.keys(moved) as (keyof typeof moved)[]) {
    if (!CARRIED_KINDS.includes(kind)) {
      return reject(ctx, RejectionCode.InvalidPayload, `${kind} cannot be stored`);
    }
  }
  if (bundleTotal(moved) < 1) {
    return reject(ctx, RejectionCode.InvalidPayload, "nothing was named to move");
  }

  const paid = spend(actor, STORE.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientEnergy, "insufficient energy");
  }

  let holder: Inhabitant;
  let storage: ResourceBundle;
  if (input.direction === "deposit") {
    const afterGiving = spend(paid, moved);
    if (afterGiving === null) {
      return reject(ctx, RejectionCode.InsufficientResources, "those goods are not held");
    }
    const filled = addBundles(structure.storage, moved);
    if (bundleTotal(filled) > structure.capacity) {
      return reject(
        ctx,
        RejectionCode.InsufficientResources,
        `the structure holds ${bundleTotal(structure.storage)} of a capacity of ${structure.capacity}`,
      );
    }
    holder = afterGiving;
    storage = normaliseBundle(filled);
  } else {
    const remaining = subtractBundles(structure.storage, moved);
    if (remaining === null) {
      return reject(ctx, RejectionCode.InsufficientResources, "the store does not hold that");
    }
    const taken = receive(paid, moved);
    if (carriedTotal(taken.inventory) > rules.carryCapacity) {
      return reject(
        ctx,
        RejectionCode.InsufficientResources,
        `that would carry ${carriedTotal(taken.inventory)} of a capacity of ${rules.carryCapacity}`,
      );
    }
    holder = taken;
    storage = normaliseBundle(remaining);
  }

  let next = updateInhabitant(state, actor.id, () => ({
    ...holder,
    needs: advanceNeeds(holder.needs, STORE.baseDuration, rules),
  }));
  next = putStructure(next, { ...structure, storage });
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: STORE.activity,
    actionType: "store_goods",
    participants: [actor.id],
    location: structure.location,
    startedAt: ctx.simTime,
    minutes: STORE.baseDuration,
    interruption: STORE.interruption,
    resourceCost: STORE.baseCost,
  }).state;

  const detail = {
    structureId: structure.id,
    direction: input.direction,
    moved,
    structureOwnerId: structure.owner,
    storageOwnerKind: structure.owner === null ? "none" : "inhabitant",
    storedAfter: storage,
    carriedAfter: carriedTotal(holder.inventory),
    capacity: structure.capacity,
    storedBy: ctx.actor.id,
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.store_goods",
        actor: actor.id,
        simTime: ctx.simTime,
        inputs: { structureId: input.structureId, direction: input.direction, resources: moved },
        resolution: detail,
        visibility: { kind: "local", x: structure.location.x, y: structure.location.y },
      },
    ],
  };
};
