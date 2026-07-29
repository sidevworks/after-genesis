/**
 * The published record of every styled narration line (§16, §12).
 *
 * ## Why styled lines are stored, not regenerated
 *
 * A hosted model is not reproducible, even at temperature 0. If the renderer
 * called Gemini afresh on every build, the same canonical caption could be
 * spoken differently each time, and there would be no way for a reader to check
 * what any given line was derived from.
 *
 * So each accepted line is written here once, keyed by everything that
 * determines it, alongside the canonical caption it came from and the hashes of
 * the exact request and raw response. That makes the dramatisation auditable in
 * the same way §16 requires canonical events to be: anyone can see the record
 * line, the spoken line, and which model turned one into the other.
 *
 * It also means a rebuild costs nothing, and that raising
 * `NARRATION_STYLE_VERSION` deliberately invalidates every line at once.
 */

import { sha256Hex } from "@after-genesis/core";
import { NARRATION_STYLE_VERSION, type StyledNarration } from "./narration-style.js";

export const NARRATION_CACHE_VERSION = 1;

export interface NarrationEntry {
  /** The chronicle caption. The canonical fact, unchanged. */
  readonly canonical: string;
  /** The line actually spoken. Equal to `canonical` when styling was refused. */
  readonly spoken: string;
  readonly styled: boolean;
  readonly modelId: string | null;
  readonly requestHash: string | null;
  readonly responseHash: string | null;
  /** Why styling was refused or retried. Published rather than swallowed. */
  readonly rejections: readonly string[];
}

export interface NarrationCache {
  readonly version: number;
  readonly styleVersion: number;
  readonly entries: Readonly<Record<string, NarrationEntry>>;
}

export const EMPTY_NARRATION_CACHE: NarrationCache = Object.freeze({
  version: NARRATION_CACHE_VERSION,
  styleVersion: NARRATION_STYLE_VERSION,
  entries: Object.freeze({}),
});

/**
 * The cache key for a caption.
 *
 * Covers every input that changes the result: the caption, the action type,
 * the names the model was allowed to use, the model, and the rule/prompt
 * version. Change any one and the line is regenerated rather than silently
 * reused under different rules.
 */
export function narrationKey(input: {
  readonly canonical: string;
  readonly actionType: string;
  readonly allowedNames: readonly string[];
  readonly modelId: string;
}): string {
  return sha256Hex(
    [
      NARRATION_STYLE_VERSION,
      input.modelId,
      input.actionType,
      [...input.allowedNames].sort().join("|"),
      input.canonical,
    ].join("\0"),
  );
}

/** A parsed cache is usable only if it was written under the current rules. */
export function isCurrentCache(value: unknown): value is NarrationCache {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<NarrationCache>;
  return (
    candidate.version === NARRATION_CACHE_VERSION &&
    candidate.styleVersion === NARRATION_STYLE_VERSION &&
    typeof candidate.entries === "object" &&
    candidate.entries !== null
  );
}

export function toEntry(styled: StyledNarration): NarrationEntry {
  return {
    canonical: styled.canonical,
    spoken: styled.text,
    styled: styled.styled,
    modelId: styled.modelId,
    requestHash: styled.requestHash,
    responseHash: styled.responseHash,
    rejections: styled.rejections,
  };
}
