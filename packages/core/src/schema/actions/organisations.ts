// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Collective structures (§11, §11D, §11G).
 *
 * §11 lists households, guilds, councils, governments and opposition groups —
 * all of which are *the same entity* here, distinguished only by a `kind` label
 * the founders choose and by what they can actually do. The world imposes no
 * political system and grants no organisation authority over non-members
 * (§11G: "declaration alone does not make those rules universal").
 *
 * §11D's coordination costs are real and appear as `coordinate_work`: an
 * organisation that wants the benefits of division of labour must spend
 * somebody's time arranging it, and a badly run group therefore produces less
 * than its members would alone.
 */
import { z } from "zod";
import { CoordSchema } from "../primitives.js";
import {
  DOCUMENT_MAX,
  IdSchema,
  LABEL_MAX,
  MAX_ITEM_LIST,
  MAX_MEDIUM_LIST,
  MAX_PLANNED_MINUTES,
  MAX_SMALL_LIST,
  MESSAGE_MAX,
  NAME_MAX,
  OptionalCoordSchema,
  OptionalIdSchema,
  PayloadBundleSchema,
  SHORT_TEXT_MAX,
  STATEMENT_MAX,
  idList,
  minutesInRange,
  optionalText,
  requiredIdList,
  requiredText,
} from "./common.js";

/**
 * Found an organisation.
 *
 * Deliberately cheap in materials and expensive in time and attention: founding
 * is a declaration plus a written charter, which is why a confined inhabitant
 * can still do it (§11H retains writing and negotiation). Founding a "government"
 * costs exactly what founding a household costs, because the world does not
 * recognise the difference — only inhabitants can (§11G).
 *
 * `accountingVisibility` implements §11E's allowance that organisations "choose
 * transparent or private accounting systems".
 */
export const CreateOrganisationPayloadSchema = z.object({
  name: requiredText(NAME_MAX),
  kind: z.enum([
    "household",
    "partnership",
    "business",
    "guild",
    "school",
    "medical_group",
    "artistic_collective",
    "philosophical_group",
    "council",
    "government",
    "opposition_group",
    "other",
  ]),
  purpose: optionalText(MESSAGE_MAX),
  charter: z.string().max(DOCUMENT_MAX).default(""),
  /** Inhabitants named as founders. Each must still join to become a member. */
  foundingMemberIds: idList(MAX_ITEM_LIST),
  membershipRule: z
    .enum(["open", "invitation", "founder_approval", "member_vote"])
    .default("invitation"),
  decisionRule: z
    .enum(["founder", "unanimous", "majority", "supermajority", "council", "none"])
    .default("founder"),
  accountingVisibility: z.enum(["public", "members", "private"]).default("members"),
  /** A tile the organisation claims as its seat. A claim, not a grant of territory. */
  seat: OptionalCoordSchema,
});

/** Ask someone to join. An invitation binds no one until it is accepted. */
export const InviteMemberPayloadSchema = z.object({
  organisationId: IdSchema,
  inviteeIds: requiredIdList(MAX_MEDIUM_LIST),
  role: optionalText(LABEL_MAX),
  message: optionalText(STATEMENT_MAX),
  /** Terms of membership expressed as a contract, if the founders want them binding. */
  termsContractId: OptionalIdSchema,
});

/**
 * Become a member.
 *
 * Requires the organisation's consent under its own `membershipRule` — which is
 * the organisation's rule, applied because its members apply it, not because the
 * engine believes in it.
 */
export const JoinOrganisationPayloadSchema = z.object({
  organisationId: IdSchema,
  invitationId: OptionalIdSchema,
  role: optionalText(LABEL_MAX),
  statement: optionalText(STATEMENT_MAX),
});

/**
 * Stop being a member.
 *
 * Always available. No organisation can prevent a member from leaving: the world
 * offers confinement of a *body* (§11H), never of a membership. Whatever
 * obligations the departing member holds under contracts survive their exit.
 */
export const LeaveOrganisationPayloadSchema = z.object({
  organisationId: IdSchema,
  reason: optionalText(STATEMENT_MAX),
  /** Hand a role to someone else on the way out. */
  transferRoleToId: OptionalIdSchema,
  /** Property the leaver claims on exit. A claim the organisation may dispute. */
  claimedProperty: PayloadBundleSchema,
});

/**
 * Propose a rule inside an organisation (§11G).
 *
 * CONSTITUTIONAL BOUNDARY: a proposed rule is text attached to an organisation.
 * It cannot alter world mechanics, action costs, the action catalogue or any
 * invariant (§11J: "Declaring a rule does not modify immutable world rules"). An
 * organisation may adopt a rule that "no inhabitant may leave the valley"; the
 * world will still resolve `move` normally, and the rule matters only to the
 * extent the organisation can persuade or compel.
 *
 * `appliesTo` may name non-members. That is allowed and is exactly how an
 * organisation claims jurisdiction — and exactly why the engine treats the claim
 * as a claim.
 */
export const ProposeRulePayloadSchema = z.object({
  organisationId: IdSchema,
  title: requiredText(NAME_MAX),
  text: requiredText(DOCUMENT_MAX),
  appliesTo: z
    .enum(["members", "organisation_property", "claimed_territory", "all_inhabitants"])
    .default("members"),
  /** What the proposer says should happen on breach. A statement of intent only. */
  proposedEnforcement: optionalText(MESSAGE_MAX),
  replacesRuleId: OptionalIdSchema,
  /** Minutes the proposal stays open for votes. */
  votingPeriodMinutes: minutesInRange(0, 43_200).default(1440),
});

/**
 * Cast a vote.
 *
 * Available to a confined inhabitant. Whether the organisation *counts* that
 * vote is the organisation's business; the engine records that the vote was cast
 * and refuses to decide, on anyone's behalf, that confinement removes a voice
 * (§11G, §11H — a confined inhabitant remains historically and cognitively
 * intact).
 *
 * `weightClaimed` is a claim about voting power, not a grant of it.
 */
export const VotePayloadSchema = z.object({
  organisationId: IdSchema,
  proposalId: IdSchema,
  choice: z.enum(["for", "against", "abstain"]),
  weightClaimed: z.number().int().min(1).max(1000).default(1),
  statement: optionalText(STATEMENT_MAX),
});

/**
 * Direct other inhabitants' work (§11D, §11I).
 *
 * This is where organisational productivity comes from and where it is paid for.
 * Coordination consumes the coordinator's time and compute, meetings consume the
 * attendees', and the resulting specialisation gain is computed from the actual
 * assignments — there is no unconditional team multiplier (§11D: "Team output
 * must not receive an unconditional multiplier").
 *
 * An assignment is a request. Assignees are not compelled by it; they perform it
 * because they agreed, are paid, or want to.
 */
export const CoordinateWorkPayloadSchema = z.object({
  organisationId: IdSchema,
  objective: requiredText(STATEMENT_MAX),
  assignments: z
    .array(
      z.object({
        assigneeId: IdSchema,
        task: requiredText(SHORT_TEXT_MAX),
        coord: CoordSchema.nullable().default(null),
        expectedMinutes: z.number().int().min(0).max(MAX_PLANNED_MINUTES).default(0),
        resources: PayloadBundleSchema,
      }),
    )
    .max(MAX_MEDIUM_LIST)
    .default([]),
  /** Time spent in a meeting. Consumed by every attendee, not just the caller (§11D). */
  meetingMinutes: z.number().int().min(0).max(480).default(0),
  attendeeIds: idList(MAX_MEDIUM_LIST),
});

/**
 * Give labour, resources or artifacts to an organisation (§11I).
 *
 * The counterpart to `coordinate_work`: shared production requires that
 * somebody actually contributes, and §11D's "unequal contribution" cost becomes
 * visible because every contribution is a separate canonical event that anyone
 * with access to the organisation's records can count.
 */
export const ContributeToGroupPayloadSchema = z.object({
  organisationId: IdSchema,
  resources: PayloadBundleSchema,
  artifactIds: idList(MAX_MEDIUM_LIST),
  structureIds: idList(MAX_SMALL_LIST),
  labourMinutes: z.number().int().min(0).max(MAX_PLANNED_MINUTES).default(0),
  /** The assignment this discharges, if any. */
  assignmentId: OptionalIdSchema,
  note: optionalText(STATEMENT_MAX),
});
