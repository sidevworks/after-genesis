// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Medicine (§8).
 *
 * §8 is explicit: "Do not preassign a 'doctor' career." These four actions are
 * the primitives from which medicine may emerge — or may not. Nothing here
 * requires a licence, a title or an organisation. An inhabitant becomes a
 * physician by repeatedly performing these actions well enough that others come
 * to it, and the world records only that it did so.
 *
 * Outcomes depend on knowledge, skill, the condition, resources and controlled
 * probability (§8) — never on how confident or eloquent the model's description
 * of the treatment is (§2).
 */
import { z } from "zod";
import { SkillNameSchema } from "../entities/skills.js";
import {
  DOCUMENT_MAX,
  IdSchema,
  MAX_MEDIUM_LIST,
  MAX_SMALL_LIST,
  NAME_MAX,
  OptionalIdSchema,
  PayloadBundleSchema,
  PercentSchema,
  SHORT_TEXT_MAX,
  STATEMENT_MAX,
  idList,
  optionalText,
  requiredText,
} from "./common.js";

/**
 * Examine another inhabitant (§8 "Inspect another inhabitant with consent or
 * applicable local authority").
 *
 * Consent is required. `authorityClaim` records an assertion of a right to
 * examine without it — a claim the engine stores and does not honour on its own
 * (§11G): whether the claim carries weight depends on whether the subject or the
 * others present treat it as carrying weight.
 *
 * What an examination reveals is bounded by the examiner's diagnosis skill. A
 * thorough examination by an unskilled inhabitant returns symptoms it cannot
 * interpret.
 */
export const InspectAgentPayloadSchema = z.object({
  targetId: IdSchema,
  focus: z
    .enum(["general", "symptoms", "injury", "cognition", "development", "nutrition"])
    .default("general"),
  thoroughness: z.enum(["cursory", "standard", "thorough"]).default("standard"),
  authorityClaim: optionalText(STATEMENT_MAX),
});

/**
 * Form and record a diagnosis (§8 "Form a diagnosis").
 *
 * A diagnosis is a *belief*, not a canonical fact about the subject's body. The
 * engine stores it as the diagnostician's claim, with a stated confidence, and
 * it may simply be wrong — which is what makes competing diagnoses, second
 * opinions and reputational consequences possible.
 */
export const DiagnoseConditionPayloadSchema = z.object({
  subjectId: IdSchema,
  /** Symptoms the diagnostician believes it observed. Short clinical phrases. */
  observedSymptoms: z.array(z.string().max(SHORT_TEXT_MAX)).max(MAX_MEDIUM_LIST).default([]),
  hypothesis: requiredText(STATEMENT_MAX),
  /** A previously discovered condition this is believed to be an instance of. */
  conditionId: OptionalIdSchema,
  /** Integer percent. No floats anywhere in the world (see util/canonical.ts). */
  confidence: PercentSchema.default(50),
  /** Examinations and studies this rests on, so a diagnosis can be audited. */
  basedOnEventSequences: z.array(z.number().int().nonnegative()).max(MAX_MEDIUM_LIST).default([]),
});

/**
 * Devise a treatment (§8 "Develop a treatment").
 *
 * The design is an artifact-like record with declared resource requirements and
 * a required skill. Whether it *works* is determined when it is applied, from
 * the condition's actual mechanics and the applier's actual skill — never from
 * the text of `method`. A treatment designed by a novice for a condition it does
 * not understand is a well-formed payload that reliably fails.
 */
export const DesignTreatmentPayloadSchema = z.object({
  name: requiredText(NAME_MAX),
  /** The condition this is aimed at, if one has been identified. */
  conditionId: OptionalIdSchema,
  /** A named condition not yet in the world's registry: speculative medicine. */
  targetConditionName: optionalText(NAME_MAX),
  method: requiredText(DOCUMENT_MAX),
  requiredResources: PayloadBundleSchema,
  requiredSkill: SkillNameSchema.nullable().default(null),
  requiredSkillLevel: z.number().int().min(0).max(100).default(0),
  /** Research notes and prior treatments this builds on (§12 provenance). */
  basedOnArtifactIds: idList(MAX_SMALL_LIST),
  basedOnTreatmentId: OptionalIdSchema,
});

/**
 * Administer a treatment to a patient (§8 "Apply a treatment").
 *
 * Requires the patient's consent. The patient occupies the `receiving_treatment`
 * activity for the duration, so being treated costs the patient time too (§11A).
 *
 * Resources are consumed on the attempt whether or not it helps. Treatment can
 * fail, do nothing, or worsen the condition; §8 requires that outcome depend on
 * controlled probability, and a treatment that always worked would make the
 * whole of §8 decorative.
 */
export const ApplyTreatmentPayloadSchema = z.object({
  patientId: IdSchema,
  treatmentId: OptionalIdSchema,
  /** An improvised treatment with no prior design. Riskier, and recorded as such. */
  improvisedMethod: optionalText(DOCUMENT_MAX),
  conditionId: OptionalIdSchema,
  resources: PayloadBundleSchema,
  /** Repetitions or strength, bounded. More is not automatically better. */
  dosage: z.number().int().min(1).max(100).default(1),
  assistantIds: idList(MAX_SMALL_LIST),
  feeAsked: PayloadBundleSchema,
  notes: optionalText(STATEMENT_MAX),
});
