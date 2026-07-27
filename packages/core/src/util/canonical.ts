/**
 * Canonical JSON encoding.
 *
 * Every hash in this world — event hashes, chain links, state checksums, model
 * request/response digests — is taken over the output of `canonicalJson`. The
 * encoding must therefore be byte-stable across machines, Node versions and
 * time. That requirement drives every rule below.
 *
 * CONSTITUTIONAL (§15 "Replayed history produces an identical state checksum"):
 * changing this encoding changes every hash in the world and ends the canonical
 * experiment. It cannot be modified after Genesis.
 */

/** Thrown when a value cannot be encoded deterministically. */
export class NonCanonicalValueError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "NonCanonicalValueError";
  }
}

/** A value that is safe to encode canonically. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * Encode a value as canonical JSON.
 *
 * Rules, and why each exists:
 *
 * - **Object keys are sorted** by UTF-16 code unit. Property insertion order is
 *   an implementation detail of whatever code built the object; it must not
 *   affect a hash.
 * - **Numbers must be safe integers.** Floating point is banned outright. IEEE
 *   754 accumulation order, `toString` rounding and platform math libraries all
 *   vary in ways that silently break replay. All world quantities are integers
 *   in their smallest unit (see `Quantity` in schema/primitives.ts).
 * - **`undefined` is rejected**, both as a value and as a property. `{a: 1}` and
 *   `{a: 1, b: undefined}` must not be able to disagree about their own hash.
 *   Absence is expressed by omitting the key; use `null` for a present-but-empty
 *   value.
 * - **No cycles, no class instances, no `bigint`, no `Date`.** Anything whose
 *   serialization depends on a runtime is rejected rather than guessed at.
 *
 * The output is minified (no whitespace) and uses `JSON.stringify` for string
 * escaping, which is fully specified by ECMA-262 and therefore stable.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "", new Set());
}

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number": {
      if (!Number.isFinite(value)) {
        throw new NonCanonicalValueError(
          `Non-finite number ${String(value)} cannot be encoded`,
          path,
        );
      }
      if (!Number.isSafeInteger(value)) {
        throw new NonCanonicalValueError(
          `Number ${value} is not a safe integer. All world quantities are ` +
            `integers in their smallest unit; floating point is banned because ` +
            `it is not reproducible across platforms`,
          path,
        );
      }
      // Safe integers stringify identically everywhere. `-0` is normalised to
      // `0` so that it cannot produce two hashes for one value.
      return Object.is(value, -0) ? "0" : String(value);
    }

    case "string":
      return JSON.stringify(value);

    case "bigint":
      throw new NonCanonicalValueError(
        "bigint cannot be encoded; convert to a decimal string explicitly",
        path,
      );

    case "undefined":
      throw new NonCanonicalValueError(
        "undefined cannot be encoded; omit the key or use null",
        path,
      );

    case "function":
    case "symbol":
      throw new NonCanonicalValueError(`${typeof value} cannot be encoded`, path);
  }

  // object
  const obj = value as object;
  if (seen.has(obj)) {
    throw new NonCanonicalValueError("Circular reference cannot be encoded", path);
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item, i) => encode(item, `${path}[${i}]`, seen));
      return `[${parts.join(",")}]`;
    }

    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new NonCanonicalValueError(
        `Only plain objects can be encoded, received ${obj.constructor?.name ?? "unknown"}`,
        path,
      );
    }

    const record = obj as Record<string, unknown>;
    // Own enumerable string keys only, sorted. Symbol keys are ignored by JSON
    // and are not part of world state.
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const child = record[key];
      if (child === undefined) {
        throw new NonCanonicalValueError(
          `Property "${key}" is undefined; omit the key or use null`,
          path,
        );
      }
      parts.push(`${JSON.stringify(key)}:${encode(child, path ? `${path}.${key}` : key, seen)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Assert at runtime that a value round-trips through canonical encoding.
 * Used in tests and at trust boundaries where a value is about to be hashed.
 */
export function assertCanonical(value: unknown): asserts value is CanonicalValue {
  canonicalJson(value);
}
