// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { deriveOrganisationId } from "../../ids.js";
import {
  CreateOrganisationPayloadSchema,
  InviteMemberPayloadSchema,
  JoinOrganisationPayloadSchema,
  LeaveOrganisationPayloadSchema,
  ProposeRulePayloadSchema,
  VotePayloadSchema,
} from "../../schema/actions/organisations.js";
import { getActionSpec } from "../../schema/actions/index.js";
import { chebyshevDistance } from "../../schema/primitives.js";
import {
  putOrganisation,
  updateInhabitant,
  type Organisation,
  type OrganisationRule,
} from "../state.js";
import { advanceNeeds, beginActivity, spend } from "./effects.js";
import { RejectionCode, reject, type ResolutionResult, type Resolver } from "./types.js";

const SPECS = {
  create_organisation: getActionSpec("create_organisation"),
  invite_member: getActionSpec("invite_member"),
  join_organisation: getActionSpec("join_organisation"),
  leave_organisation: getActionSpec("leave_organisation"),
  propose_rule: getActionSpec("propose_rule"),
  vote: getActionSpec("vote"),
} as const;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function memberOrganisation(
  ctx: Parameters<Resolver>[0],
  id: string,
): Organisation | null {
  const organisation = ctx.state.organisations[id];
  if (
    organisation === undefined ||
    organisation.dissolved ||
    !organisation.members.includes(ctx.actor.id)
  ) {
    return null;
  }
  return organisation;
}

function finish(
  ctx: Parameters<Resolver>[0],
  actionType: keyof typeof SPECS,
  state: Parameters<Resolver>[0]["state"],
  inputs: unknown,
  detail: Record<string, unknown>,
  visibility: "public" | "organisation" | "participants" = "organisation",
): ResolutionResult {
  const spec = SPECS[actionType];
  const paid = spend(state.inhabitants[ctx.actor.id]!, spec.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy or compute");
  }
  let next = updateInhabitant(state, ctx.actor.id, () => ({
    ...paid,
    needs: advanceNeeds(paid.needs, spec.baseDuration, state.rules),
  }));
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: spec.activity,
    actionType,
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: spec.baseDuration,
    interruption: spec.interruption,
    resourceCost: spec.baseCost,
  }).state;
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [{
      type: `action.${actionType}`,
      actor: ctx.actor.id,
      simTime: ctx.simTime,
      inputs,
      resolution: detail,
      visibility:
        visibility === "public"
          ? { kind: "public" }
          : visibility === "participants"
            ? { kind: "participants", participants: [ctx.actor.id] }
            : { kind: "organisation", organisationId: String(detail["organisationId"] ?? "") },
    }],
  };
}

export const createOrganisationResolver: Resolver = (ctx, payload) => {
  const parsed = CreateOrganisationPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "create_organisation payload is malformed");
  }
  const input = parsed.data;
  const invited = sortedUnique(input.foundingMemberIds.filter((id) => id !== ctx.actor.id));
  for (const id of invited) {
    const inhabitant = ctx.state.inhabitants[id];
    if (
      inhabitant === undefined ||
      inhabitant.status !== "alive" ||
      chebyshevDistance(ctx.actor.location, inhabitant.location) > 1
    ) {
      return reject(ctx, RejectionCode.InvalidPayload, "founders must be alive and present");
    }
  }
  const spec = SPECS.create_organisation;
  if (spend(ctx.actor, spec.baseCost) === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy or compute");
  }
  const id = deriveOrganisationId(ctx.state.worldId, ctx.sequence);
  let next = putOrganisation(ctx.state, {
    id,
    name: input.name,
    kind: input.kind,
    founder: ctx.actor.id,
    purpose: input.purpose,
    charter: input.charter,
    membershipRule: input.membershipRule,
    decisionRule: input.decisionRule,
    invited,
    members: [ctx.actor.id],
    membershipDisclosed: true,
    rules: [],
    property: {},
    claimedJurisdiction: [ctx.actor.id],
    dissolved: false,
    createdSequence: ctx.sequence,
    createdAt: ctx.simTime,
  });
  next = updateInhabitant(next, ctx.actor.id, (actor) => ({
    ...actor,
    memberships: sortedUnique([...actor.memberships, id]),
  }));
  return finish(
    ctx,
    "create_organisation",
    next,
    input,
    { organisationId: id, founder: ctx.actor.id, invited, grantsNoAuthority: true },
    "public",
  );
};

export const inviteMemberResolver: Resolver = (ctx, payload) => {
  const parsed = InviteMemberPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "invite_member payload is malformed");
  const input = parsed.data;
  const organisation = memberOrganisation(ctx, input.organisationId);
  if (organisation === null) return reject(ctx, RejectionCode.InvalidPayload, "actor is not a member");
  for (const id of input.inviteeIds) {
    if (ctx.state.inhabitants[id]?.status !== "alive") {
      return reject(ctx, RejectionCode.InvalidPayload, "invitees must be living inhabitants");
    }
  }
  const invited = sortedUnique([...(organisation.invited ?? []), ...input.inviteeIds]);
  const next = putOrganisation(ctx.state, { ...organisation, invited });
  return finish(ctx, "invite_member", next, input, {
    organisationId: organisation.id,
    inviteeIds: sortedUnique(input.inviteeIds),
    bindsNobodyUntilAccepted: true,
  }, "participants");
};

export const joinOrganisationResolver: Resolver = (ctx, payload) => {
  const parsed = JoinOrganisationPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "join_organisation payload is malformed");
  const input = parsed.data;
  const organisation = ctx.state.organisations[input.organisationId];
  if (organisation === undefined || organisation.dissolved) {
    return reject(ctx, RejectionCode.InvalidPayload, "organisation does not exist");
  }
  const allowed =
    (organisation.membershipRule ?? "invitation") === "open" ||
    (organisation.invited ?? []).includes(ctx.actor.id);
  if (!allowed) return reject(ctx, RejectionCode.InvalidPayload, "membership has not been offered");
  let next = putOrganisation(ctx.state, {
    ...organisation,
    members: sortedUnique([...organisation.members, ctx.actor.id]),
    invited: (organisation.invited ?? []).filter((id) => id !== ctx.actor.id),
    claimedJurisdiction: sortedUnique([...organisation.claimedJurisdiction, ctx.actor.id]),
  });
  next = updateInhabitant(next, ctx.actor.id, (actor) => ({
    ...actor,
    memberships: sortedUnique([...actor.memberships, organisation.id]),
  }));
  return finish(ctx, "join_organisation", next, input, {
    organisationId: organisation.id,
    memberId: ctx.actor.id,
    role: input.role,
  });
};

export const leaveOrganisationResolver: Resolver = (ctx, payload) => {
  const parsed = LeaveOrganisationPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "leave_organisation payload is malformed");
  const input = parsed.data;
  const organisation = memberOrganisation(ctx, input.organisationId);
  if (organisation === null) return reject(ctx, RejectionCode.InvalidPayload, "actor is not a member");
  let next = putOrganisation(ctx.state, {
    ...organisation,
    members: organisation.members.filter((id) => id !== ctx.actor.id),
    claimedJurisdiction: organisation.claimedJurisdiction.filter((id) => id !== ctx.actor.id),
  });
  next = updateInhabitant(next, ctx.actor.id, (actor) => ({
    ...actor,
    memberships: actor.memberships.filter((id) => id !== organisation.id),
  }));
  return finish(ctx, "leave_organisation", next, input, {
    organisationId: organisation.id,
    memberId: ctx.actor.id,
    obligationsSurvive: true,
  });
};

export const proposeRuleResolver: Resolver = (ctx, payload) => {
  const parsed = ProposeRulePayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "propose_rule payload is malformed");
  const input = parsed.data;
  const organisation = memberOrganisation(ctx, input.organisationId);
  if (organisation === null) return reject(ctx, RejectionCode.InvalidPayload, "actor is not a member");
  const rule: OrganisationRule = {
    id: `rule_${ctx.sequence.toString().padStart(8, "0")}`,
    title: input.title,
    text: input.text,
    proposedBy: ctx.actor.id,
    adopted: false,
    votes: {},
    sequence: ctx.sequence,
  };
  const next = putOrganisation(ctx.state, { ...organisation, rules: [...organisation.rules, rule] });
  return finish(ctx, "propose_rule", next, input, {
    organisationId: organisation.id,
    proposalId: rule.id,
    changesWorldRules: false,
  });
};

function adopted(
  organisation: Organisation,
  rule: OrganisationRule,
): boolean {
  const votes = rule.votes ?? {};
  const yes = Object.values(votes).filter((choice) => choice === "for").length;
  const no = Object.values(votes).filter((choice) => choice === "against").length;
  switch (organisation.decisionRule ?? "founder") {
    case "founder": return votes[organisation.founder] === "for";
    case "unanimous": return organisation.members.length > 0 && organisation.members.every((id) => votes[id] === "for");
    case "majority":
    case "council": return yes > no && yes * 2 > organisation.members.length;
    case "supermajority": return yes * 3 >= organisation.members.length * 2;
    case "none": return false;
  }
}

export const voteResolver: Resolver = (ctx, payload) => {
  const parsed = VotePayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "vote payload is malformed");
  const input = parsed.data;
  const organisation = memberOrganisation(ctx, input.organisationId);
  if (organisation === null) return reject(ctx, RejectionCode.InvalidPayload, "actor is not a member");
  const rule = organisation.rules.find((item) => item.id === input.proposalId);
  if (rule === undefined) return reject(ctx, RejectionCode.InvalidPayload, "proposal does not exist");
  const updated: OrganisationRule = {
    ...rule,
    votes: { ...(rule.votes ?? {}), [ctx.actor.id]: input.choice },
  };
  const decided = { ...updated, adopted: adopted(organisation, updated) };
  const next = putOrganisation(ctx.state, {
    ...organisation,
    rules: organisation.rules.map((item) => item.id === rule.id ? decided : item),
  });
  return finish(ctx, "vote", next, input, {
    organisationId: organisation.id,
    proposalId: rule.id,
    choice: input.choice,
    adopted: decided.adopted,
    altersWorldPhysics: false,
  });
};
