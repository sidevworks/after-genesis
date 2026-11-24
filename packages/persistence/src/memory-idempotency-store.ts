// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * In-process idempotency claims (§14.2, §18).
 *
 * Queues deliver twice. That is not a bug to be engineered away, it is the
 * contract every at-least-once queue offers, so the turn lifecycle is built
 * around it: before a turn does anything expensive or irreversible it claims a
 * key derived from (world, inhabitant, turn number), and a caller that loses the
 * claim abandons the turn rather than redoing it.
 *
 * Note the relationship with `EventStore.append`. The claim is an *optimisation*
 * — it stops the second delivery before it spends money on inference. The
 * *guarantee* that a turn commits at most once comes from the sequence conflict
 * on append, which holds even if the claim store were wiped. Two layers, and
 * only the lower one is load-bearing.
 */
import type { Clock, IdempotencyStore } from "@after-genesis/core";
import { SystemClock, clockMillis } from "./clock.js";

interface Claim {
  /** Epoch milliseconds after which the claim is no longer held. */
  readonly expiresAtMillis: number;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #claims = new Map<string, Claim>();
  readonly #clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.#clock = clock;
  }

  /**
   * Claim `key` for `ttlSeconds`. Returns false if someone already holds it.
   *
   * Like the event stores, the check and the set happen with no `await` between
   * them, so concurrent callers are serialised by the event loop and exactly one
   * sees `true`.
   *
   * The TTL exists because a worker can die holding a claim. It is a deliberate
   * trade: too short and a slow turn gets a duplicate racing it (harmless — the
   * sequence conflict catches it); too long and a crashed turn blocks its own
   * retry. Ceiling, not a lock.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- atomicity depends on no await
  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError(`ttlSeconds must be a positive number, received ${ttlSeconds}`);
    }
    const now = clockMillis(this.#clock);
    const existing = this.#claims.get(key);
    if (existing !== undefined && existing.expiresAtMillis > now) return false;

    this.#claims.set(key, { expiresAtMillis: now + ttlSeconds * 1000 });
    return true;
  }

  /**
   * Release `key`.
   *
   * Releasing a key nobody holds is not an error: the common caller is a
   * `finally` block that cannot know whether the claim succeeded.
   */
  async release(key: string): Promise<void> {
    this.#claims.delete(key);
  }

  /** True if the key is currently held. Diagnostics and tests only. */
  isClaimed(key: string): boolean {
    const existing = this.#claims.get(key);
    return existing !== undefined && existing.expiresAtMillis > clockMillis(this.#clock);
  }

  /**
   * Drop expired entries and return how many went.
   *
   * Expiry is lazy on `claim`, so a key that is claimed once and never claimed
   * again stays in the map forever. A long-lived worker should sweep
   * periodically; nothing depends on it for correctness.
   */
  sweep(): number {
    const now = clockMillis(this.#clock);
    let removed = 0;
    for (const [key, claim] of this.#claims) {
      if (claim.expiresAtMillis <= now) {
        this.#claims.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Number of entries held, expired or not. */
  get size(): number {
    return this.#claims.size;
  }
}
