/**
 * Resolving who is speaking, from an exported run.
 *
 * The renderer and the player both need to turn an inhabitant id into a voice
 * handle, a sex and a maturity. Sharing this function is what keeps the two in
 * agreement about which provider voice a line was rendered in.
 */

import { voiceAt, type Sex } from "@after-genesis/core";
import type { ObservatoryRun } from "../observatory-types";
import type { SpeakerLookup, SpeakerRef } from "./voice-lines";

/**
 * A deterministic voice class for a run that predates the canonical `sex`
 * field.
 *
 * Fixtures generated before `sex` existed carry no voice class, and the demo
 * reels on the Watch page are such fixtures. Rather than render every one of
 * them with the same voice — the failure this whole pipeline replaced — the
 * class is derived from the inhabitant id, which is stable, so a given
 * inhabitant sounds the same on every rebuild.
 *
 * This is presentation for legacy fixtures only. A live world always carries
 * the canonical field and never reaches this path.
 */
function derivedSex(inhabitantId: string): Sex {
  let accumulator = 0;
  for (let index = 0; index < inhabitantId.length; index += 1) {
    accumulator = (accumulator * 31 + inhabitantId.charCodeAt(index)) >>> 0;
  }
  return accumulator % 2 === 0 ? "female" : "male";
}

function derivedHandle(inhabitantId: string, sex: Sex): string {
  let accumulator = 7;
  for (let index = 0; index < inhabitantId.length; index += 1) {
    accumulator = (accumulator * 131 + inhabitantId.charCodeAt(index)) >>> 0;
  }
  return voiceAt(sex, accumulator);
}

/** A canonical handle looks like `voice_f04`. Anything else is a legacy value. */
function isCanonicalHandle(voiceId: string | undefined): boolean {
  return typeof voiceId === "string" && /^voice_[mf]\d\d$/.test(voiceId);
}

/**
 * Build a lookup over a run's inhabitants.
 *
 * Canonical fields are used wherever the export provides them; the derivation
 * above fills in only what a legacy fixture omits.
 */
export function speakerLookupFor(run: ObservatoryRun): SpeakerLookup {
  const byId = new Map<string, SpeakerRef>();

  for (const inhabitant of run.inhabitants) {
    const sex = inhabitant.sex ?? derivedSex(inhabitant.id);
    const voiceHandle = isCanonicalHandle(inhabitant.voiceId)
      ? inhabitant.voiceId
      : derivedHandle(inhabitant.id, sex);

    byId.set(inhabitant.id, {
      id: inhabitant.id,
      displayName: inhabitant.displayName,
      voiceHandle,
      sex,
      // Absent in legacy fixtures. Assuming maturity rather than defaulting to
      // 0 matters: 0 would render every historical adult as a child.
      maturity: inhabitant.maturity ?? 5,
    });
  }

  return (inhabitantId: string) => byId.get(inhabitantId) ?? null;
}
