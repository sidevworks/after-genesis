/**
 * Which moments of the record get spoken, and in whose voice (§21).
 *
 * ## This module is shared, and that is the whole point
 *
 * The offline renderer uses it to decide what to synthesize; the player uses
 * it to decide what to look up. If the two disagreed by a single character the
 * player would miss every clip, so they run the same function over the same
 * chronicle and agree by construction.
 *
 * ## Not everything is voiced
 *
 * §21: "Do not generate voice for every model response." A thirty-day record
 * holds thousands of segments, most of them a few minutes of gathering. Voicing
 * all of them would be expensive and unwatchable. `selectVoiceLines` keeps the
 * beats the director already considers notable, plus every disclosed
 * conversation, and leaves the rest silent.
 *
 * ## Narration and dialogue are different things
 *
 * §21 requires "verbatim canonical dialogue", "condensed summaries" and
 * "dramatised narration" to be clearly distinguished. Only the first is ever
 * spoken in an inhabitant's own voice here:
 *
 *   - `dialogue` is used **only** when a segment is `disclosed`, its action is
 *     a speech action, and it carries exact canonical words. The activity's
 *     actor is the speaker; other participants are listeners or witnesses.
 *   - Everything else is `narration`, spoken by the world narrator, using the
 *     segment's neutral caption. A caption is derived text (see chronicle.ts),
 *     so putting it in an inhabitant's voice would be inventing a quotation.
 *
 * Withheld contents are never voiced at all. The narrator does not read out
 * that something was withheld — the caption on screen already says so, and
 * synthesizing speech about undisclosed activity is exactly the embellishment
 * §11G forbids.
 */

import { MINUTES_PER_DAY, type Chronicle, type ChronicleSegment } from "./types";

/** Canonical actions whose disclosed contents are somebody speaking. */
const SPEECH_ACTIONS: ReadonlySet<string> = new Set(["communicate", "announce", "perform"]);

export type VoiceLineKind = "narration" | "dialogue";

export interface SpeakerRef {
  readonly id: string;
  readonly displayName: string;
  readonly voiceHandle: string;
  readonly sex: "male" | "female";
  readonly maturity: number;
}

export interface VoiceLine {
  readonly segmentId: string;
  readonly kind: VoiceLineKind;
  readonly text: string;
  readonly speaker: SpeakerRef | null;
  /** Canonical action type. Selects how — and whether — narration may be styled. */
  readonly actionType: string;
  /** Canonical start time, as a minute of the world day. */
  readonly minuteOfDay: number;
  /** Canonical duration in sim minutes. */
  readonly minutes: number;
  /**
   * Display names of the segment's participants.
   *
   * The only names a dramatised rewrite is permitted to use. Anything else in
   * a generated line is a person or place the record does not contain, and the
   * validator rejects it (see `packages/media/src/narration-style.ts`).
   */
  readonly allowedNames: readonly string[];
}

/** Everything the selector needs to know about who is on screen. */
export type SpeakerLookup = (inhabitantId: string) => SpeakerRef | null;

/**
 * The canonical words an inhabitant said, if the record discloses them.
 *
 * Returns null rather than a summary when nothing was disclosed. The engine
 * stores resolution detail under a small number of keys; anything else is not
 * speech and must not be read aloud as if it were.
 */
export function canonicalSpeech(segment: ChronicleSegment): string | null {
  if (segment.disclosure !== "disclosed") return null;
  if (!SPEECH_ACTIONS.has(segment.actionType)) return null;
  if (segment.detail === null) return null;

  for (const key of ["message", "text", "content", "utterance"]) {
    const value = segment.detail[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * The inhabitant whose speech a segment records.
 *
 * Exact speech is stored on the actor's activity. Recipients also appear in
 * `participants`, but they did not speak this line; treating them as speakers
 * would hide every real conversation from the voice renderer.
 */
function speechSpeaker(segment: ChronicleSegment): string {
  return segment.inhabitantId;
}

export interface SelectOptions {
  /** Restrict to beats plus disclosed speech. Off yields every disclosed segment. */
  readonly notableOnly?: boolean;
}

/**
 * The lines to voice for a chronicle, in deterministic order.
 *
 * Deterministic ordering matters beyond tidiness: the renderer's spend budget
 * truncates the list, so an unstable order would render a different subset on
 * every build and leave the player with a different set of gaps each time.
 */
export function selectVoiceLines(
  chronicle: Chronicle,
  speakerOf: SpeakerLookup,
  options: SelectOptions = {},
): readonly VoiceLine[] {
  const notableOnly = options.notableOnly ?? true;
  // `(subjectId, sequence)` identifies exactly one segment: a beat is built
  // from one canonical activity envelope, and a segment carries that
  // envelope's sequence.
  const notable = new Set(chronicle.beats.map((beat) => `${beat.subjectId}:${beat.sequence}`));

  const lines: VoiceLine[] = [];
  const seen = new Set<string>();

  for (const track of chronicle.tracks) {
    for (const segment of track.segments) {
      if (seen.has(segment.id)) continue;

      // Gap segments are synthesised by the chronicle to keep a track gapless
      // (`activityId === null`). They stand for time no canonical activity
      // covers. They are correct to draw — the inhabitant was somewhere — and
      // wrong to narrate, because there is no recorded action to describe.
      if (segment.activityId === null || segment.sequence === null) continue;

      // Undisclosed and unrecorded time is never spoken. The screen already
      // states that the contents are withheld; narrating it would add nothing
      // canonical and would risk implying content that was never recorded.
      if (segment.disclosure !== "disclosed") continue;

      const speech = canonicalSpeech(segment);
      const speakerId = speech === null ? null : speechSpeaker(segment);
      const speaker = speakerId === null ? null : speakerOf(speakerId);

      const names = [...new Set([segment.inhabitantId, ...segment.participants])]
        .map((id) => speakerOf(id)?.displayName)
        .filter((name): name is string => name !== undefined);

      if (speech !== null && speaker !== null) {
        seen.add(segment.id);
        lines.push({
          segmentId: segment.id,
          kind: "dialogue",
          text: speech,
          speaker,
          actionType: segment.actionType,
          minuteOfDay: Math.floor(segment.startTick) % MINUTES_PER_DAY,
          minutes: segment.canonicalMinutes,
          allowedNames: names,
        });
        continue;
      }

      if (notableOnly && !notable.has(`${segment.inhabitantId}:${segment.sequence}`)) continue;
      if (segment.caption.trim().length === 0) continue;

      seen.add(segment.id);
      lines.push({
        segmentId: segment.id,
        kind: "narration",
        text: segment.caption,
        speaker: null,
        actionType: segment.actionType,
        minuteOfDay: Math.floor(segment.startTick) % MINUTES_PER_DAY,
        minutes: segment.canonicalMinutes,
        allowedNames: names,
      });
    }
  }

  return lines.sort((left, right) => left.segmentId.localeCompare(right.segmentId));
}
