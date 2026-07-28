/**
 * The cognition service's *input* contract.
 *
 * These types are deliberately local to this package rather than imported from
 * the engine. Cognition is downstream of the engine and must not be able to
 * reach into it: if this file imported the engine's inhabitant record, a change
 * to internal engine state would silently change what a model can see, and
 * "an inhabitant must not possess omniscient access to world state" (§6) would
 * become a property nobody is checking.
 *
 * Instead the engine *projects* its state into these narrow shapes. The
 * projection is the disclosure boundary, and it is auditable precisely because
 * it is a lossy, hand-written mapping into a type that cannot express secrets it
 * was not given.
 *
 * Two rules hold throughout:
 *
 *  - Every numeric field is an integer. Floating point is banned world-wide for
 *    determinism (see core's `canonicalJson`), and scores computed here feed a
 *    hashed request.
 *  - Every string field that an inhabitant could have authored is marked in its
 *    doc comment as AUTHORED. Authored strings must reach the prompt only
 *    through `renderUntrustedBlock`.
 */
import type { ActionType, CognitionLevel } from "@after-genesis/core/schema/action-spec";
import type { ResourceKind } from "@after-genesis/core";

/** A grid coordinate. Mirrors core's `Coord` without importing engine state. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Developmental stage, 0 = newly created (§11B).
 *
 * Maturity gates action legality in the engine and context size here. A young
 * inhabitant is not a worse thinker given the same context; it is an inhabitant
 * given less context, a shorter horizon and fewer legal actions — which is the
 * distinction §11B draws when it says to "control the context and capabilities
 * supplied to" the same underlying model.
 */
export type Maturity = number;

/** A personality trait. `value` is an integer, conventionally 0–100. */
export interface Trait {
  readonly name: string;
  readonly value: number;
}

/** A stated value. AUTHORED at creation; treated as untrusted text. */
export interface HeldValue {
  readonly id: string;
  /** AUTHORED. */
  readonly statement: string;
  /** Integer weight, conventionally 0–100. Ordering is by this then by id. */
  readonly weight: number;
}

/** A private goal. Never visible to another inhabitant (§11E "Private or uncertain"). */
export interface PrivateGoal {
  readonly id: string;
  /** AUTHORED — the inhabitant wrote this about itself on a previous turn. */
  readonly statement: string;
  /** Integer priority, conventionally 0–100. */
  readonly priority: number;
  /** Free-form tags used by memory retrieval scoring. Lowercased by the caller. */
  readonly tags: readonly string[];
}

/** A current need. `level` is 0 (fully satisfied) to 100 (critical). */
export interface Need {
  readonly kind: string;
  readonly level: number;
}

export interface HealthCondition {
  readonly id: string;
  readonly name: string;
  /** Integer 0–100. */
  readonly severity: number;
  /** Whether the inhabitant currently knows it has this condition (§11E). */
  readonly known: boolean;
}

export interface Skill {
  readonly name: string;
  /** Integer level. */
  readonly level: number;
}

/**
 * What the acting inhabitant knows about itself.
 *
 * This is the only place in a prompt where private state appears, and it appears
 * only for its owner. Nothing here may be copied into another inhabitant's
 * observation without a disclosure event (§15).
 */
export interface SelfView {
  readonly id: string;
  /** AUTHORED. */
  readonly displayName: string;
  readonly generation: number;
  readonly maturity: Maturity;
  /** Simulated minutes since Genesis. */
  readonly birthTime: number;
  readonly location: Point;
  readonly terrain: string;
  readonly activity: string;
  readonly lastAction?: {
    readonly type: string;
    readonly startedAt: number;
    readonly endedAt: number;
  } | null;
  /** Integer 0–100. */
  readonly energy: number;
  /** Remaining compute allowance for the current day, in integer units (§11B). */
  readonly computeAllowance: number;
  /** Integer 0–100. */
  readonly integrity: number;
  readonly confined: boolean;
  readonly traits: readonly Trait[];
  readonly values: readonly HeldValue[];
  readonly privateGoals: readonly PrivateGoal[];
  readonly needs: readonly Need[];
  readonly conditions: readonly HealthCondition[];
  readonly skills: readonly Skill[];
  readonly inventory: Partial<Record<ResourceKind, number>>;
  readonly artifacts?: readonly {
    readonly id: string;
    readonly title: string;
    readonly kind: string;
    readonly published: boolean;
  }[];
}

/**
 * Another inhabitant as currently perceived.
 *
 * Note what is absent: no inventory, no goals, no needs, no memories. Perception
 * yields position, visible activity and whatever this inhabitant has learned
 * through prior interaction — nothing else (§11E "Directly observable").
 */
export interface PerceivedInhabitant {
  readonly id: string;
  /** AUTHORED. */
  readonly displayName: string;
  /** Chebyshev distance in tiles. */
  readonly distance: number;
  readonly location: Point;
  /** The activity state visible from outside, e.g. "gathering". */
  readonly visibleActivity: string;
  /**
   * This inhabitant's own integer sentiment towards them, -100..100, or null if
   * they have never met. A belief, not a fact about the other inhabitant.
   */
  readonly relationshipSentiment: number | null;
  /** How many prior recorded interactions. Integer. */
  readonly interactionCount: number;
}

export interface PerceivedStructure {
  readonly id: string;
  readonly kind: string;
  readonly location: Point;
  readonly ownerId: string | null;
}

export interface PerceivedTile {
  readonly location: Point;
  readonly terrain: string;
  /** Resources visibly present, in integer units. */
  readonly visibleResources: Partial<Record<ResourceKind, number>>;
}

/**
 * A piece of text another inhabitant wrote that this inhabitant can now read.
 *
 * Every instance of this type is hostile input. Messages, artifacts, published
 * works, organisation rules, contract terms and accusations all arrive here, and
 * all of them are rendered through `renderUntrustedBlock` without exception.
 */
export interface AuthoredText {
  readonly id: string;
  /** e.g. "message", "artifact", "publication", "organisation_rule", "accusation". */
  readonly kind: string;
  readonly authorId: string;
  /** AUTHORED. */
  readonly authorName: string;
  /** Simulated minutes since Genesis, used for ordering. */
  readonly simTime: number;
  /** AUTHORED — the payload. Never rendered outside an untrusted block. */
  readonly body: string;
}

/**
 * One action the inhabitant may legally take *right now*.
 *
 * The engine computes this list from maturity, confinement, energy, consent,
 * location and resources. Offering an action the engine would reject wastes
 * tokens and, worse, trains the model across turns that proposing illegal
 * actions is normal — so the prompt lists exactly this set and nothing else.
 */
export interface AvailableAction {
  readonly type: ActionType;
  /** One line, from the action catalogue. Engine-authored, not inhabitant text. */
  readonly description: string;
  /**
   * A short, engine-authored description of the payload shape, e.g.
   * `{ "to": <inhabitant id>, "text": <string> }`. Optional; omitted for
   * payload-free actions.
   */
  readonly payloadHint?: string;
}

/**
 * The complete, legally-observable input to one turn of cognition.
 *
 * If a fact is not in this object, the model cannot see it. That is the whole
 * design: the disclosure boundary is a type, not a convention.
 */
export interface Observation {
  readonly worldId: string;
  /** Canonical event sequence this turn will occupy. Used for audit and replay. */
  readonly sequence: number;
  /** Simulated minutes since Genesis. */
  readonly simTime: number;
  /** This inhabitant's own turn counter. */
  readonly turnNumber: number;
  readonly cognitionLevel: CognitionLevel;
  readonly self: SelfView;
  readonly nearbyInhabitants: readonly PerceivedInhabitant[];
  readonly nearbyStructures: readonly PerceivedStructure[];
  readonly nearbyTiles: readonly PerceivedTile[];
  /** Text authored by other inhabitants that this one may now read. Hostile input. */
  readonly authoredTexts: readonly AuthoredText[];
  /** Engine-authored, world-factual notices, e.g. "You are confined at (4,7)." */
  readonly worldNotices: readonly string[];
  readonly availableActions: readonly AvailableAction[];
}
