// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Neutral speech resolvers.
 *
 * Speech changes the world only by adding an authored statement to history.
 * Its content is never interpreted as a rule, fact, obligation or authority.
 */
import { getActionSpec } from "../../schema/actions/index.js";
import { CommunicatePayloadSchema } from "../../schema/actions/communication.js";
import { chebyshevDistance } from "../../schema/primitives.js";
import { updateInhabitant } from "../state.js";
import { advanceNeeds, beginActivity, spend } from "./effects.js";
import { asObject, readEnum, readString } from "./payload.js";
import { RejectionCode, reject, type ResolutionResult, type Resolver } from "./types.js";

const SPEC = getActionSpec("announce");
const COMMUNICATE = getActionSpec("communicate");

export const communicateResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = CommunicatePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "communicate payload is malformed");
  }
  const input = parsed.data;
  const recipients = input.recipients
    .map((id) => ctx.state.inhabitants[id])
    .filter((item) => item !== undefined);
  if (
    recipients.length !== input.recipients.length ||
    recipients.some(
      (recipient) =>
        recipient.status !== "alive" ||
        chebyshevDistance(ctx.actor.location, recipient.location) > 5,
    )
  ) {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      "every recipient must be alive and within speaking distance (radius 5)",
    );
  }
  const paid = spend(ctx.actor, COMMUNICATE.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy or compute to speak");
  }
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({
    ...paid,
    needs: advanceNeeds(paid.needs, input.intendedMinutes, ctx.state.rules),
  }));
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: COMMUNICATE.activity,
    actionType: "communicate",
    // Receiving an utterance does not seize the recipient's primary activity.
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: input.intendedMinutes,
    interruption: COMMUNICATE.interruption,
    resourceCost: COMMUNICATE.baseCost,
  }).state;
  const detail = {
    recipients: [...input.recipients].sort(),
    messageRecorded: true,
    recipientsAreNotAssumedToAgree: true,
    minutes: input.intendedMinutes,
  };
  const participantIds = [ctx.actor.id, ...input.recipients].sort();
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [{
      type: "action.communicate",
      actor: ctx.actor.id,
      simTime: ctx.simTime,
      inputs: { recipients: input.recipients, message: input.message },
      resolution: detail,
      visibility: { kind: "participants", participants: participantIds },
    }],
  };
};

export const announceResolver: Resolver = (ctx, payload): ResolutionResult => {
  const object = asObject(payload);
  if (object === null) {
    return reject(ctx, RejectionCode.InvalidPayload, "announce payload must be an object");
  }
  const message = readString(object, "message");
  const scope = readEnum(object, "scope", ["local", "world", "organisation"] as const) ?? "local";
  if (message === null || message.trim() === "" || message.length > 20_000) {
    return reject(ctx, RejectionCode.InvalidPayload, '"message" must be non-empty text');
  }
  if (scope === "organisation") {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      "association-scoped speech is not available in the neutral experimental slice",
    );
  }

  const paid = spend(ctx.actor, SPEC.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy or compute to speak");
  }
  const actor = {
    ...paid,
    needs: advanceNeeds(paid.needs, SPEC.baseDuration, ctx.state.rules),
  };
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => actor);
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: SPEC.activity,
    actionType: "announce",
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: SPEC.baseDuration,
    interruption: SPEC.interruption,
    resourceCost: SPEC.baseCost,
  }).state;

  const location = scope === "world" ? null : { ...ctx.actor.location };
  next = {
    ...next,
    publicRecords: {
      ...next.publicRecords,
      announcements: [
        ...next.publicRecords.announcements,
        {
          sequence: ctx.sequence,
          simTime: ctx.simTime,
          speaker: ctx.actor.id,
          text: message,
          location,
        },
      ],
    },
  };

  const detail = {
    statementRecorded: true,
    scope,
    location,
    witnessesAreNotAssumedToAgree: true,
    minutes: SPEC.baseDuration,
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.announce",
        actor: ctx.actor.id,
        simTime: ctx.simTime,
        inputs: { message, scope },
        resolution: detail,
        visibility:
          location === null
            ? { kind: "public" }
            : { kind: "local", x: location.x, y: location.y },
      },
    ],
  };
};
