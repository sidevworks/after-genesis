/**
 * Finding things out and telling people (§11E, §11I).
 *
 * §11E forbids omniscience: "Information must enter an inhabitant's knowledge
 * through observation, communication, investigation, publication or authorised
 * access." These three actions are the *investigation* and *authorised access*
 * routes. Everything they return is bounded by what was actually observable,
 * recorded or disclosed — an investigation cannot reach into private cognition,
 * and an audit cannot read a ledger its subject declared private without the
 * subject's cooperation.
 *
 * §11F is equally explicit that auditors and investigators are not preassigned.
 * Nothing here requires a role, an appointment or an organisation; an inhabitant
 * becomes an investigator by investigating.
 */
import { z } from "zod";
import {
  AudienceSchema,
  EventReferenceListSchema,
  LONG_TEXT_MAX,
  MAX_MEDIUM_LIST,
  MAX_SMALL_LIST,
  MAX_TERM_MINUTES,
  OptionalCoordSchema,
  OptionalIdSchema,
  PercentSchema,
  STATEMENT_MAX,
  idList,
  optionalText,
  requiredText,
} from "./common.js";

/**
 * Examine records (§11I).
 *
 * The target may be an organisation's internal records, a currency's ledger, or
 * an individual's declared holdings. What is returned depends entirely on the
 * subject's declared visibility (§11E): a public ledger yields everything, a
 * members-only ledger yields nothing to a non-member, and a private one yields
 * nothing to anyone but its keeper.
 *
 * `authorityClaim` is stored as an assertion. §11G: an organisation claiming a
 * right of audit does not acquire one; it acquires a claim that other
 * inhabitants may honour, resent or ignore.
 */
export const AuditRecordsPayloadSchema = z.object({
  organisationId: OptionalIdSchema,
  currencyId: OptionalIdSchema,
  subjectInhabitantId: OptionalIdSchema,
  contractIds: idList(MAX_SMALL_LIST),
  scope: z
    .enum(["membership", "property", "ledger", "contracts", "rules", "all"])
    .default("all"),
  /** Window of simulated time to examine, in minutes since Genesis. */
  periodStart: z.number().int().min(0).max(MAX_TERM_MINUTES * 10).nullable().default(null),
  periodEnd: z.number().int().min(0).max(MAX_TERM_MINUTES * 10).nullable().default(null),
  authorityClaim: optionalText(STATEMENT_MAX),
});

/**
 * Look into something that happened (§11I).
 *
 * Investigation is physical and social work: examining a site, questioning
 * inhabitants, reading records, watching. It costs hours, it is observable while
 * it happens, and it can fail. What it can never do is read a mind — private
 * cognition and private memories stay private unless disclosed (§6, §11E).
 *
 * `referencedEvents` points at canonical sequence numbers, so an investigation
 * is anchored to the neutral record rather than to someone's account of it
 * (§11G: "The canonical event log must describe observable events neutrally").
 */
export const InvestigateEventPayloadSchema = z.object({
  question: requiredText(STATEMENT_MAX),
  referencedEvents: EventReferenceListSchema,
  subjectIds: idList(MAX_SMALL_LIST),
  coord: OptionalCoordSchema,
  structureId: OptionalIdSchema,
  method: z
    .enum(["site_examination", "questioning", "records", "observation", "reconstruction"])
    .default("site_examination"),
  organisationId: OptionalIdSchema,
  /** Investigate without being seen doing it. Costs more time, may still be noticed. */
  discreet: z.boolean().default(false),
});

/**
 * Tell others what was found (§11I).
 *
 * A report is a claim with a stated confidence, attributable to its author. It
 * is not a finding of fact and confers no authority: §11G's distinction between
 * "Claimed authority" and "Recognised legitimacy" is preserved by the simple
 * device that a report is stored as *what someone said*.
 *
 * A report may be false. Nothing checks it. Detecting a false report is another
 * investigation.
 */
export const ReportFindingsPayloadSchema = z.object({
  summary: requiredText(LONG_TEXT_MAX),
  /** The investigation or audit this reports on. */
  investigationEventSequence: z.number().int().nonnegative().nullable().default(null),
  audience: AudienceSchema.default("public"),
  recipientIds: idList(MAX_MEDIUM_LIST),
  organisationId: OptionalIdSchema,
  subjectIds: idList(MAX_SMALL_LIST),
  evidenceArtifactIds: idList(MAX_MEDIUM_LIST),
  referencedEvents: EventReferenceListSchema,
  confidence: PercentSchema.default(50),
});
