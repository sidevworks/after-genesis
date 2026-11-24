// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import {
  FieldPath,
  FieldValue,
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "@google-cloud/firestore";
import {
  CanonicalEventSchema,
  GENESIS_PREV_HASH,
  SpendLimitExceededError,
  canonicalJson,
  computeStateChecksum,
  hashEquals,
  sha256Hex,
  type AtomicCanonicalStore,
  type CanonicalEvent,
  type EventStore,
  type IdempotencyStore,
  type ModelAuditStore,
  type ModelRequest,
  type ModelResponse,
  type Sha256Hex,
  type SpendReservation,
  type SpendReservationStore,
  type StateStore,
  type WorldState,
} from "@after-genesis/core";
import {
  AuditIntegrityError,
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

interface FirestoreAuditRecord {
  readonly worldId: string;
  readonly sequence: number;
  readonly attempt: number;
  readonly request: ModelRequest & { readonly responseSchema: unknown };
  readonly requestHash: Sha256Hex;
  readonly response: ModelResponse | null;
  readonly responseHash: Sha256Hex | null;
  readonly costMicros: number;
  readonly entryDigest: Sha256Hex;
}

/** Write-once model audit storage for production replay. */
export class FirestoreModelAuditStore implements ModelAuditStore {
  constructor(private readonly db: Firestore) {}

  async record(entry: Parameters<ModelAuditStore["record"]>[0]): Promise<void> {
    const attempt = entry.attempt ?? 1;
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 0) {
      throw new RangeError("audit sequence must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 2) {
      throw new RangeError("audit attempt must be 1 or 2");
    }
    const record = auditRecord(entry, attempt);
    canonicalJson(record);
    const ref = this.db.doc(
      `${worldPath(entry.worldId)}/private/modelAudit/entries/` +
        `${firestoreSequenceId(entry.sequence)}-a${String(attempt).padStart(2, "0")}`,
    );

    await this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) {
        tx.create(ref, {
          ...record,
          recordedAt: FieldValue.serverTimestamp(),
        });
        return;
      }
      const existing = snapshot.data() as FirestoreAuditRecord;
      if (hashEquals(existing.entryDigest, record.entryDigest)) return;
      if (!hashEquals(existing.requestHash, record.requestHash)) {
        throw new AuditIntegrityError(
          entry.worldId,
          entry.sequence,
          "a different model request is already recorded for this attempt",
        );
      }
      if (existing.response !== null) {
        throw new AuditIntegrityError(
          entry.worldId,
          entry.sequence,
          "a model response is already recorded and cannot be rewritten",
        );
      }
      if (record.response === null) {
        throw new AuditIntegrityError(
          entry.worldId,
          entry.sequence,
          "request-only audit records are not editable",
        );
      }
      tx.set(ref, {
        ...record,
        recordedAt: snapshot.get("recordedAt") ?? FieldValue.serverTimestamp(),
        responseRecordedAt: FieldValue.serverTimestamp(),
      });
    });
  }

  async get(
    worldId: string,
    sequence: number,
    attempt: number = 1,
  ): Promise<{ rawText: string; modelId: string } | null> {
    const snapshot = await this.db
      .doc(
        `${worldPath(worldId)}/private/modelAudit/entries/` +
          `${firestoreSequenceId(sequence)}-a${String(attempt).padStart(2, "0")}`,
      )
      .get();
    if (!snapshot.exists) return null;
    const response = snapshot.get("response") as ModelResponse | null | undefined;
    if (response === null || response === undefined) return null;
    return { rawText: response.rawText, modelId: response.modelId };
  }
}

function auditRecord(
  entry: Parameters<ModelAuditStore["record"]>[0],
  attempt: number,
): FirestoreAuditRecord {
  const base = {
    worldId: entry.worldId,
    sequence: entry.sequence,
    attempt,
    request: {
      ...entry.request,
      responseSchema: entry.request.responseSchema ?? null,
    },
    requestHash: entry.requestHash,
    response: entry.response,
    responseHash: entry.responseHash,
    costMicros: entry.costMicros,
  };
  return { ...base, entryDigest: sha256Hex(canonicalJson(base)) };
}

interface SpendTotals {
  readonly actualMicros: number;
  readonly reservedMicros: number;
}

interface StoredSpendReservation extends SpendReservation {
  readonly status: "reserved" | "settled" | "released";
  readonly actualMicros: number | null;
}

/**
 * Firestore-backed spend reservations shared by every worker instance.
 *
 * The global and daily counters move in the same transaction as each
 * reservation, so concurrent workers cannot both spend the final allowance.
 */
export class FirestoreSpendReservationStore implements SpendReservationStore {
  constructor(private readonly db: Firestore) {}

  async reserve(
    reservation: SpendReservation,
  ): Promise<
    | { readonly status: "reserved" | "already-reserved" }
    | { readonly status: "settled"; readonly actualMicros: number }
  > {
    validateReservation(reservation);
    const refs = this.refs(reservation.reservationId, reservation.dayKey);
    return this.db.runTransaction(async (tx) => {
      const [storedSnapshot, globalSnapshot, daySnapshot] = await Promise.all([
        tx.get(refs.reservation),
        tx.get(refs.global),
        tx.get(refs.day),
      ]);
      if (storedSnapshot.exists) {
        const stored = storedSnapshot.data() as StoredSpendReservation;
        if (stored.status === "settled") {
          if (stored.actualMicros === null) {
            throw new Error("settled spend reservation has no actual cost");
          }
          return { status: "settled", actualMicros: stored.actualMicros };
        }
        if (stored.status === "reserved") {
          if (canonicalJson(stripSpendStatus(stored)) !== canonicalJson(reservation)) {
            throw new Error("spend reservation id already describes different work");
          }
          return { status: "already-reserved" };
        }
      }

      const global = spendTotals(globalSnapshot.data());
      const day = spendTotals(daySnapshot.data());
      const projectedDay =
        day.actualMicros + day.reservedMicros + reservation.estimatedMicros;
      const projectedTotal =
        global.actualMicros + global.reservedMicros + reservation.estimatedMicros;
      if (projectedDay > reservation.dailyLimitMicros) {
        throw new SpendLimitExceededError(
          `daily:${reservation.dayKey}`,
          projectedDay,
          reservation.dailyLimitMicros,
        );
      }
      if (projectedTotal > reservation.totalLimitMicros) {
        throw new SpendLimitExceededError(
          "total",
          projectedTotal,
          reservation.totalLimitMicros,
        );
      }

      tx.set(refs.global, {
        actualMicros: global.actualMicros,
        reservedMicros: global.reservedMicros + reservation.estimatedMicros,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(refs.day, {
        dayKey: reservation.dayKey,
        actualMicros: day.actualMicros,
        reservedMicros: day.reservedMicros + reservation.estimatedMicros,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(refs.reservation, {
        ...reservation,
        status: "reserved",
        actualMicros: null,
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { status: "reserved" };
    });
  }

  async settle(reservationId: string, actualMicros: number): Promise<void> {
    assertMicros(actualMicros, "actualMicros");
    const reservationRef = this.reservationRef(reservationId);
    await this.db.runTransaction(async (tx) => {
      const reservationSnapshot = await tx.get(reservationRef);
      if (!reservationSnapshot.exists) throw new Error("spend reservation does not exist");
      const reservation = reservationSnapshot.data() as StoredSpendReservation;
      const refs = this.refs(reservationId, reservation.dayKey);
      const [globalSnapshot, daySnapshot] = await Promise.all([
        tx.get(refs.global),
        tx.get(refs.day),
      ]);
      if (reservation.status === "settled") {
        if (reservation.actualMicros !== actualMicros) {
          throw new Error("settled spend reservation has a different actual cost");
        }
        return;
      }
      if (reservation.status !== "reserved") {
        throw new Error("released spend reservation cannot be settled");
      }
      const global = spendTotals(globalSnapshot.data());
      const day = spendTotals(daySnapshot.data());
      writeSettledTotals(
        tx,
        refs.global,
        global,
        reservation.estimatedMicros,
        actualMicros,
      );
      writeSettledTotals(
        tx,
        refs.day,
        day,
        reservation.estimatedMicros,
        actualMicros,
        { dayKey: reservation.dayKey },
      );
      tx.set(
        reservationRef,
        {
          status: "settled",
          actualMicros,
          settledAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  }

  async release(reservationId: string): Promise<void> {
    const reservationRef = this.reservationRef(reservationId);
    await this.db.runTransaction(async (tx) => {
      const reservationSnapshot = await tx.get(reservationRef);
      if (!reservationSnapshot.exists) return;
      const reservation = reservationSnapshot.data() as StoredSpendReservation;
      if (reservation.status === "released") return;
      if (reservation.status === "settled") {
        throw new Error("settled spend reservation cannot be released");
      }
      const refs = this.refs(reservationId, reservation.dayKey);
      const [globalSnapshot, daySnapshot] = await Promise.all([
        tx.get(refs.global),
        tx.get(refs.day),
      ]);
      writeReleasedTotals(
        tx,
        refs.global,
        spendTotals(globalSnapshot.data()),
        reservation.estimatedMicros,
      );
      writeReleasedTotals(
        tx,
        refs.day,
        spendTotals(daySnapshot.data()),
        reservation.estimatedMicros,
        { dayKey: reservation.dayKey },
      );
      tx.set(
        reservationRef,
        {
          status: "released",
          releasedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });
  }

  private refs(reservationId: string, dayKey: string) {
    return {
      global: this.db.doc("spend/control"),
      day: this.db.doc(`spend/control/days/${dayKey}`),
      reservation: this.reservationRef(reservationId),
    };
  }

  private reservationRef(reservationId: string) {
    if (reservationId.trim() === "") throw new Error("reservationId must not be empty");
    return this.db.doc(`spend/control/reservations/${sha256Hex(reservationId)}`);
  }
}

function validateReservation(reservation: SpendReservation): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reservation.dayKey)) {
    throw new Error("spend reservation dayKey must use YYYY-MM-DD");
  }
  assertMicros(reservation.estimatedMicros, "estimatedMicros");
  assertMicros(reservation.dailyLimitMicros, "dailyLimitMicros");
  assertMicros(reservation.totalLimitMicros, "totalLimitMicros");
  if (!Number.isSafeInteger(reservation.sequence) || reservation.sequence < 0) {
    throw new Error("spend reservation sequence must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(reservation.attempt) || reservation.attempt < 1) {
    throw new Error("spend reservation attempt must be a positive safe integer");
  }
}

function assertMicros(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function spendTotals(value: DocumentData | undefined): SpendTotals {
  const actualMicros = value?.["actualMicros"] ?? 0;
  const reservedMicros = value?.["reservedMicros"] ?? 0;
  assertMicros(actualMicros as number, "stored actualMicros");
  assertMicros(reservedMicros as number, "stored reservedMicros");
  return {
    actualMicros: actualMicros as number,
    reservedMicros: reservedMicros as number,
  };
}

function stripSpendStatus(value: StoredSpendReservation): SpendReservation {
  return {
    reservationId: value.reservationId,
    worldId: value.worldId,
    sequence: value.sequence,
    attempt: value.attempt,
    dayKey: value.dayKey,
    estimatedMicros: value.estimatedMicros,
    dailyLimitMicros: value.dailyLimitMicros,
    totalLimitMicros: value.totalLimitMicros,
  };
}

function writeSettledTotals(
  tx: Transaction,
  ref: DocumentReference,
  totals: SpendTotals,
  reservedMicros: number,
  actualMicros: number,
  extra: Record<string, unknown> = {},
): void {
  if (totals.reservedMicros < reservedMicros) {
    throw new Error("stored spend reservation counter underflow");
  }
  tx.set(ref, {
    ...extra,
    actualMicros: totals.actualMicros + actualMicros,
    reservedMicros: totals.reservedMicros - reservedMicros,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

function writeReleasedTotals(
  tx: Transaction,
  ref: DocumentReference,
  totals: SpendTotals,
  reservedMicros: number,
  extra: Record<string, unknown> = {},
): void {
  if (totals.reservedMicros < reservedMicros) {
    throw new Error("stored spend reservation counter underflow");
  }
  tx.set(ref, {
    ...extra,
    actualMicros: totals.actualMicros,
    reservedMicros: totals.reservedMicros - reservedMicros,
    updatedAt: FieldValue.serverTimestamp(),
  });
}
