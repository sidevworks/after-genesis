// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Ports: the boundaries between the deterministic core and everything else.
 *
 * The core engine performs no I/O. It takes state and an action, and returns
 * events and new state. Everything that touches a network, a disk or a clock
 * sits behind one of these interfaces, which is what makes the engine testable,
 * replayable, and impossible for a model to reach through (§2).
 *
 * Note what is absent: there is no `write`, `update` or `delete` on any port
 * available to cognition. The model provider returns text. It cannot persist.
 */
import type { CanonicalEvent } from "./event.js";
import type { Sha256Hex } from "./util/hash.js";

/**
 * Real wall-clock access, isolated so the engine cannot accidentally depend on
 * it. Only used to stamp `realTimestamp` on events, which no rule may read.
 */
export interface Clock {
  nowIso(): string;
}

/** A model request, recorded verbatim for audit before it is sent. */
export interface ModelRequest {
  /** Exact model identifier, e.g. "gemini-2.5-flash-lite". Recorded on the event. */
  readonly modelId: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** JSON schema the response must conform to, if the provider supports it. */
  readonly responseSchema?: unknown;
  readonly maxOutputTokens: number;
  /**
   * Sampling temperature. Note that even at 0 no hosted LLM is bit-reproducible,
   * which is exactly why replay uses the *recorded* response rather than
   * re-calling the model (§16).
   */
  readonly temperature: number;
}

export interface ModelResponse {
  /** The raw response text, stored untouched and hashed before parsing (§14.8). */
  readonly rawText: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Provider-reported finish reason, e.g. "stop", "max_tokens", "safety". */
  readonly finishReason: string;
}

/**
 * A provider-neutral cognition interface (§3).
 *
 * Implementations exist for Gemini, for a deterministic scripted provider used
 * in mechanical simulation, and for a replay provider that serves recorded
 * responses from the audit log instead of calling anything.
 */
export interface ModelProvider {
  readonly name: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

/** Raised when a spend ceiling would be exceeded. Freezes paid inference (§15). */
export class SpendLimitExceededError extends Error {
  constructor(
    readonly limitName: string,
    readonly spentMicros: number,
    readonly limitMicros: number,
  ) {
    super(
      `Spend limit "${limitName}" reached: ${spentMicros} of ${limitMicros} micros used. ` +
        `Paid inference is frozen; the world will pause rather than proceed.`,
    );
    this.name = "SpendLimitExceededError";
  }
}

/**
 * Append-only event storage.
 *
 * There is deliberately no update or delete method. The interface itself is part
 * of the guarantee — an implementation cannot be asked to rewrite history
 * because no caller can express the request.
 */
export interface EventStore {
  /**
   * Append one event at `expectedSequence`.
   *
   * Must be atomic and must reject if an event already exists at that sequence.
   * This is the concurrency control that makes duplicate task delivery safe:
   * two workers racing on the same turn will see one succeed and one rejected
   * (§15 "each task can commit at most once").
   */
  append(event: CanonicalEvent, expectedSequence: number): Promise<void>;

  /** Read a contiguous range, ordered by sequence. */
  read(worldId: string, fromSequence: number, toSequence?: number): AsyncIterable<CanonicalEvent>;

  /** The sequence number of the most recent event, or -1 for an empty world. */
  headSequence(worldId: string): Promise<number>;

  /** The most recent event, or null for an empty world. */
  head(worldId: string): Promise<CanonicalEvent | null>;
}

/**
 * Materialised state storage (§4E). This is a cache: it can be dropped and
 * rebuilt from the event log at any time.
 */
export interface StateStore<TState> {
  load(worldId: string): Promise<{ state: TState; sequence: number } | null>;
  /** Save must be atomic with respect to the event append that produced it. */
  save(worldId: string, state: TState, sequence: number, checksum: Sha256Hex): Promise<void>;
}

/**
 * Optional production capability: append the event and replace its materialised
 * snapshot in one database transaction.
 */
export interface AtomicCanonicalStore<TState> {
  commit(
    event: CanonicalEvent,
    state: TState,
    expectedSequence: number,
    checksum: Sha256Hex,
  ): Promise<void>;
}

/**
 * Idempotency: guarantees a turn commits at most once regardless of how many
 * times the queue delivers it (§14.2, §18).
 */
export interface IdempotencyStore {
  /**
   * Claim a key. Returns false if it was already claimed, in which case the
   * caller must abandon the turn rather than redo it.
   */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

export interface SpendReservation {
  readonly reservationId: string;
  readonly worldId: string;
  readonly sequence: number;
  readonly attempt: number;
  readonly dayKey: string;
  readonly estimatedMicros: number;
  readonly dailyLimitMicros: number;
  readonly totalLimitMicros: number;
}

/**
 * Durable pre-authorisation for paid inference.
 *
 * Implementations must reserve against both ceilings atomically. A process
 * restart must never reset or forget outstanding/settled spend.
 */
export interface SpendReservationStore {
  reserve(
    reservation: SpendReservation,
  ): Promise<
    | { readonly status: "reserved" | "already-reserved" }
    | { readonly status: "settled"; readonly actualMicros: number }
  >;
  settle(reservationId: string, actualMicros: number): Promise<void>;
  release(reservationId: string): Promise<void>;
}

/** Audit storage for raw prompts and responses (§16). Write-once. */
export interface ModelAuditStore {
  record(entry: {
    readonly worldId: string;
    readonly sequence: number;
    /** Model call within the turn: 1 for initial, 2 for format correction. */
    readonly attempt?: number;
    readonly request: ModelRequest;
    readonly requestHash: Sha256Hex;
    readonly response: ModelResponse | null;
    readonly responseHash: Sha256Hex | null;
    readonly costMicros: number;
  }): Promise<void>;

  /** Used by replay to serve the recorded response instead of calling a model. */
  get(
    worldId: string,
    sequence: number,
    attempt?: number,
  ): Promise<{ rawText: string; modelId: string } | null>;
}
