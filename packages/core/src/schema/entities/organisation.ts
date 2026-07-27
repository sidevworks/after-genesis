/**
 * Organisations (§11, §11D, §11G).
 *
 * One schema covers households, guilds, businesses, councils, governments and
 * opposition groups. That is a design decision, not a shortcut: §11 requires the
 * world to "Allow inhabitants to develop governance rather than imposing a
 * preferred political system", and giving a `government` a field that a `guild`
 * lacks would be imposing one.
 *
 * There is deliberately **no `legitimacy`, `jurisdiction`, `authority` or
 * `recognised` field**. §11G requires a strict distinction between claimed
 * authority and recognised legitimacy, and legitimacy is not a fact about an
 * organisation — it is a distribution of opinions held by inhabitants, readable
 * only from their beliefs and their behaviour. A field here would collapse the
 * distinction the section exists to protect.
 *
 * Rules adopted by an organisation are text with a status. They cannot alter
 * world mechanics (§11J: "Declaring a rule does not modify immutable world
 * rules").
 */
import { z } from "zod";
import { CoordSchema } from "../primitives.js";
import {
  ENTITY_DOCUMENT_MAX,
  ENTITY_LABEL_MAX,
  ENTITY_NOTE_MAX,
  ENTITY_TEXT_MAX,
  EntityIdSchema,
  HeldBundleSchema,
  CurrencyHoldingSchema,
  DisclosurePolicySchema,
  SequenceSchema,
  SimTimeSchema,
  entityName,
  entityText,
} from "./common.js";

/** A member and their standing inside the organisation. */
export const MembershipSchema = z.object({
  inhabitantId: EntityIdSchema,
  role: entityText(ENTITY_LABEL_MAX).default(""),
  joinedAt: SimTimeSchema,
  joinedByEventSequence: SequenceSchema,
  /** Contributions counted, so §11D's "unequal contribution" is visible. */
  contributedMinutes: z.number().int().nonnegative().max(52_560_000).default(0),
  contributedResources: HeldBundleSchema,
  /** Voting weight the organisation's own rules assign. Meaningful only internally. */
  voteWeight: z.number().int().min(0).max(1000).default(1),
  leftAt: SimTimeSchema.nullable().default(null),
});
export type Membership = z.infer<typeof MembershipSchema>;

/**
 * A rule an organisation has adopted (§11G).
 *
 * `appliesTo` may name all inhabitants. That is a claim of jurisdiction and
 * nothing more: "A rule applies socially only to the extent that inhabitants
 * recognise it, agree to it or can be compelled to follow it." The engine stores
 * the claim and enforces nothing.
 */
export const OrganisationRuleSchema = z.object({
  id: EntityIdSchema,
  title: entityName(),
  text: entityText(ENTITY_DOCUMENT_MAX),
  proposedById: EntityIdSchema,
  proposedAt: SimTimeSchema,
  proposedByEventSequence: SequenceSchema,
  appliesTo: z.enum(["members", "organisation_property", "claimed_territory", "all_inhabitants"]),
  /** What the organisation says happens on breach. Not executed by the engine. */
  statedEnforcement: entityText(ENTITY_TEXT_MAX).default(""),
  status: z.enum(["proposed", "adopted", "rejected", "repealed", "superseded"]),
  adoptedAt: SimTimeSchema.nullable().default(null),
  repealedAt: SimTimeSchema.nullable().default(null),
  replacesRuleId: EntityIdSchema.nullable().default(null),
});
export type OrganisationRule = z.infer<typeof OrganisationRuleSchema>;

/** A matter put to the organisation's decision procedure. */
export const ProposalSchema = z.object({
  id: EntityIdSchema,
  kind: z.enum(["rule", "membership", "expenditure", "dissolution", "role", "other"]),
  subject: entityText(ENTITY_NOTE_MAX),
  ruleId: EntityIdSchema.nullable().default(null),
  proposedById: EntityIdSchema,
  proposedAt: SimTimeSchema,
  closesAt: SimTimeSchema,
  votes: z
    .array(
      z.object({
        voterId: EntityIdSchema,
        choice: z.enum(["for", "against", "abstain"]),
        weight: z.number().int().min(0).max(1000),
        at: SimTimeSchema,
        eventSequence: SequenceSchema,
      }),
    )
    .max(256)
    .default([]),
  outcome: z.enum(["open", "carried", "failed", "withdrawn", "lapsed"]).default("open"),
  decidedAt: SimTimeSchema.nullable().default(null),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const OrganisationSchema = z.object({
  id: EntityIdSchema,
  worldId: EntityIdSchema,
  name: entityName(),
  /** A self-description chosen by the founders. It grants nothing (§11G). */
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
  purpose: entityText(ENTITY_TEXT_MAX).default(""),
  charter: entityText(ENTITY_DOCUMENT_MAX).default(""),
  foundedAt: SimTimeSchema,
  foundedByEventSequence: SequenceSchema,
  founderIds: z.array(EntityIdSchema).min(1).max(32),

  members: z.array(MembershipSchema).max(512).default([]),
  membershipRule: z.enum(["open", "invitation", "founder_approval", "member_vote"]),
  decisionRule: z.enum(["founder", "unanimous", "majority", "supermajority", "council", "none"]),

  rules: z.array(OrganisationRuleSchema).max(256).default([]),
  proposals: z.array(ProposalSchema).max(512).default([]),

  /** §11: organisations require declared property ownership. */
  treasury: HeldBundleSchema,
  currencyHoldings: z.array(CurrencyHoldingSchema).max(32).default([]),
  ownedArtifactIds: z.array(EntityIdSchema).max(512).default([]),
  ownedStructureIds: z.array(EntityIdSchema).max(256).default([]),
  /** Tiles the organisation claims. A claim; the world grants no territory. */
  claimedTiles: z.array(CoordSchema).max(1024).default([]),
  seat: CoordSchema.nullable().default(null),

  /** §11E: organisations may run transparent or private accounting. */
  accountingVisibility: DisclosurePolicySchema.default("members"),
  /** Currencies this organisation issues or governs (§10). */
  currencyIds: z.array(EntityIdSchema).max(16).default([]),

  status: z.enum(["active", "dormant", "dissolved"]).default("active"),
  dissolvedAt: SimTimeSchema.nullable().default(null),
  /** Preserved after dissolution and after every member has died (§8). */
  dissolvedByEventSequence: SequenceSchema.nullable().default(null),
});
export type Organisation = z.infer<typeof OrganisationSchema>;
