// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Learning, teaching, creating and publishing (§9, §12).
 *
 * Skills rise through practice, study and instruction (§9) — never by
 * assignment. `create_artifact` and `publish` are separate actions on purpose:
 * writing something and letting others read it are different acts with different
 * visibility, and the gap between them is where private drafts, suppressed
 * findings and posthumous publication live (§11E, §12).
 */
import { z } from "zod";
import { SkillNameSchema } from "../entities/skills.js";
import {
  ARTIFACT_CONTENT_MAX,
  AudienceSchema,
  IdSchema,
  MAX_MEDIUM_LIST,
  MAX_SMALL_LIST,
  MESSAGE_MAX,
  NAME_MAX,
  OptionalIdSchema,
  PayloadBundleSchema,
  STATEMENT_MAX,
  idList,
  optionalText,
  requiredIdList,
  requiredText,
} from "./common.js";

/**
 * Spend time getting better at something, alone.
 *
 * Study can be aimed at a skill, at an artifact (reading someone's research), or
 * at an open question. `intensity` trades simulated time and compute against
 * progress — a deliberate exposure of §11B's cognition levels to the inhabitant,
 * so that "think hard about this" is a choice with a cost rather than a free
 * upgrade.
 */
export const StudyPayloadSchema = z.object({
  skill: SkillNameSchema.nullable().default(null),
  /** A written work, research note or design being studied (§12). */
  artifactId: OptionalIdSchema,
  /** A condition being studied, which is how medical knowledge accrues (§8). */
  conditionId: OptionalIdSchema,
  question: optionalText(STATEMENT_MAX),
  intensity: z.enum(["light", "focused", "deep"]).default("focused"),
});

/**
 * Instruct other inhabitants (§9).
 *
 * Teaching is the fastest route to a skill and the only one that requires
 * another inhabitant's agreement, because it spends the students' time as well
 * as the teacher's (§11J). `feeAsked` makes paid instruction possible without
 * the world taking a position on whether teaching should be paid.
 */
export const TeachPayloadSchema = z.object({
  studentIds: requiredIdList(MAX_SMALL_LIST),
  skill: SkillNameSchema,
  lessonSummary: requiredText(MESSAGE_MAX),
  /** Teaching material the students may afterwards study independently. */
  artifactId: OptionalIdSchema,
  feeAsked: PayloadBundleSchema,
  organisationId: OptionalIdSchema,
});

/**
 * Produce a persistent creative work (§12).
 *
 * `content` is stored verbatim on the canonical event and lives forever, which
 * is why it is capped at 20 000 characters (see ARTIFACT_CONTENT_MAX). Longer
 * works are chains of artifacts linked by `derivedFromArtifactId`, which also
 * gives them provenance and a revision history.
 *
 * The artifact kinds cover §12's list. `invention` produces a *design*: whether
 * the described thing works is decided by the engine when someone tries to build
 * or craft from it, never by the description itself.
 */
export const CreateArtifactPayloadSchema = z.object({
  kind: z.enum([
    "written_work",
    "image",
    "design",
    "song",
    "script",
    "play",
    "performance_record",
    "research_note",
    "advertisement",
    "news_report",
    "invention",
    "other",
  ]),
  title: requiredText(NAME_MAX),
  content: z.string().max(ARTIFACT_CONTENT_MAX).default(""),
  /** For works whose body lives in Cloud Storage rather than inline (§3, §12). */
  externalReference: optionalText(NAME_MAX),
  collaboratorIds: idList(MAX_SMALL_LIST),
  materials: PayloadBundleSchema,
  derivedFromArtifactId: OptionalIdSchema,
  /** Creating on behalf of an organisation, which then holds the work. */
  organisationId: OptionalIdSchema,
  /** Revise an existing work. A new revision, never an edit of history (§19). */
  revisesArtifactId: OptionalIdSchema,
});

/**
 * Make an artifact observable to others (§12, §11E).
 *
 * Publication is a disclosure event: after it, the work's content may
 * legitimately enter other inhabitants' knowledge. `priceAsked` lets a work be
 * offered for sale rather than given away; the world neither enforces nor
 * suggests a price (§10: "Do not manipulate prices or demand").
 */
export const PublishPayloadSchema = z.object({
  artifactId: IdSchema,
  audience: AudienceSchema.default("public"),
  recipientIds: idList(MAX_MEDIUM_LIST),
  organisationId: OptionalIdSchema,
  priceAsked: PayloadBundleSchema,
  statement: optionalText(STATEMENT_MAX),
});
