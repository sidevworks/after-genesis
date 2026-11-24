// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Health conditions and treatments (§8, §7).
 *
 * A condition is a deterministic state machine over declared stages. §7 is
 * emphatic about why this shape and not another: bounded imperfections "must be
 * represented through safe schemas and deterministic rules. Never generate or
 * execute arbitrary broken application code to simulate illness." An inhabitant
 * with weak memory retention has a condition whose stage effects reduce its
 * retrieval budget — it does not have a sabotaged code path.
 *
 * §8 requires that a serious condition left unresolved beyond its defined
 * progression may kill. That is why every stage declares how long it lasts and
 * what follows it: mortality is the end of a published progression, not a
 * surprise roll.
 */
import { z } from "zod";
import {
  ENTITY_LINE_MAX,
  ENTITY_NAME_MAX,
  ENTITY_NOTE_MAX,
  ENTITY_TEXT_MAX,
  EntityIdSchema,
  HeldBundleSchema,
  PercentSchema,
  PermilleSchema,
  SequenceSchema,
  SimTimeSchema,
  entityName,
  entityText,
} from "./common.js";
import { SkillNameSchema } from "./skills.js";

/**
 * What a condition stage does to an inhabitant while it lasts.
 *
 * Every effect is a bounded integer applied by the engine at a known point in
 * the turn. Nothing here can reach the model's prompt, its weights, or its
 * ability to be an autonomous agent — an impaired inhabitant is still an
 * inhabitant, thinking for itself with fewer resources. §11B's cognitive
 * restrictions and these penalties are the same mechanism.
 */
export const ConditionEffectsSchema = z.object({
  /** Extra energy burned per simulated day, beyond ordinary living. */
  energyDrainPerDay: z.number().int().min(0).max(1000).default(0),
  /** Percentage reduction in the daily compute allowance (§11B). */
  computePenaltyPercent: PercentSchema.default(0),
  /** Percentage reduction in effective skill for every action. */
  skillPenaltyPercent: PercentSchema.default(0),
  /** Percentage increase in the duration of movement. 100 means immobile. */
  mobilityPenaltyPercent: PercentSchema.default(0),
  /** Percentage reduction in how many memories can be retrieved per turn (§19). */
  memoryPenaltyPercent: PercentSchema.default(0),
  /** Chance per simulated day that this stage ends in death, per mille (§8). */
  mortalityRiskPermillePerDay: PermilleSchema.default(0),
  /** Actions this stage makes impossible (§7 "Impaired use of particular world actions"). */
  blockedActionTypes: z.array(z.string().max(64)).max(16).default([]),
});
export type ConditionEffects = z.infer<typeof ConditionEffectsSchema>;

/**
 * One stage in a condition's progression (§8).
 *
 * `minutesToNextStage` of 0 means the stage is stable: it persists until treated
 * or until the inhabitant dies of something else. `nextStageIndex` of null means
 * the progression ends here — either in recovery or, if
 * `mortalityRiskPermillePerDay` is non-zero, in death.
 */
export const ConditionStageSchema = z.object({
  index: z.number().int().min(0).max(15),
  name: entityName(),
  description: entityText(ENTITY_NOTE_MAX),
  severity: PercentSchema,
  /** 0 means stable indefinitely. */
  minutesToNextStage: z.number().int().min(0).max(5_256_000),
  nextStageIndex: z.number().int().min(0).max(15).nullable(),
  /** The stage a successful treatment moves the subject to. */
  treatedStageIndex: z.number().int().min(0).max(15).nullable(),
  effects: ConditionEffectsSchema,
  /**
   * What another inhabitant can perceive by looking (§8 "Observe symptoms").
   * These are the *only* clues available before a diagnosis: the condition's
   * name and mechanics are not visible to anyone who has not studied it.
   */
  observableSymptoms: z.array(z.string().max(ENTITY_LINE_MAX)).max(16).default([]),
});
export type ConditionStage = z.infer<typeof ConditionStageSchema>;

/**
 * The definition of a kind of condition.
 *
 * Definitions may pre-exist (created at Genesis as part of the published world
 * rules) or be discovered — an inhabitant that studies a novel presentation long
 * enough registers a definition, and `discoveredBy` is how medical priority
 * becomes a fact anyone can check.
 */
export const ConditionDefinitionSchema = z.object({
  id: EntityIdSchema,
  worldId: EntityIdSchema,
  name: entityName(),
  description: entityText(ENTITY_TEXT_MAX),
  origin: z.enum([
    "creation_imperfection",
    "injury",
    "malnutrition",
    "dehydration",
    "exhaustion",
    "contagion",
    "ageing",
    "unknown",
  ]),
  /** Whether proximity can transmit it. Contagion is resolved by the engine, not narrated. */
  contagious: z.boolean().default(false),
  transmissionChancePermille: PermilleSchema.default(0),
  stages: z.array(ConditionStageSchema).min(1).max(16),
  /** The inhabitant that first successfully characterised it, if any (§8). */
  discoveredById: EntityIdSchema.nullable().default(null),
  discoveredAt: SimTimeSchema.nullable().default(null),
  /** The event that registered this definition. */
  definedByEventSequence: SequenceSchema.nullable().default(null),
});
export type ConditionDefinition = z.infer<typeof ConditionDefinitionSchema>;

/**
 * One inhabitant actually having a condition.
 *
 * `status` distinguishes a condition that is present but not yet progressing
 * (`latent`) from one that is running. Resolution and death both leave the
 * record in place: §8 requires that death never delete history, and a resolved
 * condition remains part of the subject's medical record for anyone who later
 * studies it.
 */
export const ConditionInstanceSchema = z.object({
  conditionId: EntityIdSchema,
  subjectId: EntityIdSchema,
  onsetAt: SimTimeSchema,
  currentStageIndex: z.number().int().min(0).max(15),
  stageEnteredAt: SimTimeSchema,
  status: z.enum(["latent", "active", "in_remission", "resolved", "terminal"]),
  resolvedAt: SimTimeSchema.nullable().default(null),
  /** Who or what caused it, where known. */
  sourceInhabitantId: EntityIdSchema.nullable().default(null),
  causedByEventSequence: SequenceSchema.nullable().default(null),
  /** Treatments applied so far, with what actually happened (§8 "Record results"). */
  treatmentApplications: z
    .array(
      z.object({
        treatmentId: EntityIdSchema.nullable(),
        appliedById: EntityIdSchema,
        appliedAt: SimTimeSchema,
        outcome: z.enum(["improved", "no_change", "worsened", "resolved", "fatal"]),
        eventSequence: SequenceSchema,
      }),
    )
    .max(64)
    .default([]),
});
export type ConditionInstance = z.infer<typeof ConditionInstanceSchema>;

/**
 * A treatment somebody designed (§8 "Develop a treatment").
 *
 * `efficacyPermille` and `riskPermille` are the engine's assessment, derived
 * from the designer's skill, the research it drew on, and the actual mechanics
 * of the target condition. They are *not* taken from the designer's claims.
 * §8: outcomes "must depend on knowledge, skill, condition, resources and
 * controlled probability—not solely on persuasive language from the model."
 *
 * `trials` accumulates real applications, so a treatment's reputation can be
 * built from evidence anyone can audit rather than from its author's assertions.
 */
export const TreatmentSchema = z.object({
  id: EntityIdSchema,
  worldId: EntityIdSchema,
  name: entityName(),
  designedById: EntityIdSchema,
  designedAt: SimTimeSchema,
  designedByEventSequence: SequenceSchema,
  targetConditionId: EntityIdSchema.nullable().default(null),
  targetConditionName: entityText(ENTITY_NAME_MAX).nullable().default(null),
  method: entityText(ENTITY_TEXT_MAX),
  requiredResources: HeldBundleSchema,
  requiredSkill: SkillNameSchema.nullable().default(null),
  requiredSkillLevel: z.number().int().min(0).max(100).default(0),
  efficacyPermille: PermilleSchema.default(0),
  riskPermille: PermilleSchema.default(0),
  /** Research notes and prior treatments this builds on (§12 provenance). */
  basedOnArtifactIds: z.array(EntityIdSchema).max(16).default([]),
  basedOnTreatmentId: EntityIdSchema.nullable().default(null),
  /** Published treatments can be studied and used by others (§8 "Publish findings"). */
  publishedAt: SimTimeSchema.nullable().default(null),
  trials: z
    .array(
      z.object({
        subjectId: EntityIdSchema,
        appliedAt: SimTimeSchema,
        outcome: z.enum(["improved", "no_change", "worsened", "resolved", "fatal"]),
        eventSequence: SequenceSchema,
      }),
    )
    .max(256)
    .default([]),
});
export type Treatment = z.infer<typeof TreatmentSchema>;
