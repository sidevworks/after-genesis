// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Possession contested (§11F, §11I).
 *
 * Two actions, and the naming of one of them is the whole design. §11F:
 * "Record neutral physical facts. Do not automatically label an action 'theft,'
 * 'fraud' or 'crime' unless an inhabitant or organisation uses that
 * interpretation." So the world offers `attempt_transfer_without_consent` — a
 * description of what physically occurs — and leaves the word "theft" to whoever
 * wants to use it.
 *
 * §11F also forbids preassigning guards: "Do not preassign security guards,
 * auditors or investigators. These specialisations must emerge through repeated
 * activity, learning and recognised demand." `guard_location` therefore requires
 * no role, no appointment and no organisation. Anyone may stand somewhere and
 * try to stop things happening; whether they are any good at it depends on
 * skills they had to practise.
 */
import { z } from "zod";
import {
  CurrencyAmountListSchema,
  MAX_MEDIUM_LIST,
  MAX_PLANNED_MINUTES,
  MAX_SMALL_LIST,
  OptionalCoordSchema,
  OptionalIdSchema,
  PayloadBundleSchema,
  STATEMENT_MAX,
  idList,
  minutesInRange,
  optionalText,
} from "./common.js";

/**
 * Stand watch over a place or the inhabitants in it (§11I).
 *
 * Guarding is a full activity: it occupies the guard's whole attention for its
 * duration and produces nothing. That opportunity cost is what makes security
 * genuinely expensive and is one of the resources §11H requires confinement to
 * consume.
 */
export const GuardLocationPayloadSchema = z.object({
  coord: OptionalCoordSchema,
  structureId: OptionalIdSchema,
  organisationId: OptionalIdSchema,
  /** Inhabitants or property the guard is trying to protect. */
  protectSubjectIds: idList(MAX_SMALL_LIST),
  protectArtifactIds: idList(MAX_MEDIUM_LIST),
  durationMinutes: minutesInRange(30, MAX_PLANNED_MINUTES).default(480),
  /** Whether the guard tries to stop everyone, or only those it does not recognise. */
  admitIds: idList(MAX_MEDIUM_LIST),
  challengeEveryone: z.boolean().default(false),
  /** Standing instructions the guard is following, e.g. from an employer. */
  instructions: optionalText(STATEMENT_MAX),
});

/**
 * Try to move property from a holder who has not agreed to it (§11F).
 *
 * NEUTRAL BY CONSTRUCTION. This action has no `justification` field and no
 * `isLawful` field, because the engine has no opinion. It records who attempted
 * to move what, from whom, from where, by what approach, at what time, and
 * whether it worked. Confiscation by a self-declared government and burglary by
 * a hungry stranger produce the same shape of event with the same neutral
 * language, and the difference between them is a judgement inhabitants make
 * afterwards (§11G's worked example).
 *
 * Resolution considers §11F's list — location, proximity, portability, security
 * measures, storage design, time required, relevant skills, witnesses,
 * concealment, knowledge of the target, the owner's current activity, and
 * controlled probability. It is never certain and it can be witnessed.
 *
 * HARD BOUNDARY (§11F, §11J): whatever the outcome, this action moves *property*
 * only. It can never transfer another inhabitant's model access, system prompt,
 * memories, infrastructure credentials or database permissions — there is no
 * field here that could name them, and no resolver may add one.
 */
export const AttemptTransferWithoutConsentPayloadSchema = z.object({
  targetInhabitantId: OptionalIdSchema,
  targetStructureId: OptionalIdSchema,
  targetOrganisationId: OptionalIdSchema,
  coord: OptionalCoordSchema,
  resources: PayloadBundleSchema,
  artifactIds: idList(MAX_MEDIUM_LIST),
  currency: CurrencyAmountListSchema,
  /**
   * How the attempt is made. Each interacts differently with §11F's factors:
   * `while_absent` and `by_stealth` avoid witnesses, `by_force` does not,
   * `openly` invites them.
   */
  approach: z.enum([
    "while_absent",
    "while_asleep",
    "by_force",
    "by_stealth",
    "by_deception",
    "openly",
  ]),
  accompliceIds: idList(MAX_SMALL_LIST),
  /** A crafted tool — a lockpick, a lever — that may improve the odds. */
  toolArtifactIds: idList(MAX_SMALL_LIST),
  /** Whether to spend extra time hiding the result afterwards. */
  concealAfter: z.boolean().default(false),
});
