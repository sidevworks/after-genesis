// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Deterministic pseudo-random number generation.
 *
 * "Controlled probability" appears throughout the world rules — treatment
 * outcomes (§8), unauthorised transfers (§11F), trait generation (§7). All of it
 * must replay identically, so `Math.random` is banned everywhere in this
 * repository and every random draw comes from a seeded stream.
 *
 * Two properties matter:
 *
 * 1. **Exactness.** The generator is SplitMix64 over `bigint`, so arithmetic is
 *    exact and platform-independent. No floating point is produced or consumed;
 *    probabilities are expressed as integer numerator/denominator pairs.
 *
 * 2. **Stream independence.** Streams are *derived*, never shared. A stream is
 *    identified by (world seed, sequence number, purpose), so adding a random
 *    draw to the treatment resolver cannot shift the numbers the map generator
 *    sees. Sharing one global stream would make every rule change a silent
 *    constitutional change.
 *
 * CONSTITUTIONAL: the algorithm and derivation scheme are fixed at Genesis.
 */
import { HashDomain, hashValue } from "./hash.js";

const MASK64 = 0xffffffffffffffffn;
const GOLDEN_GAMMA = 0x9e3779b97f4a7c15n;

/** A deterministic, independently-derived random stream. */
export class Rng {
  #state: bigint;
  /** Number of draws taken. Exposed so resolvers can record stream usage. */
  #draws = 0;

  constructor(seed: bigint) {
    this.#state = BigInt.asUintN(64, seed);
  }

  /**
   * Derive an independent stream from a world seed and a purpose path.
   *
   * The purpose path should be specific enough that no two logically distinct
   * draws share it, e.g.
   * `Rng.derive(worldSeed, "turn", String(seq), "treatment", patientId)`.
   */
  static derive(worldSeed: string, ...purpose: readonly string[]): Rng {
    const digest = hashValue(HashDomain.Rng, { seed: worldSeed, purpose });
    return new Rng(BigInt(`0x${digest.slice(0, 16)}`));
  }

  /** Draws taken so far from this stream. */
  get draws(): number {
    return this.#draws;
  }

  /** Next raw 64-bit value. */
  nextU64(): bigint {
    this.#draws++;
    this.#state = (this.#state + GOLDEN_GAMMA) & MASK64;
    let z = this.#state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  }

  /** Next 32-bit value as a safe integer. */
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /**
   * Uniform integer in `[0, bound)`.
   *
   * Uses rejection sampling rather than modulo. Plain `x % bound` biases towards
   * low values whenever `bound` does not divide 2^64, which would quietly skew
   * every probabilistic rule in the world.
   */
  nextBelow(bound: number): number {
    if (!Number.isSafeInteger(bound) || bound <= 0) {
      throw new RangeError(`bound must be a positive safe integer, received ${bound}`);
    }
    const b = BigInt(bound);
    // Largest multiple of b that fits in 64 bits; values at or above it are
    // rejected so the accepted range is an exact multiple of b.
    const limit = (MASK64 / b) * b;
    let x = this.nextU64();
    while (x >= limit) x = this.nextU64();
    return Number(x % b);
  }

  /** Uniform integer in `[minInclusive, maxInclusive]`. */
  nextInt(minInclusive: number, maxInclusive: number): number {
    if (maxInclusive < minInclusive) {
      throw new RangeError(`empty range [${minInclusive}, ${maxInclusive}]`);
    }
    return minInclusive + this.nextBelow(maxInclusive - minInclusive + 1);
  }

  /**
   * True with probability `numerator / denominator`.
   * Integer-only: there is no float probability anywhere in the engine.
   */
  chance(numerator: number, denominator: number): boolean {
    if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
      throw new RangeError("chance() requires integer numerator and denominator");
    }
    if (denominator <= 0) throw new RangeError("denominator must be positive");
    if (numerator <= 0) return false;
    if (numerator >= denominator) return true;
    return this.nextBelow(denominator) < numerator;
  }

  /** Uniformly pick one element. Throws on an empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("cannot pick from an empty array");
    return items[this.nextBelow(items.length)]!;
  }

  /**
   * Pick one element by integer weight. Weights must be non-negative integers
   * and must not all be zero.
   */
  pickWeighted<T>(items: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, weight] of items) {
      if (!Number.isSafeInteger(weight) || weight < 0) {
        throw new RangeError("weights must be non-negative integers");
      }
      total += weight;
    }
    if (total <= 0) throw new RangeError("total weight must be positive");
    let roll = this.nextBelow(total);
    for (const [item, weight] of items) {
      roll -= weight;
      if (roll < 0) return item;
    }
    /* c8 ignore next */
    throw new Error("unreachable: weighted pick fell through");
  }

  /** A shuffled copy (Fisher-Yates). The input is not mutated. */
  shuffled<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.nextBelow(i + 1);
      const a = out[i]!;
      out[i] = out[j]!;
      out[j] = a;
    }
    return out;
  }
}
