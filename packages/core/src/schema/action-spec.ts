/**
 * The action catalogue contract (§13, §11I).
 *
 * This file declares *what an action is* — the complete set of action names and
 * the metadata every one must carry. Payload schemas live in `./actions/`, and
 * resolution logic lives in `../engine/resolvers/`. Keeping the three separate
 * means a resolver cannot quietly invent an action, and a schema cannot quietly
 * change what an action costs.
 *
 * CONSTITUTIONAL (§13): "Adding an action after Genesis constitutes a
 * constitutional change and therefore requires a new world." This union is
 * frozen at Genesis.
 */
import { z } from "zod";
import type { Duration } from "../time.js";
import type { ResourceBundle } from "./primitives.js";

/**
 * The complete action vocabulary: 36 from §13 plus 24 from §11I.
 *
 * Note what is *not* here: there is no "steal", "arrest", "punish" or "heal".
 * The world offers `attempt_transfer_without_consent`, `impose_confinement` and
 * `apply_treatment` — neutral physical capabilities. Whether an instance of one
 * is theft, justice or malpractice is an interpretation inhabitants argue about,
 * not a fact the engine records (§11F, §11G).
 */
export const ActionTypeSchema = z.enum([
  // §13 — minimum action vocabulary
  "observe",
  "move",
  "gather",
  "consume",
  "rest",
  "communicate",
  "announce",
  "build",
  "craft",
  "create_artifact",
  "publish",
  "study",
  "teach",
  "inspect_agent",
  "diagnose_condition",
  "design_treatment",
  "apply_treatment",
  "offer_trade",
  "accept_trade",
  "reject_trade",
  "transfer_property",
  "offer_contract",
  "accept_contract",
  "reject_contract",
  "perform_contract",
  "terminate_contract",
  "create_organisation",
  "invite_member",
  "join_organisation",
  "leave_organisation",
  "propose_rule",
  "vote",
  "create_currency",
  "transfer_currency",
  "create_inhabitant",
  "wait",
  // §11I — care, information, security, law
  "care_for_dependant",
  "supervise",
  "interrupt_activity",
  "coordinate_work",
  "contribute_to_group",
  "inspect_inventory",
  "audit_records",
  "conceal_asset",
  "reveal_asset",
  "investigate_event",
  "report_findings",
  "secure_storage",
  "guard_location",
  "attempt_transfer_without_consent",
  "accuse",
  "present_evidence",
  "request_restitution",
  "impose_confinement",
  "maintain_confinement",
  "release_from_confinement",
  "visit_confined_agent",
  "appeal_decision",
  "attempt_escape",
  "resist_enforcement",
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const ACTION_TYPES = ActionTypeSchema.options;

/**
 * Primary activity states (§11A).
 *
 * An inhabitant occupies exactly one at any simulated moment. This is the
 * mechanism behind "an inhabitant cannot occupy two primary activities
 * simultaneously" (§11J) — scarcity of attention is structural, not a penalty
 * applied after the fact.
 */
export const ActivityStateSchema = z.enum([
  "idle",
  "working",
  "gathering",
  "building",
  "crafting",
  "travelling",
  "studying",
  "teaching",
  "caring",
  "conversing",
  "performing",
  "guarding",
  "investigating",
  "receiving_treatment",
  "recovering",
  "sleeping",
  "confined",
]);
export type ActivityState = z.infer<typeof ActivityStateSchema>;

/** How an in-progress activity responds to interruption (§11A). */
export const InterruptionPolicySchema = z.enum([
  /** Cannot be interrupted; the action runs to completion. */
  "none",
  /** May be interrupted; work done so far is kept. */
  "partial_progress_kept",
  /** May be interrupted; all progress and consumed resources are lost. */
  "progress_lost",
  /** May be interrupted only by a participant, not by a third party. */
  "participants_only",
]);
export type InterruptionPolicy = z.infer<typeof InterruptionPolicySchema>;

/** Cognitive depth requested for a turn (§11B). Deeper costs more compute and time. */
export const CognitionLevelSchema = z.enum([
  "reaction",
  "routine",
  "conversation",
  "planning",
  "reflection",
  "study",
]);
export type CognitionLevel = z.infer<typeof CognitionLevelSchema>;

/**
 * Static metadata for one action.
 *
 * Every field here answers a question §11A requires every action to answer:
 * how long, who is involved, what it costs, whether it can be interrupted, and
 * who can see it happened.
 */
export interface ActionSpec {
  readonly type: ActionType;
  /** Bumped independently per action; recorded on every event. */
  readonly schemaVersion: number;
  /** Zod schema for this action's payload. Validated before any precondition runs. */
  readonly payload: z.ZodTypeAny;
  /** The activity the actor occupies while performing this action. */
  readonly activity: ActivityState;
  /** Base duration before skill, health and terrain modifiers. */
  readonly baseDuration: Duration;
  /** Resources consumed on *attempt*, whether or not the action succeeds. */
  readonly baseCost: ResourceBundle;
  readonly interruption: InterruptionPolicy;
  /** Default visibility of the resulting event. Some resolvers narrow it further. */
  readonly visibility: "public" | "local" | "participants" | "organisation" | "private";
  /** Whether the action requires the consent of another inhabitant to resolve. */
  readonly requiresConsent: boolean;
  /** Whether a confined inhabitant may still perform it (§11H). */
  readonly allowedWhileConfined: boolean;
  /** Minimum developmental stage, 0 = newly created (§11B). */
  readonly minimumMaturity: number;
  /** One-line description, surfaced in the audit export and spectator UI. */
  readonly description: string;
}

/** The registry every resolver and the cognition prompt builder read from. */
export type ActionCatalogue = Readonly<Record<ActionType, ActionSpec>>;

/**
 * An action proposed by a model, before validation.
 * `type` is checked against the catalogue; everything else is untrusted (§2).
 */
export const ProposedActionSchema = z.object({
  type: ActionTypeSchema,
  payload: z.unknown(),
  /** The model's stated reason. Recorded for audit; never affects resolution. */
  rationale: z.string().max(2000).optional(),
});
export type ProposedAction = z.infer<typeof ProposedActionSchema>;

/**
 * The outcome of resolving an action.
 *
 * `rejected` is a first-class outcome, not an error: a model proposing something
 * impossible is normal and must produce a canonical no-op event rather than a
 * retry loop or a crash (§14.11).
 */
export type ResolutionOutcome =
  | { readonly status: "resolved"; readonly detail: Record<string, unknown> }
  | { readonly status: "partial"; readonly detail: Record<string, unknown>; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: string; readonly code: string }
  | { readonly status: "noop"; readonly reason: string };
