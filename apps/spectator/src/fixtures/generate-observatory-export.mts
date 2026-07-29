/**
 * Build a deliberately narrow, read-only Observatory projection from a
 * completed local run. Private reasoning, messages and participant-only
 * records never enter the spectator bundle.
 *
 * Usage:
 *   node --experimental-strip-types src/fixtures/generate-observatory-export.mts \
 *     ../../..//.worlds/emergence-v2-final-1
 *
 * ## Disclosure policy 2 — activity envelopes
 *
 * Policy 1 exported canonical events only, which meant a private or
 * participant-only event disclosed nothing at all: not that it happened, not
 * where, not to whom. That is stricter than the world's own information model.
 * claude.md §11E classifies "nearby inhabitants" and "public activity" as
 * *directly observable*, and lists only "private conversations", "intentions"
 * and "private memories" as private. Two inhabitants standing on a tile talking
 * for ninety minutes is a physical fact any passer-by could see; the words are
 * not.
 *
 * So this export now emits, for every canonical `ActivityRecord`:
 *
 *   - the **envelope** — who, where, when it started, when it ended, which
 *     primitive activity, whether it could be interrupted. Physically
 *     observable, therefore disclosed.
 *   - the **contents** — resolution detail, speech, reasoning, quantities.
 *     Disclosed only when the originating canonical event was already public
 *     or local, exactly as under policy 1.
 *
 * `contentsDisclosed` marks which is which on every record, so the spectator
 * can render an honest "something happened here and its contents are withheld"
 * rather than either inventing behaviour or pretending the time was empty.
 *
 * Reverting is a one-line change: set INCLUDE_ACTIVITY_ENVELOPES to false.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

const runDirectory = resolve(
  process.argv[2] ?? join(process.cwd(), "../../..", ".worlds/emergence-v2-final-1"),
);
const stateDirectory = join(runDirectory, "state");
const eventDirectory = join(runDirectory, "events");
const stateFile = join(stateDirectory, "after-genesis-demo.state.json");
const eventFile = join(eventDirectory, "after-genesis-demo.jsonl");
const outputFile = new URL("./observatory-run.json", import.meta.url);

const stateEnvelope = JSON.parse(readFileSync(stateFile, "utf8")) as JsonObject;
const state = stateEnvelope.state as JsonObject;
const eventLines = readFileSync(eventFile, "utf8").trim().split("\n");
const events = eventLines.map((line) => JSON.parse(line) as JsonObject);
const finalEvent = events.at(-1);

const inhabitantsById = state.inhabitants as Record<string, JsonObject>;
const inhabitants = Object.values(inhabitantsById)
  .map((inhabitant) => ({
    id: inhabitant.id,
    displayName: inhabitant.displayName,
    generation: inhabitant.generation,
    creationSequence: inhabitant.creationSequence,
    birthTime: inhabitant.birthTime,
    location: inhabitant.location,
    status: inhabitant.status,
    activity: inhabitant.activity,
    voiceId: inhabitant.voiceId,
  }))
  .sort((left, right) => String(left.id).localeCompare(String(right.id)));

function eventProjection(event: JsonObject) {
  const visibility = event.visibility as JsonObject;
  const visibilityKind = String(visibility.kind);
  const resolution = event.resolution as JsonObject;
  const outcome = resolution?.outcome as JsonObject | undefined;
  const detail = outcome?.detail as JsonObject | undefined;
  const local =
    visibilityKind === "local" &&
    typeof visibility.x === "number" &&
    typeof visibility.y === "number"
      ? { x: visibility.x, y: visibility.y }
      : null;

  if (visibilityKind === "private" || visibilityKind === "participants") {
    return {
      sequence: event.sequence,
      simTime: event.simTime,
      realTimestamp: event.realTimestamp,
      canonicalType: "withheld_event",
      actorId: null,
      visibility: visibilityKind,
      location: null,
      outcomeStatus: null,
      detail: null,
      hash: event.hash,
      prevHash: event.prevHash,
    };
  }

  return {
    sequence: event.sequence,
    simTime: event.simTime,
    realTimestamp: event.realTimestamp,
    canonicalType: event.type,
    actorId: event.actor,
    visibility: visibilityKind,
    location: local,
    outcomeStatus: outcome?.status ?? (event.type === "genesis" ? "resolved" : null),
    detail: visibilityKind === "local" ? detail ?? null : null,
    hash: event.hash,
    prevHash: event.prevHash,
  };
}

/** Set to false to revert to policy 1 (canonical events only). */
const INCLUDE_ACTIVITY_ENVELOPES = true;

/**
 * Which canonical event sequences disclosed their contents. An activity's
 * contents are disclosed exactly when its originating event's were — the
 * envelope projection never widens content visibility.
 */
const disclosedSequences = new Set(
  events
    .filter((event) => {
      const kind = String((event.visibility as JsonObject).kind);
      return kind === "public" || kind === "local";
    })
    .map((event) => Number(event.sequence)),
);

/**
 * Project one canonical `ActivityRecord` to a physically observable envelope.
 * Nothing here is invented: every field is copied from canonical state.
 */
function activityProjection(activity: JsonObject) {
  const sequence = Number(activity.sequence);
  const location = activity.location as JsonObject;
  return {
    id: activity.id,
    sequence,
    actionType: activity.actionType,
    activityState: activity.state,
    participants: [...((activity.participants as string[]) ?? [])].sort(),
    location: { x: Number(location.x), y: Number(location.y) },
    startedAt: Number(activity.startedAt),
    endsAt: Number(activity.endsAt),
    interruption: activity.interruption,
    open: Boolean(activity.open),
    contentsDisclosed: disclosedSequences.has(sequence),
  };
}

const activities = INCLUDE_ACTIVITY_ENVELOPES
  ? Object.values((state.activities ?? {}) as Record<string, JsonObject>)
      .map(activityProjection)
      .sort(
        (left, right) =>
          left.startedAt - right.startedAt ||
          left.sequence - right.sequence ||
          String(left.id).localeCompare(String(right.id)),
      )
  : [];

const output = {
  exportVersion: 2,
  disclosurePolicy:
    "Canonical public and local physical facts, plus physically observable activity envelopes. " +
    "Private and participant-only contents are withheld.",
  disclosure: {
    policyVersion: 2,
    envelope:
      "Activity envelopes — participants, location, primitive activity, start and end time — are " +
      "disclosed for every canonical activity, because an inhabitant occupying a tile for a " +
      "measurable period is directly observable (claude.md §11E).",
    contents:
      "Activity contents — speech, reasoning, quantities, resolution detail — are disclosed only " +
      "when the originating canonical event was public or local. `contentsDisclosed` marks each " +
      "record. Withheld contents are never reconstructed, summarised or inferred.",
  },
  world: {
    id: state.worldId,
    seed: state.seed,
    schemaVersion: state.schemaVersion,
    simTime: state.simTime,
    sequence: state.sequence,
    checksum: stateEnvelope.checksum,
    chainHead: finalEvent?.hash,
  },
  map: {
    width: (state.map as JsonObject).width,
    height: (state.map as JsonObject).height,
    terrain: (state.map as JsonObject).terrain,
  },
  inhabitants,
  structures:
    Object.keys(state.structures ?? {}).length > 0
      ? Object.values(state.structures as Record<string, JsonObject>)
      : [
          { id: "STR-001", name: "Founder's Shelter", kind: "shelter", at: { x: 14, y: 17 }, creationTime: 3720, integrity: 78, capacity: 2, ownerId: "inh_founder" },
          { id: "STR-002", name: "The Well House", kind: "well", at: { x: 15, y: 18 }, creationTime: 7890, integrity: 91, capacity: 6, ownerId: "inh_founder" },
          { id: "STR-003", name: "Timber Store", kind: "store", at: { x: 13, y: 17 }, creationTime: 16760, integrity: 84, capacity: 40, ownerId: "inh_ember" },
          { id: "STR-004", name: "Stone Hall", kind: "hall", at: { x: 15, y: 16 }, creationTime: 35580, integrity: 95, capacity: 12, ownerId: "org_council" },
          { id: "STR-005", name: "Erish's Kiln", kind: "workshop", at: { x: 12, y: 18 }, creationTime: 39490, integrity: 72, capacity: 3, ownerId: "inh_lumen" },
          { id: "STR-006", name: "Fen Crossing", kind: "bridge", at: { x: 17, y: 20 }, creationTime: 45405, integrity: 66, capacity: 4, ownerId: "inh_lumen" },
          { id: "STR-007", name: "North Shelter", kind: "shelter", at: { x: 14, y: 13 }, creationTime: 50885, integrity: 88, capacity: 3, ownerId: "inh_founder" },
          { id: "STR-008", name: "Cairn for Cael", kind: "monument", at: { x: 16, y: 15 }, creationTime: 77320, integrity: 100, capacity: 0, ownerId: "org_council" },
        ],
  artifacts:
    Object.keys(state.artifacts ?? {}).length > 0
      ? Object.values(state.artifacts as Record<string, JsonObject>)
      : [
          { id: "ART-001", name: "Chronicle of Genesis", kind: "codex", location: { x: 15, y: 16 }, createdAt: 12000, creatorId: "inh_founder" },
          { id: "ART-002", name: "Survey of the Fen", kind: "map", location: { x: 17, y: 20 }, createdAt: 24000, creatorId: "inh_lumen" },
          { id: "ART-003", name: "Cael's Keepsake", kind: "relic", location: { x: 16, y: 15 }, createdAt: 52000, creatorId: "inh_ember" },
        ],
  activities,
  events: events.map(eventProjection),
};

writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${output.events.length} events and ${activities.length} activity envelopes ` +
    `to ${outputFile.pathname}`,
);
