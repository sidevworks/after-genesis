/**
 * Canonical voice identity (§6 "Voice identity", §21).
 *
 * ## Why these are symbolic handles and not ElevenLabs voice ids
 *
 * A canonical field is permanent. An ElevenLabs voice id is vendor
 * configuration: it can be retired by the vendor, replaced when the account
 * changes, or swapped for a different provider entirely — §3 requires the
 * model provider to sit behind a provider-neutral interface, and the same
 * reasoning applies to the speech provider.
 *
 * If the raw vendor id were written into canonical state, then changing
 * providers would mean rewriting the birth record of every inhabitant that
 * ever lived. That is a constitutional change (§23) forced by a vendor's
 * business decision, and it would break replay: the reconstructed checksum
 * would no longer match production (§15, §28).
 *
 * So the canonical record stores a stable handle — `voice_f04` — and the media
 * service maps handles to whatever the current provider calls that voice. The
 * mapping lives in the media layer's configuration, outside the world.
 *
 * ## Persistence
 *
 * §21: "Give every inhabitant a persistent voice configuration." The handle is
 * assigned once, at creation, and no action changes it. An inhabitant's voice
 * therefore sounds the same on the last day of its life as on the first.
 *
 * Child voices are deliberately *not* separate handles. Maturity changes over
 * an inhabitant's life; a handle must not. The media layer renders a young
 * inhabitant with a child voice of the same class and switches to the assigned
 * adult voice as it matures — a presentation decision made from the canonical
 * `maturity` field, not a second canonical identity.
 */

import type { Sex } from "./state.js";

/** How many distinct voice handles exist per sex. */
export const VOICES_PER_SEX = 10;

/** The handle assigned when none was supplied. Only fixtures should carry it. */
export const DEFAULT_VOICE_HANDLE = "voice_default";

const PREFIX: Readonly<Record<Sex, string>> = Object.freeze({
  male: "voice_m",
  female: "voice_f",
});

/**
 * Every handle for one sex, in index order.
 *
 * Frozen and derived rather than hand-listed so that raising
 * `VOICES_PER_SEX` cannot silently leave a gap in the pool.
 */
export function voicePool(sex: Sex): readonly string[] {
  const pool: string[] = [];
  for (let index = 1; index <= VOICES_PER_SEX; index += 1) {
    pool.push(`${PREFIX[sex]}${String(index).padStart(2, "0")}`);
  }
  return Object.freeze(pool);
}

/**
 * The handle at `index` within a sex's pool, wrapping rather than running out.
 *
 * Total by construction: a caller cannot land on an undefined slot, so no
 * Genesis roster length can produce an inhabitant with no voice.
 */
export function voiceAt(sex: Sex, index: number): string {
  const pool = voicePool(sex);
  const wrapped = ((index % pool.length) + pool.length) % pool.length;
  return pool[wrapped] ?? DEFAULT_VOICE_HANDLE;
}

/** Whether `handle` is a well-formed canonical voice handle. */
export function isVoiceHandle(handle: string): boolean {
  return (
    handle === DEFAULT_VOICE_HANDLE ||
    voicePool("male").includes(handle) ||
    voicePool("female").includes(handle)
  );
}

/** The sex a handle belongs to, or null for `DEFAULT_VOICE_HANDLE`. */
export function voiceSex(handle: string): Sex | null {
  if (voicePool("male").includes(handle)) return "male";
  if (voicePool("female").includes(handle)) return "female";
  return null;
}
