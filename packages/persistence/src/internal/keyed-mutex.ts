// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Serialise async work per key within a single process.
 *
 * This is not a distributed lock and is not pretending to be one. It exists so
 * that two concurrent calls inside one worker cannot interleave a
 * read-modify-write on the same file. Cross-process safety comes from the
 * filesystem primitives themselves (`O_EXCL` creation, atomic `rename`), not
 * from here.
 */
export class KeyedMutex {
  readonly #chains = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    // Swallow the predecessor's rejection so one failure does not cascade
    // through every later waiter; each caller still sees its own outcome.
    const result = previous.then(fn, fn);
    this.#chains.set(
      key,
      result.catch(() => undefined),
    );
    try {
      return await result;
    } finally {
      // Drop the entry once this is the tail, so the map does not grow forever
      // across millions of sequences.
      if (this.#chains.get(key) !== undefined) {
        const tail = this.#chains.get(key);
        void Promise.resolve(tail).then(() => {
          if (this.#chains.get(key) === tail) this.#chains.delete(key);
        });
      }
    }
  }
}
