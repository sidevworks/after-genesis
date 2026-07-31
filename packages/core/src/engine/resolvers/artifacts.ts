/**
 * Neutral symbolic artifacts and physical transfers.
 *
 * Artifact content is inert authored text. A disc may be described as a promise
 * or a day's labour, but the engine records only the object, its current
 * possessor, its words, and later transfers.
 */
import { deriveArtifactId } from "../../ids.js";
import {
  CreateArtifactPayloadSchema,
  PublishPayloadSchema,
} from "../../schema/actions/knowledge.js";
import { CopyArtifactPayloadSchema } from "../../schema/actions/neutral.js";
import { ReadArtifactPayloadSchema, TransferPropertyPayloadSchema } from "../../schema/actions/resources.js";
import { chebyshevDistance } from "../../schema/primitives.js";
import { derivePhysicalProcess } from "../../schema/physical-process.js";
import { getActionSpec } from "../../schema/actions/index.js";
import {
  putArtifact,
  recordDestroyed,
  updateInhabitant,
} from "../state.js";
import { advanceNeeds, beginActivity, carriedTotal, receive, spend } from "./effects.js";
import { RejectionCode, reject, type ResolutionResult, type Resolver } from "./types.js";

const CREATE = getActionSpec("create_artifact");
const COPY = getActionSpec("copy_artifact");
const PUBLISH = getActionSpec("publish");
const TRANSFER = getActionSpec("transfer");
const READ = getActionSpec("read_artifact");

const readableBy = (state: Parameters<Resolver>[0]["state"], actorId: string, artifact: { owner: string | null; published: boolean; storageStructureId?: string | null }): boolean => {
  const container = artifact.storageStructureId == null ? null : state.structures[artifact.storageStructureId];
  if (container?.accessPolicy === "owner_only" && container.owner !== actorId) return false;
  return artifact.published || artifact.owner === actorId;
};

export const readArtifactResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = ReadArtifactPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "read_artifact payload is malformed");
  const artifact = ctx.state.artifacts[parsed.data.artifactId];
  if (artifact === undefined || !readableBy(ctx.state, ctx.actor.id, artifact)) return reject(ctx, RejectionCode.InvalidPayload, "artifact is not readable by the actor");
  const paid = spend(ctx.actor, READ.baseCost);
  if (paid === null) return reject(ctx, RejectionCode.InsufficientResources, "insufficient compute");
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({ ...paid, needs: advanceNeeds(paid.needs, READ.baseDuration, ctx.state.rules) }));
  next = beginActivity({ state: next, sequence: ctx.sequence, activityState: READ.activity, actionType: "read_artifact", participants: [ctx.actor.id], location: ctx.actor.location, startedAt: ctx.simTime, minutes: READ.baseDuration, interruption: READ.interruption, resourceCost: READ.baseCost }).state;
  const detail = { artifactId: artifact.id, title: artifact.title, content: artifact.content, mechanicalKind: artifact.mechanicalKind ?? null };
  return { outcome: { status: "resolved", detail }, state: next, events: [{ type: "action.read_artifact", actor: ctx.actor.id, simTime: ctx.simTime, inputs: { artifactId: artifact.id }, resolution: detail, visibility: { kind: "private", owner: ctx.actor.id } }] };
};

export const createArtifactResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = CreateArtifactPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "create_artifact payload is malformed");
  }
  const input = parsed.data;
  if (
    input.collaboratorIds.length > 0 ||
    input.organisationId != null ||
    input.revisesArtifactId != null
  ) {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      "collaboration, association holding and revision are not available in this neutral slice",
    );
  }

  const afterEffort = spend(ctx.actor, CREATE.baseCost);
  const paid = afterEffort === null ? null : spend(afterEffort, input.materials);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy, compute or materials");
  }

  const id = deriveArtifactId(ctx.state.worldId, ctx.sequence);
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({
    ...paid,
    needs: advanceNeeds(paid.needs, CREATE.baseDuration, ctx.state.rules),
  }));
  next = recordDestroyed(next, input.materials);
  next = putArtifact(next, {
    id,
    title: input.title,
    kind: input.kind,
    creators: [ctx.actor.id],
    // Internally this legacy field means current physical possessor only.
    owner: ctx.actor.id,
    ownerOrganisation: null,
    contentRef: input.externalReference ?? "",
    content: input.content,
    published: false,
    provenance: [ctx.actor.id],
    revision: 0,
    location: { ...ctx.actor.location },
    createdSequence: ctx.sequence,
    createdAt: ctx.simTime,
  });
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: CREATE.activity,
    actionType: "create_artifact",
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: CREATE.baseDuration,
    interruption: CREATE.interruption,
    resourceCost: { ...CREATE.baseCost, ...input.materials },
  }).state;

  const detail = {
    artifactId: id,
    title: input.title,
    kind: input.kind,
    published: false,
    process: derivePhysicalProcess({
      actionType: "create_artifact",
      actorIds: [ctx.actor.id],
      origin: ctx.actor.location,
      target: {
        kind: "artifact",
        id,
        coord: ctx.actor.location,
        label: input.title,
      },
      durationMinutes: CREATE.baseDuration,
      materials: input.materials,
      resultEntityIds: [id],
    }),
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [{
      type: "action.create_artifact",
      actor: ctx.actor.id,
      simTime: ctx.simTime,
      inputs: { title: input.title, kind: input.kind, content: input.content, materials: input.materials },
      resolution: detail,
      visibility: { kind: "private", owner: ctx.actor.id },
    }],
  };
};

export const copyArtifactResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = CopyArtifactPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "copy_artifact payload is malformed");
  }
  const source = ctx.state.artifacts[parsed.data.sourceArtifactId];
  if (
    source === undefined ||
    !readableBy(ctx.state, ctx.actor.id, source) ||
    source.content.length === 0
  ) {
    return reject(ctx, RejectionCode.InvalidPayload, "source artifact is not readable by the actor");
  }
  const paid = spend(ctx.actor, COPY.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy or compute");
  }
  const id = deriveArtifactId(ctx.state.worldId, ctx.sequence);
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({
    ...paid,
    needs: advanceNeeds(paid.needs, COPY.baseDuration, ctx.state.rules),
  }));
  next = putArtifact(next, {
    ...source,
    id,
    title: parsed.data.title ?? source.title,
    creators: [ctx.actor.id],
    owner: ctx.actor.id,
    ownerOrganisation: null,
    published: false,
    provenance: [...source.provenance, ctx.actor.id],
    revision: 0,
    location: { ...ctx.actor.location },
    createdSequence: ctx.sequence,
    createdAt: ctx.simTime,
  });
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: COPY.activity,
    actionType: "copy_artifact",
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: COPY.baseDuration,
    interruption: COPY.interruption,
    resourceCost: COPY.baseCost,
  }).state;
  const detail = { artifactId: id, sourceArtifactId: source.id, published: false };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [{
      type: "action.copy_artifact",
      actor: ctx.actor.id,
      simTime: ctx.simTime,
      inputs: { sourceArtifactId: source.id, title: parsed.data.title ?? null },
      resolution: detail,
      visibility: { kind: "private", owner: ctx.actor.id },
    }],
  };
};

export const publishArtifactResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = PublishPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "publish payload is malformed");
  }
  const artifact = ctx.state.artifacts[parsed.data.artifactId];
  if (artifact === undefined || artifact.owner !== ctx.actor.id) {
    return reject(ctx, RejectionCode.InvalidPayload, "artifact is not possessed by the actor");
  }
  const paid = spend(ctx.actor, PUBLISH.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy or compute");
  }
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({
    ...paid,
    needs: advanceNeeds(paid.needs, PUBLISH.baseDuration, ctx.state.rules),
  }));
  next = putArtifact(next, { ...artifact, published: true, location: { ...ctx.actor.location } });
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: PUBLISH.activity,
    actionType: "publish",
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: PUBLISH.baseDuration,
    interruption: PUBLISH.interruption,
    resourceCost: PUBLISH.baseCost,
  }).state;
  return {
    outcome: { status: "resolved", detail: { artifactId: artifact.id, published: true } },
    state: next,
    events: [{
      type: "action.publish",
      actor: ctx.actor.id,
      simTime: ctx.simTime,
      inputs: { artifactId: artifact.id },
      resolution: { artifactId: artifact.id, published: true },
      visibility: { kind: "public" },
    }],
  };
};

export const transferResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = TransferPropertyPayloadSchema.safeParse(payload);
  if (!parsed.success || parsed.data.toInhabitantId == null) {
    return reject(ctx, RejectionCode.InvalidPayload, "transfer requires a recipient inhabitant");
  }
  const input = parsed.data;
  const recipientId = input.toInhabitantId as string;
  if (
    input.toOrganisationId != null ||
    input.structureIds.length > 0 ||
    input.landTiles.length > 0
  ) {
    return reject(ctx, RejectionCode.InvalidPayload, "this slice transfers only resources and artifacts");
  }
  const recipient = ctx.state.inhabitants[recipientId];
  if (
    recipient === undefined ||
    recipient.status !== "alive" ||
    chebyshevDistance(ctx.actor.location, recipient.location) > 0
  ) {
    return reject(ctx, RejectionCode.InvalidPayload, "recipient must be alive and at the same location");
  }
  for (const artifactId of input.artifactIds) {
    if (ctx.state.artifacts[artifactId]?.owner !== ctx.actor.id) {
      return reject(ctx, RejectionCode.InvalidPayload, `artifact ${artifactId} is not possessed by the actor`);
    }
  }
  const afterEffort = spend(ctx.actor, TRANSFER.baseCost);
  const sender = afterEffort === null ? null : spend(afterEffort, input.resources);
  if (sender === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient held resources");
  }
  const received = receive(recipient, input.resources);
  if (carriedTotal(received.inventory) > ctx.state.rules.carryCapacity) {
    return reject(
      ctx,
      RejectionCode.InsufficientResources,
      "the recipient cannot carry those resources",
    );
  }

  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({
    ...sender,
    needs: advanceNeeds(sender.needs, TRANSFER.baseDuration, ctx.state.rules),
  }));
  next = updateInhabitant(next, recipient.id, () => received);
  for (const artifactId of input.artifactIds) {
    const artifact = next.artifacts[artifactId]!;
    next = putArtifact(next, {
      ...artifact,
      owner: recipient.id,
      provenance: [...artifact.provenance, recipient.id],
      location: { ...recipient.location },
    });
  }
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: TRANSFER.activity,
    actionType: "transfer",
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: TRANSFER.baseDuration,
    interruption: TRANSFER.interruption,
    resourceCost: TRANSFER.baseCost,
  }).state;

  const detail = {
    from: ctx.actor.id,
    to: recipient.id,
    resources: input.resources,
    artifactIds: input.artifactIds,
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [{
      type: "action.transfer",
      actor: ctx.actor.id,
      simTime: ctx.simTime,
      inputs: detail,
      resolution: detail,
      visibility: { kind: "participants", participants: [ctx.actor.id, recipient.id].sort() },
    }],
  };
};
