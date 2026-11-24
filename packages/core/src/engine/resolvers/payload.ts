// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Untrusted payload readers (§2).
 *
 * "Every model response must be treated as untrusted input." These helpers are
 * the resolvers' only way to look at a payload. They never coerce, never
 * default silently past a wrong type, and never widen a number into a float.
 *
 * They are intentionally hand-written rather than delegating to the action
 * payload schemas in `schema/actions/`. A resolver's precondition check is the
 * last line of defence and must not depend on a schema module staying in sync
 * with it — if the two ever disagree, the stricter one should win, and this one
 * is the stricter one.
 */

/** A payload we can index into, or `null` if it is not a plain object. */
export function asObject(payload: unknown): Readonly<Record<string, unknown>> | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return payload as Readonly<Record<string, unknown>>;
}

/**
 * Read a required safe integer. Floats, strings and `NaN` are all rejected —
 * there is no float anywhere in the world, so `3.0` and `"3"` are not `3`.
 */
export function readInt(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value;
}

/** Read an optional safe integer. Returns `fallback` when absent, `null` when malformed. */
export function readOptionalInt(
  payload: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number | null {
  if (!(key in payload) || payload[key] === null) return fallback;
  return readInt(payload, key);
}

export function readString(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

export function readOptionalString(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | null | undefined {
  if (!(key in payload) || payload[key] === null) return undefined;
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

/** Read a `{x, y}` coordinate. Non-integer or negative components are rejected. */
export function readCoord(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): { readonly x: number; readonly y: number } | null {
  const nested = asObject(payload[key]);
  if (nested === null) return null;
  const x = readInt(nested, "x");
  const y = readInt(nested, "y");
  if (x === null || y === null) return null;
  if (x < 0 || y < 0) return null;
  return { x, y };
}

/** Read a value constrained to a fixed set of literals. */
export function readEnum<T extends string>(
  payload: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly T[],
): T | null {
  const value = payload[key];
  if (typeof value !== "string") return null;
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}
