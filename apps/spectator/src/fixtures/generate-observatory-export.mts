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
/**
 * Defaults to the committed fixture, which is what a deliberate regeneration of
 * the published demo wants. The dev controller overrides it so that driving a
 * throwaway world cannot overwrite the demo the public pages render.
 */
const outputFile = process.env.AG_OBSERVATORY_OUTPUT_FILE
  ? new URL(`file://${resolve(process.env.AG_OBSERVATORY_OUTPUT_FILE)}`)
  : new URL("./observatory-run.json", import.meta.url);

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
    maturity: inhabitant.maturity,
    // Both are canonical (§6) and both are needed to select a voice: the
    // handle names the assigned adult voice, `sex` selects the child voice
    // used while `maturity` is below the media layer's threshold.
    sex: inhabitant.sex,
    voiceId: inhabitant.voiceId,
  }))
  .sort((left, right) => String(left.id).localeCompare(String(right.id)));

function eventProjection(event: JsonObject) {
  const visibility = event.visibility as JsonObject;
  const visibilityKind = String(visibility.kind);
  const resolution = event.resolution as JsonObject;
  const outcome = resolution?.outcome as JsonObject | undefined;
  const outcomeDetail = outcome?.detail as JsonObject | undefined;
  const inputs = event.inputs as JsonObject | undefined;
  const proposedAction = inputs?.action as JsonObject | undefined;
  const actionPayload = proposedAction?.payload as JsonObject | undefined;
  const detail =
    actionPayload === undefined && outcomeDetail === undefined
      ? (inputs ?? null)
      : { ...(actionPayload ?? {}), ...(outcomeDetail ?? {}) };
  const local =
    visibilityKind === "local" &&
    typeof visibility.x === "number" &&
    typeof visibility.y === "number"
      ? { x: visibility.x, y: visibility.y }
      : null;

  return {
    sequence: event.sequence,
    simTime: event.simTime,
    realTimestamp: event.realTimestamp,
    canonicalType: event.type,
    actorId: event.actor,
    visibility: "public",
    location: local,
    outcomeStatus: outcome?.status ?? (event.type === "genesis" ? "resolved" : null),
    detail,
    hash: event.hash,
    prevHash: event.prevHash,
  };
}

/** Set to false to revert to policy 1 (canonical events only). */
const INCLUDE_ACTIVITY_ENVELOPES = true;

/**
 * The experimental spectator publishes the complete canonical record. This is
 * a one-way projection: widening what observers can read cannot change world
 * state, event hashes or anything an inhabitant observes.
 */
const disclosedSequences = new Set(events.map((event) => Number(event.sequence)));

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
    "The complete canonical record, including participant-scoped speech and action detail.",
  disclosure: {
    policyVersion: 2,
    envelope:
      "Activity envelopes — participants, location, primitive activity, start and end time — are " +
      "disclosed for every canonical activity, because an inhabitant occupying a tile for a " +
      "measurable period is directly observable (claude.md §11E).",
    contents:
      "Activity contents — speech, quantities and resolution detail — are disclosed for every " +
      "canonical event. `contentsDisclosed` marks each record explicitly.",
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
  structures: Object.values((state.structures ?? {}) as Record<string, JsonObject>),
  artifacts: Object.values((state.artifacts ?? {}) as Record<string, JsonObject>),
  activities,
  events: events.map(eventProjection),
};

writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(
  `Wrote ${output.events.length} events and ${activities.length} activity envelopes ` +
    `to ${outputFile.pathname}`,
);
