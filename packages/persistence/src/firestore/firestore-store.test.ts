import type { Firestore } from "@google-cloud/firestore";
import {
  GENESIS_PREV_HASH,
  buildGenesis,
  sealEvent,
} from "@after-genesis/core";
import { describe, expect, it } from "vitest";
import { SequenceConflictError } from "../errors.js";
import {
  FirestoreCanonicalStore,
  firestoreSequenceId,
} from "./firestore-store.js";

class FakeSnapshot {
  constructor(
    readonly exists: boolean,
    private readonly value: Record<string, unknown> | undefined,
  ) {}
  data() {
    return this.value;
  }
  get(field: string) {
    return this.value?.[field];
  }
}

class FakeRef {
  constructor(
    readonly path: string,
    private readonly documents: Map<string, Record<string, unknown>>,
  ) {}
  async get() {
    const value = this.documents.get(this.path);
    return new FakeSnapshot(value !== undefined, value);
  }
  async set(value: Record<string, unknown>) {
    this.documents.set(this.path, structuredClone(value));
  }
}

class FakeTransaction {
  constructor(private readonly documents: Map<string, Record<string, unknown>>) {}
  async get(ref: FakeRef) {
    return ref.get();
  }
  create(ref: FakeRef, value: Record<string, unknown>) {
    if (this.documents.has(ref.path)) throw Object.assign(new Error("exists"), { code: 6 });
    this.documents.set(ref.path, structuredClone(value));
  }
  set(ref: FakeRef, value: Record<string, unknown>, options?: { merge?: boolean }) {
    const existing = options?.merge === true ? this.documents.get(ref.path) ?? {} : {};
    this.documents.set(ref.path, structuredClone({ ...existing, ...value }));
  }
  delete(ref: FakeRef) {
    this.documents.delete(ref.path);
  }
}

class FakeFirestore {
  readonly documents = new Map<string, Record<string, unknown>>();
  doc(path: string) {
    return new FakeRef(path, this.documents);
  }
  async runTransaction<T>(fn: (tx: FakeTransaction) => Promise<T>): Promise<T> {
    return fn(new FakeTransaction(this.documents));
  }
}

function genesis() {
  const built = buildGenesis({
    worldId: "world_firestore_test",
    seed: "firestore-seed",
    width: 8,
    height: 8,
    founder: {
      id: "inh_founder",
      displayName: "Aster",
      modelId: "test",
      inventory: { energy: 100, compute: 100 },
      traits: {},
      values: [],
      privateGoals: [],
    },
  });
  const event = sealEvent({
    worldId: built.config.worldId,
    sequence: 0,
    simTime: 0,
    realTimestamp: "2026-01-01T00:00:00.000Z",
    actor: null,
    type: "genesis",
    inputs: { genesis: built.config },
    resolution: {},
    visibility: { kind: "public" },
    preStateChecksum: built.emptyStateChecksum,
    postStateChecksum: built.stateChecksum,
    provenance: {
      sourceCommit: "test",
      deployedDigest: "test",
      modelRequestHash: null,
      modelResponseHash: null,
      modelId: null,
    },
    schemaVersion: 1,
    prevHash: GENESIS_PREV_HASH,
  });
  return { built, event };
}

describe("FirestoreCanonicalStore", () => {
  it("pads event sequence ids so lexical order is numeric order", () => {
    expect(firestoreSequenceId(2)).toBe("000000000002");
    expect(firestoreSequenceId(10)).toBe("000000000010");
    expect(firestoreSequenceId(2) < firestoreSequenceId(10)).toBe(true);
  });

  it("atomically commits Genesis, the head pointer, and current state", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreCanonicalStore(fake as unknown as Firestore);
    const { built, event } = genesis();
    await store.commit(event, built.state, 0, built.stateChecksum);

    expect(await store.headSequence(built.config.worldId)).toBe(0);
    expect((await store.head(built.config.worldId))?.hash).toBe(event.hash);
    expect((await store.load(built.config.worldId))?.state).toEqual(built.state);
  });

  it("refuses to overwrite an existing canonical sequence", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreCanonicalStore(fake as unknown as Firestore);
    const { built, event } = genesis();
    await store.commit(event, built.state, 0, built.stateChecksum);
    await expect(
      store.commit(event, built.state, 0, built.stateChecksum),
    ).rejects.toBeInstanceOf(SequenceConflictError);
  });
});
