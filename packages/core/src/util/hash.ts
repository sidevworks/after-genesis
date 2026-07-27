/**
 * Hashing primitives for the canonical event chain and state checksums.
 *
 * CONSTITUTIONAL. The hash function and the domain-separation strings below are
 * part of the world's identity. Changing either invalidates every recorded
 * event hash and ends the canonical experiment (§23).
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";

/** Lowercase hex-encoded SHA-256 digest. */
export type Sha256Hex = string & { readonly __brand: "Sha256Hex" };

/**
 * Domain separation tags.
 *
 * Every hash is prefixed with a tag naming what is being hashed. Without this,
 * a value hashed as an event could collide with the same bytes hashed as a
 * state checksum, and a crafted payload in one position could be replayed in
 * another. The tags are fixed forever.
 */
export const HashDomain = {
  Event: "after-genesis/v1/event",
  StateChecksum: "after-genesis/v1/state-checksum",
  ModelRequest: "after-genesis/v1/model-request",
  ModelResponse: "after-genesis/v1/model-response",
  Rng: "after-genesis/v1/rng",
  GenesisConfig: "after-genesis/v1/genesis-config",
} as const;

export type HashDomainTag = (typeof HashDomain)[keyof typeof HashDomain];

/** The chain terminator: the `prevHash` of the very first event in a world. */
export const GENESIS_PREV_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000" as Sha256Hex;

/** SHA-256 of a UTF-8 string, hex encoded. */
export function sha256Hex(input: string): Sha256Hex {
  return createHash("sha256").update(input, "utf8").digest("hex") as Sha256Hex;
}

/**
 * Hash a structured value within a domain.
 *
 * The preimage is `${domain}\n${canonicalJson(value)}`. The newline cannot
 * appear in a domain tag, so the domain and payload are unambiguously
 * separated.
 */
export function hashValue(domain: HashDomainTag, value: unknown): Sha256Hex {
  return sha256Hex(`${domain}\n${canonicalJson(value)}`);
}

/** Constant-time-ish equality for hex digests. Avoids leaking position on mismatch. */
export function hashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** True if a string is a well-formed lowercase SHA-256 hex digest. */
export function isSha256Hex(value: string): value is Sha256Hex {
  return /^[0-9a-f]{64}$/.test(value);
}
