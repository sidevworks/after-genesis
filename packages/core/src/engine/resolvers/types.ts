// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * The resolver contract (§2, §4A).
 *
 * "The LLM proposes intentions. The deterministic world engine decides
 * reality." A resolver is where that sentence becomes code. It receives an
 * untrusted payload — whatever a model emitted, already parsed as JSON but not
 * otherwise believed — and returns what actually happened.
 *
 * Four rules bind every resolver:
 *
 * 1. **Pure.** `(context, payload) -> result`. No I/O, no clock, no
 *    `Math.random`. The only randomness available is `ctx.rng`, a stream
 *    derived from the world seed and the turn's sequence number, so a replay
 *    draws the identical numbers.
 * 2. **Total.** It must not throw. A precondition failure is a `rejected`
 *    outcome, which is a normal, canonical, hash-chained event (§14.11) — not
 *    an exception, not a retry, and never a silent no-op that leaves the world
 *    unchanged but the turn consumed.
 * 3. **Atomic.** It returns a complete new `WorldState` or leaves the input
 *    untouched. §15: "failed transactions cannot partially alter state." Since
 *    every state helper is pure, a resolver that returns early has by
 *    construction changed nothing.
 * 4. **Honest.** A resolver that cannot do its job returns `rejected`. It never
 *    reports success it did not achieve. This is why the 54 unimplemented
 *    actions are wired to `notYetImplemented` rather than to a stub that
 *    returns `resolved`.
 */
import type { ResolutionOutcome } from "../../schema/action-spec.js";
import type { Visibility } from "../../event.js";
import type { SimTime } from "../../time.js";
import type { Rng } from "../../util/rng.js";
import type { Inhabitant, WorldState } from "../state.js";

/**
 * An event a resolver decided should be appended.
 *
 * Resolvers do not seal events — they have no access to hashes, checksums, the
 * wall clock or the previous event, and must not. The turn pipeline assembles
 * the full `CanonicalEvent` envelope around these.
 */
export interface DerivedEvent {
  /** Canonical event type, e.g. `action.move`. */
  readonly type: string;
  readonly actor: string | null;
  readonly simTime: SimTime;
  /** The validated inputs, as the engine understood them. */
  readonly inputs: unknown;
  /** What the engine decided happened. Recorded next to `inputs` so an auditor
   *  can see the two differ — that is the proof the engine, not the model,
   *  decided reality (§2). */
  readonly resolution: unknown;
  readonly visibility: Visibility;
}

/** Everything a resolver may read about the turn it is resolving. */
export interface ResolutionContext {
  readonly state: WorldState;
  /** The acting inhabitant, already proven to exist, be alive and be free. */
  readonly actor: Inhabitant;
  /** The instant the action begins. */
  readonly simTime: SimTime;
  /** The sequence number this turn will occupy. Used to derive ids. */
  readonly sequence: number;
  /** A stream derived for exactly this turn and action. */
  readonly rng: Rng;
}

export interface ResolutionResult {
  readonly outcome: ResolutionOutcome;
  /** The world after resolution. Identical to `ctx.state` when rejected. */
  readonly state: WorldState;
  readonly events: readonly DerivedEvent[];
}

export type Resolver = (ctx: ResolutionContext, payload: unknown) => ResolutionResult;

/** Reject without touching the world. The only correct failure path. */
export function reject(
  ctx: ResolutionContext,
  code: string,
  reason: string,
): ResolutionResult {
  return {
    outcome: { status: "rejected", code, reason },
    state: ctx.state,
    events: [],
  };
}

/** Standard rejection codes. Stable strings: they are recorded in the event log. */
export const RejectionCode = {
  NotImplemented: "NOT_IMPLEMENTED",
  InvalidPayload: "INVALID_PAYLOAD",
  Busy: "BUSY",
  Dead: "DEAD",
  NotEligible: "NOT_ELIGIBLE",
  Confined: "CONFINED",
  OutOfBounds: "OUT_OF_BOUNDS",
  Impassable: "IMPASSABLE",
  NoRoute: "NO_ROUTE",
  TooFar: "TOO_FAR",
  AlreadyThere: "ALREADY_THERE",
  InsufficientEnergy: "INSUFFICIENT_ENERGY",
  InsufficientResources: "INSUFFICIENT_RESOURCES",
  NothingToGather: "NOTHING_TO_GATHER",
  NotGatherable: "NOT_GATHERABLE",
  NotConsumable: "NOT_CONSUMABLE",
  UnknownActor: "UNKNOWN_ACTOR",
  ResolverError: "RESOLVER_ERROR",
} as const;
