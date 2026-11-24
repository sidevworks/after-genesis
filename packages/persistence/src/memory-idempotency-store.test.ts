// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { FixedClock } from "./clock.js";
import { MemoryIdempotencyStore } from "./memory-idempotency-store.js";

const KEY = "test-world:inh_alice:turn-7";

describe("MemoryIdempotencyStore", () => {
  it("grants a claim on a fresh key", async () => {
    const store = new MemoryIdempotencyStore(new FixedClock());
    expect(await store.claim(KEY, 60)).toBe(true);
    expect(store.isClaimed(KEY)).toBe(true);
  });

  // The whole point: a second delivery of the same task is turned away.
  it("refuses a second claim on a held key", async () => {
    const store = new MemoryIdempotencyStore(new FixedClock());
    expect(await store.claim(KEY, 60)).toBe(true);
    expect(await store.claim(KEY, 60)).toBe(false);
    expect(await store.claim(KEY, 60)).toBe(false);
  });

  it("keeps distinct keys independent", async () => {
    const store = new MemoryIdempotencyStore(new FixedClock());
    expect(await store.claim("world:inh_alice:turn-1", 60)).toBe(true);
    expect(await store.claim("world:inh_alice:turn-2", 60)).toBe(true);
    expect(await store.claim("world:inh_bob:turn-1", 60)).toBe(true);
  });

  it("frees the key on release", async () => {
    const store = new MemoryIdempotencyStore(new FixedClock());
    expect(await store.claim(KEY, 60)).toBe(true);
    await store.release(KEY);
    expect(store.isClaimed(KEY)).toBe(false);
    expect(await store.claim(KEY, 60)).toBe(true);
  });

  it("tolerates releasing a key nobody holds", async () => {
    const store = new MemoryIdempotencyStore(new FixedClock());
    // The caller is a `finally` block that cannot know whether it won the claim.
    await expect(store.release("never-claimed")).resolves.toBeUndefined();
  });

  describe("TTL", () => {
    it("holds the key for the full TTL and no longer", async () => {
      const clock = new FixedClock("2026-03-01T00:00:00.000Z");
      const store = new MemoryIdempotencyStore(clock);

      expect(await store.claim(KEY, 30)).toBe(true);

      clock.advanceSeconds(29);
      expect(await store.claim(KEY, 30)).toBe(false);

      clock.advanceSeconds(1); // exactly at expiry
      expect(await store.claim(KEY, 30)).toBe(true);
    });

    it("re-claiming after expiry starts a fresh TTL", async () => {
      const clock = new FixedClock("2026-03-01T00:00:00.000Z");
      const store = new MemoryIdempotencyStore(clock);

      expect(await store.claim(KEY, 10)).toBe(true);
      clock.advanceSeconds(11);
      expect(await store.claim(KEY, 10)).toBe(true);
      clock.advanceSeconds(5);
      expect(await store.claim(KEY, 10)).toBe(false);
    });

    it("refuses a non-positive TTL", async () => {
      const store = new MemoryIdempotencyStore(new FixedClock());
      await expect(store.claim(KEY, 0)).rejects.toBeInstanceOf(RangeError);
      await expect(store.claim(KEY, -1)).rejects.toBeInstanceOf(RangeError);
    });

    it("sweeps expired entries without touching live ones", async () => {
      const clock = new FixedClock("2026-03-01T00:00:00.000Z");
      const store = new MemoryIdempotencyStore(clock);

      await store.claim("short", 10);
      await store.claim("long", 600);
      expect(store.size).toBe(2);

      clock.advanceSeconds(60);
      expect(store.sweep()).toBe(1);
      expect(store.size).toBe(1);
      expect(store.isClaimed("long")).toBe(true);
    });
  });

  it("lets exactly one of many concurrent claims win", async () => {
    const store = new MemoryIdempotencyStore(new FixedClock());
    const results = await Promise.all(
      Array.from({ length: 32 }, async () => {
        await Promise.resolve();
        return store.claim(KEY, 60);
      }),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("uses the injected clock, not the wall clock", async () => {
    // A store reading `Date.now()` directly would make TTL tests either flaky or
    // slow; this asserts the port is actually the source of time.
    const clock = new FixedClock("2020-01-01T00:00:00.000Z");
    const store = new MemoryIdempotencyStore(clock);
    await store.claim(KEY, 5);
    expect(store.isClaimed(KEY)).toBe(true);
    clock.set("2030-01-01T00:00:00.000Z");
    expect(store.isClaimed(KEY)).toBe(false);
  });
});
