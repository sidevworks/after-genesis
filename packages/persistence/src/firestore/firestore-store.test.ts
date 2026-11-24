// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import type { Firestore } from "@google-cloud/firestore";
import {
  GENESIS_PREV_HASH,
  buildGenesis,
  sealEvent,
  SpendLimitExceededError,
  type ModelRequest,
  type ModelResponse,
  type Sha256Hex,
} from "@after-genesis/core";
import { describe, expect, it } from "vitest";
import { AuditIntegrityError, SequenceConflictError } from "../errors.js";
import {
  FirestoreCanonicalStore,
  FirestoreModelAuditStore,
  FirestoreSpendReservationStore,
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
      sex: "female",
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

describe("FirestoreSpendReservationStore", () => {
  const reservation = {
    reservationId: "world:1:1:hash",
    worldId: "world",
    sequence: 1,
    attempt: 1,
    dayKey: "2026-07-28",
    estimatedMicros: 600,
    dailyLimitMicros: 1_000,
    totalLimitMicros: 2_000,
  };

  it("reserves, settles actual spend, and makes settlement idempotent", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreSpendReservationStore(fake as unknown as Firestore);

    await expect(store.reserve(reservation)).resolves.toEqual({ status: "reserved" });
    await expect(store.reserve(reservation)).resolves.toEqual({
      status: "already-reserved",
    });
    await store.settle(reservation.reservationId, 250);
    await store.settle(reservation.reservationId, 250);

    expect(fake.documents.get("spend/control")).toMatchObject({
      actualMicros: 250,
      reservedMicros: 0,
    });
    expect(await store.reserve(reservation)).toEqual({
      status: "settled",
      actualMicros: 250,
    });
  });

  it("atomically refuses a reservation beyond either durable ceiling", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreSpendReservationStore(fake as unknown as Firestore);
    await store.reserve(reservation);

    await expect(
      store.reserve({
        ...reservation,
        reservationId: "world:1:2:hash",
        attempt: 2,
      }),
    ).rejects.toBeInstanceOf(SpendLimitExceededError);
  });

  it("releases an unanswered reservation so the same work may retry", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreSpendReservationStore(fake as unknown as Firestore);
    await store.reserve(reservation);
    await store.release(reservation.reservationId);
    expect(fake.documents.get("spend/control")).toMatchObject({
      actualMicros: 0,
      reservedMicros: 0,
    });
    await expect(store.reserve(reservation)).resolves.toEqual({ status: "reserved" });
  });
});

describe("FirestoreModelAuditStore", () => {
  const request: ModelRequest = {
    modelId: "gemini-test",
    systemPrompt: "system",
    userPrompt: "user",
    maxOutputTokens: 100,
    temperature: 0,
  };
  const response: ModelResponse = {
    rawText: "{\"action\":\"wait\"}",
    modelId: "gemini-test-001",
    inputTokens: 10,
    outputTokens: 5,
    finishReason: "stop",
  };
  const requestHash = "a".repeat(64) as Sha256Hex;
  const responseHash = "b".repeat(64) as Sha256Hex;

  it("permits only the request-only to request-plus-response transition", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreModelAuditStore(fake as unknown as Firestore);
    const base = {
      worldId: "world_audit",
      sequence: 1,
      request,
      requestHash,
      costMicros: 0,
    };

    await store.record({ ...base, response: null, responseHash: null });
    expect(await store.get(base.worldId, base.sequence)).toBeNull();
    await store.record({ ...base, response, responseHash, costMicros: 25 });
    expect(await store.get(base.worldId, base.sequence)).toEqual({
      rawText: response.rawText,
      modelId: response.modelId,
    });
    await store.record({ ...base, response, responseHash, costMicros: 25 });

    await expect(
      store.record({
        ...base,
        response: { ...response, rawText: "different" },
        responseHash: "c".repeat(64) as Sha256Hex,
        costMicros: 25,
      }),
    ).rejects.toBeInstanceOf(AuditIntegrityError);
  });

  it("stores correction attempts independently", async () => {
    const fake = new FakeFirestore();
    const store = new FirestoreModelAuditStore(fake as unknown as Firestore);
    await store.record({
      worldId: "world_audit",
      sequence: 2,
      attempt: 2,
      request,
      requestHash,
      response,
      responseHash,
      costMicros: 25,
    });

    expect(await store.get("world_audit", 2, 1)).toBeNull();
    expect(await store.get("world_audit", 2, 2)).toEqual({
      rawText: response.rawText,
      modelId: response.modelId,
    });
  });
});
