/**
 * Canonical event hashing (claude.md §16).
 *
 * The spectator app recomputes the hash chain from the exported log rather than
 * trusting the `hash` field that came with it. The same function is used by the
 * fixture generator, so the fixture is a genuine chain and a deliberately
 * corrupted fixture would fail the audit page — which is the point.
 *
 * This is a verifier. It reads. It cannot repair or rewrite anything.
 */

import { createHash } from "node:crypto";
import type { WorldEvent } from "./world-types";

/** Fields covered by the hash, in a fixed order. Order is part of the format. */
export interface CanonicalEventPayload {
  worldId: string;
  sequence: number;
  simTime: number;
  actor: string | null;
  type: string;
  description: string;
  subjects: string[];
  inputs: Array<[string, string | number | boolean]>;
  resolution: string;
  visibility: string;
  preStateChecksum: string;
  postStateChecksum: string;
  modelRequestHash: string | null;
  modelResponseHash: string | null;
  prevHash: string;
  schemaVersion: string;
}

export function canonicalEventPayload(
  event: Omit<WorldEvent, "hash" | "id" | "realTime" | "claims" | "actorName" | "sourceCommit" | "imageDigest"> & {
    sourceCommit?: string;
  },
): CanonicalEventPayload {
  return {
    worldId: event.worldId,
    sequence: event.sequence,
    simTime: event.simTime,
    actor: event.actor,
    type: event.type,
    description: event.description,
    subjects: [...event.subjects].sort(),
    inputs: Object.keys(event.inputs)
      .sort()
      .map((key) => [key, event.inputs[key] as string | number | boolean]),
    resolution: event.resolution,
    visibility: event.visibility,
    preStateChecksum: event.preStateChecksum,
    postStateChecksum: event.postStateChecksum,
    modelRequestHash: event.modelRequestHash ?? null,
    modelResponseHash: event.modelResponseHash ?? null,
    prevHash: event.prevHash,
    schemaVersion: event.schemaVersion,
  };
}

export function hashEvent(
  event: Parameters<typeof canonicalEventPayload>[0],
): string {
  const serialised = JSON.stringify(canonicalEventPayload(event));
  return `sha256:${createHash("sha256").update(serialised, "utf8").digest("hex")}`;
}

export interface ChainVerification {
  verified: boolean;
  verifiedThroughSequence: number;
  eventCount: number;
  head: string;
  brokenAtSequence?: number;
  brokenReason?: string;
}

/**
 * Walks the log in sequence order, recomputing every hash and checking that
 * each event's `prevHash` equals the previous event's recomputed hash.
 */
export function verifyEventChain(events: readonly WorldEvent[]): ChainVerification {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const genesisPrev = "sha256:" + "0".repeat(64);

  let previousHash = genesisPrev;
  let verifiedThrough = -1;
  let head = genesisPrev;

  for (const [index, event] of ordered.entries()) {
    if (event.sequence !== index) {
      return {
        verified: false,
        verifiedThroughSequence: verifiedThrough,
        eventCount: ordered.length,
        head,
        brokenAtSequence: event.sequence,
        brokenReason: `sequence gap: expected ${index}, found ${event.sequence}`,
      };
    }
    if (event.prevHash !== previousHash) {
      return {
        verified: false,
        verifiedThroughSequence: verifiedThrough,
        eventCount: ordered.length,
        head,
        brokenAtSequence: event.sequence,
        brokenReason: "prevHash does not match the previous event's recomputed hash",
      };
    }
    const recomputed = hashEvent(event);
    if (recomputed !== event.hash) {
      return {
        verified: false,
        verifiedThroughSequence: verifiedThrough,
        eventCount: ordered.length,
        head,
        brokenAtSequence: event.sequence,
        brokenReason: "recomputed hash does not match the recorded hash",
      };
    }
    previousHash = recomputed;
    head = recomputed;
    verifiedThrough = event.sequence;
  }

  return {
    verified: true,
    verifiedThroughSequence: verifiedThrough,
    eventCount: ordered.length,
    head,
  };
}
