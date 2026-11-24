// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Response validation (§14.8–§14.11).
 *
 * The single rule this file exists to enforce: **tolerate formatting noise,
 * never repair semantics.**
 *
 * Those two look similar and are not. Stripping a markdown fence the model
 * wrapped its JSON in changes nothing about what the model decided — the fence
 * is transport, not content. Guessing that `"tpye": "mvoe"` meant `move`, or
 * filling in a missing `payload`, is the engine deciding what the inhabitant
 * did. §2 reserves that to the model proposing and the engine resolving; a
 * parser that splits the difference has quietly become a third author of world
 * history, and an unauditable one.
 *
 * So the tolerances here are strictly syntactic: fences, leading prose, trailing
 * commentary, a UTF-8 BOM. Everything semantic — an unknown action type, an
 * extra key, a payload that is not an object — is invalid, and invalid means
 * one format-correction retry (§14.10) and then a no-op (§14.11). Never an
 * exception, never a retry loop.
 *
 * The raw text is hashed *before* any of this runs. If parsing threw, or if a
 * future change to this file altered what "the response" means, the recorded
 * hash would still be the hash of exactly what the provider returned (§14.8).
 */
import { HashDomain, hashValue } from "@after-genesis/core";
import type { Sha256Hex } from "@after-genesis/core";
import { canonicalJson } from "@after-genesis/core";
import {
  ACTION_TYPES,
  ProposedActionSchema,
  type ProposedAction,
} from "@after-genesis/core/schema/action-spec";

/**
 * Hard ceiling on a response, in characters.
 *
 * Checked before anything else touches the string. A hostile or broken provider
 * returning ten megabytes must cost one length comparison, not a regex scan and
 * a JSON parse. 64 KiB is roughly eighty times the largest legitimate action.
 */
export const MAX_RESPONSE_CHARS = 65_536;

/** Ceiling on the canonical encoding of a payload. Bounds what reaches the engine. */
export const MAX_PAYLOAD_CHARS = 8_192;

/** Maximum nesting depth in a payload. Bounds recursion in every downstream consumer. */
export const MAX_PAYLOAD_DEPTH = 8;

/** Why a response was rejected. Recorded on the no-op event so failures are analysable. */
export type ParseFailureCode =
  | "oversized_response"
  | "empty_response"
  | "no_json_found"
  | "malformed_json"
  | "not_an_object"
  | "unknown_action_type"
  | "unexpected_fields"
  | "invalid_shape"
  | "payload_not_object"
  | "oversized_payload"
  | "payload_too_deep"
  | "non_canonical_payload";

export interface ParseSuccess {
  readonly ok: true;
  readonly action: ProposedAction;
  /** Canonical encoding of the accepted action. What the engine will see. */
  readonly canonical: string;
}

export interface ParseFailure {
  readonly ok: false;
  readonly code: ParseFailureCode;
  /**
   * A short, safe description. Built from our own vocabulary and bounded
   * excerpts — never a raw echo of the model's output, since this string is fed
   * back into the correction prompt and would otherwise be an injection path
   * straight into the prompt body.
   */
  readonly reason: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

/**
 * Hash the raw response text.
 *
 * Called before parsing, always. The hash covers the untouched text: no
 * trimming, no fence removal, no normalisation. Whatever the provider sent is
 * what the audit chain commits to (§14.8, §16).
 */
export function hashRawResponse(rawText: string): Sha256Hex {
  return hashValue(HashDomain.ModelResponse, rawText);
}

/**
 * The strict shape. `.strict()` is the load-bearing part: it rejects extra keys
 * outright rather than stripping them.
 *
 * Stripping would be worse than it sounds. A model that returns
 * `{"type":"wait","payload":{},"grant_capability":"admin"}` has proposed
 * something outside the vocabulary. Silently dropping the extra key records a
 * clean `wait` in the audit log and erases the evidence that the model tried.
 * Rejecting keeps the attempt visible in the raw response, which is stored.
 */
const StrictProposedActionSchema = ProposedActionSchema.strict();

/**
 * Remove transport-layer noise: a byte-order mark and a markdown code fence.
 *
 * Both are packaging applied by the provider or by the model's habits. Neither
 * carries any information about what the inhabitant decided, which is what makes
 * removing them safe under this file's one rule.
 */
export function stripTransportNoise(rawText: string): string {
  let text = rawText;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const fenced = /```(?:[a-zA-Z0-9_-]{0,20})?\s*\n?([\s\S]*?)```/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1];
  return text;
}

/**
 * Extract the JSON object from a response that may carry formatting noise.
 *
 * Handles, in order: BOM, markdown fences (with or without a language tag), and
 * prose before or after the object. The object itself is located by scanning for
 * balanced braces while tracking string state, so a `}` inside a string value
 * does not terminate the scan early.
 *
 * Returns null rather than throwing: "no JSON here" is an ordinary outcome.
 */
export function extractJsonObject(rawText: string): string | null {
  const text = stripTransportNoise(rawText);
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === undefined) break;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  // Unbalanced: the response was truncated mid-object. Not repairable — closing
  // the braces ourselves would be inventing the tail of a decision.
  return null;
}

/** Depth of a parsed JSON value. Iterative, so a deep payload cannot blow the stack. */
function measureDepth(value: unknown, limit: number): number {
  let maxDepth = 0;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];

  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    if (entry.depth > maxDepth) maxDepth = entry.depth;
    // Stop as soon as the limit is exceeded; a hostile payload should not cost
    // a full traversal to reject.
    if (maxDepth > limit) return maxDepth;

    const node = entry.node;
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: entry.depth + 1 });
    } else if (node !== null && typeof node === "object") {
      for (const child of Object.values(node as Record<string, unknown>)) {
        stack.push({ node: child, depth: entry.depth + 1 });
      }
    }
  }
  return maxDepth;
}

const ACTION_TYPE_SET: ReadonlySet<string> = new Set<string>(ACTION_TYPES);

/**
 * Parse and validate one raw model response.
 *
 * Never throws. Every failure path returns a `ParseFailure` with a code, because
 * §14.11 requires an invalid response to become a no-op rather than an
 * exception — an exception would abort the turn, and an aborted turn is a
 * different state transition from a no-op turn.
 */
export function parseModelResponse(rawText: string): ParseResult {
  if (rawText.length > MAX_RESPONSE_CHARS) {
    return {
      ok: false,
      code: "oversized_response",
      reason: `Response was ${rawText.length} characters; the limit is ${MAX_RESPONSE_CHARS}.`,
    };
  }
  if (rawText.trim().length === 0) {
    return { ok: false, code: "empty_response", reason: "Response was empty." };
  }

  // A response that is a JSON *array* is rejected outright rather than having
  // its first element extracted. A list is a model proposing several actions,
  // and choosing one of them would be this parser deciding what the inhabitant
  // did — precisely the semantic repair §2 reserves to nobody. Prose before an
  // object is noise; a list of objects is a different answer to the question.
  const stripped = stripTransportNoise(rawText).trimStart();
  if (stripped.startsWith("[")) {
    return {
      ok: false,
      code: "not_an_object",
      reason:
        "The response was a JSON array. Propose exactly one action as a single JSON object.",
    };
  }

  const json = extractJsonObject(rawText);
  if (json === null) {
    return {
      ok: false,
      code: "no_json_found",
      reason: "No complete JSON object was found. The object may have been truncated.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      ok: false,
      code: "malformed_json",
      reason: "The extracted text was not valid JSON.",
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      code: "not_an_object",
      reason: "The response must be a JSON object.",
    };
  }

  const record = parsed as Record<string, unknown>;

  // Checked before Zod so the failure code distinguishes "invented an action"
  // from "got the shape wrong". The two mean different things when analysing a
  // world's no-op rate, and collapsing them would hide a model drifting out of
  // vocabulary.
  const typeValue = record["type"];
  if (typeof typeValue !== "string" || !ACTION_TYPE_SET.has(typeValue)) {
    return {
      ok: false,
      code: "unknown_action_type",
      reason: "The `type` field was missing or not one of the available action types.",
    };
  }

  const extraKeys = Object.keys(record).filter(
    (key) =>
      key !== "type" && key !== "payload" && key !== "rationale" && key !== "intention",
  );
  if (extraKeys.length > 0) {
    // The key *names* are echoed because they are useful for correction and are
    // bounded; the values never are.
    const shown = extraKeys
      .slice(0, 5)
      .map((key) => JSON.stringify(key.slice(0, 40)))
      .join(", ");
    return {
      ok: false,
      code: "unexpected_fields",
      reason: `The object contained ${extraKeys.length} unexpected field(s): ${shown}. Only type, payload, rationale and intention are allowed.`,
    };
  }

  const payload = record["payload"];
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      code: "payload_not_object",
      reason: "`payload` must be a JSON object. Use {} for an action with no arguments.",
    };
  }

  const depth = measureDepth(payload, MAX_PAYLOAD_DEPTH);
  if (depth > MAX_PAYLOAD_DEPTH) {
    return {
      ok: false,
      code: "payload_too_deep",
      reason: `The payload nests more than ${MAX_PAYLOAD_DEPTH} levels deep.`,
    };
  }

  const result = StrictProposedActionSchema.safeParse(record);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first === undefined ? "" : first.path.join(".");
    return {
      ok: false,
      code: "invalid_shape",
      reason: `The action did not match the required shape${path === "" ? "" : ` at "${path}"`}.`,
    };
  }

  // Canonical encoding is the last gate. It rejects non-integer numbers, which
  // are banned world-wide for determinism, and it produces the exact bytes the
  // engine and the event hash will see. Doing it here means a payload that
  // cannot be hashed never reaches a resolver.
  let canonical: string;
  try {
    canonical = canonicalJson({ type: result.data.type, payload: result.data.payload });
  } catch {
    return {
      ok: false,
      code: "non_canonical_payload",
      reason:
        "The payload contained a value that cannot be encoded deterministically " +
        "(a fractional number, for example). All world quantities are whole numbers.",
    };
  }

  if (canonical.length > MAX_PAYLOAD_CHARS) {
    return {
      ok: false,
      code: "oversized_payload",
      reason: `The encoded payload was ${canonical.length} characters; the limit is ${MAX_PAYLOAD_CHARS}.`,
    };
  }

  return { ok: true, action: result.data, canonical };
}
