// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Bringing a new inhabitant into the world (§7).
 *
 * This is the single most consequential action in the catalogue and the most
 * expensive. After Genesis it is the *only* way population grows: humans cannot
 * create inhabitants (§1), and every inhabitant after the founder must originate
 * from an existing one through this action.
 *
 * The payload is a set of *intentions*, and every field name says so. §7 requires
 * that creation "Prevent the creator from directly controlling the new
 * inhabitant" and "Give the new inhabitant independent goals and decision
 * making". So the creator may express hopes about traits and values; the engine
 * generates bounded inherited and novel traits deterministically from the
 * creation event, and the result may disappoint the creator entirely.
 *
 * §7 also permits bounded imperfections — weak memory retention, conflicting
 * priorities, reduced planning ability, communication difficulty, low energy,
 * impaired use of particular world actions, unstable attention, increased
 * resource requirements. These arise from the engine's deterministic generation,
 * never from a request in this payload and never from executing broken code
 * (§7: "Never generate or execute arbitrary broken application code to simulate
 * illness"). There is deliberately no field here through which a creator could
 * ask for an impairment.
 */
import { z } from "zod";
import {
  LABEL_MAX,
  MAX_PLANNED_MINUTES,
  MAX_TINY_LIST,
  MAX_TRAIT_HINTS,
  MESSAGE_MAX,
  NAME_MAX,
  OptionalIdSchema,
  PayloadBundleSchema,
  idList,
  optionalText,
  requiredText,
} from "./common.js";

/**
 * A hope about the new inhabitant's disposition.
 *
 * `emphasis` runs −3…+3 and is a weak input to a bounded, seeded generation
 * process. It cannot pin a trait, and the generated inhabitant may land opposite
 * to it. That gap between what a creator wanted and what exists is not a bug; it
 * is the mechanism by which descendants are genuinely other people.
 */
export const TraitHintSchema = z.object({
  trait: requiredText(LABEL_MAX),
  emphasis: z.number().int().min(-3).max(3).default(0),
});

export const CreateInhabitantPayloadSchema = z.object({
  /** A name the creator proposes. The new inhabitant may later be known by another. */
  proposedName: requiredText(NAME_MAX),
  /**
   * Resources the creator commits. Creation consumes declared resources (§7) and
   * the cost cannot be bypassed (§15). Committing more than the world's minimum
   * may improve the new inhabitant's starting energy and health; committing less
   * than the minimum fails the precondition and consumes the attempt's cost only.
   */
  resourcesCommitted: PayloadBundleSchema,
  traitHints: z.array(TraitHintSchema).max(MAX_TRAIT_HINTS).default([]),
  valueHints: z.array(z.string().max(NAME_MAX)).max(MAX_TINY_LIST * 2).default([]),
  /** Co-creators who contribute resources and appear in the lineage record (§7). */
  coCreatorIds: idList(MAX_TINY_LIST),
  /**
   * Care the creator states it intends to provide (§11C). A statement only: the
   * world does not compel a creator to provide care, and neglect, shared care,
   * paid care, adoption and abandonment are all valid outcomes (§11C). Recording
   * the stated intention is what lets other inhabitants later observe that it
   * was or was not honoured.
   */
  statedCareMinutesPerDay: z.number().int().min(0).max(MAX_PLANNED_MINUTES).default(0),
  /** The creator's account of why. Stored on the immutable birth event (§7). */
  statement: optionalText(MESSAGE_MAX),
  /** A structure the new inhabitant begins in, if the creator has one. */
  structureId: OptionalIdSchema,
});
