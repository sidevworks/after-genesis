// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Skills (§9).
 *
 * CONSTITUTIONAL NOTE — there is deliberately **no career, profession or role
 * enum in this file, and there must never be one**. §9: "Do not define rigid
 * careers such as doctor, writer, politician or merchant. […] Careers are
 * descriptive labels inferred from repeated behaviour, reputation and economic
 * activity." An inhabitant becomes a physician because it repeatedly diagnoses
 * and treats and other inhabitants come to it — not because a field somewhere
 * says `career: "doctor"`. Spectator-facing labels are computed from event
 * history at read time and are never stored on the inhabitant.
 *
 * The skill list itself *is* constitutional: adding a skill after Genesis
 * changes what inhabitants can become and requires a new world (§23).
 */
import { z } from "zod";

/**
 * The skills named in §9.
 *
 * §9 lists fifteen underlying skills. They are reproduced here exactly and in
 * order; none is omitted and none is invented.
 */
export const SkillNameSchema = z.enum([
  "gathering",
  "construction",
  "crafting",
  "communication",
  "negotiation",
  "organisation",
  "teaching",
  "diagnosis",
  "treatment",
  "writing",
  "performance",
  "visual_creation",
  "research",
  "accounting",
  "leadership",
]);
export type SkillName = z.infer<typeof SkillNameSchema>;

export const SKILL_NAMES = SkillNameSchema.options;

/** Highest attainable level. Levels are integers; there is no fractional skill. */
export const MAX_SKILL_LEVEL = 100;

/**
 * Accumulated practice, in simulated minutes, is capped so that a very long-lived
 * inhabitant cannot overflow integer arithmetic in the level curve. 100 years of
 * uninterrupted practice at one skill.
 */
export const MAX_PRACTICE_MINUTES = 52_560_000;

/**
 * One skill's state.
 *
 * `level` is what the engine consults when resolving an action. `practice` is
 * the accumulator that produces it, kept separately so the curve from practice
 * to level can be inspected and replayed rather than being a hidden increment.
 */
export const SkillLevelSchema = z.object({
  level: z.number().int().min(0).max(MAX_SKILL_LEVEL),
  /** Simulated minutes actually spent doing or studying this skill. */
  practice: z.number().int().nonnegative().max(MAX_PRACTICE_MINUTES),
  /** Minutes of instruction received from another inhabitant, a subset of practice. */
  taughtMinutes: z.number().int().nonnegative().max(MAX_PRACTICE_MINUTES),
  /** SimTime of the most recent practice, or null if never practised. */
  lastPractisedAt: z.number().int().nonnegative().nullable(),
});
export type SkillLevel = z.infer<typeof SkillLevelSchema>;

/**
 * An inhabitant's skills. Absent keys mean the skill has never been practised,
 * which is distinct from a level of 0 reached by decay.
 */
export const SkillSetSchema = z.record(SkillNameSchema, SkillLevelSchema);
export type SkillSet = Partial<Record<SkillName, SkillLevel>>;

export const EMPTY_SKILL_SET: SkillSet = Object.freeze({});
