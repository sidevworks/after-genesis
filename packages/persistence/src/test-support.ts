// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Event fixtures for this package's tests.
 *
 * Deliberately not re-exported from `index.ts`: nothing outside these tests
 * should be able to conjure a sealed event without going through the engine.
 *
 * The events produced here are structurally valid — real hashes, real chain
 * links, real checksum continuity — so `verifyChain` accepts them. That matters:
 * a test that proved tamper detection using fixtures the verifier already
 * rejected would be proving nothing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENESIS_PREV_HASH,
  HashDomain,
  hashValue,
  sealEvent,
  type CanonicalEvent,
  type Sha256Hex,
  type UnsealedEvent,
} from "@after-genesis/core";

/** Checksum standing in for "the state of the world after event `sequence`". */
export function fakeChecksum(worldId: string, sequence: number): Sha256Hex {
  return hashValue(HashDomain.StateChecksum, { worldId, sequence });
}

export interface EventOverrides {
  readonly type?: string;
  readonly actor?: string | null;
  readonly simTime?: number;
  readonly inputs?: unknown;
  readonly resolution?: unknown;
}

/**
 * Build the event that follows `previous` (or the genesis event when `previous`
 * is null), sealed with a correct hash.
 */
export function nextEvent(
  worldId: string,
  previous: CanonicalEvent | null,
  overrides: EventOverrides = {},
): CanonicalEvent {
  const sequence = previous === null ? 0 : previous.sequence + 1;
  const unsealed: UnsealedEvent = {
    worldId,
    sequence,
    simTime: overrides.simTime ?? sequence * 10,
    realTimestamp: "2026-01-01T00:00:00.000Z",
    actor: overrides.actor ?? null,
    type: overrides.type ?? (sequence === 0 ? "genesis" : "action.test"),
    inputs: overrides.inputs ?? null,
    resolution: overrides.resolution ?? null,
    visibility: { kind: "public" },
    preStateChecksum:
      previous === null ? fakeChecksum(worldId, -1) : previous.postStateChecksum,
    postStateChecksum: fakeChecksum(worldId, sequence),
    provenance: {
      sourceCommit: "0000000000000000000000000000000000000000",
      deployedDigest: "local",
      modelRequestHash: null,
      modelResponseHash: null,
      modelId: null,
    },
    schemaVersion: 1,
    prevHash: previous === null ? GENESIS_PREV_HASH : previous.hash,
  };
  return sealEvent(unsealed);
}

/** A valid chain of `count` events starting at sequence 0. */
export function buildChain(worldId: string, count: number): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  let previous: CanonicalEvent | null = null;
  for (let i = 0; i < count; i++) {
    previous = nextEvent(worldId, previous);
    events.push(previous);
  }
  return events;
}

/** A scratch directory plus its cleanup, for filesystem tests. */
export async function makeTempDir(prefix = "after-genesis-"): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
