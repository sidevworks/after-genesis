/**
 * A stable, key-sorted JSON encoder for *non-canonical* payloads.
 *
 * IMPORTANT: this is NOT `canonicalJson` and must never be used for anything
 * inside the event hash chain. `canonicalJson` forbids floating point, because a
 * float that round-trips differently on another platform would silently break
 * replay. That restriction is correct for world state and wrong for audit
 * records: a model request legitimately carries `temperature: 0.7`, and refusing
 * to store it would mean refusing to keep the evidence.
 *
 * So audit records get this encoder instead — deterministic enough to detect
 * "someone tried to record a different response for this sequence", and honest
 * about the fact that it lives outside the constitutional hashing rules.
 */

/** Deterministic JSON: object keys sorted, `undefined` properties dropped. */
export function stableStringify(value: unknown): string {
  const encoded = JSON.stringify(sortDeep(value));
  return encoded === undefined ? "null" : encoded;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child === undefined) continue;
      out[key] = sortDeep(child);
    }
    return out;
  }
  return value;
}
