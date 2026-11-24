// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Snapshot storage for materialised world state (§4E).
 *
 * Materialised state is a cache. The event log is the truth. Everything in this
 * file exists to make that relationship checkable rather than assumed: a
 * snapshot is stored with the sequence number it corresponds to *and* the state
 * checksum at that point, so it can be proven against the log — and is rejected
 * if it cannot be.
 *
 * There are two independent checks, and both matter:
 *
 *  1. **Internal.** The recorded checksum must equal the checksum recomputed
 *     from the stored state. This catches bit rot, a truncated write, and a
 *     caller that handed us a checksum that never described the state it came
 *     with.
 *  2. **Against the log** (`loadSnapshotVerified`). The recorded checksum must
 *     equal `postStateChecksum` of the event at that sequence. This is the check
 *     that matters for §15's "replayed history produces an identical state
 *     checksum": a snapshot from a divergent run passes check 1 perfectly and
 *     fails this one.
 */
import { rename, mkdir, readFile, unlink, open as fsOpen } from "node:fs/promises";
import { join } from "node:path";
import {
  HashDomain,
  hashEquals,
  hashValue,
  type CanonicalEvent,
  type EventStore,
  type Sha256Hex,
  type StateStore,
} from "@after-genesis/core";
import { SnapshotChecksumError, SnapshotCorruptionError } from "./errors.js";
import { worldFileStem } from "./internal/world-file.js";

/** A snapshot together with the evidence tying it to a point in the log. */
export interface StateSnapshot<TState> {
  readonly worldId: string;
  readonly sequence: number;
  readonly checksum: Sha256Hex;
  readonly state: TState;
}

/** Computes the checksum a snapshot is checked against. */
export type ChecksumFn<TState> = (state: TState) => Sha256Hex;

export interface StateStoreOptions<TState> {
  /**
   * How to derive a checksum from state. Defaults to the canonical state
   * checksum, `hashValue(HashDomain.StateChecksum, state)`.
   *
   * Override this **only** if the engine computes `postStateChecksum` over
   * something other than the whole state object — a projection, say. If the two
   * disagree, every snapshot will be rejected, which is the correct failure: a
   * store that cannot check a snapshot has no business storing one.
   */
  readonly checksum?: ChecksumFn<TState>;
}

/** The default state checksum: the canonical encoding of state, domain-separated. */
export function defaultStateChecksum(state: unknown): Sha256Hex {
  return hashValue(HashDomain.StateChecksum, state);
}

/**
 * In-memory snapshots.
 *
 * State is deep-copied in and out. Handing back a live reference would let a
 * caller mutate "stored" state after the fact, so the checksum would still
 * verify while describing something that was never saved — the exact class of
 * silent divergence this layer exists to prevent.
 */
export class MemoryStateStore<TState> implements StateStore<TState> {
  readonly #snapshots = new Map<string, StateSnapshot<TState>>();
  readonly #checksum: ChecksumFn<TState>;

  constructor(options: StateStoreOptions<TState> = {}) {
    this.#checksum = options.checksum ?? (defaultStateChecksum as ChecksumFn<TState>);
  }

  async save(
    worldId: string,
    state: TState,
    sequence: number,
    checksum: Sha256Hex,
  ): Promise<void> {
    assertSequence(sequence);
    const actual = this.#checksum(state);
    if (!hashEquals(actual, checksum)) {
      throw new SnapshotChecksumError(
        worldId,
        sequence,
        checksum,
        actual,
        "the supplied checksum does not describe the supplied state",
      );
    }
    this.#snapshots.set(worldId, {
      worldId,
      sequence,
      checksum,
      state: structuredClone(state),
    });
  }

  async load(worldId: string): Promise<{ state: TState; sequence: number } | null> {
    const snapshot = await this.loadSnapshot(worldId);
    if (snapshot === null) return null;
    return { state: snapshot.state, sequence: snapshot.sequence };
  }

  /** Load with the checksum attached, for callers that want to prove it. */
  async loadSnapshot(worldId: string): Promise<StateSnapshot<TState> | null> {
    const stored = this.#snapshots.get(worldId);
    if (stored === undefined) return null;

    const state = structuredClone(stored.state);
    const actual = this.#checksum(state);
    if (!hashEquals(actual, stored.checksum)) {
      throw new SnapshotChecksumError(
        worldId,
        stored.sequence,
        stored.checksum,
        actual,
        "the stored state no longer matches its recorded checksum",
      );
    }
    return { worldId, sequence: stored.sequence, checksum: stored.checksum, state };
  }
}

/**
 * Snapshots as JSON files, one per world, latest wins.
 *
 * Saves are atomic: the snapshot is written to a temporary file in the same
 * directory, fsynced, then `rename`d over the target. `rename(2)` within a
 * filesystem is atomic, so a reader sees either the whole previous snapshot or
 * the whole new one and never a half-written file. A crash mid-save leaves the
 * temporary file behind as litter, which is harmless — the old snapshot is
 * still intact and still verifiable.
 */
export class FileStateStore<TState> implements StateStore<TState> {
  readonly #directory: string;
  readonly #checksum: ChecksumFn<TState>;

  private constructor(directory: string, checksum: ChecksumFn<TState>) {
    this.#directory = directory;
    this.#checksum = checksum;
  }

  static async open<TState>(
    directory: string,
    options: StateStoreOptions<TState> = {},
  ): Promise<FileStateStore<TState>> {
    await mkdir(directory, { recursive: true });
    return new FileStateStore<TState>(
      directory,
      options.checksum ?? (defaultStateChecksum as ChecksumFn<TState>),
    );
  }

  pathFor(worldId: string): string {
    return join(this.#directory, `${worldFileStem(worldId)}.state.json`);
  }

  async save(
    worldId: string,
    state: TState,
    sequence: number,
    checksum: Sha256Hex,
  ): Promise<void> {
    assertSequence(sequence);
    const actual = this.#checksum(state);
    if (!hashEquals(actual, checksum)) {
      throw new SnapshotChecksumError(
        worldId,
        sequence,
        checksum,
        actual,
        "the supplied checksum does not describe the supplied state",
      );
    }

    const target = this.pathFor(worldId);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    const payload = `${JSON.stringify({ worldId, sequence, checksum, state }, null, 2)}\n`;

    // "wx" fails rather than clobbering, so two savers cannot share a temp file.
    const handle = await fsOpen(temporary, "wx");
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await rename(temporary, target);
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      throw cause;
    }
  }

  async load(worldId: string): Promise<{ state: TState; sequence: number } | null> {
    const snapshot = await this.loadSnapshot(worldId);
    if (snapshot === null) return null;
    return { state: snapshot.state, sequence: snapshot.sequence };
  }

  async loadSnapshot(worldId: string): Promise<StateSnapshot<TState> | null> {
    const path = this.pathFor(worldId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new SnapshotCorruptionError(path, "not valid JSON", { cause });
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new SnapshotCorruptionError(path, "not a snapshot object");
    }
    const record = parsed as Record<string, unknown>;
    const sequence = record["sequence"];
    const recorded = record["checksum"];
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
      throw new SnapshotCorruptionError(path, "missing or invalid sequence number");
    }
    if (typeof recorded !== "string") {
      throw new SnapshotCorruptionError(path, "missing or invalid checksum");
    }
    if (record["worldId"] !== worldId) {
      throw new SnapshotCorruptionError(
        path,
        `holds world "${String(record["worldId"])}", expected "${worldId}"`,
      );
    }

    const state = record["state"] as TState;
    const actual = this.#checksum(state);
    if (!hashEquals(actual, recorded)) {
      throw new SnapshotChecksumError(
        worldId,
        sequence,
        recorded,
        actual,
        "the stored state does not match its recorded checksum",
      );
    }

    return { worldId, sequence, checksum: recorded as Sha256Hex, state };
  }
}

/** A store that can hand back the checksum alongside the state. */
export interface VerifiableStateStore<TState> extends StateStore<TState> {
  loadSnapshot(worldId: string): Promise<StateSnapshot<TState> | null>;
}

/**
 * Load a snapshot and prove it against the event log.
 *
 * This is the check that makes a snapshot safe to resume from. It reads the
 * single event at the snapshot's sequence and compares that event's
 * `postStateChecksum` with the snapshot's checksum. A mismatch means the
 * snapshot describes a world that the log does not — a stale cache, a snapshot
 * copied between worlds, or a genuine divergence — and it is rejected so the
 * caller rebuilds from events instead of resuming a fiction.
 *
 * Returns `null` when there is no snapshot, or when the log has not yet reached
 * the snapshot's sequence (a snapshot ahead of the log is not evidence of
 * anything and must not be trusted).
 */
export async function loadSnapshotVerified<TState>(
  stateStore: VerifiableStateStore<TState>,
  eventStore: EventStore,
  worldId: string,
): Promise<{ state: TState; sequence: number } | null> {
  const snapshot = await stateStore.loadSnapshot(worldId);
  if (snapshot === null) return null;

  let anchor: CanonicalEvent | null = null;
  for await (const event of eventStore.read(worldId, snapshot.sequence, snapshot.sequence)) {
    anchor = event;
    break;
  }

  if (anchor === null) {
    throw new SnapshotChecksumError(
      worldId,
      snapshot.sequence,
      snapshot.checksum,
      "<no event>",
      `the log has no event at sequence ${snapshot.sequence}, so the snapshot ` +
        `cannot be tied to any point in history`,
    );
  }

  if (!hashEquals(anchor.postStateChecksum, snapshot.checksum)) {
    throw new SnapshotChecksumError(
      worldId,
      snapshot.sequence,
      snapshot.checksum,
      anchor.postStateChecksum,
      `the log's postStateChecksum at sequence ${snapshot.sequence} disagrees with the snapshot`,
    );
  }

  return { state: snapshot.state, sequence: snapshot.sequence };
}

function assertSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError(`Snapshot sequence must be a non-negative safe integer, got ${sequence}`);
  }
}
