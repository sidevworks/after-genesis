// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
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
  readonly sex: "male" | "female";
  readonly maturity: Maturity;
  /** Simulated minutes since Genesis. */
  readonly birthTime: number;
  readonly ageDays: number;
  readonly maxLifespanDays: number;
  readonly elder: boolean;
  readonly location: Point;
  readonly terrain: string;
  readonly activity: string;
  readonly lastAction?: {
    readonly type: string;
    readonly startedAt: number;
    readonly endedAt: number;
  } | null;
  /** Integer, 0 to `maxEnergy`. */
  readonly energy: number;
  /**
   * This inhabitant's own energy ceiling (§11B: capacity is per-inhabitant, and
   * a newborn's is lower than an adult's). Carried explicitly because the prompt
   * used to render energy against a hardcoded 100 while the default ceiling is
   * 1000 — the founder spent its life reasoning aloud about being at "998/100".
   */
  readonly maxEnergy: number;
  /** Remaining compute allowance for the current day, in integer units (§11B). */
  readonly computeAllowance: number;
  /** Integer 0–100. */
  readonly integrity: number;
  readonly confined: boolean;
  /**
   * What this inhabitant last said it was doing, in its own words, or null if
   * it has never said. Authored by the inhabitant, so it is rendered inside an
   * untrusted block like any other authored text.
   */
  readonly currentIntention: { readonly statement: string; readonly simTime: number } | null;
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
  readonly sex: "male" | "female";
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
  /**
   * Contents the observer may legitimately inspect, or null when private.
   *
   * An empty object means visible and empty; null means the contents are not
   * observable. Keeping those states distinct prevents cognition from treating
   * hidden goods as proof that a store contains nothing.
   */
  readonly visibleStorage: Partial<Record<ResourceKind, number>> | null;
}

export interface PerceivedTile {
  readonly location: Point;
  readonly terrain: string;
  /** Resources visibly present, in integer units. */
  readonly visibleResources: Partial<Record<ResourceKind, number>>;
  /** Optional observational hints from nearby terrain features (non-canonical). */
  readonly materialClues?: readonly string[];
}

/**
 * A place the inhabitant has been, recalled from experience rather than seen.
 *
 * Terrain only: terrain is durable, so recalling it is honest. Deposits deplete,
 * and reporting a remembered deposit as if it were still there would be the
 * engine asserting a fact the inhabitant cannot know.
 */
export interface RememberedPlace {
  readonly location: Point;
  readonly terrain: string;
  /** Chebyshev distance from where the inhabitant now stands. */
  readonly distance: number;
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
  /**
   * Terrain this inhabitant has seen before and is no longer looking at.
   *
   * Sight reaches a few tiles; a life reaches further. Without this an
   * inhabitant cannot act on anything outside its current view, however often
   * it has been there before.
   */
  readonly rememberedPlaces: readonly RememberedPlace[];
  /** Text authored by other inhabitants that this one may now read. Hostile input. */
  readonly authoredTexts: readonly AuthoredText[];
  /** Engine-authored, world-factual notices, e.g. "You are confined at (4,7)." */
  readonly worldNotices: readonly string[];
  readonly availableActions: readonly AvailableAction[];
}
