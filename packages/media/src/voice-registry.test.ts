// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Voice registry tests (§21, §3).
 *
 * The bug this package exists to fix was a configuration shape, not a code
 * path: twenty-two lines sharing one environment key, of which a loader keeps
 * one. Several tests below assert that the loader now refuses that shape
 * loudly instead of quietly rendering every inhabitant with one voice.
 */
import { VOICES_PER_SEX, voicePool } from "@after-genesis/core";
import { describe, expect, it } from "vitest";
import {
  GENESIS_ELEVENLABS_VOICE_IDS,
  VoiceConfigError,
  buildVoiceRegistry,
  resolveVoiceId,
  type SpeakerRef,
} from "./voice-registry.js";

const male = Array.from({ length: VOICES_PER_SEX }, (_, i) => `m-provider-${i}`);
const female = Array.from({ length: VOICES_PER_SEX }, (_, i) => `f-provider-${i}`);

const ENV: Readonly<Record<string, string>> = Object.freeze({
  ELEVENLABS_VOICE_NARRATION: "narrator-provider",
  ELEVENLABS_VOICES_MALE: male.join(","),
  ELEVENLABS_VOICES_FEMALE: female.join(","),
  ELEVENLABS_VOICE_CHILD_MALE: "boy-provider",
  ELEVENLABS_VOICE_CHILD_FEMALE: "girl-provider",
  ELEVENLABS_MODEL_ID: "eleven_multilingual_v2",
  MEDIA_CHILD_MATURITY_BELOW: "3",
});

const adult = (voiceHandle: string, sex: SpeakerRef["sex"]): SpeakerRef => ({
  voiceHandle,
  sex,
  maturity: 5,
});

describe("buildVoiceRegistry", () => {
  it("maps every canonical handle of both sexes to a provider voice", () => {
    const registry = buildVoiceRegistry(ENV);
    for (const sex of ["male", "female"] as const) {
      for (const handle of voicePool(sex)) {
        expect(registry.adult[handle]).toBeTypeOf("string");
      }
    }
    expect(Object.keys(registry.adult)).toHaveLength(VOICES_PER_SEX * 2);
  });

  it("assigns pool position N to canonical handle N, in order", () => {
    const registry = buildVoiceRegistry(ENV);
    expect(registry.adult.voice_m01).toBe(male[0]);
    expect(registry.adult.voice_m10).toBe(male[9]);
    expect(registry.adult.voice_f01).toBe(female[0]);
    expect(registry.adult.voice_f10).toBe(female[9]);
  });

  it("rejects a pool that is not exactly one voice per handle", () => {
    // This is the shape a repeated `ELEVENLABS_VOICE_ID=` key collapses to:
    // a single surviving value where ten were intended.
    expect(() => buildVoiceRegistry({ ...ENV, ELEVENLABS_VOICES_MALE: "only-one" })).toThrow(
      VoiceConfigError,
    );
    expect(() => buildVoiceRegistry({ ...ENV, ELEVENLABS_VOICES_MALE: male.join(",") + ",extra" })).toThrow(
      VoiceConfigError,
    );
  });

  it("rejects a pool containing the same provider voice twice", () => {
    const duplicated = [...male.slice(0, 9), male[0]!].join(",");
    expect(() => buildVoiceRegistry({ ...ENV, ELEVENLABS_VOICES_MALE: duplicated })).toThrow(
      /duplicate/i,
    );
  });

  it("refuses to start without a narration voice rather than substituting one", () => {
    expect(() => buildVoiceRegistry({ ...ENV, ELEVENLABS_VOICE_NARRATION: "" })).toThrow(
      VoiceConfigError,
    );
  });

  it("tolerates surrounding whitespace in a pool", () => {
    const spaced = male.map((id) => ` ${id} `).join(",");
    const registry = buildVoiceRegistry({ ...ENV, ELEVENLABS_VOICES_MALE: spaced });
    expect(registry.adult.voice_m01).toBe(male[0]);
  });
});

describe("resolveVoiceId", () => {
  const registry = buildVoiceRegistry(ENV);

  it("uses the narration voice for narration, whoever is on screen", () => {
    expect(resolveVoiceId(registry, "narration", null)).toBe("narrator-provider");
    expect(resolveVoiceId(registry, "narration", adult("voice_m04", "male"))).toBe(
      "narrator-provider",
    );
  });

  it("uses the speaker's assigned voice for dialogue", () => {
    expect(resolveVoiceId(registry, "dialogue", adult("voice_f07", "female"))).toBe(female[6]);
    expect(resolveVoiceId(registry, "dialogue", adult("voice_m02", "male"))).toBe(male[1]);
  });

  it("uses the commissioned ElevenLabs voice for every Genesis character, never the environment pool", () => {
    for (const [id, providerVoiceId] of Object.entries(GENESIS_ELEVENLABS_VOICE_IDS)) {
      expect(
        resolveVoiceId(registry, "dialogue", {
          id,
          voiceHandle: "voice_m01",
          sex: "male",
          // The direct Genesis map must also win over the generic child path.
          maturity: 0,
        }),
      ).toBe(providerVoiceId);
    }
  });

  it("renders an immature inhabitant with the child voice of its sex (§11B)", () => {
    const child: SpeakerRef = { voiceHandle: "voice_f07", sex: "female", maturity: 0 };
    expect(resolveVoiceId(registry, "dialogue", child)).toBe("girl-provider");
    expect(resolveVoiceId(registry, "dialogue", { ...child, sex: "male" })).toBe("boy-provider");
  });

  it("returns to the assigned adult voice once the inhabitant matures (§21)", () => {
    // Voice identity is persistent: the same canonical handle must resolve to
    // the same adult voice for the rest of the inhabitant's life.
    const handle = "voice_f07";
    const atThreshold: SpeakerRef = { voiceHandle: handle, sex: "female", maturity: 3 };
    const old: SpeakerRef = { voiceHandle: handle, sex: "female", maturity: 40 };
    expect(resolveVoiceId(registry, "dialogue", atThreshold)).toBe(female[6]);
    expect(resolveVoiceId(registry, "dialogue", old)).toBe(female[6]);
  });

  it("falls back to narration when dialogue has no identified speaker", () => {
    expect(resolveVoiceId(registry, "dialogue", null)).toBe("narrator-provider");
  });

  it("throws on an unmapped handle rather than silently using the narrator", () => {
    // Silently substituting is exactly how a broken voice layer looks like a
    // working one. It must be loud.
    expect(() => resolveVoiceId(registry, "dialogue", adult("voice_x99", "male"))).toThrow(
      VoiceConfigError,
    );
  });

  it("gives two inhabitants of the same sex with different handles different voices", () => {
    const first = resolveVoiceId(registry, "dialogue", adult("voice_m01", "male"));
    const second = resolveVoiceId(registry, "dialogue", adult("voice_m09", "male"));
    expect(first).not.toBe(second);
  });
});
