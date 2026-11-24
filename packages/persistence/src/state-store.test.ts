// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HashDomain, hashValue, type Sha256Hex } from "@after-genesis/core";
import { SnapshotChecksumError, SnapshotCorruptionError } from "./errors.js";
import { FileEventStore } from "./file-event-store.js";
import { MemoryEventStore } from "./memory-event-store.js";
import {
  FileStateStore,
  MemoryStateStore,
  defaultStateChecksum,
  loadSnapshotVerified,
  type VerifiableStateStore,
} from "./state-store.js";
import { buildChain, fakeChecksum, makeTempDir } from "./test-support.js";

const WORLD = "test-world";

/**
 * The fixtures set `postStateChecksum` to `hashValue(StateChecksum, {worldId,
 * sequence})`, so this object is genuinely the state those events describe —
 * the snapshot's checksum and the log's agree for real, not by contrivance.
 */
function stateAt(sequence: number, worldId = WORLD): { worldId: string; sequence: number } {
  return { worldId, sequence };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
  const { path, cleanup } = await makeTempDir("after-genesis-state-");
  cleanups.push(cleanup);
  return path;
}

describe.each([
  ["MemoryStateStore", async (): Promise<VerifiableStateStore<{ worldId: string; sequence: number }>> => new MemoryStateStore()],
  [
    "FileStateStore",
    async (): Promise<VerifiableStateStore<{ worldId: string; sequence: number }>> =>
      FileStateStore.open(await tempDir()),
  ],
] as const)("%s", (_name, make) => {
  it("returns null for a world with no snapshot", async () => {
    const store = await make();
    expect(await store.load(WORLD)).toBeNull();
  });

  it("round-trips state with its sequence and checksum", async () => {
    const store = await make();
    const state = stateAt(7);
    await store.save(WORLD, state, 7, defaultStateChecksum(state));

    expect(await store.load(WORLD)).toEqual({ state, sequence: 7 });
    const snapshot = await store.loadSnapshot(WORLD);
    expect(snapshot?.sequence).toBe(7);
    expect(snapshot?.checksum).toBe(defaultStateChecksum(state));
  });

  it("overwrites with a later snapshot", async () => {
    const store = await make();
    await store.save(WORLD, stateAt(1), 1, defaultStateChecksum(stateAt(1)));
    await store.save(WORLD, stateAt(2), 2, defaultStateChecksum(stateAt(2)));
    expect((await store.load(WORLD))?.sequence).toBe(2);
  });

  it("keeps worlds separate", async () => {
    const store = await make();
    const a = stateAt(1, "world-a");
    await store.save("world-a", a, 1, defaultStateChecksum(a));
    expect(await store.load("world-b")).toBeNull();
  });

  // A checksum that does not describe the state is a lie about where the
  // snapshot came from. Refuse it at the door rather than storing it.
  it("refuses to save a snapshot whose checksum does not describe the state", async () => {
    const store = await make();
    const wrong = defaultStateChecksum(stateAt(999));
    await expect(store.save(WORLD, stateAt(7), 7, wrong)).rejects.toBeInstanceOf(
      SnapshotChecksumError,
    );
    expect(await store.load(WORLD)).toBeNull();
  });

  it("refuses a negative sequence", async () => {
    const store = await make();
    const state = stateAt(0);
    await expect(store.save(WORLD, state, -1, defaultStateChecksum(state))).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});

describe("MemoryStateStore", () => {
  it("does not hand back a live reference to stored state", async () => {
    const store = new MemoryStateStore<{ worldId: string; sequence: number }>();
    const state = stateAt(3);
    await store.save(WORLD, state, 3, defaultStateChecksum(state));

    // Mutating what was saved, and what was loaded, must not touch the store.
    state.sequence = 99;
    const loaded = await store.load(WORLD);
    loaded!.state.sequence = 42;

    expect((await store.load(WORLD))?.state).toEqual({ worldId: WORLD, sequence: 3 });
  });

  it("accepts a caller-supplied checksum scheme", async () => {
    const checksum = (s: { worldId: string; sequence: number }): Sha256Hex =>
      hashValue(HashDomain.StateChecksum, { onlySequence: s.sequence });
    const store = new MemoryStateStore({ checksum });
    const state = stateAt(4);

    await store.save(WORLD, state, 4, checksum(state));
    expect((await store.load(WORLD))?.sequence).toBe(4);
    // The default scheme disagrees, which is exactly why it had to be overridden.
    await expect(store.save(WORLD, state, 4, defaultStateChecksum(state))).rejects.toBeInstanceOf(
      SnapshotChecksumError,
    );
  });
});

describe("FileStateStore", () => {
  it("rejects a snapshot whose stored state was tampered with", async () => {
    const store = await FileStateStore.open<{ worldId: string; sequence: number }>(await tempDir());
    const state = stateAt(5);
    await store.save(WORLD, state, 5, defaultStateChecksum(state));

    // Edit the state on disk, leaving the recorded checksum untouched.
    const path = store.pathFor(WORLD);
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    record["state"] = { worldId: WORLD, sequence: 500 };
    await writeFile(path, JSON.stringify(record), "utf8");

    await expect(store.loadSnapshot(WORLD)).rejects.toBeInstanceOf(SnapshotChecksumError);
    await expect(store.load(WORLD)).rejects.toBeInstanceOf(SnapshotChecksumError);
  });

  it("rejects a snapshot whose recorded checksum was tampered with", async () => {
    const store = await FileStateStore.open<{ worldId: string; sequence: number }>(await tempDir());
    const state = stateAt(5);
    await store.save(WORLD, state, 5, defaultStateChecksum(state));

    const path = store.pathFor(WORLD);
    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    record["checksum"] = fakeChecksum(WORLD, 12345);
    await writeFile(path, JSON.stringify(record), "utf8");

    await expect(store.load(WORLD)).rejects.toBeInstanceOf(SnapshotChecksumError);
  });

  it("rejects a truncated snapshot file", async () => {
    const store = await FileStateStore.open<{ worldId: string; sequence: number }>(await tempDir());
    const state = stateAt(5);
    await store.save(WORLD, state, 5, defaultStateChecksum(state));

    const path = store.pathFor(WORLD);
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.slice(0, raw.length / 2), "utf8");

    await expect(store.load(WORLD)).rejects.toBeInstanceOf(SnapshotCorruptionError);
  });

  it("rejects a snapshot copied in from another world", async () => {
    const dir = await tempDir();
    const store = await FileStateStore.open<{ worldId: string; sequence: number }>(dir);
    const state = stateAt(2, "world-a");
    await store.save("world-a", state, 2, defaultStateChecksum(state));

    // Same bytes, filed under a different world.
    await writeFile(store.pathFor("world-b"), await readFile(store.pathFor("world-a"), "utf8"));
    await expect(store.load("world-b")).rejects.toBeInstanceOf(SnapshotCorruptionError);
  });

  it("leaves the previous snapshot intact when a save is interrupted", async () => {
    const dir = await tempDir();
    const store = await FileStateStore.open<{ worldId: string; sequence: number }>(dir);
    const good = stateAt(1);
    await store.save(WORLD, good, 1, defaultStateChecksum(good));

    // A crashed save leaves a temp file behind; the real snapshot is untouched
    // because the rename never happened.
    await writeFile(`${store.pathFor(WORLD)}.999.999.tmp`, "half a snapsh", "utf8");
    expect(await store.load(WORLD)).toEqual({ state: good, sequence: 1 });
  });
});

// §15: "replayed history produces an identical state checksum". A snapshot that
// cannot be tied to the log is not evidence of anything.
describe("loadSnapshotVerified", () => {
  it("accepts a snapshot that matches the log's postStateChecksum", async () => {
    const events = new MemoryEventStore();
    for (const event of buildChain(WORLD, 5)) await events.append(event, event.sequence);

    const state = new MemoryStateStore<{ worldId: string; sequence: number }>();
    const snapshot = stateAt(4);
    await state.save(WORLD, snapshot, 4, defaultStateChecksum(snapshot));

    expect(await loadSnapshotVerified(state, events, WORLD)).toEqual({ state: snapshot, sequence: 4 });
  });

  it("returns null when there is no snapshot", async () => {
    const events = new MemoryEventStore();
    for (const event of buildChain(WORLD, 2)) await events.append(event, event.sequence);
    const state = new MemoryStateStore<{ worldId: string; sequence: number }>();
    expect(await loadSnapshotVerified(state, events, WORLD)).toBeNull();
  });

  it("rejects a snapshot whose checksum disagrees with the log", async () => {
    const events = new MemoryEventStore();
    for (const event of buildChain(WORLD, 5)) await events.append(event, event.sequence);

    // Internally consistent — the checksum genuinely describes the state — but
    // it is the state of a *different* point in history. This is the divergence
    // that a store trusting its own checksum alone would happily resume from.
    const state = new MemoryStateStore<{ worldId: string; sequence: number }>();
    const divergent = stateAt(99);
    await state.save(WORLD, divergent, 4, defaultStateChecksum(divergent));
    expect((await state.loadSnapshot(WORLD))?.checksum).toBe(defaultStateChecksum(divergent));

    await expect(loadSnapshotVerified(state, events, WORLD)).rejects.toBeInstanceOf(
      SnapshotChecksumError,
    );
  });

  it("rejects a snapshot ahead of the log", async () => {
    const events = new MemoryEventStore();
    for (const event of buildChain(WORLD, 3)) await events.append(event, event.sequence);

    const state = new MemoryStateStore<{ worldId: string; sequence: number }>();
    const ahead = stateAt(50);
    await state.save(WORLD, ahead, 50, defaultStateChecksum(ahead));

    await expect(loadSnapshotVerified(state, events, WORLD)).rejects.toBeInstanceOf(
      SnapshotChecksumError,
    );
  });

  it("works against the file-backed stores too", async () => {
    const dir = await tempDir();
    const events = await FileEventStore.open(dir);
    for (const event of buildChain(WORLD, 4)) await events.append(event, event.sequence);

    const state = await FileStateStore.open<{ worldId: string; sequence: number }>(await tempDir());
    const good = stateAt(3);
    await state.save(WORLD, good, 3, defaultStateChecksum(good));
    expect(await loadSnapshotVerified(state, events, WORLD)).toEqual({ state: good, sequence: 3 });

    const divergent = stateAt(31337);
    await state.save(WORLD, divergent, 3, defaultStateChecksum(divergent));
    await expect(loadSnapshotVerified(state, events, WORLD)).rejects.toBeInstanceOf(
      SnapshotChecksumError,
    );

    await events.close();
  });
});
