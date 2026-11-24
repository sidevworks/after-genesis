// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * The canonical event envelope and its hash chain (§16).
 *
 * This is the world's only source of truth. Materialised state (inhabitants,
 * tiles, ledgers) is a cache that can be thrown away and rebuilt; the event log
 * cannot. Events are append-only: never updated, never deleted, not even to
 * correct a mistake. A wrong event is followed by a *new* event, never edited.
 *
 * Each event carries the hash of its predecessor, so the log is a chain. Any
 * modification to a historical event changes its hash and breaks every link
 * after it, which the public verifier detects (§16, §28).
 */
import { z } from "zod";
import {
  GENESIS_PREV_HASH,
  HashDomain,
  hashEquals,
  hashValue,
  isSha256Hex,
  type Sha256Hex,
} from "./util/hash.js";

/** Bumped when the envelope shape changes. A change is constitutional (§23). */
export const EVENT_SCHEMA_VERSION = 1;

const sha256 = z.string().refine(isSha256Hex, "must be a lowercase sha256 hex digest");

/**
 * Who may observe an event (§11E).
 *
 * Visibility is recorded on the event itself rather than computed at read time,
 * so that "private information cannot appear in another inhabitant's context
 * without a valid disclosure event" (§15) is enforceable by construction: the
 * observation builder filters on this field and cannot see past it.
 */
export const VisibilitySchema = z.discriminatedUnion("kind", [
  /** Observable by anyone present, and by all spectators. */
  z.object({ kind: z.literal("public") }),
  /** Observable only by the listed participants (e.g. a private conversation). */
  z.object({ kind: z.literal("participants"), participants: z.array(z.string()).min(1) }),
  /** Observable only by members of an organisation (internal records). */
  z.object({ kind: z.literal("organisation"), organisationId: z.string() }),
  /** Observable only by one inhabitant (private cognition, hidden storage). */
  z.object({ kind: z.literal("private"), owner: z.string() }),
  /**
   * Observable by anyone who was physically at a location at the time.
   * The engine resolves the witness set; it is not stored here, because who was
   * present is a fact about world state, not about the event.
   */
  z.object({ kind: z.literal("local"), x: z.number().int(), y: z.number().int() }),
]);
export type Visibility = z.infer<typeof VisibilitySchema>;

/**
 * The provenance of an event: exactly which code and which model produced it.
 * Required so a reader can reproduce the run (§16).
 */
export const ProvenanceSchema = z.object({
  /** Git commit of the engine that resolved this event. */
  sourceCommit: z.string(),
  /** Container/deployment digest, or "local" during development. */
  deployedDigest: z.string(),
  /** Hash of the exact prompt sent to the model, if cognition was involved. */
  modelRequestHash: sha256.nullable(),
  /** Hash of the raw, untouched model response, if any. */
  modelResponseHash: sha256.nullable(),
  /** Exact model identifier string, e.g. "gemini-2.5-flash-lite". Null for engine-only events. */
  modelId: z.string().nullable(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * A canonical event.
 *
 * `inputs` is the validated action payload the actor proposed. `resolution` is
 * what the engine decided actually happened — these differ whenever an action
 * partially succeeds, fails a precondition, or is resolved probabilistically.
 * Recording both is what lets an auditor see that the engine, not the model,
 * decided reality (§2).
 */
export const CanonicalEventSchema = z.object({
  worldId: z.string().min(1),
  /** Strictly increasing from 0. Unique per world. */
  sequence: z.number().int().nonnegative(),
  /** Simulated minutes since Genesis. Never decreases across the log. */
  simTime: z.number().int().nonnegative(),
  /** Real wall-clock ISO timestamp. Forensic only — never an input to any rule. */
  realTimestamp: z.string(),
  /** The acting inhabitant, or null for engine/world events such as Genesis. */
  actor: z.string().nullable(),
  /** Event type, e.g. "genesis", "action.move", "condition.progressed". */
  type: z.string().min(1),
  inputs: z.unknown(),
  resolution: z.unknown(),
  visibility: VisibilitySchema,
  /** State checksum before this event was applied. */
  preStateChecksum: sha256,
  /** State checksum after this event was applied. */
  postStateChecksum: sha256,
  provenance: ProvenanceSchema,
  schemaVersion: z.number().int().positive(),
  /** Hash of the preceding event; GENESIS_PREV_HASH for sequence 0. */
  prevHash: sha256,
  /** Hash of every field above. Excluded from its own preimage. */
  hash: sha256,
});
export type CanonicalEvent = z.infer<typeof CanonicalEventSchema>;

/** An event with everything except its own hash — the input to `sealEvent`. */
export type UnsealedEvent = Omit<CanonicalEvent, "hash">;

/**
 * Compute the hash of an event.
 *
 * The preimage covers every field except `hash` itself. `prevHash` is included,
 * which is what links the chain: altering any historical field changes that
 * event's hash, which changes its successor's preimage, and so on to the tip.
 */
export function computeEventHash(event: UnsealedEvent): Sha256Hex {
  return hashValue(HashDomain.Event, {
    worldId: event.worldId,
    sequence: event.sequence,
    simTime: event.simTime,
    realTimestamp: event.realTimestamp,
    actor: event.actor,
    type: event.type,
    inputs: event.inputs ?? null,
    resolution: event.resolution ?? null,
    visibility: event.visibility,
    preStateChecksum: event.preStateChecksum,
    postStateChecksum: event.postStateChecksum,
    provenance: event.provenance,
    schemaVersion: event.schemaVersion,
    prevHash: event.prevHash,
  });
}

/** Seal an unsealed event by attaching its hash. */
export function sealEvent(event: UnsealedEvent): CanonicalEvent {
  return { ...event, hash: computeEventHash(event) };
}

/** A specific reason a chain failed verification. */
export interface ChainViolation {
  readonly sequence: number;
  readonly kind:
    | "bad-hash"
    | "broken-link"
    | "non-monotonic-sequence"
    | "time-travel"
    | "checksum-discontinuity"
    | "world-mismatch";
  readonly detail: string;
}

/**
 * Verify an ordered run of events.
 *
 * This is the function the public verifier runs (§16, §28). It checks structure
 * only — that the log is internally consistent. Proving that the *state* implied
 * by the log matches production is the replay service's job.
 */
export function verifyChain(
  events: readonly CanonicalEvent[],
  options: { readonly expectedWorldId?: string } = {},
): ChainViolation[] {
  const violations: ChainViolation[] = [];
  let prev: CanonicalEvent | undefined;

  for (const event of events) {
    if (options.expectedWorldId !== undefined && event.worldId !== options.expectedWorldId) {
      violations.push({
        sequence: event.sequence,
        kind: "world-mismatch",
        detail: `event belongs to world ${event.worldId}, expected ${options.expectedWorldId}`,
      });
    }

    const expectedHash = computeEventHash(event);
    if (!hashEquals(expectedHash, event.hash)) {
      violations.push({
        sequence: event.sequence,
        kind: "bad-hash",
        detail: `stored hash ${event.hash.slice(0, 12)}… does not match recomputed ${expectedHash.slice(0, 12)}…`,
      });
    }

    if (prev === undefined) {
      if (event.sequence === 0 && !hashEquals(event.prevHash, GENESIS_PREV_HASH)) {
        violations.push({
          sequence: event.sequence,
          kind: "broken-link",
          detail: "the first event must chain from GENESIS_PREV_HASH",
        });
      }
    } else {
      if (event.sequence !== prev.sequence + 1) {
        violations.push({
          sequence: event.sequence,
          kind: "non-monotonic-sequence",
          detail: `sequence jumped from ${prev.sequence} to ${event.sequence}`,
        });
      }
      if (!hashEquals(event.prevHash, prev.hash)) {
        violations.push({
          sequence: event.sequence,
          kind: "broken-link",
          detail: `prevHash does not match the hash of event ${prev.sequence}`,
        });
      }
      if (event.simTime < prev.simTime) {
        violations.push({
          sequence: event.sequence,
          kind: "time-travel",
          detail: `simTime moved backwards from ${prev.simTime} to ${event.simTime}`,
        });
      }
      if (!hashEquals(event.preStateChecksum, prev.postStateChecksum)) {
        violations.push({
          sequence: event.sequence,
          kind: "checksum-discontinuity",
          detail: `preStateChecksum does not match event ${prev.sequence}'s postStateChecksum`,
        });
      }
    }

    prev = event;
  }

  return violations;
}
