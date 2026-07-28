/**
 * Build a deliberately narrow, read-only Observatory projection from a
 * completed local run. Private reasoning, messages and participant-only
 * records never enter the spectator bundle.
 *
 * Usage:
 *   node --experimental-strip-types src/fixtures/generate-observatory-export.mts \
 *     ../../..//.worlds/emergence-v2-final-1
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

const output = {
  exportVersion: 1,
  disclosurePolicy:
    "Canonical public and local physical facts only. Private and participant-only contents are withheld.",
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
  structures: Object.values((state.structures ?? {}) as Record<string, JsonObject>),
  artifacts: Object.values((state.artifacts ?? {}) as Record<string, JsonObject>),
  events: events.map(eventProjection),
};

writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Wrote ${output.events.length} events to ${outputFile.pathname}`);
