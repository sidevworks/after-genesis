// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * The single place the Cinema layer reads the world from.
 *
 * The chronicle is derived from a completed export and never changes, so it is
 * built once per browser session and memoised. Building it on every render
 * would re-walk 497 activity envelopes and 601 events for no benefit.
 *
 * Note what this module does *not* do: it holds no writer, no connection and no
 * mutable world handle. It reads `observatorySource`, which reads a committed
 * JSON export. There is no path from here back to canonical state
 * (claude.md §17, §20).
 */
import { observatorySource } from "../observatory-source";
import type { ReferenceRecord } from "../observatory-types";
import { buildChronicle } from "./chronicle";
import { MINUTES_PER_DAY, type Chronicle, type ChronicleTrack } from "./types";

let chronicleCache: Chronicle | null = null;
let entityRefCache: ReadonlyMap<string, string> | null = null;

export function getChronicle(): Chronicle {
  if (chronicleCache === null) {
    chronicleCache = buildChronicle(observatorySource.getRun());
  }
  return chronicleCache;
}

/** Canonical inhabitant id → permanent `ENT` Reference ID, for deep links. */
export function getEntityRefs(): ReadonlyMap<string, string> {
  if (entityRefCache === null) {
    const pairs: Array<readonly [string, string]> = [];
    for (const record of observatorySource.getReferences("ENT")) {
      const canonicalId = record.canonicalMetadata.canonicalId;
      if (typeof canonicalId === "string") pairs.push([canonicalId, record.refId]);
    }
    entityRefCache = new Map(pairs);
  }
  return entityRefCache;
}

export function entityRefFor(inhabitantId: string): string | null {
  return getEntityRefs().get(inhabitantId) ?? null;
}

/** The `ENT` record for an inhabitant, when the Observatory indexed one. */
export function entityRecordFor(inhabitantId: string): ReferenceRecord | null {
  const refId = entityRefFor(inhabitantId);
  return refId === null ? null : observatorySource.getReference(refId);
}

export function trackFor(inhabitantId: string): ChronicleTrack | null {
  return getChronicle().byInhabitant.get(inhabitantId) ?? null;
}

/** The map the Stage renders. Canonical terrain, straight from the export. */
export function getMap(): { width: number; height: number; terrain: string[] } {
  const run = observatorySource.getRun();
  return { width: run.map.width, height: run.map.height, terrain: run.map.terrain };
}

/**
 * Where playback opens.
 *
 * World tick 0 is midnight on day one, and the first canonical activity in the
 * demonstration run begins at 02:00 — so an honest "start at the beginning"
 * opens on an unlit field with nothing in it. That is a true picture of the
 * record and a useless first frame.
 *
 * So the opening frame is the first recorded activity that happens in daylight.
 * This is an editorial default and nothing more: it selects a starting position
 * for the playhead, exactly as a viewer dragging the scrub bar would, and every
 * earlier minute remains reachable. It changes no fact, hides nothing, and the
 * transport reports the tick it landed on.
 */
const DAYLIGHT_START = 0.3;
const DAYLIGHT_END = 0.75;

export function openingTick(subjectId: string | null = null): number {
  const chronicle = getChronicle();
  const tracks =
    subjectId === null
      ? chronicle.tracks
      : chronicle.tracks.filter((track) => track.inhabitantId === subjectId);

  let earliest: number | null = null;
  for (const track of tracks) {
    for (const segment of track.segments) {
      if (segment.activityState === "idle" || segment.disclosure === "unrecorded") continue;
      const fraction = (segment.startTick % MINUTES_PER_DAY) / MINUTES_PER_DAY;
      if (fraction < DAYLIGHT_START || fraction > DAYLIGHT_END) continue;
      if (earliest === null || segment.startTick < earliest) earliest = segment.startTick;
      break;
    }
  }

  // Fall back to the first recorded activity of any kind, then to the start.
  if (earliest !== null) return Math.max(chronicle.startTick, earliest - 10);
  return chronicle.cutTicks[0] ?? chronicle.startTick;
}

/** The disclosure policy under which this export was produced, for the UI. */
export function getDisclosure(): { policyVersion: number; envelope: string; contents: string } {
  const run = observatorySource.getRun();
  return (
    run.disclosure ?? {
      policyVersion: 1,
      envelope: "Canonical events only.",
      contents: run.disclosurePolicy,
    }
  );
}
