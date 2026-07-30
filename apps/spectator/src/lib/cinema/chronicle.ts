/**
 * The Chronicle — the discrete canonical record projected onto continuous time.
 *
 * ## The problem this solves
 *
 * The export in `ObservatoryRun` is two lists that describe *instants*: activity
 * envelopes (`participants`, `location`, `startedAt`, `endsAt`) and the canonical
 * events those envelopes came from. Neither says what an inhabitant was doing at
 * sim-minute 4 371, which is exactly the question a camera asks sixty times a
 * second. This module answers it by turning each inhabitant's envelopes into a
 * strip of contiguous segments that tiles their whole lifetime end to end, so
 * that sampling any tick in `[bornTick, endTick]` always lands on a defined
 * state and never on a hole.
 *
 * ## Where the tiling comes from, and where it stops
 *
 * Everything here is either copied from the export or derived by a rule stated
 * in a comment beside the code that applies it. Three rules carry the weight:
 *
 *   1. **The time between activities is idle, and that is a canonical fact.**
 *      The demo runner issues a turn every 120 sim-minutes while activities last
 *      5–60, so more than half of every inhabitant's running time falls between
 *      two activity records. That time is not a hole. Two constitutional rules
 *      determine it exactly — `settleExpiredActivities` returns every
 *      participant to `IDLE_ACTIVITY` the moment an activity's `endsAt` passes,
 *      and `resolvers/move.ts` is the only writer of an inhabitant's `location`,
 *      so a stretch with no activity record is an inhabitant standing idle where
 *      the last one left them. `interstitialSegment` fills those stretches, and
 *      `unrecorded` is reserved for intervals the record genuinely does not
 *      determine: before birth, after death, or after the export's clock runs
 *      out while the inhabitant was mid-activity.
 *
 *   2. **`envelope_only` is never upgraded.** claude.md §11E classifies an
 *      inhabitant occupying a tile for a measurable period as directly
 *      observable, and the contents of a private or participants-only event as
 *      not. So an undisclosed envelope yields a segment with real time, real
 *      position, real participants — and `detail: null`, enforced structurally
 *      by `buildSegment` rather than by convention.
 *
 *   3. **Captions state canonical fields and stop.** claude.md §11G: the
 *      canonical log describes events neutrally and interpretation belongs to
 *      inhabitants. "Gathered 2 food from plains at (4, 0) over 60 minutes" is
 *      four fields of `detail` in a sentence. Anything about effort, intent,
 *      hardship or contribution would be the renderer editorialising on the
 *      world's behalf.
 *
 * Nothing in this file may import React, three.js or Node built-ins, and it has
 * no write path of any kind (claude.md §17, §20): `buildChronicle` reads a
 * plain object and returns a plain object.
 */

import type { ActivityEnvelope, ObservatoryRun } from "../observatory-types";
import { findReferenceByCanonicalKey, type ReferenceRegistry } from "../reference-registry";
import type {
  Chronicle,
  ChronicleBeat,
  ChronicleSegment,
  ChronicleTrack,
  Disclosure,
  Tick,
  Vec2,
} from "./types";

type RunEvent = ObservatoryRun["events"][number];
type RunInhabitant = ObservatoryRun["inhabitants"][number];

/**
 * The narrowest a segment is allowed to be.
 *
 * The engine may resolve an action whose recorded envelope has `endsAt ===
 * startedAt` — an instantaneous state change that consumed no simulated time.
 * A zero-width segment is unsamplable: `progress` would divide by zero and
 * `segmentAt` could never return it. Widening it to one sim-minute makes it
 * reachable without claiming any duration the record did not contain — the
 * caption still reports the canonical duration, which for such an activity is
 * "0 minutes". Widening is *never* allowed to swallow the following activity;
 * see `draftSegments`, where the widened end is clamped to the next start so
 * that "an inhabitant cannot occupy two primary activities simultaneously"
 * (claude.md §11A, §11J) survives the projection.
 */
const MIN_SEGMENT_TICKS = 1;

const UNRECORDED = "unrecorded";
const UNRECORDED_CAPTION = "No canonical record covers this interval.";

/** The canonical `ActivityState` an inhabitant holds while no activity is open. */
const IDLE = "idle";

/**
 * No canonical *activity record* covers a synthesised segment, so none names
 * participants. The inhabitant is on the segment's own `inhabitantId`.
 */
const NO_PARTICIPANTS: readonly string[] = Object.freeze([]);

/* -------------------------------------------------------------------------- */
/* Reading the export                                                          */
/* -------------------------------------------------------------------------- */

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Read a coordinate out of a canonical `detail` blob.
 *
 * `detail` is `Record<string, unknown>` because the export carries one shape per
 * action type and the Chronicle must not pretend to know them all. Anything that
 * is not a pair of finite numbers is treated as absent rather than coerced —
 * a malformed record must degrade to "the record names no such point", never to
 * a position at the origin.
 */
function readCoord(detail: Readonly<Record<string, unknown>> | null, key: string): Vec2 | null {
  if (detail === null) return null;
  const raw = detail[key];
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as { readonly x?: unknown; readonly y?: unknown };
  if (typeof candidate.x !== "number" || typeof candidate.y !== "number") return null;
  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return null;
  return { x: candidate.x, y: candidate.y };
}

function readNumber(detail: Readonly<Record<string, unknown>> | null, key: string): number | null {
  if (detail === null) return null;
  const raw = detail[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function readText(detail: Readonly<Record<string, unknown>> | null, key: string): string | null {
  if (detail === null) return null;
  const raw = detail[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function sameCoord(left: Vec2, right: Vec2): boolean {
  return left.x === right.x && left.y === right.y;
}

/* -------------------------------------------------------------------------- */
/* Captions (claude.md §11G)                                                   */
/* -------------------------------------------------------------------------- */

function formatCoord(coord: Vec2): string {
  return `(${coord.x}, ${coord.y})`;
}

function formatMinutes(minutes: number): string {
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

const COUNT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
] as const;

function formatCount(count: number): string {
  return COUNT_WORDS[count] ?? String(count);
}

/**
 * `ActivityState` values that describe no observable posture.
 *
 * Every other state in the canonical enum — `gathering`, `conversing`,
 * `travelling`, `sleeping`, `confined` — already names what a bystander would
 * see. `idle` does not: it is the engine's word for "holding no long-running
 * activity", and an inhabitant who is `idle` while resolving an `observe` is
 * visibly observing. For those the caption falls back to the action type, which
 * the envelope also discloses.
 */
const UNINFORMATIVE_STATES: ReadonlySet<string> = new Set([UNRECORDED, "idle"]);

/**
 * Turn a canonical action type into the present participle that names it.
 *
 * Action types are `snake_case` verb phrases (`observe`, `guard_location`,
 * `attempt_transfer_without_consent`), so the first token is always the verb and
 * the rest is its object. English orthography here is only the silent-`e` rule,
 * which is all the catalogue needs: `observe` → `observing`, `move` → `moving`,
 * `gather` → `gathering`.
 */
function participleOf(actionType: string): string {
  const [verb = actionType, ...rest] = actionType.split("_");
  const stem = verb.endsWith("e") && !verb.endsWith("ee") ? verb.slice(0, -1) : verb;
  return [`${stem}ing`, ...rest].join(" ");
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;
}

/**
 * The canonical name for what an inhabitant was visibly doing.
 *
 * The activity state is preferred because it is the field the envelope always
 * carries; the action type stands in only where the state names no posture.
 */
function activityLabel(activityState: string, actionType: string): string {
  const source = UNINFORMATIVE_STATES.has(activityState)
    ? participleOf(actionType)
    : activityState.replaceAll("_", " ");
  return capitalise(source);
}

/** "Ember", "Ember and Lumen", "Ember, Lumen and Aster". */
function formatNameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  const head = names.slice(0, -1).join(", ");
  const tail = names[names.length - 1] ?? "";
  return `${head} and ${tail}`;
}

/**
 * The caption for an activity whose *contents* the canonical record withheld.
 *
 * The envelope is not withheld. claude.md §11E lists nearby inhabitants and
 * public activity as directly observable, and the export's own disclosure policy
 * says so explicitly: participants, location, start and end time and the
 * primitive activity state are disclosed for every canonical activity, because
 * an inhabitant occupying a tile for a measurable period is something a
 * bystander can see. Under-reporting that would be its own distortion — it would
 * render an observable hour as a mystery.
 *
 * So the sentence names what was observable — the activity, where, with whom,
 * for how long — and then stops at the boundary the record drew. What is
 * withheld is speech, reasoning, quantities and outcome, and the caption says
 * that they are withheld rather than characterising, summarising or hinting at
 * them (claude.md §11E, §11G).
 */
function envelopeCaption(
  activityState: string,
  actionType: string,
  location: Vec2,
  minutes: number,
  otherParticipantNames: readonly string[],
): string {
  const label = activityLabel(activityState, actionType);
  const withClause =
    otherParticipantNames.length > 0 ? ` with ${formatNameList(otherParticipantNames)}` : "";
  return (
    `${label} at ${formatCoord(location)}${withClause} for ${formatMinutes(minutes)}. ` +
    `Contents withheld by canonical visibility.`
  );
}

/**
 * The caption for an activity whose contents the canonical record disclosed.
 *
 * Every clause is a field of `detail` or of the envelope. `minutes` is the
 * envelope's own duration rather than the possibly-widened segment duration, so
 * the sentence never reports a number the projection invented.
 *
 * The fallback branch names the action type and nothing else, which is what the
 * record itself says when the Chronicle does not have a phrasing for the type.
 */
function disclosedCaption(
  actionType: string,
  detail: Readonly<Record<string, unknown>> | null,
  from: Vec2,
  to: Vec2,
  focus: Vec2 | null,
  minutes: number,
): string {
  switch (actionType) {
    case "gather": {
      const amount = readNumber(detail, "amount");
      const resource = readText(detail, "resource");
      const terrain = readText(detail, "terrain");
      if (amount !== null && resource !== null) {
        const source = focus ?? to;
        const terrainClause = terrain === null ? "" : ` from ${terrain}`;
        return `Gathered ${amount} ${resource}${terrainClause} at ${formatCoord(source)} over ${formatMinutes(minutes)}.`;
      }
      break;
    }
    case "move": {
      if (!sameCoord(from, to)) {
        return `Moved from ${formatCoord(from)} to ${formatCoord(to)} over ${formatMinutes(minutes)}.`;
      }
      break;
    }
    case "consume": {
      const amount = readNumber(detail, "amount");
      const resource = readText(detail, "resource");
      if (amount !== null && resource !== null) {
        return `Consumed ${amount} ${resource} at ${formatCoord(to)} over ${formatMinutes(minutes)}.`;
      }
      break;
    }
    case "communicate":
    case "announce":
    case "perform": {
      const message =
        readText(detail, "message") ??
        readText(detail, "text") ??
        readText(detail, "content") ??
        readText(detail, "utterance");
      if (message !== null) return `“${message}”`;
      break;
    }
    case "rest":
      return `Rested at ${formatCoord(to)} for ${formatMinutes(minutes)}.`;
    case "wait":
      return `Waited at ${formatCoord(to)} for ${formatMinutes(minutes)}.`;
    default:
      break;
  }
  const name = actionType.replaceAll("_", " ");
  return `Canonical ${name} recorded at ${formatCoord(to)} over ${formatMinutes(minutes)}.`;
}

/* -------------------------------------------------------------------------- */
/* Segment drafting                                                            */
/* -------------------------------------------------------------------------- */

interface SegmentDraft {
  readonly envelope: ActivityEnvelope;
  readonly startTick: Tick;
  readonly endTick: Tick;
  readonly from: Vec2;
  readonly to: Vec2;
  readonly route: readonly Vec2[] | undefined;
  readonly focus: Vec2 | null;
  readonly disclosure: Disclosure;
  readonly detail: Readonly<Record<string, unknown>> | null;
  readonly event: RunEvent | null;
}

/**
 * Where an activity started, where it ended, and what it was directed at.
 *
 * The envelope carries exactly one coordinate — where the activity *was*. For a
 * `move` that is the destination, so the origin can only come from the resolved
 * event's `detail.from`, and only when the event was disclosed. An undisclosed
 * move therefore yields a stationary segment at the destination: the record
 * discloses that the inhabitant occupied the destination tile for that span and
 * withholds the path, and a straight line drawn from a guessed origin would be
 * fabrication.
 *
 * A disclosed move is the one segment kind whose position genuinely changes over
 * its span. The engine writes the arriving location eagerly, at the start of the
 * travelling window, and says why: it keeps location "a single fact rather than
 * a function of time" (resolvers/move.ts). That is a state-representation
 * choice, not a claim that the inhabitant teleported — the record still bounds
 * the journey between `detail.from` and `detail.to` across the window it
 * charged for it, and reading a position inside those bounds is reading the
 * record.
 *
 * `focus` is the second canonical point an activity is directed at. A disclosed
 * `gather` names its source tile in `detail.from` — in the demo run that is
 * always the actor's own tile, because everything gathered so far was taken from
 * underfoot, but the resolver permits water to be drawn from an adjacent tile,
 * and when it is, the focus is where the actor turns to reach. `detail.target`
 * is read first for the action types that name a subject tile that way.
 */
function endpointsOf(
  envelope: ActivityEnvelope,
  detail: Readonly<Record<string, unknown>> | null,
): { from: Vec2; to: Vec2; route: readonly Vec2[] | undefined; focus: Vec2 | null } {
  const here: Vec2 = { x: envelope.location.x, y: envelope.location.y };

  if (envelope.actionType === "move") {
    const origin = readCoord(detail, "from");
    const destination = readCoord(detail, "to") ?? here;
    const entered = Array.isArray(detail?.path)
      ? detail.path
          .map((point) => readCoord({ point }, "point"))
          .filter((point): point is Vec2 => point !== null)
      : [];
    const route =
      origin !== null && entered.length > 0
        ? [origin, ...entered]
        : undefined;
    // A move with no disclosed origin is held at its destination rather than
    // travelling from an assumed tile.
    return { from: origin ?? destination, to: destination, route, focus: null };
  }

  const target = readCoord(detail, "target") ?? readCoord(detail, "from");
  return { from: here, to: here, route: undefined, focus: target };
}

/**
 * Turn one inhabitant's envelopes into non-overlapping, ordered drafts.
 *
 * Two clamps run here, and both exist to keep a projection artefact from
 * becoming a claim about the world:
 *
 *   - the widening clamp, so a zero-duration activity is samplable (see
 *     `MIN_SEGMENT_TICKS`);
 *   - the overlap clamp, so a widened — or, in a malformed export, a genuinely
 *     overlapping — activity can never extend past the start of the next one.
 *     claude.md §11A makes a primary activity exclusive; a track that showed two
 *     at once would be asserting something the engine forbids.
 *
 * `envelopes` must already be sorted by `startedAt`.
 */
function draftSegments(
  envelopes: readonly ActivityEnvelope[],
  eventsBySequence: ReadonlyMap<number, RunEvent>,
  bornTick: Tick,
  endTick: Tick,
): SegmentDraft[] {
  const starts: number[] = [];
  for (const envelope of envelopes) {
    starts.push(Math.min(Math.max(envelope.startedAt, bornTick), endTick));
  }

  const drafts: SegmentDraft[] = [];
  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index];
    const startTick = starts[index];
    if (envelope === undefined || startTick === undefined) continue;

    // The next activity's start, or the end of the exported world, is the
    // hard ceiling for this segment.
    const ceiling = index + 1 < starts.length ? (starts[index + 1] ?? endTick) : endTick;
    const widened = Math.max(envelope.endsAt, startTick + MIN_SEGMENT_TICKS);
    const clamped = Math.min(widened, ceiling);
    const segmentEnd = Math.max(clamped, startTick);

    const event = eventsBySequence.get(envelope.sequence) ?? null;
    const disclosure: Disclosure = envelope.contentsDisclosed ? "disclosed" : "envelope_only";
    // The privacy invariant, enforced at its single source: resolution detail
    // exists on the segment only when the canonical event disclosed it.
    const detail = disclosure === "disclosed" ? (event?.detail ?? null) : null;
    const { from, to, route, focus } = endpointsOf(envelope, detail);

    drafts.push({
      envelope,
      startTick,
      endTick: segmentEnd,
      from,
      to,
      route,
      focus,
      disclosure,
      detail,
      event,
    });
  }
  return drafts;
}

/**
 * The stretch between two canonical activities.
 *
 * Everything about this interval is determined by the engine's own rules, which
 * is why it is `disclosed` rather than `unrecorded`:
 *
 *   - **The state.** `settleExpiredActivities` (engine/resolvers/effects.ts)
 *     runs before every turn and returns each participant of a finished
 *     activity to `IDLE_ACTIVITY`. An inhabitant holding no open activity is
 *     canonically `idle` — a constitutional consequence of §11A's one-primary-
 *     activity rule, not an inference about what they were probably up to.
 *
 *   - **The place.** `resolvers/move.ts` holds the only write to an
 *     inhabitant's `location` in the whole engine, and every move produces an
 *     activity record. With no activity record covering the interval, no move
 *     occurred in it, so the inhabitant is exactly where the previous activity
 *     left them.
 *
 *   - **The contents.** There are none. Nothing is withheld, so there is nothing
 *     for a `detail` payload to carry and nothing for `envelope_only` to
 *     protect.
 *
 * Treating these stretches as `unrecorded` would blank out more than half of the
 * demo world's running time and would tell spectators the record is silent about
 * hours it fully determines.
 */
function interstitialSegment(
  inhabitantId: string,
  startTick: Tick,
  endTick: Tick,
  held: Vec2,
): ChronicleSegment {
  const minutes = endTick - startTick;
  return {
    id: `seg:${inhabitantId}:${startTick}:idle`,
    canonicalMinutes: 0,
    inhabitantId,
    activityId: null,
    sequence: null,
    actionType: IDLE,
    activityState: IDLE,
    startTick,
    endTick,
    from: held,
    to: held,
    focus: null,
    participants: NO_PARTICIPANTS,
    disclosure: "disclosed",
    visibility: null,
    outcomeStatus: null,
    detail: null,
    caption:
      `Idle at ${formatCoord(held)} for ${formatMinutes(minutes)}. ` +
      `No canonical activity was recorded in this interval.`,
  };
}

/**
 * An interval the record genuinely does not determine.
 *
 * Reserved for the cases where the engine's rules give no answer: before an
 * inhabitant existed, after they died, or beyond the point where the export
 * stopped while they were still mid-activity. The position is held at the last
 * canonical one so that a scrub across the boundary does not teleport anyone,
 * but the segment claims nothing about what was happening.
 */
function unrecordedSegment(
  inhabitantId: string,
  startTick: Tick,
  endTick: Tick,
  held: Vec2,
): ChronicleSegment {
  return {
    id: `seg:${inhabitantId}:${startTick}:unrecorded`,
    canonicalMinutes: 0,
    inhabitantId,
    activityId: null,
    sequence: null,
    actionType: UNRECORDED,
    activityState: UNRECORDED,
    startTick,
    endTick,
    from: held,
    to: held,
    focus: null,
    participants: NO_PARTICIPANTS,
    disclosure: "unrecorded",
    visibility: null,
    outcomeStatus: null,
    detail: null,
    caption: UNRECORDED_CAPTION,
  };
}

function canonicalSegment(
  inhabitantId: string,
  draft: SegmentDraft,
  displayNames: ReadonlyMap<string, string>,
): ChronicleSegment {
  const { envelope, detail } = draft;
  const participants = [...envelope.participants].sort(compareText);
  // The canonical duration, not the possibly-widened segment duration: the
  // caption must never quote a number the projection produced.
  const canonicalMinutes = Math.max(envelope.endsAt - envelope.startedAt, 0);
  const caption =
    draft.disclosure === "disclosed"
      ? disclosedCaption(
          envelope.actionType,
          detail,
          draft.from,
          draft.to,
          draft.focus,
          canonicalMinutes,
        )
      : envelopeCaption(
          envelope.activityState,
          envelope.actionType,
          draft.to,
          canonicalMinutes,
          // The other participants, named. Identity is in the envelope, so
          // naming them discloses nothing the record withheld. An id the export
          // never introduces is printed as itself rather than invented.
          participants
            .filter((id) => id !== inhabitantId)
            .map((id) => displayNames.get(id) ?? id),
        );

  return {
    id: `seg:${inhabitantId}:${draft.startTick}:${envelope.sequence}`,
    inhabitantId,
    activityId: envelope.id,
    sequence: envelope.sequence,
    actionType: envelope.actionType,
    activityState: envelope.activityState,
    startTick: draft.startTick,
    canonicalMinutes,
    endTick: draft.endTick,
    from: draft.from,
    to: draft.to,
    ...(draft.route === undefined ? {} : { route: draft.route }),
    focus: draft.focus,
    participants,
    disclosure: draft.disclosure,
    visibility: draft.event?.visibility ?? null,
    outcomeStatus: draft.event?.outcomeStatus ?? null,
    detail,
    caption,
  };
}

/**
 * Tile `[bornTick, endTick]` with canonical segments and synthesised filler.
 *
 * The leading filler holds the inhabitant at the first position the record ever
 * gives them. Because `move` is the only writer of an inhabitant's location and
 * every move is an activity, that first position is also where they were born;
 * the projection does not need a birth-location field to know it. Later fillers
 * hold at the previous segment's `to` for the same reason.
 *
 * `trailingIsIdle` decides how the stretch after the last activity is treated.
 * The export's final `activity.state` answers it: an inhabitant the export
 * leaves idle and alive was idle for the rest of the run, and one it leaves
 * mid-activity — or dead — was not, and gets `unrecorded` instead.
 */
function buildTrackSegments(
  inhabitant: RunInhabitant,
  drafts: readonly SegmentDraft[],
  bornTick: Tick,
  endTick: Tick,
  displayNames: ReadonlyMap<string, string>,
  trailingIsIdle: boolean,
): ChronicleSegment[] {
  const segments: ChronicleSegment[] = [];
  if (endTick <= bornTick) return segments;

  const first = drafts[0];
  let held: Vec2 = first
    ? first.from
    : { x: inhabitant.location.x, y: inhabitant.location.y };
  let cursor = bornTick;

  for (const draft of drafts) {
    if (draft.startTick > cursor) {
      segments.push(interstitialSegment(inhabitant.id, cursor, draft.startTick, held));
      cursor = draft.startTick;
    }
    segments.push(canonicalSegment(inhabitant.id, draft, displayNames));
    cursor = draft.endTick;
    held = draft.to;
  }

  if (cursor < endTick) {
    segments.push(
      trailingIsIdle
        ? interstitialSegment(inhabitant.id, cursor, endTick, held)
        : unrecordedSegment(inhabitant.id, cursor, endTick, held),
    );
  }
  return segments;
}

/* -------------------------------------------------------------------------- */
/* Beats                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How a beat earns its weight.
 *
 * The weight ranks moments for an automatic world feed, so the temptation is to
 * rank by what would look good. The rule here refuses that: every term is a
 * count or a duration read off the canonical record, and `reason` names the
 * exact fact that produced it, so a spectator can check the ranking against the
 * event log rather than trusting the renderer's taste.
 *
 *   base                    1
 *   shared activity         +4 per participant beyond the first
 *   first of its type       +3 (world) or +1 (this inhabitant only)
 *   rare developmental act  +1..6 by canonical action type
 *   duration                +1 per hour, capped at +4
 *
 * Shared beats solitary because §11A makes a shared activity cost every
 * participant's exclusive time — several inhabitants spending the same hour
 * together is a materially larger commitment than one spending it alone. First
 * occurrence beats repetition because the record itself marks it as the point
 * where a capability entered the world. Duration is capped so that a long sleep
 * cannot outrank a first meeting.
 *
 * Deliberately absent: disclosure. Weighting disclosed moments above withheld
 * ones would build a feed that quietly equates "visible to spectators" with
 * "important to the world" (claude.md §11E).
 */
const BEAT_BASE_WEIGHT = 1;
const BEAT_SHARED_WEIGHT = 4;
const BEAT_WORLD_FIRST_WEIGHT = 3;
const BEAT_SUBJECT_FIRST_WEIGHT = 1;
const BEAT_HOUR_WEIGHT = 1;
const BEAT_DURATION_CAP = 4;
const BEAT_ACTION_WEIGHT: Readonly<Record<string, number>> = Object.freeze({
  create_inhabitant: 6,
  create_artifact: 5,
  build: 4,
  teach: 4,
  communicate: 3,
  announce: 3,
  perform: 3,
  study: 2,
  craft: 2,
  transfer: 2,
});

function roundWeight(weight: number): number {
  return Math.round(weight * 1000) / 1000;
}

function buildBeats(envelopes: readonly ActivityEnvelope[], known: ReadonlySet<string>): ChronicleBeat[] {
  const seenTypes = new Set<string>();
  const seenBySubject = new Set<string>();
  const beats: ChronicleBeat[] = [];

  // Canonical order, so "first of its type" means first in the event log and
  // not first in whatever order the export happened to serialise.
  const ordered = [...envelopes].sort(
    (left, right) => left.sequence - right.sequence || compareText(left.id, right.id),
  );

  for (const envelope of ordered) {
    const participants = [...envelope.participants].sort(compareText);
    const subjectId = participants.find((id) => known.has(id)) ?? participants[0];
    if (subjectId === undefined) continue;

    const worldFirst = !seenTypes.has(envelope.actionType);
    seenTypes.add(envelope.actionType);
    const subjectKey = `${subjectId}:${envelope.actionType}`;
    const subjectFirst = !seenBySubject.has(subjectKey);
    seenBySubject.add(subjectKey);

    const minutes = Math.max(envelope.endsAt - envelope.startedAt, 0);
    const reasons: string[] = [];
    let weight = BEAT_BASE_WEIGHT;

    if (participants.length > 1) {
      weight += BEAT_SHARED_WEIGHT * (participants.length - 1);
      reasons.push(
        `Canonical activity records ${formatCount(participants.length)} participants.`,
      );
    }
    if (worldFirst) {
      weight += BEAT_WORLD_FIRST_WEIGHT;
      reasons.push(`First canonical ${envelope.actionType.replaceAll("_", " ")} in this world.`);
    } else if (subjectFirst) {
      weight += BEAT_SUBJECT_FIRST_WEIGHT;
      reasons.push(
        `First canonical ${envelope.actionType.replaceAll("_", " ")} recorded for this inhabitant.`,
      );
    }
    const actionWeight = BEAT_ACTION_WEIGHT[envelope.actionType] ?? 0;
    if (actionWeight > 0) {
      weight += actionWeight;
      reasons.push(`Canonical action type ${envelope.actionType.replaceAll("_", " ")} changes the public record.`);
    }
    const durationWeight = Math.min((minutes / 60) * BEAT_HOUR_WEIGHT, BEAT_DURATION_CAP);
    weight += durationWeight;
    reasons.push(`Canonical duration of ${formatMinutes(minutes)}.`);

    beats.push({
      id: `beat:${envelope.sequence}:${subjectId}`,
      sequence: envelope.sequence,
      tick: envelope.startedAt,
      endTick: Math.max(envelope.endsAt, envelope.startedAt),
      subjectId,
      participants,
      actionType: envelope.actionType,
      location: { x: envelope.location.x, y: envelope.location.y },
      disclosure: envelope.contentsDisclosed ? "disclosed" : "envelope_only",
      weight: roundWeight(weight),
      reason: reasons.join(" "),
    });
  }

  beats.sort(
    (left, right) =>
      right.weight - left.weight || left.tick - right.tick || compareText(left.id, right.id),
  );
  return beats;
}

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The tick after which the projection has nothing left to say.
 *
 * `world.simTime` is the exported clock, but an activity may still be open at
 * export time and run past it — the demo run's final `rest` is open and ends 120
 * minutes after `simTime`. Taking the maximum keeps that segment inside the
 * chronicle instead of truncating an activity the record explicitly bounds.
 */
function resolveBounds(
  run: ObservatoryRun,
  envelopes: readonly ActivityEnvelope[],
): { startTick: Tick; endTick: Tick } {
  let startTick = run.world.simTime;
  let endTick = run.world.simTime;
  for (const inhabitant of run.inhabitants) {
    startTick = Math.min(startTick, inhabitant.birthTime);
    endTick = Math.max(endTick, inhabitant.birthTime);
  }
  for (const event of run.events) {
    startTick = Math.min(startTick, event.simTime);
    endTick = Math.max(endTick, event.simTime);
  }
  for (const envelope of envelopes) {
    startTick = Math.min(startTick, envelope.startedAt);
    endTick = Math.max(endTick, envelope.endsAt, envelope.startedAt);
  }
  return { startTick, endTick };
}

/**
 * The tick after which an inhabitant is no longer present.
 *
 * The export carries `status` but no death time, so the only canonical instant
 * available is the last event the record attributes to them. Using it errs
 * toward absence: an inhabitant the record has stopped speaking of is drawn as
 * gone rather than as standing indefinitely on the tile where they were last
 * seen. claude.md §8 — death removes an inhabitant from the world's activity and
 * removes nothing from its history, which is why the segments after `diedTick`
 * still exist and still sample; they simply report `present: false`.
 */
function resolveDiedTick(
  inhabitant: RunInhabitant,
  drafts: readonly SegmentDraft[],
  events: readonly RunEvent[],
): Tick | null {
  if (inhabitant.status === "alive") return null;
  let latest: Tick | null = null;
  for (const event of events) {
    if (event.actorId === inhabitant.id) {
      latest = latest === null ? event.simTime : Math.max(latest, event.simTime);
    }
  }
  const lastDraft = drafts[drafts.length - 1];
  if (lastDraft !== undefined) {
    latest = latest === null ? lastDraft.endTick : Math.max(latest, lastDraft.endTick);
  }
  return latest;
}

/**
 * Project an exported run onto continuous time.
 *
 * `registry` is optional on purpose. Reference ids belong to the Observatory's
 * addressing scheme, not to the world, so the Chronicle must be buildable — and
 * testable — without one; when it is absent every `refId` is `null` and nothing
 * else changes.
 *
 * The result is a pure function of `run`: no clock, no randomness, no iteration
 * over object keys in insertion order. Two calls on the same input deep-equal
 * each other, which is what makes a chronicle safe to rebuild on any client and
 * compare against any other.
 */
export function buildChronicle(run: ObservatoryRun, registry?: ReferenceRegistry): Chronicle {
  const envelopes = run.activities ?? [];
  const { startTick, endTick } = resolveBounds(run, envelopes);

  const eventsBySequence = new Map<number, RunEvent>();
  for (const event of run.events) eventsBySequence.set(event.sequence, event);

  // Only exported inhabitants get a track. An envelope may name a participant
  // the export does not describe — the Chronicle records nothing about someone
  // the record does not introduce.
  const inhabitants = [...run.inhabitants].sort(
    (left, right) =>
      left.creationSequence - right.creationSequence ||
      left.birthTime - right.birthTime ||
      compareText(left.id, right.id),
  );
  const known = new Set(inhabitants.map((inhabitant) => inhabitant.id));
  const displayNames = new Map(
    inhabitants.map((inhabitant) => [inhabitant.id, inhabitant.displayName] as const),
  );

  const envelopesByInhabitant = new Map<string, ActivityEnvelope[]>();
  for (const inhabitant of inhabitants) envelopesByInhabitant.set(inhabitant.id, []);
  for (const envelope of envelopes) {
    for (const participant of envelope.participants) {
      envelopesByInhabitant.get(participant)?.push(envelope);
    }
  }

  const tracks: ChronicleTrack[] = [];
  const byInhabitant = new Map<string, ChronicleTrack>();
  for (const inhabitant of inhabitants) {
    const own = envelopesByInhabitant.get(inhabitant.id) ?? [];
    own.sort(
      (left, right) =>
        left.startedAt - right.startedAt ||
        left.sequence - right.sequence ||
        compareText(left.id, right.id),
    );
    const bornTick = Math.min(Math.max(inhabitant.birthTime, startTick), endTick);
    const drafts = draftSegments(own, eventsBySequence, bornTick, endTick);
    // The export's final world state settles what happened after the last
    // activity record: idle and alive means idle to the end of the run, and
    // anything else means the record stops determining it.
    const trailingIsIdle = inhabitant.status === "alive" && inhabitant.activity.state === IDLE;
    const track: ChronicleTrack = {
      inhabitantId: inhabitant.id,
      displayName: inhabitant.displayName,
      refId:
        registry === undefined
          ? null
          : (findReferenceByCanonicalKey(registry, `inhabitant:${inhabitant.id}`)?.refId ?? null),
      bornTick,
      diedTick: resolveDiedTick(inhabitant, drafts, run.events),
      segments: buildTrackSegments(
        inhabitant,
        drafts,
        bornTick,
        endTick,
        displayNames,
        trailingIsIdle,
      ),
    };
    tracks.push(track);
    byInhabitant.set(track.inhabitantId, track);
  }

  const cutTicks = [...new Set(envelopes.map((envelope) => envelope.startedAt))].sort(
    (left, right) => left - right,
  );

  return {
    worldId: run.world.id,
    startTick,
    endTick,
    tracks,
    byInhabitant,
    beats: buildBeats(envelopes, known),
    cutTicks,
  };
}
