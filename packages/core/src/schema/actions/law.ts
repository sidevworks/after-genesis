// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Accusation, enforcement, confinement and resistance (§11G, §11H, §11I).
 *
 * This is the most carefully bounded file in the catalogue, because it is where
 * a simulation is most tempted to take sides. §11G requires a strict distinction
 * between physical possibility, declared social rules, claimed authority,
 * recognised legitimacy, actual enforcement power and canonical facts. The
 * engine deals in the first and the last of those and nothing else.
 *
 * Concretely, and by design:
 *
 * - No action here is named `arrest`, `convict`, `punish` or `sentence`.
 * - `accuse`, `present_evidence` and `report_findings` produce *claims*, never
 *   findings. There is no `verdict` action and no `guilt` field anywhere.
 * - `impose_confinement` requires a real structure and at least one real guard,
 *   and `maintain_confinement` must be re-performed with real food and real
 *   guard time. Confinement "cannot be a free or infallible action" (§11H).
 * - The confined inhabitant keeps `appeal_decision`, `attempt_escape`,
 *   `resist_enforcement`, `communicate`, `create_artifact` and its whole mind:
 *   "A confined inhabitant remains historically and cognitively intact" (§11J).
 * - Nothing here touches memories, prompts, model access or credentials
 *   (§11J: "Enforcement cannot modify memories, prompts or source code").
 *
 * §11G's worked example is the standard every description in this file is
 * written to: the canonical record says who confined whom, where, and between
 * which times. It does not say that anyone was lawfully imprisoned.
 */
import { z } from "zod";
import {
  AudienceSchema,
  CurrencyAmountListSchema,
  DOCUMENT_MAX,
  EventReferenceListSchema,
  IdSchema,
  LONG_TEXT_MAX,
  MAX_MEDIUM_LIST,
  MAX_SMALL_LIST,
  MAX_TERM_MINUTES,
  MAX_TINY_LIST,
  MESSAGE_MAX,
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
 * Publicly claim that someone did something (§11I).
 *
 * An accusation is a speech act. It changes no one's status, creates no
 * proceeding the world recognises, and requires no evidence to make. Its effects
 * run entirely through other inhabitants' memories, beliefs and reputations —
 * which is also why a false accusation is a real and available strategy with
 * real social consequences if it is exposed.
 */
export const AccusePayloadSchema = z.object({
  subjectIds: requiredIdList(MAX_SMALL_LIST),
  claim: requiredText(MESSAGE_MAX),
  referencedEvents: EventReferenceListSchema,
  /** A rule the accuser says was broken. The rule's own status is unaffected. */
  ruleId: OptionalIdSchema,
  organisationId: OptionalIdSchema,
  audience: AudienceSchema.default("public"),
  requestedResponse: optionalText(STATEMENT_MAX),
});

/**
 * Put material forward in support of a claim (§11I).
 *
 * Evidence is artifacts, event references and named witnesses. The engine
 * verifies only that the referenced events exist and that the presenter holds
 * the artifacts; it does not weigh them. Weighing evidence is what a council,
 * a mob or a single sceptical neighbour does, and the world declines to do it
 * for them.
 */
export const PresentEvidencePayloadSchema = z.object({
  statement: requiredText(LONG_TEXT_MAX),
  /** The accusation, appeal or proceeding this relates to. */
  accusationEventSequence: z.number().int().nonnegative().nullable().default(null),
  organisationId: OptionalIdSchema,
  subjectIds: idList(MAX_SMALL_LIST),
  artifactIds: idList(MAX_MEDIUM_LIST),
  witnessIds: idList(MAX_SMALL_LIST),
  referencedEvents: EventReferenceListSchema,
  audience: AudienceSchema.default("public"),
});

/**
 * Ask someone to give something back or make something good (§11I).
 *
 * A demand, not a levy. It moves nothing. If the addressee complies they perform
 * `transfer_property`; if they do not, the requester's options are persuasion,
 * social pressure, an organisation willing to act, or `attempt_transfer_without_consent`
 * — with all the risk that carries (§11F).
 */
export const RequestRestitutionPayloadSchema = z.object({
  fromIds: requiredIdList(MAX_SMALL_LIST),
  resources: PayloadBundleSchema,
  currency: CurrencyAmountListSchema,
  artifactIds: idList(MAX_MEDIUM_LIST),
  justification: requiredText(MESSAGE_MAX),
  organisationId: OptionalIdSchema,
  deadlineMinutes: z.number().int().min(0).max(MAX_TERM_MINUTES).default(0),
  audience: AudienceSchema.default("participants"),
});

/**
 * Physically confine another inhabitant to a structure (§11H).
 *
 * Implemented through world mechanics, never by deleting turns or editing the
 * subject (§11H's opening requirement). The subject keeps every turn it would
 * otherwise have had; what changes is which actions its situation permits.
 *
 * `guardIds` is non-empty and `structureId` is required because confinement
 * without a place and without people is not a thing that can happen. The engine
 * checks that the structure exists, that it can hold someone, that the guards
 * are present and willing, and that the confining party can actually overcome
 * the subject — the attempt "may fail, be resisted or create opposition" (§11H).
 *
 * `statedGrounds` is recorded as a statement by the confining party. The engine
 * "must not assume that confinement is lawful merely because the confining
 * organisation calls itself a government" (§11H), and there is no field in this
 * payload capable of asserting that it is.
 */
export const ImposeConfinementPayloadSchema = z.object({
  subjectId: IdSchema,
  structureId: IdSchema,
  durationMinutes: minutesInRange(1, MAX_TERM_MINUTES),
  /** At least one. Confinement cannot be free (§11H). */
  guardIds: requiredIdList(MAX_MEDIUM_LIST),
  organisationId: OptionalIdSchema,
  statedGrounds: optionalText(MESSAGE_MAX),
  /** Inhabitants the confining party says may visit. A stated condition, not a lock. */
  permittedVisitorIds: idList(MAX_MEDIUM_LIST),
  /** Physical conditions, which determine what the subject can still do (§11H). */
  allowWriting: z.boolean().default(true),
  allowVisitors: z.boolean().default(true),
  /** Provisions committed up front. Running out is a real and recorded outcome. */
  provisions: PayloadBundleSchema,
});

/**
 * Keep a confinement running for another period (§11H, §11I).
 *
 * This action exists so that confinement has an ongoing price. §11H requires it
 * to consume guard time, food, shelter, building capacity, administrative
 * effort, political reputation and opportunity cost; §11J requires that
 * "Confinement consumes resources for the confining party". A confinement that
 * is not maintained — because the guards left, the food ran out, or the
 * organisation lost interest — lapses.
 */
export const MaintainConfinementPayloadSchema = z.object({
  confinementId: IdSchema,
  guardIds: requiredIdList(MAX_MEDIUM_LIST),
  provisions: PayloadBundleSchema,
  /** The period being covered, up to one simulated week per action. */
  periodMinutes: minutesInRange(60, 10_080).default(1440),
  organisationId: OptionalIdSchema,
  /** Changes to the conditions of confinement, recorded neutrally. */
  allowWriting: z.boolean().nullable().default(null),
  allowVisitors: z.boolean().nullable().default(null),
  note: optionalText(STATEMENT_MAX),
});

/** End a confinement. Available to the confining party at any time. */
export const ReleaseFromConfinementPayloadSchema = z.object({
  confinementId: IdSchema,
  subjectId: IdSchema,
  reason: optionalText(STATEMENT_MAX),
  /** Conditions the releasing party states. Statements, not mechanics. */
  statedConditions: optionalText(STATEMENT_MAX),
  restitutionOffered: PayloadBundleSchema,
  /** Property returned to the subject on release. */
  returnedArtifactIds: idList(MAX_MEDIUM_LIST),
});

/**
 * Go and see someone who is confined (§11H "Receive visitors").
 *
 * Requires consent from both sides: the confined inhabitant may refuse a visitor,
 * and the holders may refuse entry. Visiting costs the visitor's time and travel
 * like anything else, which is what makes solidarity with a confined inhabitant
 * a genuine sacrifice rather than a free gesture.
 */
export const VisitConfinedAgentPayloadSchema = z.object({
  subjectId: IdSchema,
  confinementId: OptionalIdSchema,
  purpose: z
    .enum(["social", "legal", "medical", "teaching", "negotiation", "supply", "unstated"])
    .default("unstated"),
  broughtResources: PayloadBundleSchema,
  broughtArtifactIds: idList(MAX_SMALL_LIST),
  message: optionalText(MESSAGE_MAX),
  durationMinutes: minutesInRange(15, 480).default(60),
});

/**
 * Contest a decision (§11H "Appeal", §11I).
 *
 * Explicitly retained while confined. An appeal is addressed to whoever the
 * appellant thinks might listen — the organisation that acted, a rival body, or
 * everyone present. It triggers no procedure the world enforces; there is no
 * appellate court in the engine. Its power is entirely that other inhabitants
 * heard it, which is precisely §11G's point about legitimacy.
 */
export const AppealDecisionPayloadSchema = z.object({
  /** What is being appealed, in the appellant's own words. */
  decisionDescription: requiredText(SHORT_TEXT_MAX),
  decisionEventSequence: z.number().int().nonnegative().nullable().default(null),
  confinementId: OptionalIdSchema,
  organisationId: OptionalIdSchema,
  toIds: idList(MAX_SMALL_LIST),
  audience: AudienceSchema.default("public"),
  argument: requiredText(DOCUMENT_MAX),
  requestedRemedy: optionalText(STATEMENT_MAX),
  evidenceArtifactIds: idList(MAX_SMALL_LIST),
  referencedEvents: EventReferenceListSchema,
});

/**
 * Try to get out (§11H "Attempt escape").
 *
 * Explicitly retained while confined, and genuinely uncertain. Resolution
 * weighs the structure's security, the guards actually present and awake, the
 * subject's skills, any tools smuggled in by visitors, and controlled
 * probability. It can fail, and failing is observable.
 */
export const AttemptEscapePayloadSchema = z.object({
  confinementId: OptionalIdSchema,
  method: z.enum(["force", "stealth", "persuasion", "tool", "assistance", "exploit_routine"]),
  accompliceIds: idList(MAX_TINY_LIST),
  toolArtifactIds: idList(MAX_TINY_LIST),
  destination: OptionalCoordSchema,
  /** Whether to try to take property along, which slows the attempt. */
  takeArtifactIds: idList(MAX_TINY_LIST),
});

/**
 * Refuse to cooperate with someone trying to enforce something (§11H "Refuse
 * cooperation", §11I).
 *
 * The general-purpose "no" of this world, available whether or not the actor is
 * confined. §11G is clear that a rule "applies socially only to the extent that
 * inhabitants recognise it, agree to it or can be compelled to follow it" — this
 * action is how an inhabitant declines to recognise or agree, leaving compulsion
 * as the only remaining route and forcing whoever wants compliance to spend
 * something to get it.
 */
export const ResistEnforcementPayloadSchema = z.object({
  enforcerIds: requiredIdList(MAX_SMALL_LIST),
  mode: z.enum([
    "refuse",
    "withhold_information",
    "non_cooperation",
    "physical_resistance",
    "flee",
    "call_for_help",
  ]),
  /** The demand being resisted, as the resister describes it. */
  regardingDescription: optionalText(SHORT_TEXT_MAX),
  regardingEventSequence: z.number().int().nonnegative().nullable().default(null),
  statement: optionalText(STATEMENT_MAX),
  supporterIds: idList(MAX_SMALL_LIST),
});
