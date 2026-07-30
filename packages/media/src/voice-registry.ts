/**
 * Canonical voice handle → provider voice id (§21, §4G).
 *
 * This is the only place the two namespaces meet. Canonical state stores
 * `voice_f04` forever; ElevenLabs calls that same voice `EST9Ui...` until it
 * doesn't. Keeping the mapping here means a provider migration is a config
 * change, not a rewrite of every birth record (see `core/engine/voice.ts`).
 *
 * Pure and side-effect free: it reads a plain record of strings, never
 * `process.env` directly, so it is testable without a live environment and
 * cannot leak an API key by construction — no key passes through this file.
 */

import { VOICES_PER_SEX, voicePool, type Sex } from "@after-genesis/core";
import type { VoiceKind } from "./manifest.js";

export type { VoiceKind };

export interface VoiceRegistry {
  readonly narration: string;
  readonly adult: Readonly<Record<string, string>>;
  readonly child: Readonly<Record<Sex, string>>;
  /** Canonical maturity strictly below this renders with a child voice. */
  readonly childMaturityBelow: number;
  readonly modelId: string;
}

export class VoiceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceConfigError";
  }
}

function splitPool(raw: string | undefined, key: string): readonly string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length !== VOICES_PER_SEX) {
    throw new VoiceConfigError(
      `${key} must list exactly ${VOICES_PER_SEX} comma-separated voice ids, found ${entries.length}. ` +
        `Note that repeating the same key on separate lines does not build a list — only the last line survives.`,
    );
  }
  if (new Set(entries).size !== entries.length) {
    throw new VoiceConfigError(`${key} contains a duplicate voice id; every inhabitant voice must be distinct`);
  }
  return entries;
}

function required(env: Readonly<Record<string, string | undefined>>, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new VoiceConfigError(`${key} is not set`);
  }
  return value;
}

/**
 * Build the registry from an environment-shaped record.
 *
 * Throws rather than falling back. A missing voice pool silently defaulting to
 * the narrator would make every inhabitant sound identical and would look like
 * a working feature — which is precisely the failure this pipeline replaced.
 */
export function buildVoiceRegistry(
  env: Readonly<Record<string, string | undefined>>,
): VoiceRegistry {
  const male = splitPool(env.ELEVENLABS_VOICES_MALE, "ELEVENLABS_VOICES_MALE");
  const female = splitPool(env.ELEVENLABS_VOICES_FEMALE, "ELEVENLABS_VOICES_FEMALE");

  const adult: Record<string, string> = {};
  for (const [index, handle] of voicePool("male").entries()) adult[handle] = male[index]!;
  for (const [index, handle] of voicePool("female").entries()) adult[handle] = female[index]!;

  const parsedMaturity = Number.parseInt(env.MEDIA_CHILD_MATURITY_BELOW ?? "3", 10);
  if (!Number.isInteger(parsedMaturity) || parsedMaturity < 0) {
    throw new VoiceConfigError("MEDIA_CHILD_MATURITY_BELOW must be a non-negative integer");
  }

  return {
    narration: required(env, "ELEVENLABS_VOICE_NARRATION"),
    adult: Object.freeze(adult),
    child: Object.freeze({
      male: required(env, "ELEVENLABS_VOICE_CHILD_MALE"),
      female: required(env, "ELEVENLABS_VOICE_CHILD_FEMALE"),
    }),
    childMaturityBelow: parsedMaturity,
    modelId: env.ELEVENLABS_MODEL_ID?.trim() || "eleven_flash_v2_5",
  };
}

export interface SpeakerRef {
  readonly voiceHandle: string;
  readonly sex: Sex;
  /** Canonical developmental stage (§11B). Selects the child rendering. */
  readonly maturity: number;
}

/**
 * The provider voice id to synthesize with.
 *
 * `narration` never consults the speaker: the narrator is the world's voice,
 * not an inhabitant's, and §21 requires the two to stay clearly distinguishable.
 *
 * For dialogue, a young inhabitant renders with the child voice of its sex.
 * Its canonical handle is unchanged — the same inhabitant resolves to its
 * assigned adult voice once `maturity` reaches the threshold. Voice identity is
 * persistent (§21); what changes is a rendering decision read from canonical
 * maturity, exactly as gait and camera framing are.
 */
export function resolveVoiceId(
  registry: VoiceRegistry,
  kind: VoiceKind,
  speaker: SpeakerRef | null,
): string {
  if (kind === "narration" || speaker === null) return registry.narration;

  if (speaker.maturity < registry.childMaturityBelow) {
    return registry.child[speaker.sex];
  }

  const adult = registry.adult[speaker.voiceHandle];
  if (adult === undefined) {
    throw new VoiceConfigError(
      `no provider voice is mapped for canonical handle "${speaker.voiceHandle}"`,
    );
  }
  return adult;
}
