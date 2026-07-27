import {
  FieldPath,
  FieldValue,
  Timestamp,
  type DocumentData,
  type Firestore,
  type Transaction,
} from "@google-cloud/firestore";
import {
  CanonicalEventSchema,
  GENESIS_PREV_HASH,
  canonicalJson,
  computeStateChecksum,
  hashEquals,
  sha256Hex,
  type AtomicCanonicalStore,
  type CanonicalEvent,
  type EventStore,
  type IdempotencyStore,
  type Sha256Hex,
  type StateStore,
  type WorldState,
} from "@after-genesis/core";
import {
  ChainIntegrityError,
  SequenceConflictError,
  SnapshotChecksumError,
} from "../errors.js";

const SEQUENCE_WIDTH = 12;

export function firestoreSequenceId(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError(`sequence must be a non-negative safe integer, got ${sequence}`);
  }
  if (String(sequence).length > SEQUENCE_WIDTH) {
    throw new RangeError(`sequence ${sequence} exceeds ${SEQUENCE_WIDTH} digits`);
  }
  return String(sequence).padStart(SEQUENCE_WIDTH, "0");
}

function worldPath(worldId: string): string {
  if (worldId.trim() === "" || worldId.includes("/")) {
    throw new Error(`invalid Firestore world id: ${worldId}`);
  }
  return `worlds/${worldId}`;
}

export class FirestoreCanonicalStore
  implements
    EventStore,
    StateStore<WorldState>,
    AtomicCanonicalStore<WorldState>
{
  constructor(private readonly db: Firestore) {}

  async append(event: CanonicalEvent, expectedSequence: number): Promise<void> {
    canonicalJson(event);
    await this.db.runTransaction(async (tx) => {
      await this.appendInTransaction(tx, event, expectedSequence);
    });
  }

  async commit(
    event: CanonicalEvent,
    state: WorldState,
    expectedSequence: number,
    checksum: Sha256Hex,
  ): Promise<void> {
    const actual = computeStateChecksum(state);
    if (!hashEquals(actual, checksum)) {
      throw new SnapshotChecksumError(
        event.worldId,
        expectedSequence,
        checksum,
        actual,
        "atomic commit checksum does not describe its state",
      );
    }
    canonicalJson(event);
    canonicalJson(state);

    await this.db.runTransaction(async (tx) => {
      await this.appendInTransaction(tx, event, expectedSequence);
      tx.set(this.db.doc(`${worldPath(event.worldId)}/state/current`), {
        worldId: event.worldId,
        sequence: expectedSequence,
        checksum,
        simTime: state.simTime,
        state,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  }

  async save(
    worldId: string,
    state: WorldState,
    sequence: number,
    checksum: Sha256Hex,
  ): Promise<void> {
    const actual = computeStateChecksum(state);
    if (!hashEquals(actual, checksum)) {
      throw new SnapshotChecksumError(
        worldId,
        sequence,
        checksum,
        actual,
        "the supplied checksum does not describe the supplied state",
      );
    }
    canonicalJson(state);
    const world = await this.db.doc(worldPath(worldId)).get();
    const head = world.exists ? Number(world.get("headSequence")) : -1;
    if (head !== sequence) {
      throw new SequenceConflictError(worldId, sequence, head);
    }
    await this.db.doc(`${worldPath(worldId)}/state/current`).set({
      worldId,
      sequence,
      checksum,
      simTime: state.simTime,
      state,
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  async load(worldId: string): Promise<{ state: WorldState; sequence: number } | null> {
    const snapshot = await this.db.doc(`${worldPath(worldId)}/state/current`).get();
    if (!snapshot.exists) return null;
    const data = snapshot.data() as DocumentData;
    const state = data["state"] as WorldState;
    const sequence = data["sequence"];
    const checksum = data["checksum"];
    if (!Number.isSafeInteger(sequence) || typeof checksum !== "string") {
      throw new Error(`Firestore snapshot for ${worldId} is malformed`);
    }
    const actual = computeStateChecksum(state);
    if (!hashEquals(actual, checksum)) {
      throw new SnapshotChecksumError(
        worldId,
        sequence as number,
        checksum as Sha256Hex,
        actual,
        "stored Firestore snapshot checksum does not match its state",
      );
    }
    return { state, sequence: sequence as number };
  }

  async *read(
    worldId: string,
    fromSequence: number,
    toSequence?: number,
  ): AsyncIterable<CanonicalEvent> {
    let query = this.db
      .collection(`${worldPath(worldId)}/events`)
      .orderBy(FieldPath.documentId())
      .startAt(firestoreSequenceId(Math.max(0, fromSequence)));
    if (toSequence !== undefined) query = query.endAt(firestoreSequenceId(toSequence));
    const result = await query.get();
    for (const document of result.docs) {
      yield CanonicalEventSchema.parse(document.data());
    }
  }

  async headSequence(worldId: string): Promise<number> {
    const snapshot = await this.db.doc(worldPath(worldId)).get();
    if (!snapshot.exists) return -1;
    const sequence = snapshot.get("headSequence");
    if (!Number.isSafeInteger(sequence)) {
      throw new Error(`Firestore head for ${worldId} has an invalid sequence`);
    }
    return sequence as number;
  }

  async head(worldId: string): Promise<CanonicalEvent | null> {
    const sequence = await this.headSequence(worldId);
    if (sequence < 0) return null;
    const snapshot = await this.db
      .doc(`${worldPath(worldId)}/events/${firestoreSequenceId(sequence)}`)
      .get();
    if (!snapshot.exists) {
      throw new Error(`Firestore head points to missing event ${sequence}`);
    }
    return CanonicalEventSchema.parse(snapshot.data());
  }

  private async appendInTransaction(
    tx: Transaction,
    event: CanonicalEvent,
    expectedSequence: number,
  ): Promise<void> {
    const worldRef = this.db.doc(worldPath(event.worldId));
    const eventRef = this.db.doc(
      `${worldPath(event.worldId)}/events/${firestoreSequenceId(expectedSequence)}`,
    );
    const [world, existing] = await Promise.all([tx.get(worldRef), tx.get(eventRef)]);
    const head = world.exists ? Number(world.get("headSequence")) : -1;
    const headHash = world.exists ? String(world.get("headHash")) : GENESIS_PREV_HASH;
    const headTime = world.exists ? Number(world.get("headSimTime")) : 0;

    if (existing.exists || event.sequence !== expectedSequence || expectedSequence !== head + 1) {
      throw new SequenceConflictError(event.worldId, expectedSequence, head);
    }
    if (!hashEquals(event.prevHash, headHash)) {
      throw new ChainIntegrityError(event.worldId, "event does not chain from Firestore head", []);
    }
    if (world.exists && event.simTime < headTime) {
      throw new ChainIntegrityError(event.worldId, "world time cannot move backwards", []);
    }
    if (world.exists && world.get("frozen") === true) {
      throw new Error(`world ${event.worldId} is frozen`);
    }

    tx.create(eventRef, event);
    tx.set(
      worldRef,
      {
        worldId: event.worldId,
        headSequence: expectedSequence,
        headHash: event.hash,
        headSimTime: event.simTime,
        schemaVersion: event.schemaVersion,
        frozen: world.exists ? world.get("frozen") === true : false,
        frozenAtSequence: world.exists ? world.get("frozenAtSequence") ?? null : null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }
}

export class FirestoreIdempotencyStore implements IdempotencyStore {
  private readonly ownerId: string;

  constructor(
    private readonly db: Firestore,
    ownerId: string,
  ) {
    if (ownerId.trim() === "") throw new Error("idempotency ownerId must not be empty");
    this.ownerId = ownerId;
  }

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError("ttlSeconds must be positive");
    }
    const ref = this.db.doc(`idempotency/${sha256Hex(key)}`);
    return this.db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      const now = Timestamp.now();
      const expiry = current.exists ? current.get("expiresAt") : null;
      if (expiry instanceof Timestamp && expiry.toMillis() > now.toMillis()) return false;
      tx.set(ref, {
        keyHash: sha256Hex(key),
        ownerId: this.ownerId,
        claimedAt: now,
        expiresAt: Timestamp.fromMillis(now.toMillis() + ttlSeconds * 1000),
      });
      return true;
    });
  }

  async release(key: string): Promise<void> {
    const ref = this.db.doc(`idempotency/${sha256Hex(key)}`);
    await this.db.runTransaction(async (tx) => {
      const current = await tx.get(ref);
      if (current.exists && current.get("ownerId") === this.ownerId) tx.delete(ref);
    });
  }
}
