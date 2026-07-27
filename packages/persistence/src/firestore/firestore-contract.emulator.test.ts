import { Firestore } from "@google-cloud/firestore";
import {
  buildGenesis,
  sealEvent,
  type CanonicalEvent,
} from "@after-genesis/core";
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FirestoreCanonicalStore } from "./firestore-store.js";

const PROJECT_ID = "demo-after-genesis";
const describeEmulator = process.env["FIRESTORE_EMULATOR_HOST"] ? describe : describe.skip;

describeEmulator("FirestoreCanonicalStore emulator contract", () => {
  let environment: RulesTestEnvironment;
  let database: Firestore;
  let store: FirestoreCanonicalStore;

  beforeAll(async () => {
    const host = process.env["FIRESTORE_EMULATOR_HOST"];
    if (host === undefined) throw new Error("FIRESTORE_EMULATOR_HOST is required");
    environment = await initializeTestEnvironment({ projectId: PROJECT_ID });
    database = new Firestore({ projectId: PROJECT_ID, host, ssl: false });
    store = new FirestoreCanonicalStore(database);
  });

  beforeEach(async () => {
    await environment.clearFirestore();
  });

  afterAll(async () => {
    await database.terminate();
    await environment.cleanup();
  });

  it("round-trips an atomic Genesis event and materialised state", async () => {
    const fixture = genesisFixture("emulator_roundtrip");
    await store.commit(
      fixture.event,
      fixture.built.state,
      0,
      fixture.built.stateChecksum,
    );

    expect(await store.headSequence(fixture.event.worldId)).toBe(0);
    expect(await store.head(fixture.event.worldId)).toEqual(fixture.event);
    expect(await store.load(fixture.event.worldId)).toEqual({
      state: fixture.built.state,
      sequence: 0,
    });
    const events: CanonicalEvent[] = [];
    for await (const event of store.read(fixture.event.worldId, 0)) events.push(event);
    expect(events).toEqual([fixture.event]);
  });

  it("allows exactly one of ten concurrent writes to the same sequence", async () => {
    const fixture = genesisFixture("emulator_contention");
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        store.commit(
          fixture.event,
          fixture.built.state,
          0,
          fixture.built.stateChecksum,
        ),
      ),
    );

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(9);
    expect(await store.headSequence(fixture.event.worldId)).toBe(0);
  });
});

function genesisFixture(worldId: string) {
  const built = buildGenesis({
    worldId,
    seed: `${worldId}-seed`,
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
    worldId,
    sequence: 0,
    simTime: 0,
    realTimestamp: "2026-01-01T00:00:00.000Z",
    actor: null,
    type: "genesis",
    inputs: { genesis: built.config },
    resolution: { founderId: built.config.founder.id },
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
    prevHash: "0".repeat(64) as never,
  });
  return { built, event };
}
