// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const PROJECT_ID = "demo-after-genesis";
const describeEmulator = process.env["FIRESTORE_EMULATOR_HOST"] ? describe : describe.skip;

describeEmulator("Firestore security rules against the emulator", () => {
  let environment: RulesTestEnvironment;

  beforeAll(async () => {
    environment = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: await readFile(resolve("firestore.rules"), "utf8"),
      },
    });
  });

  beforeEach(async () => {
    await environment.clearFirestore();
    await environment.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "worlds/world"), {
        worldId: "world",
        headSequence: 0,
        headHash: "abc",
      });
      await setDoc(doc(db, "worlds/world/public/summary"), { inhabitants: 1 });
      await setDoc(doc(db, "worlds/world/events/000000000000"), { type: "genesis" });
      await setDoc(doc(db, "worlds/world/state/current"), { privateState: true });
      await setDoc(doc(db, "worlds/world/private/founder"), { goal: "secret" });
      await setDoc(doc(db, "idempotency/lease"), { ownerId: "worker" });
    });
  });

  afterAll(async () => {
    await environment.cleanup();
  });

  it("allows unauthenticated spectators to read only the public projection", async () => {
    const db = environment.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(db, "worlds/world")));
    await assertSucceeds(getDoc(doc(db, "worlds/world/public/summary")));
    await assertFails(getDoc(doc(db, "worlds/world/events/000000000000")));
    await assertFails(getDoc(doc(db, "worlds/world/state/current")));
    await assertFails(getDoc(doc(db, "worlds/world/private/founder")));
    await assertFails(getDoc(doc(db, "idempotency/lease")));
  });

  it("does not grant canonical access merely because a client is authenticated", async () => {
    const db = environment.authenticatedContext("admin-looking-client", {
      admin: true,
    }).firestore();
    await assertFails(getDoc(doc(db, "worlds/world/events/000000000000")));
    await assertFails(setDoc(doc(db, "worlds/world/public/forged"), { forged: true }));
    await assertFails(setDoc(doc(db, "worlds/world/events/000000000001"), { forged: true }));
    await assertFails(setDoc(doc(db, "idempotency/forged"), { forged: true }));
  });

  it("denies every client write, including writes to public documents", async () => {
    const db = environment.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, "worlds/world"), { headSequence: 999 }));
    await assertFails(setDoc(doc(db, "worlds/world/public/summary"), { inhabitants: 999 }));
    await assertFails(setDoc(doc(db, "worlds/world/private/founder"), { goal: "stolen" }));
  });
});
