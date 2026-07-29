/**
 * Dramatised narration (§21, §12, §11G).
 *
 * ## What this is allowed to be
 *
 * §21 names three kinds of generated audio and requires them to stay clearly
 * distinguishable: "Verbatim canonical dialogue", "Condensed summaries",
 * "Dramatised narration". This module produces the third. A canonical caption
 * reads
 *
 *     Gathered 6 food at (14, 17) over 30 minutes.
 *
 * which is precise, auditable and unpleasant to listen to. Spoken, it becomes
 *
 *     Aleth spent the morning gathering food.
 *
 * The coordinates and counts are not lost — they remain on the canonical
 * caption, which stays on the record, stays in the manifest and stays on
 * screen. Only the *spoken* line changes.
 *
 * ## What this must never be
 *
 * §11G: the canonical log describes events neutrally; interpretation belongs to
 * inhabitants, not to the renderer. §26: "Do not create fake behaviours merely
 * to make the world entertaining... Do not script drama."
 *
 * The failure mode is not a bad sentence, it is a plausible one. A model asked
 * to make a caption engaging will reach for motive — *hoping to feed her
 * family*, *determined to finish before dark* — and that is a claim about an
 * inhabitant's interior life that no one recorded. Once spoken over the
 * footage it is indistinguishable from something the world actually contains.
 *
 * So the prompt asks for restraint and `validateNarration` enforces it. The
 * validator is the safeguard; the prompt is only an optimisation that makes the
 * validator pass more often. A line that fails twice falls back to the
 * canonical caption, which is always safe to say because it is what happened.
 */

import { sha256Hex } from "@after-genesis/core";
import type { ModelRequest, ModelResponse } from "@after-genesis/core";

/** Bump when the prompt or the rules change: it invalidates every cached line. */
export const NARRATION_STYLE_VERSION = 2;

/** Spoken lines are short. A narrator paragraph over a four-second shot is wrong. */
const MAX_CHARS = 180;
const MAX_SENTENCES = 2;

/**
 * Words that assert an inhabitant's interior state or a reason for acting.
 *
 * A blunt instrument, deliberately. It cannot catch every way to imply motive,
 * and it is not the only defence — the no-new-proper-nouns and no-digits rules
 * do more work. What it does catch is the specific register a model reaches for
 * when asked to make something "more of a story", which is the actual risk.
 */
const INTERIORITY = [
  "hop", "want", "wish", "dream", "fear", "hope", "eager", "reluctant",
  "determin", "proud", "asham", "angry", "sad", "happy", "lonely", "desperat",
  "anxious", "content", "weary", "excit", "worri", "love", "hate", "believ",
  "decid", "intend", "plan", "know", "think", "feel", "need", "must",
  "because", "so that", "in order", "hoping", "trying", "seeking",
];

/**
 * Verb stems that keep a line about the action the record names.
 *
 * Prevents the quiet substitution of one activity for another — a rewrite of a
 * `gather` that says the inhabitant "worked on the new hall" is a false
 * statement about the world even though it contains no motive and no numbers.
 *
 * An action type absent from this table is never styled: the renderer speaks
 * its canonical caption instead. Adding a new action to the world therefore
 * degrades to the safe behaviour rather than to an unchecked one.
 */
const ACTION_VERBS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  gather: ["gather", "collect", "forag", "harvest", "cut", "draw", "fetch", "pick"],
  move: ["mov", "walk", "travel", "cross", "head", "went", "go", "set out", "journey", "left"],
  build: ["build", "built", "rais", "construct", "work"],
  craft: ["craft", "made", "make", "shap", "work", "fashion"],
  rest: ["rest", "sleep", "slept", "lay", "settl"],
  consume: ["eat", "ate", "drink", "drank", "consum", "meal"],
  study: ["stud", "learn", "read", "practis", "practic"],
  teach: ["teach", "taught", "show", "instruct"],
  observe: ["watch", "look", "observ", "survey"],
  communicate: ["communicat", "spoke", "speak", "talk", "convers", "met", "meet", "exchang"],
  announce: ["announc", "declar", "address", "spoke"],
  perform: ["perform", "play", "sang", "sing", "recit"],
  transfer: ["transfer", "gave", "give", "hand", "pass", "deliver", "carr"],
});

export interface NarrationContext {
  /** The neutral caption from the chronicle. Always safe to speak. */
  readonly canonical: string;
  readonly actionType: string;
  /** Display names the line may use. Any other proper noun is invented. */
  readonly allowedNames: readonly string[];
  /**
   * Part of the world day the activity began in — "morning", "afternoon",
   * "evening", "night".
   *
   * Canonical, not decoration: it is the segment's start time expressed in
   * words instead of a clock reading. Supplying it is what lets a line say
   * "spent the morning gathering" rather than "gathers". Without material like
   * this the model has nothing to write with and returns telegram prose.
   */
  readonly dayPart?: string;
  /**
   * The activity's recorded duration in words — "briefly", "for a few hours",
   * "for most of the day". A coarsening of a canonical number, in the same way
   * the caption itself is a rendering of canonical fields.
   */
  readonly span?: string;
}

function firstAllowedName(context: NarrationContext): string | null {
  return context.allowedNames[0]?.trim() || null;
}

function subjectOf(context: NarrationContext): string {
  return firstAllowedName(context) ?? "Someone";
}

function resourceOf(canonical: string): string | null {
  const match = canonical.match(
    /\b(?:gathered|consumed)\s+\d+\s+([a-z_ -]+?)(?:\s+(?:at|from|over|for)\b|[.])/i,
  );
  const value = match?.[1]?.trim().toLowerCase().replace(/[^\p{L}_ -]/gu, "") ?? "";
  return value.length === 0 ? null : value;
}

/**
 * A provider-free spoken line that removes the audit-only numbers from a
 * canonical caption without adding facts.
 *
 * This is deliberately plainer than the model-styled line. Its job is to keep
 * a public documentary reel listenable when the model is unavailable or its
 * reply is rejected, while leaving the exact canonical caption beside it in
 * the manifest and UI.
 */
export function documentaryFallback(context: NarrationContext): string {
  const subject = subjectOf(context);
  const dayPart = context.dayPart === undefined ? "" : ` through the ${context.dayPart}`;
  const span = context.span === undefined ? "" : ` ${context.span}`;
  const resource = resourceOf(context.canonical);

  switch (context.actionType) {
    case "gather":
      return `${subject} gathers${resource === null ? "" : ` ${resource}`}${dayPart}.`;
    case "move":
      return `${subject} moves across the settlement${dayPart}.`;
    case "build":
      return `${subject} builds${span}.`;
    case "craft":
      return `${subject} crafts${span}.`;
    case "rest":
      return `${subject} rests${dayPart}.`;
    case "consume":
      return `${subject} ${resource === "water" ? "drinks" : "eats"}${dayPart}.`;
    case "study":
      return `${subject} studies${span}.`;
    case "teach":
      return `${subject} teaches${span}.`;
    case "observe":
      return `${subject} observes${dayPart}.`;
    case "communicate":
      return `${subject} speaks with others${dayPart}.`;
    case "announce":
      return `${subject} addresses the settlement${dayPart}.`;
    case "perform":
      return `${subject} performs${dayPart}.`;
    case "transfer":
      return `${subject} transfers supplies${dayPart}.`;
    default:
      return `${subject} continues the recorded activity${dayPart}.`;
  }
}

function safeFallback(context: NarrationContext): string {
  const candidate = documentaryFallback(context);
  return validateNarration(candidate, context).ok ? candidate : context.canonical;
}

/** The canonical start time of a segment, in words. */
export function dayPartOf(minuteOfDay: number): string {
  const minute = ((Math.floor(minuteOfDay) % 1440) + 1440) % 1440;
  if (minute < 300) return "night";
  if (minute < 720) return "morning";
  if (minute < 1020) return "afternoon";
  if (minute < 1290) return "evening";
  return "night";
}

/** The canonical duration of a segment, in words. */
export function spanOf(minutes: number): string {
  if (minutes < 60) return "briefly";
  if (minutes < 180) return "for an hour or two";
  if (minutes < 420) return "for a few hours";
  return "for most of the day";
}

export type NarrationRejection =
  | "empty"
  | "too_long"
  | "too_many_sentences"
  | "contains_numbers"
  | "invented_name"
  | "asserts_motive"
  | "wrong_action"
  | "contains_quotation";

export interface NarrationCheck {
  readonly ok: boolean;
  readonly reason: NarrationRejection | null;
  readonly detail: string;
}

const ok: NarrationCheck = { ok: true, reason: null, detail: "" };
const bad = (reason: NarrationRejection, detail: string): NarrationCheck => ({
  ok: false,
  reason,
  detail,
});

/** Words that may begin a sentence in capitals without being a name. */
function isSentenceInitial(words: readonly string[], index: number): boolean {
  if (index === 0) return true;
  const previous = words[index - 1] ?? "";
  return /[.!?]$/.test(previous);
}

/**
 * Whether a styled line may be spoken.
 *
 * Every rule rejects a specific way the line could assert something the record
 * does not contain. Nothing here is about style.
 */
export function validateNarration(styled: string, context: NarrationContext): NarrationCheck {
  const text = styled.trim();

  if (text.length === 0) return bad("empty", "the model returned nothing");
  if (text.length > MAX_CHARS) {
    return bad("too_long", `${text.length} characters, limit ${MAX_CHARS}`);
  }

  // Quotation marks would present the line as something an inhabitant said.
  // Speech is only ever rendered from disclosed canonical dialogue.
  if (/["“”']/.test(text.replace(/'(s|t|re|ve|ll|d)\b/g, ""))) {
    return bad("contains_quotation", "a styled narration line may not quote anyone");
  }

  const sentences = text.split(/[.!?]+/).filter((part) => part.trim().length > 0);
  if (sentences.length > MAX_SENTENCES) {
    return bad("too_many_sentences", `${sentences.length} sentences, limit ${MAX_SENTENCES}`);
  }

  // The whole point of the rewrite: no coordinates, counts or durations.
  if (/\d/.test(text)) {
    return bad("contains_numbers", "styled narration must not contain figures");
  }

  const lower = text.toLowerCase();
  for (const marker of INTERIORITY) {
    if (lower.includes(marker)) {
      return bad("asserts_motive", `contains "${marker}", which asserts motive or interior state`);
    }
  }

  const allowed = new Set(context.allowedNames.map((name) => name.toLowerCase()));
  const words = text.split(/\s+/);
  for (const [index, word] of words.entries()) {
    const bare = word.replace(/[^\p{L}'-]/gu, "");
    if (bare.length === 0) continue;
    if (!/^\p{Lu}/u.test(bare)) continue;
    if (isSentenceInitial(words, index)) continue;
    if (allowed.has(bare.toLowerCase())) continue;
    if (allowed.has(bare.replace(/'s$/i, "").toLowerCase())) continue;
    return bad("invented_name", `"${bare}" is a name or place the record does not contain`);
  }

  const stems = ACTION_VERBS[context.actionType];
  if (stems !== undefined && !stems.some((stem) => lower.includes(stem))) {
    return bad("wrong_action", `nothing in the line describes a ${context.actionType}`);
  }

  return ok;
}

/** Whether an action type may be styled at all. Unknown actions are not. */
export function isStyleable(actionType: string): boolean {
  return actionType in ACTION_VERBS;
}

const SYSTEM_PROMPT = `You are the narrator of an observational documentary about a settlement. You turn one line of a technical activity log into one natural sentence a narrator would say over the footage.

Write the way a wildlife or fly-on-the-wall documentary narrator writes: warm, plain, unhurried, present or past tense. Use the time of day and the duration you are given to give the sentence shape.

Absolute rules. A sentence breaking any of them is discarded:
- Say only what the given facts say. Add no cause, no purpose, no feeling, no thought, no plan, no relationship and no consequence.
- Never say why anyone did something, or how they felt. Never use words like hoping, wanting, deciding, needing, trying, because, so that.
- No digits, no coordinates, no counts, no clock times.
- Use only the names you are given. Invent no person, place, building, tool or object name.
- No quotation marks. Nobody speaks.
- One sentence, two at most. Under 180 characters.
- Keep the activity the log names. Do not substitute a different one.

Good, from "Gathered 6 food at (14, 17) over 30 minutes", morning, briefly:
  Aleth is out gathering food this morning.
Good, from "Canonical build recorded at (15, 18) over 415 minutes", morning, for most of the day:
  Aleth spends most of the day building.`;

/** The exact request for a caption. Deterministic, so it can be hashed and cached. */
export function buildNarrationRequest(
  context: NarrationContext,
  modelId: string,
): ModelRequest {
  const names =
    context.allowedNames.length > 0 ? context.allowedNames.join(", ") : "(no names available)";

  return {
    modelId,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt:
      `Names you may use: ${names}\n` +
      `Activity: ${context.actionType}\n` +
      `Time of day: ${context.dayPart ?? "unknown"}\n` +
      `How long: ${context.span ?? "unknown"}\n` +
      `Log line: ${context.canonical}\n\n` +
      `Reply with {"line": "<the narrator's sentence>"}.`,
    responseSchema: NARRATION_RESPONSE_SCHEMA,
    maxOutputTokens: 96,
    // 0 for the least embellishment available. Hosted models are not
    // bit-reproducible even at 0, which is why every accepted line is cached
    // and published rather than regenerated (§16).
    temperature: 0,
  };
}

export interface StyledNarration {
  /** The line to speak. The canonical caption when styling was refused. */
  readonly text: string;
  readonly canonical: string;
  readonly styled: boolean;
  readonly modelId: string | null;
  /** Hashes of the exact request and raw response, for audit (§16). */
  readonly requestHash: string | null;
  readonly responseHash: string | null;
  /** Why styling was refused, if it was. */
  readonly rejections: readonly string[];
}

/** The caption, unstyled — the always-safe result. */
export function unstyled(canonical: string, rejections: readonly string[] = []): StyledNarration {
  return {
    text: canonical,
    canonical,
    styled: false,
    modelId: null,
    requestHash: null,
    responseHash: null,
    rejections,
  };
}

function fallbackNarration(
  context: NarrationContext,
  rejections: readonly string[],
): StyledNarration {
  return {
    text: safeFallback(context),
    canonical: context.canonical,
    styled: false,
    modelId: null,
    requestHash: null,
    responseHash: null,
    rejections,
  };
}

/**
 * The schema the reply must satisfy.
 *
 * The Gemini binding requests `application/json` unconditionally — it was
 * built for the action-proposal path, where the reply is always structured.
 * Rather than fight that and scrape prose out of a JSON string, the request
 * names the shape it wants. `extractLine` still tolerates the alternatives,
 * because §2 treats every model reply as untrusted input regardless of what
 * the provider promised.
 */
export const NARRATION_RESPONSE_SCHEMA = {
  type: "object",
  properties: { line: { type: "string" } },
  required: ["line"],
} as const;

/**
 * The sentence inside a reply, whatever wrapping it arrived in.
 *
 * Observed shapes from one provider in one afternoon: a bare sentence, a
 * JSON string, a JSON array of one string, an object under `line`, and a
 * fenced code block. All are handled; anything else falls through to the raw
 * text and is judged by the validator like any other candidate.
 */
export function extractLine(raw: string): string {
  const trimmed = raw.trim().replace(/^```[a-z]*\n?|\n?```$/g, "").trim();

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") return clean(parsed);
    if (Array.isArray(parsed) && typeof parsed[0] === "string") return clean(parsed[0]);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["line", "text", "narration", "spoken"]) {
        const value = record[key];
        if (typeof value === "string") return clean(value);
      }
    }
  } catch {
    // Not JSON. Prose is the other expected shape.
  }
  return clean(trimmed);
}

function clean(value: string): string {
  return value
    .trim()
    .replace(/^(spoken line|narration|line)\s*:\s*/i, "")
    .replace(/^["“](.*)["”]$/s, "$1")
    .trim();
}

export interface StyleDeps {
  readonly generate: (request: ModelRequest) => Promise<ModelResponse>;
  readonly modelId: string;
}

/**
 * Style one caption, or return it unchanged.
 *
 * Two attempts, mirroring §14's "Optionally request one format correction /
 * Treat a second invalid response as a no-op". A provider error is not retried
 * here at all — the provider already retries transport failures, and a render
 * that cannot reach the model should fall back to captions rather than stall.
 */
export async function styleNarration(
  context: NarrationContext,
  deps: StyleDeps,
): Promise<StyledNarration> {
  if (!isStyleable(context.actionType)) {
    return fallbackNarration(context, [`action "${context.actionType}" is not styleable`]);
  }

  const request = buildNarrationRequest(context, deps.modelId);
  const requestHash = sha256Hex(`${request.systemPrompt}\n\n${request.userPrompt}`);
  const rejections: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: ModelResponse;
    try {
      response = await deps.generate(
        attempt === 1
          ? request
          : {
              ...request,
              userPrompt: `${request.userPrompt}\n\nYour previous reply was rejected: ${rejections.at(-1)}. Reply with one plain sentence obeying every rule.`,
            },
      );
    } catch (cause) {
      rejections.push(`provider error: ${cause instanceof Error ? cause.message : String(cause)}`);
      return fallbackNarration(context, rejections);
    }

    const candidate = extractLine(response.rawText);
    const check = validateNarration(candidate, context);

    if (check.ok) {
      return {
        text: candidate,
        canonical: context.canonical,
        styled: true,
        modelId: response.modelId,
        requestHash,
        responseHash: sha256Hex(response.rawText),
        rejections,
      };
    }
    rejections.push(`${check.reason}: ${check.detail}`);
  }

  return fallbackNarration(context, rejections);
}
