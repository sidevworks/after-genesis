// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
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

/**
 * The supplied ElevenLabs voices for the published Genesis cohort.
 *
 * This lives in the media layer, rather than canonical world state: provider
 * identifiers are configuration, while the engine keeps its replay-stable
 * voice handles. Genesis dialogue therefore never reads the environment's
 * generic adult pools or changes when their order changes.
 */
export const GENESIS_ELEVENLABS_VOICE_IDS: Readonly<Record<string, string>> = Object.freeze({
  inh_01_alpha: "GLSWsaquVBsIPLPPRi2s",
  inh_02_beta: "0AAqfBIcsRqywS7ceXpK",
  inh_03_gamma: "JRIj9I6iNUE54uwAYd1w",
  inh_04_delta: "NXaTw4ifg0LAguvKuIwZ",
  inh_05_epsilon: "LgVKhF8NfPN1eYSzWQpW",
  inh_06_zeta: "87tjwokZlpNU7QL3HaLP",
  inh_07_eta: "N2lVS1w4EtoT3dr4eOWO",
  inh_08_theta: "qyB4MYCSWkgEVlsboQ7O",
  inh_09_iota: "WqfqZq3UXPCD87IXHLnm",
  inh_10_kappa: "VukfMVtvHInVUWoMNPiQ",
});

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
  /** Canonical inhabitant id, present for every contemporary export. */
  readonly id?: string;
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

  // Genesis has an explicitly commissioned, character-level roster. Resolve
  // it before the generic adult/child handles so it is never affected by the
  // old environment voice pools or the progenitor's sex/roster position.
  const genesisVoice = speaker.id === undefined
    ? undefined
    : GENESIS_ELEVENLABS_VOICE_IDS[speaker.id.trim().toLowerCase()];
  if (genesisVoice !== undefined) return genesisVoice;

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
