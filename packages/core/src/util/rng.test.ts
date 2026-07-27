import { describe, expect, it } from "vitest";
import { Rng } from "./rng.js";

describe("Rng", () => {
  describe("determinism", () => {
    it("produces an identical sequence from an identical seed", () => {
      const a = new Rng(12345n);
      const b = new Rng(12345n);
      const seqA = Array.from({ length: 100 }, () => a.nextU64());
      const seqB = Array.from({ length: 100 }, () => b.nextU64());
      expect(seqA).toEqual(seqB);
    });

    it("produces a different sequence from a different seed", () => {
      const a = new Rng(1n);
      const b = new Rng(2n);
      expect(a.nextU64()).not.toBe(b.nextU64());
    });

    it("derives identical streams from identical purpose paths", () => {
      const a = Rng.derive("seed-alpha", "turn", "42", "gather");
      const b = Rng.derive("seed-alpha", "turn", "42", "gather");
      expect(a.nextU64()).toBe(b.nextU64());
    });
  });

  describe("stream independence", () => {
    /**
     * This is the property that makes the engine safe to extend. If every
     * subsystem drew from one shared stream, adding a single die roll to the
     * treatment resolver would shift every later map, trait and theft outcome —
     * turning any rule tweak into a silent constitutional change (§23).
     */
    it("gives different purposes independent streams", () => {
      const gather = Rng.derive("seed", "turn", "42", "gather");
      const treat = Rng.derive("seed", "turn", "42", "treatment");
      expect(gather.nextU64()).not.toBe(treat.nextU64());
    });

    it("is unaffected by how many draws another stream has taken", () => {
      const noisy = Rng.derive("seed", "other");
      for (let i = 0; i < 1000; i++) noisy.nextU64();

      const a = Rng.derive("seed", "mapgen");
      const b = Rng.derive("seed", "mapgen");
      expect(a.nextU64()).toBe(b.nextU64());
    });

    it("separates streams by world seed", () => {
      const w1 = Rng.derive("world-1", "mapgen");
      const w2 = Rng.derive("world-2", "mapgen");
      expect(w1.nextU64()).not.toBe(w2.nextU64());
    });
  });

  describe("nextBelow", () => {
    it("stays within bounds", () => {
      const rng = new Rng(99n);
      for (let i = 0; i < 2000; i++) {
        const value = rng.nextBelow(7);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(7);
      }
    });

    it("always returns 0 for a bound of 1", () => {
      const rng = new Rng(5n);
      expect(rng.nextBelow(1)).toBe(0);
    });

    it("rejects non-positive and non-integer bounds", () => {
      const rng = new Rng(5n);
      expect(() => rng.nextBelow(0)).toThrow(RangeError);
      expect(() => rng.nextBelow(-1)).toThrow(RangeError);
      expect(() => rng.nextBelow(1.5)).toThrow(RangeError);
    });

    it("is close to uniform, so probabilistic rules are not silently skewed", () => {
      // Rejection sampling should avoid the low-value bias that `% bound`
      // introduces. A crude chi-square check is enough to catch gross skew.
      const rng = new Rng(2024n);
      const buckets = 10;
      const draws = 100_000;
      const counts = new Array<number>(buckets).fill(0);
      for (let i = 0; i < draws; i++) counts[rng.nextBelow(buckets)]!++;

      const expected = draws / buckets;
      const chiSquare = counts.reduce((sum, c) => sum + (c - expected) ** 2 / expected, 0);
      // 9 degrees of freedom, p=0.001 critical value ≈ 27.9
      expect(chiSquare).toBeLessThan(27.9);
    });
  });

  describe("nextInt", () => {
    it("covers an inclusive range", () => {
      const rng = new Rng(7n);
      const seen = new Set<number>();
      for (let i = 0; i < 500; i++) seen.add(rng.nextInt(3, 6));
      expect([...seen].sort()).toEqual([3, 4, 5, 6]);
    });

    it("handles a single-value range", () => {
      expect(new Rng(1n).nextInt(5, 5)).toBe(5);
    });

    it("rejects an inverted range", () => {
      expect(() => new Rng(1n).nextInt(5, 4)).toThrow(RangeError);
    });
  });

  describe("chance", () => {
    it("treats impossible and certain as absolute, without consuming entropy", () => {
      const rng = new Rng(1n);
      expect(rng.chance(0, 10)).toBe(false);
      expect(rng.chance(10, 10)).toBe(true);
      expect(rng.chance(-5, 10)).toBe(false);
      expect(rng.draws).toBe(0);
    });

    it("approximates the stated integer probability", () => {
      const rng = new Rng(4242n);
      let hits = 0;
      const trials = 50_000;
      for (let i = 0; i < trials; i++) if (rng.chance(1, 4)) hits++;
      expect(hits / trials).toBeGreaterThan(0.24);
      expect(hits / trials).toBeLessThan(0.26);
    });

    it("rejects float probabilities outright", () => {
      const rng = new Rng(1n);
      expect(() => rng.chance(0.5, 1)).toThrow(RangeError);
      expect(() => rng.chance(1, 0)).toThrow(RangeError);
    });
  });

  describe("pick and pickWeighted", () => {
    it("throws rather than returning undefined on an empty array", () => {
      expect(() => new Rng(1n).pick([])).toThrow(RangeError);
    });

    it("never selects a zero-weight option", () => {
      const rng = new Rng(11n);
      for (let i = 0; i < 500; i++) {
        expect(rng.pickWeighted([["never", 0] as const, ["always", 5] as const])).toBe("always");
      }
    });

    it("respects relative weights", () => {
      const rng = new Rng(31n);
      let common = 0;
      for (let i = 0; i < 20_000; i++) {
        if (rng.pickWeighted([["common", 9] as const, ["rare", 1] as const]) === "common") common++;
      }
      expect(common / 20_000).toBeGreaterThan(0.87);
      expect(common / 20_000).toBeLessThan(0.93);
    });

    it("rejects negative or all-zero weights", () => {
      const rng = new Rng(1n);
      expect(() => rng.pickWeighted([["a", -1] as const])).toThrow(RangeError);
      expect(() => rng.pickWeighted([["a", 0] as const])).toThrow(RangeError);
    });
  });

  describe("shuffled", () => {
    it("does not mutate the input", () => {
      const input = Object.freeze([1, 2, 3, 4, 5]);
      expect(() => new Rng(1n).shuffled(input)).not.toThrow();
      expect(input).toEqual([1, 2, 3, 4, 5]);
    });

    it("preserves the multiset of elements", () => {
      const input = [1, 2, 3, 4, 5, 5, 5];
      const out = new Rng(77n).shuffled(input);
      expect([...out].sort()).toEqual([...input].sort());
    });

    it("is reproducible for the same seed", () => {
      const input = [1, 2, 3, 4, 5, 6, 7, 8];
      expect(new Rng(9n).shuffled(input)).toEqual(new Rng(9n).shuffled(input));
    });
  });

  it("counts draws so resolvers can record stream usage", () => {
    const rng = new Rng(1n);
    rng.nextU64();
    rng.nextU32();
    expect(rng.draws).toBe(2);
  });
});
