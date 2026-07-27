/**
 * Care, supervision and interruption (§11C, §11I).
 *
 * §11C's central rule is that care must cost the carer's *actual time*, not a
 * productivity penalty applied to parents. There is no "parent" flag anywhere in
 * this world and no output modifier for having dependants. An inhabitant that
 * spends four hours caring has four fewer hours, exactly like one that spent
 * them gathering — and that is the entire mechanism (§11A: "Do not implement
 * arbitrary productivity penalties for parents or socially burdened
 * inhabitants").
 *
 * Nothing here is obligatory. §11C: "A creator or parent is not technically
 * forced to provide care unless a valid social rule is established. Neglect,
 * shared care, paid care, adoption, communal care and abandonment are possible
 * world outcomes."
 */
import { z } from "zod";
import {
  IdSchema,
  MAX_PLANNED_MINUTES,
  MAX_SMALL_LIST,
  OptionalCoordSchema,
  OptionalIdSchema,
  PayloadBundleSchema,
  STATEMENT_MAX,
  idList,
  minutesInRange,
  optionalText,
  requiredIdList,
} from "./common.js";

/**
 * Attend to a dependant (§11C).
 *
 * `careKinds` are §11C's list verbatim: food provision, shelter, supervision,
 * teaching, medical attention, emotional or social interaction, protection,
 * transportation. Insufficient care affects development, health, memory
 * formation, skills, relationships, trust and survival — through the dependant's
 * actual state, not through a scripted emotional response. §11C is explicit:
 * "Do not script guilt, affection, resentment or grief."
 *
 * Requires no consent, because an infant cannot give it and a refusing adult can
 * simply leave. The dependant's own activity is not seized: care given to
 * someone who is asleep, confined or ill is care they receive without acting.
 */
export const CareForDependantPayloadSchema = z.object({
  dependantId: IdSchema,
  careKinds: z
    .array(
      z.enum([
        "food",
        "shelter",
        "supervision",
        "teaching",
        "medical",
        "social",
        "protection",
        "transport",
      ]),
    )
    .min(1)
    .max(MAX_SMALL_LIST),
  resources: PayloadBundleSchema,
  /** Time actually committed. This is the cost §11C requires (§11J). */
  durationMinutes: minutesInRange(15, MAX_PLANNED_MINUTES).default(240),
  /** Care performed on behalf of an organisation: communal or paid care. */
  organisationId: OptionalIdSchema,
  destination: OptionalCoordSchema,
  note: optionalText(STATEMENT_MAX),
});

/**
 * Watch over inhabitants, a place or property without providing care (§11I).
 *
 * Distinct from `guard_location`, which contests possession by force or
 * presence: supervision is attention paid to what happens, which is what makes
 * an unwitnessed act different from a witnessed one (§11F lists "Witnesses"
 * among the factors resolving an unauthorised transfer). A supervisor sees
 * things; a guard tries to stop them.
 */
export const SupervisePayloadSchema = z.object({
  subjectIds: idList(MAX_SMALL_LIST),
  coord: OptionalCoordSchema,
  structureId: OptionalIdSchema,
  organisationId: OptionalIdSchema,
  durationMinutes: minutesInRange(15, MAX_PLANNED_MINUTES).default(240),
  purpose: optionalText(STATEMENT_MAX),
});

/**
 * Try to break into someone else's activity (§11I, §11A).
 *
 * Whether it works is decided by the target activity's `InterruptionPolicy`, not
 * by this payload: an action declared `none` runs to completion regardless of
 * how urgent the interrupter says the matter is, and one declared
 * `participants_only` cannot be broken by a third party. This is the mechanism
 * behind §11A's requirement that every action declare "Whether interruption is
 * permitted" and "Result of interruption".
 *
 * Requires no consent by definition — an interruption the target agreed to is a
 * conversation.
 */
export const InterruptActivityPayloadSchema = z.object({
  targetIds: requiredIdList(MAX_SMALL_LIST),
  reason: optionalText(STATEMENT_MAX),
  urgency: z.enum(["low", "normal", "urgent"]).default("normal"),
  /** What the interrupter wants the target to do instead. A request, not a command. */
  requestedInstead: optionalText(STATEMENT_MAX),
});
