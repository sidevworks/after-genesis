// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/** Neutral construction and guarding. */
import { deriveArtifactId, deriveStructureId } from "../../ids.js";
import { BuildPayloadSchema } from "../../schema/actions/construction.js";
import { CraftPayloadSchema, RefinePayloadSchema } from "../../schema/actions/construction.js";
import { StoreArtifactPayloadSchema, StoreGoodsPayloadSchema } from "../../schema/actions/resources.js";
import { GuardLocationPayloadSchema } from "../../schema/actions/security.js";
import { getActionSpec } from "../../schema/actions/index.js";
import { recipeById } from "../../schema/recipes.js";
import { addBundles, bundleTotal, chebyshevDistance, subtractBundles } from "../../schema/primitives.js";
import type { ResourceBundle } from "../../schema/primitives.js";
import { derivePhysicalProcess } from "../../schema/physical-process.js";
import {
  normaliseBundle,
  putStructure,
  recordDestroyed,
  putArtifact,
  recordCreated,
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
const CRAFT = getActionSpec("craft");
const REFINE = getActionSpec("refine");
const STORE_ARTIFACT = getActionSpec("store_artifact");
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
  smelter: 4,
  reinforced_vault: 60,
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
  const vaultRecipe = input.structureKind === "reinforced_vault" ? recipeById("recipe_build_vault") : null;
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
  if (vaultRecipe !== null && !sameBundle(input.materials, vaultRecipe.inputs)) {
    return reject(ctx, RejectionCode.InvalidPayload, "a reinforced vault must use the canonical recipe_build_vault materials");
  }
  if (vaultRecipe !== null && !hasRequiredStructure(ctx.state, ctx.actor.id, "workshop")) {
    return reject(ctx, RejectionCode.InvalidPayload, "a reinforced vault requires access to a workshop on the actor's tile");
  }
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
    ownershipPublic: input.structureKind !== "reinforced_vault",
    storagePublic: false,
    secured: input.structureKind === "enclosure" || input.structureKind === "wall" || input.structureKind === "reinforced_vault",
    // Keep ordinary historical structures byte-for-byte compatible with the
    // states that predate vault access control.  Only a vault needs an
    // explicit policy; an absent policy is mechanically open everywhere it is
    // read.
    ...(input.structureKind === "reinforced_vault" ? { accessPolicy: "owner_only" as const } : {}),
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

/** Resolve a canonical recipe, never a model-supplied materials list. */
export const refineResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = RefinePayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "refine requires a canonical recipeId: recipe_refine_iron, recipe_refine_titanium, recipe_refine_copper, or recipe_refine_molybdenum");
  const recipe = recipeById(parsed.data.recipeId);
  if (recipe === null || recipe.action !== "refine" || recipe.output.kind !== "resource") {
    return reject(ctx, RejectionCode.InvalidPayload, "unknown refining recipe");
  }
  const smelter = ctx.state.structures[parsed.data.structureId ?? ""];
  if (smelter === undefined || smelter.kind !== recipe.requiredStructure || !sameTile(ctx.actor, smelter)) {
    return reject(ctx, RejectionCode.InvalidPayload, "refining requires standing on a smelter");
  }
  const afterEffort = spend(ctx.actor, REFINE.baseCost);
  const paid = afterEffort === null ? null : spend(afterEffort, recipe.inputs);
  if (paid === null) return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy or recipe materials");
  const gained = receive(paid, { [recipe.output.item]: recipe.output.quantity });
  if (carriedTotal(gained.inventory) > ctx.state.rules.carryCapacity) {
    return reject(ctx, RejectionCode.InsufficientResources, "the refined ingot will not fit in the actor's pack");
  }
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({ ...gained, needs: advanceNeeds(gained.needs, REFINE.baseDuration, ctx.state.rules) }));
  next = recordDestroyed(next, recipe.inputs);
  next = recordCreated(next, { [recipe.output.item]: recipe.output.quantity });
  next = beginActivity({ state: next, sequence: ctx.sequence, activityState: REFINE.activity, actionType: "refine", participants: [ctx.actor.id], location: smelter.location, startedAt: ctx.simTime, minutes: REFINE.baseDuration, interruption: REFINE.interruption, resourceCost: { ...REFINE.baseCost, ...recipe.inputs } }).state;
  const detail = { recipeId: recipe.id, structureId: smelter.id, output: recipe.output };
  return { outcome: { status: "resolved", detail }, state: next, events: [{ type: "action.refine", actor: ctx.actor.id, simTime: ctx.simTime, inputs: { recipeId: recipe.id, structureId: smelter.id }, resolution: detail, visibility: { kind: "local", x: smelter.location.x, y: smelter.location.y } }] };
};

export const craftResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = CraftPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "craft payload is malformed");
  const input = parsed.data;
  const recipe = input.recipeId === null ? null : recipeById(input.recipeId);
  if (recipe === null || recipe.action !== "craft" || recipe.output.kind !== "artifact") {
    return reject(ctx, RejectionCode.InvalidPayload, "crafting a mechanical item requires a canonical recipe");
  }
  const workshop = ctx.state.structures[input.structureId ?? ""];
  if (workshop === undefined || workshop.kind !== recipe.requiredStructure || !sameTile(ctx.actor, workshop)) {
    return reject(ctx, RejectionCode.InvalidPayload, "this recipe requires standing on a workshop");
  }
  const afterEffort = spend(ctx.actor, CRAFT.baseCost);
  const paid = afterEffort === null ? null : spend(afterEffort, recipe.inputs);
  if (paid === null) return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy or recipe materials");
  const id = deriveArtifactId(ctx.state.worldId, ctx.sequence);
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({ ...paid, needs: advanceNeeds(paid.needs, CRAFT.baseDuration, ctx.state.rules) }));
  next = recordDestroyed(next, recipe.inputs);
  next = putArtifact(next, { id, title: recipe.output.mechanicalKind, kind: "tool", creators: [ctx.actor.id], owner: ctx.actor.id, ownerOrganisation: null, contentRef: "", content: "", published: false, provenance: [ctx.actor.id], revision: 0, location: { ...ctx.actor.location }, createdSequence: ctx.sequence, createdAt: ctx.simTime, mechanicalKind: recipe.output.mechanicalKind, integrity: recipe.output.durability });
  next = beginActivity({ state: next, sequence: ctx.sequence, activityState: CRAFT.activity, actionType: "craft", participants: [ctx.actor.id], location: workshop.location, startedAt: ctx.simTime, minutes: CRAFT.baseDuration, interruption: CRAFT.interruption, resourceCost: { ...CRAFT.baseCost, ...recipe.inputs } }).state;
  const detail = { recipeId: recipe.id, artifactId: id, mechanicalKind: recipe.output.mechanicalKind, durability: recipe.output.durability };
  return { outcome: { status: "resolved", detail }, state: next, events: [{ type: "action.craft", actor: ctx.actor.id, simTime: ctx.simTime, inputs: { recipeId: recipe.id, structureId: workshop.id }, resolution: detail, visibility: { kind: "local", x: workshop.location.x, y: workshop.location.y } }] };
};

function sameBundle(a: ResourceBundle, b: ResourceBundle): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => (a[key as keyof ResourceBundle] ?? 0) === (b[key as keyof ResourceBundle] ?? 0));
}

function sameTile(a: { location: { x: number; y: number } }, b: { location: { x: number; y: number } }): boolean {
  return a.location.x === b.location.x && a.location.y === b.location.y;
}

function hasRequiredStructure(state: Parameters<Resolver>[0]["state"], actorId: string, kind: string): boolean {
  const actor = state.inhabitants[actorId];
  return actor !== undefined && Object.values(state.structures).some((structure) => structure.kind === kind && sameTile(actor, structure));
}

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
  if (structure.accessPolicy === "owner_only" && structure.owner !== actor.id) {
    return reject(ctx, RejectionCode.InvalidPayload, "only the reinforced vault's builder may access its storage");
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

export const storeArtifactResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = StoreArtifactPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "store_artifact payload is malformed");
  const input = parsed.data;
  const structure = ctx.state.structures[input.structureId];
  const artifact = ctx.state.artifacts[input.artifactId];
  if (structure === undefined || artifact === undefined) return reject(ctx, RejectionCode.InvalidPayload, "the named structure or artifact does not exist");
  if (!sameTile(ctx.actor, structure)) return reject(ctx, RejectionCode.InvalidPayload, "a container can only be reached from its tile");
  if (structure.accessPolicy === "owner_only" && structure.owner !== ctx.actor.id) return reject(ctx, RejectionCode.InvalidPayload, "only the vault builder may access this container");
  if (artifact.owner !== ctx.actor.id) return reject(ctx, RejectionCode.InvalidPayload, "only the artifact owner may store or withdraw it");
  if (input.direction === "deposit" && artifact.storageStructureId != null) return reject(ctx, RejectionCode.InvalidPayload, "the artifact is already stored elsewhere");
  if (input.direction === "withdraw" && artifact.storageStructureId !== structure.id) return reject(ctx, RejectionCode.InvalidPayload, "the artifact is not stored in this structure");
  const paid = spend(ctx.actor, STORE_ARTIFACT.baseCost);
  if (paid === null) return reject(ctx, RejectionCode.InsufficientEnergy, "insufficient energy");
  const stored = new Set(structure.storedArtifactIds ?? []);
  if (input.direction === "deposit") stored.add(artifact.id); else stored.delete(artifact.id);
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({ ...paid, needs: advanceNeeds(paid.needs, STORE_ARTIFACT.baseDuration, ctx.state.rules) }));
  next = putStructure(next, { ...structure, storedArtifactIds: [...stored].sort() });
  next = putArtifact(next, { ...artifact, storageStructureId: input.direction === "deposit" ? structure.id : null, location: input.direction === "deposit" ? null : { ...ctx.actor.location } });
  next = beginActivity({ state: next, sequence: ctx.sequence, activityState: STORE_ARTIFACT.activity, actionType: "store_artifact", participants: [ctx.actor.id], location: structure.location, startedAt: ctx.simTime, minutes: STORE_ARTIFACT.baseDuration, interruption: STORE_ARTIFACT.interruption, resourceCost: STORE_ARTIFACT.baseCost }).state;
  const detail = { structureId: structure.id, artifactId: artifact.id, direction: input.direction };
  return { outcome: { status: "resolved", detail }, state: next, events: [{ type: "action.store_artifact", actor: ctx.actor.id, simTime: ctx.simTime, inputs: detail, resolution: detail, visibility: { kind: "local", x: structure.location.x, y: structure.location.y } }] };
};
