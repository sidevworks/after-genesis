// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * An in-memory `EventStore` for tests and mechanical simulation (§24).
 *
 * It is not a toy. It enforces exactly the same three rules the durable stores
 * enforce — one event per sequence, contiguous sequences, unbroken hash chain —
 * because a test that passes against a permissive fake and fails against
 * Firestore has told you nothing.
 */
import {
  GENESIS_PREV_HASH,
  hashEquals,
  type CanonicalEvent,
  type EventStore,
} from "@after-genesis/core";
import { ChainIntegrityError, SequenceConflictError } from "./errors.js";

export class MemoryEventStore implements EventStore {
  readonly #worlds = new Map<string, CanonicalEvent[]>();

  /**
   * Append at `expectedSequence`, rejecting if that slot is taken.
   *
   * ## Why this is atomic
   *
   * Everything below runs synchronously. The method is `async` only because the
   * port says so; there is no `await` between reading the head and pushing the
   * new event, so the JavaScript event loop cannot interleave another `append`
   * in the middle of the check-and-set. Two callers racing at the same sequence
   * are therefore serialised by the runtime itself: the first mutates the array,
   * the second observes the mutation and is rejected.
   *
   * Introducing an `await` before the `push` would quietly destroy that property
   * and let duplicate task delivery produce duplicate events (§15). Do not.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- see the note above
  async append(event: CanonicalEvent, expectedSequence: number): Promise<void> {
    const log = this.#logFor(event.worldId);

    // The event must actually be the event the caller claims to be appending.
    // Without this a worker could reserve slot 7 and write an event stamped 4.
    if (event.sequence !== expectedSequence) {
      throw new SequenceConflictError(event.worldId, expectedSequence, log.length - 1);
    }

    // `log.length` is the next free sequence, because sequences are contiguous
    // from 0 and nothing is ever removed. This single comparison rejects both
    // "already taken" and "leaves a hole".
    if (expectedSequence !== log.length) {
      throw new SequenceConflictError(event.worldId, expectedSequence, log.length - 1);
    }

    const previous = log[log.length - 1];
    const expectedPrevHash = previous === undefined ? GENESIS_PREV_HASH : previous.hash;
    if (!hashEquals(event.prevHash, expectedPrevHash)) {
      throw new ChainIntegrityError(
        event.worldId,
        `event ${event.sequence} does not chain from the current head ` +
          `(${previous === undefined ? "genesis" : `event ${previous.sequence}`})`,
        [
          {
            sequence: event.sequence,
            kind: "broken-link",
            detail: `prevHash ${event.prevHash.slice(0, 12)}… does not match ${expectedPrevHash.slice(0, 12)}…`,
          },
        ],
      );
    }

    log.push(event);
  }

  /**
   * Stream a contiguous range, `fromSequence` and `toSequence` both inclusive.
   *
   * The range is resolved against the log as it stands when iteration begins, so
   * a concurrent append cannot extend a read that is already in flight. A reader
   * asking for 0..99 gets 0..99 or fewer, never a moving target.
   */
  async *read(
    worldId: string,
    fromSequence: number,
    toSequence?: number,
  ): AsyncIterable<CanonicalEvent> {
    const log = this.#worlds.get(worldId);
    if (log === undefined) return;

    const start = Math.max(0, fromSequence);
    const end = Math.min(log.length - 1, toSequence ?? log.length - 1);
    for (let i = start; i <= end; i++) {
      const event = log[i];
      if (event === undefined) return;
      yield event;
    }
  }

  async headSequence(worldId: string): Promise<number> {
    return (this.#worlds.get(worldId)?.length ?? 0) - 1;
  }

  async head(worldId: string): Promise<CanonicalEvent | null> {
    const log = this.#worlds.get(worldId);
    if (log === undefined || log.length === 0) return null;
    return log[log.length - 1] ?? null;
  }

  /** World ids that hold at least one event. Convenience for tests and tooling. */
  worlds(): string[] {
    return [...this.#worlds.keys()];
  }

  #logFor(worldId: string): CanonicalEvent[] {
    let log = this.#worlds.get(worldId);
    if (log === undefined) {
      log = [];
      this.#worlds.set(worldId, log);
    }
    return log;
  }
}
