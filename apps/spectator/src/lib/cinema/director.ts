/**
 * The Director — canonical structure in, shot plan and camera poses out.
 *
 * A record of the world is not yet a film of it. The Chronicle already says
 * where everyone was and what they were doing at any fractional minute; this
 * file decides where to stand to watch, for how long, and when to cut. That is
 * the whole of its authority. It reads canonical structure and produces camera
 * numbers: it has "no navigation, collision, cognition, event, or state
 * mutation dependency" (docs/observatory-architecture.md §7), and the world
 * cannot perceive the camera any more than the camera can touch the world
 * (claude.md §20).
 *
 * ## Where the shots come from
 *
 * Every shot is derived from a canonical fact — a segment's duration, its
 * participant count, whether its endpoints differ, the time of day it started.
 * None is derived from how interesting the result would look. The grammar:
 *
 *   - **Shared activity** (`participants.length > 1`) → `TWO_SHOT`,
 *     perpendicular to the line between the two, which is the standard
 *     180-degree setup and keeps both in frame.
 *   - **Travel** (`move`, `travelling`, or differing endpoints) →
 *     `TRACKING_DOLLY` or `THIRD_PERSON_FOLLOW` behind the heading; a long
 *     journey hands its last third to `OVERHEAD_FOLLOW`, which is the framing
 *     that reads a route.
 *   - **Sleep and rest** → `ESTABLISH` at night, `STATIC_SITE` by day, both
 *     locked off with at most a slow crane. Orbiting a sleeping figure for
 *     minutes is a music video, not an observation.
 *   - **Long stationary work** → `ORBIT`, slowly circling, handing its last
 *     third to `CLOSE`.
 *   - **Idle** → wide or establishing, slowly. Never `CLOSE`, never a fast
 *     orbit. See the note on occupancy below.
 *   - **`unrecorded`** → deliberately distant and uninformative.
 *   - A sequence opens on an `ESTABLISH`, and so does any stretch the record
 *     does not cover.
 *
 * ## Most of a world is quiet, and the grammar has to survive that
 *
 * Measured on the reference run: 19,978 activity-minutes out of 216,000
 * inhabitant-minutes — 9.2% occupancy, a median gap of 300 sim minutes between
 * one inhabitant's activities, and a longest gap of 1,740. A director that
 * simply follows a subject would spend most of its running time orbiting a
 * motionless figure.
 *
 * Two consequences, both implemented below. The world feed prefers, at every
 * tick, an inhabitant who is *mid-activity*, and only falls back on stillness
 * when nobody is; when nobody is active for a long stretch it emits one long
 * `ESTABLISH` over the settlement rather than a run of pointless close shots. A
 * wide, slow, empty landscape is an honest depiction of a world where nothing
 * is being recorded. A tight orbit on a still figure is not — it implies an
 * event, and there is none.
 *
 * ## The disclosure distinction, which is easy to get backwards
 *
 * `envelope_only` is framed **normally**, including `TWO_SHOT`. Participants,
 * location and duration are canonical and observable (§11E lists nearby
 * inhabitants and public activity as directly observable) — a two-shot of a
 * conversation whose words were withheld reveals nothing the record does not
 * already contain, and it is the honest picture of what someone standing nearby
 * would have seen. Only `unrecorded` — an interval no canonical record covers
 * at all — is held at a distance. Do not tighten this back to cover
 * `envelope_only`: doing so would deny facts the world disclosed and would
 * leave most of a run looking dead.
 *
 * What the distant framing for `unrecorded` protects against is the opposite
 * error: a camera that pushes in on a stretch it knows nothing about, in the
 * visual grammar of revelation, showing nothing. Hence `dollyRate >= 0` on
 * those shots — the camera may drift back, never in.
 *
 * ## Determinism
 *
 * `planShots` is a pure function of its inputs and `resolvePose` is a pure
 * function of a plan, a frame and a tick. No `Date.now`, no `Math.random`, no
 * module-level mutable state. Azimuths vary between successive shots of the
 * same activity — otherwise every gather in a world is framed identically — but
 * they vary from a FNV-1a hash of the shot's canonical seed, so two runs of the
 * planner produce byte-identical plans and a spectator sharing a timestamp sees
 * what the other spectator saw.
 */
import type {
  CameraPose,
  Chronicle,
  ChronicleSegment,
  Disclosure,
  Shot,
  ShotFraming,
  ShotKind,
  ShotMotion,
  ShotPlan,
  Tick,
  Transition,
  Vec2,
  Vec3,
  WorldFrame,
} from "./types";
import { MINUTES_PER_DAY } from "./types";

/* -------------------------------------------------------------------------- */
/* Stated constants                                                            */
/* -------------------------------------------------------------------------- */

/**
 * No shot is shorter than this in sim minutes.
 *
 * The canonical record is full of five-minute activities separated by long
 * quiet stretches; one shot per activity would strobe. Twenty sim minutes is
 * twenty real seconds at the 60× reference rate and five at 240×.
 */
export const MIN_SHOT_MINUTES = 20;

/** A segment longer than this earns a second angle — the last-third rule. */
const LONG_SEGMENT_MINUTES = 90;

/** The opening `ESTABLISH`, when the first segment is long enough to spare it. */
const ESTABLISH_MINUTES = 30;

/** Target length of one world-feed shot before looking for the next beat. */
const WORLD_SHOT_MINUTES = 60;

/** How far ahead the world feed will reach for a beat before holding or resetting. */
const WORLD_LOOKAHEAD_MINUTES = 90;

/** Bounds the world-feed loop against a pathological beat list. */
const MAX_WORLD_SLOTS = 2000;

/** Night is when the sun is down: rest before ~06:00 or after ~20:00 is a night shot. */
const NIGHT_END_FRACTION = 0.25;
const NIGHT_START_FRACTION = 0.83;

/** The camera never descends into the ground plane. Metres. */
export const MIN_CAMERA_HEIGHT = 2.4;

/** Nor does it end up inside the subject. Metres. */
const MIN_CAMERA_DISTANCE = 1.5;

/** Look-at heights in metres: an inhabitant's upper body, and a site's ground. */
const SUBJECT_TARGET_HEIGHT = 1.2;
const ANCHOR_TARGET_HEIGHT = 0.6;

/** Clear space beyond each subject of a two-shot, in tiles. */
const TWO_SHOT_MARGIN = 1.6;

/**
 * How long after a shot's start `cut` stays true, in sim minutes.
 *
 * `resolvePose` is pure and cannot remember which shot it resolved last, so the
 * cut flag has to be a property of the tick. The window must exceed one frame
 * at the fastest listed playback rate: 1440 sim minutes per real second at a
 * 30 fps floor is 0.8 sim minutes per frame, so one minute always catches at
 * least one frame.
 */
const CUT_WINDOW_MINUTES = 1;

/** The floor for an unrecorded stretch's framing distance, in metres. */
const DISTANT_FRAMING_DISTANCE = 26;

/**
 * Ceilings on integrated camera motion, in metres.
 *
 * A single `ESTABLISH` can legitimately run for a thousand sim minutes over a
 * quiet world, and an uncapped crane rate would take it to orbit.
 */
const MAX_CAMERA_HEIGHT = 120;
const MAX_CAMERA_DISTANCE = 220;

/* -------------------------------------------------------------------------- */
/* Deterministic variation                                                     */
/* -------------------------------------------------------------------------- */

/** FNV-1a, 32-bit. Chosen for being short, stable and dependency-free. */
function hash32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** A stable value in [-1, 1) from a seed string. */
function signedUnit(seed: string): number {
  return ((hash32(seed) % 20000) / 10000) - 1;
}

/** A stable boolean from a seed string. */
function coinFlip(seed: string): boolean {
  return (hash32(seed) & 1) === 1;
}

/* -------------------------------------------------------------------------- */
/* Internal shapes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What the grammar needs to know about one stretch of canonical record.
 *
 * Segments and beats both reduce to this, so the world feed and a subject feed
 * are choreographed by exactly the same rules.
 */
interface ShotBasis {
  subjectId: string;
  participants: readonly string[];
  actionType: string;
  activityState: string;
  disclosure: Disclosure;
  from: Vec2;
  to: Vec2;
  startTick: Tick;
  endTick: Tick;
  /** The canonical id this basis came from. Seeds the shot's azimuth. */
  sourceId: string;
  reason: string;
  /**
   * Offset in tiles from `from` to the canonical `focus`. The best estimate at
   * planning time of how far apart the participants of a shared activity stood;
   * `resolvePose` replaces it with the sampled truth once both are on screen.
   */
  focusSeparationX: number;
  focusSeparationY: number;
}

/** A shot before its window has been reconciled with its neighbours. */
interface Draft {
  kind: ShotKind;
  startTick: Tick;
  endTick: Tick;
  subjectId: string;
  secondarySubjectId: string | null;
  anchor: Vec2 | null;
  framing: ShotFraming;
  motion: ShotMotion;
  reason: string;
  sourceId: string;
  /**
   * Where this shot's canonical basis was, whether or not the shot is anchored
   * there. Lets a following hold settle over the last place its subject stood
   * rather than over the map origin.
   */
  anchorHint: Vec2 | null;
}

/* -------------------------------------------------------------------------- */
/* Framing tables                                                              */
/* -------------------------------------------------------------------------- */

interface KindDefaults {
  readonly distance: number;
  readonly height: number;
  readonly fov: number;
  /** Base azimuth before jitter. π is directly behind a subject-relative shot. */
  readonly azimuth: number;
  readonly relativeToSubject: boolean;
  /** Radians of deterministic variation applied either side of `azimuth`. */
  readonly jitter: number;
  readonly motion: ShotMotion;
}

const STILL: ShotMotion = { orbitRate: 0, dollyRate: 0, craneRate: 0 };

const KIND_DEFAULTS: Readonly<Record<ShotKind, KindDefaults>> = Object.freeze({
  ESTABLISH: {
    distance: 34,
    height: 22,
    fov: 42,
    azimuth: Math.PI * 0.25,
    relativeToSubject: false,
    jitter: Math.PI * 0.5,
    // Almost imperceptible: a quarter of a degree of arc and a metre of lift per
    // ten sim minutes. Enough that the frame is not a photograph.
    motion: { orbitRate: 0.0008, dollyRate: 0, craneRate: 0.01 },
  },
  THIRD_PERSON_FOLLOW: {
    distance: 7,
    height: 3.2,
    fov: 50,
    azimuth: Math.PI,
    relativeToSubject: true,
    jitter: 0.35,
    motion: STILL,
  },
  WIDE_FOLLOW: {
    distance: 20,
    height: 10,
    fov: 46,
    azimuth: Math.PI * 0.75,
    relativeToSubject: false,
    jitter: Math.PI * 0.4,
    motion: { orbitRate: 0.0006, dollyRate: 0, craneRate: 0 },
  },
  OVERHEAD_FOLLOW: {
    distance: 3,
    height: 26,
    fov: 40,
    azimuth: 0,
    relativeToSubject: false,
    jitter: Math.PI,
    motion: STILL,
  },
  ORBIT: {
    distance: 6.5,
    height: 2.8,
    fov: 45,
    azimuth: 0,
    relativeToSubject: false,
    jitter: Math.PI,
    // A quarter turn over roughly two sim hours: circling, not spinning.
    motion: { orbitRate: 0.012, dollyRate: 0, craneRate: 0 },
  },
  CLOSE: {
    distance: 3.2,
    height: 1.9,
    fov: 34,
    azimuth: Math.PI * 0.3,
    relativeToSubject: true,
    jitter: 0.6,
    motion: { orbitRate: 0.006, dollyRate: -0.002, craneRate: 0 },
  },
  TWO_SHOT: {
    // Overwritten by twoShotDistance once the separation is known.
    distance: 9,
    height: 2.2,
    fov: 40,
    azimuth: 0,
    relativeToSubject: false,
    // Half a radian either side of the perpendicular, and never enough to cross
    // the line: the 180-degree rule survives the variation.
    jitter: 0.5,
    motion: { orbitRate: 0.002, dollyRate: 0, craneRate: 0 },
  },
  TRACKING_DOLLY: {
    distance: 9,
    height: 2.4,
    fov: 48,
    azimuth: Math.PI * 0.8,
    relativeToSubject: true,
    jitter: 0.3,
    motion: STILL,
  },
  STATIC_SITE: {
    distance: 13,
    height: 6.5,
    fov: 45,
    azimuth: Math.PI * 0.4,
    relativeToSubject: false,
    jitter: Math.PI,
    motion: { orbitRate: 0, dollyRate: 0, craneRate: 0.008 },
  },
  FALLBACK_REFERENCE: {
    distance: 44,
    height: 32,
    fov: 50,
    azimuth: Math.PI * 0.25,
    relativeToSubject: false,
    jitter: 0,
    motion: STILL,
  },
});

function framingFor(kind: ShotKind, seed: string): ShotFraming {
  const base = KIND_DEFAULTS[kind];
  return {
    distance: base.distance,
    height: base.height,
    azimuth: base.azimuth + signedUnit(seed) * base.jitter,
    relativeToSubject: base.relativeToSubject,
    fov: base.fov,
  };
}

/**
 * How far back a two-shot must sit for a separation to fit the frame.
 *
 * Computed from the lens rather than hardcoded, so changing `fov` cannot
 * silently push a participant out of frame. The separation is measured against
 * the *vertical* field of view even though it lies horizontally on screen: any
 * viewport at least as wide as it is tall then has room to spare, which makes
 * this the conservative choice at every aspect ratio the page can produce.
 */
export function twoShotDistance(separation: number, fov: number): number {
  const halfAngle = (Math.max(fov, 1) * Math.PI) / 360;
  const needed = (separation / 2 + TWO_SHOT_MARGIN) / Math.tan(halfAngle);
  return Math.max(MIN_CAMERA_DISTANCE, needed);
}

/* -------------------------------------------------------------------------- */
/* The grammar                                                                 */
/* -------------------------------------------------------------------------- */

function dayFractionOf(tick: Tick): number {
  const withinDay = ((tick % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return withinDay / MINUTES_PER_DAY;
}

function isNight(tick: Tick): boolean {
  const fraction = dayFractionOf(tick);
  return fraction >= NIGHT_START_FRACTION || fraction < NIGHT_END_FRACTION;
}

function isTravel(basis: ShotBasis): boolean {
  return (
    basis.actionType === "move" ||
    basis.actionType === "attempt_escape" ||
    basis.activityState === "travelling" ||
    basis.from.x !== basis.to.x ||
    basis.from.y !== basis.to.y
  );
}

function isRest(basis: ShotBasis): boolean {
  return basis.activityState === "sleeping" || basis.actionType === "rest";
}

/**
 * Whether a segment is an inhabitant *doing* something.
 *
 * Disclosure alone does not answer this. The engine's `settleExpiredActivities`
 * makes `idle` a known state rather than an unknown one, so an interstitial
 * idle stretch is disclosed — a canonical statement that the inhabitant was
 * there and occupied with nothing. That is worth showing, but not worth
 * pushing in on, and not worth skipping the playhead to.
 */
function isRecordedActivity(segment: ChronicleSegment): boolean {
  return segment.disclosure !== "unrecorded" && segment.activityState !== "idle";
}

function isIdle(basis: ShotBasis): boolean {
  return basis.activityState === "idle";
}

function otherParticipant(basis: ShotBasis): string | null {
  for (const participant of basis.participants) {
    if (participant !== basis.subjectId) return participant;
  }
  return null;
}

function draft(
  kind: ShotKind,
  basis: ShotBasis,
  startTick: Tick,
  endTick: Tick,
  ordinal: number,
  reason: string,
  options: { readonly anchor?: Vec2; readonly secondarySubjectId?: string } = {},
): Draft {
  // Seeded from the canonical source rather than from the shot's final window,
  // so merging a neighbouring shot cannot rotate this one's azimuth.
  const seed = `${basis.sourceId}|${kind}|${ordinal}|${basis.subjectId}`;
  const framing = framingFor(kind, seed);
  return {
    kind,
    startTick,
    endTick,
    subjectId: basis.subjectId,
    secondarySubjectId: options.secondarySubjectId ?? null,
    anchor: options.anchor ?? null,
    framing,
    motion: KIND_DEFAULTS[kind].motion,
    reason,
    sourceId: basis.sourceId,
    anchorHint: basis.to,
  };
}

/**
 * Where to split a long basis so its last third gets a second angle.
 * Returns null when either piece would fall below the minimum shot length.
 */
function lastThirdBoundary(startTick: Tick, endTick: Tick): Tick | null {
  const span = endTick - startTick;
  if (span < LONG_SEGMENT_MINUTES) return null;
  const boundary = endTick - span / 3;
  if (boundary - startTick < MIN_SHOT_MINUTES) return null;
  if (endTick - boundary < MIN_SHOT_MINUTES) return null;
  return boundary;
}

function draftsForBasis(basis: ShotBasis): Draft[] {
  const { startTick, endTick } = basis;
  const minutes = Math.round(endTick - startTick);

  // Rule one, checked before anything else: an interval no canonical record
  // covers is held at a distance and never pushed into. `envelope_only` is not
  // caught here — see the disclosure note in the file header.
  if (basis.disclosure === "unrecorded") {
    const reason = `no canonical record covers ${minutes} sim minutes for ${basis.subjectId}`;
    const boundary = lastThirdBoundary(startTick, endTick);
    const distant = (kind: ShotKind, from: Tick, to: Tick, ordinal: number): Draft => {
      const made = draft(kind, basis, from, to, ordinal, reason, { anchor: basis.from });
      return {
        ...made,
        framing: { ...made.framing, distance: Math.max(made.framing.distance, DISTANT_FRAMING_DISTANCE) },
        // Never negative: the camera may drift back from an unrecorded stretch,
        // never in. A push-in is the grammar of revelation and there is nothing
        // here to reveal.
        motion: { ...made.motion, dollyRate: Math.max(made.motion.dollyRate, 0) },
      };
    };
    if (boundary === null) return [distant("WIDE_FOLLOW", startTick, endTick, 0)];
    return [
      distant("ESTABLISH", startTick, boundary, 0),
      distant("WIDE_FOLLOW", boundary, endTick, 1),
    ];
  }

  // An idle stretch is canonical and worth showing, and the world is idle 90% of
  // the time. It gets distance and slowness: wide when it is brief, an
  // establishing hold when it is long. Never CLOSE, never a working orbit —
  // those are the grammar of something happening.
  if (isIdle(basis)) {
    const kind: ShotKind = minutes >= LONG_SEGMENT_MINUTES ? "ESTABLISH" : "WIDE_FOLLOW";
    return [
      draft(
        kind,
        basis,
        startTick,
        endTick,
        0,
        `idle for ${minutes} sim minutes at (${basis.from.x}, ${basis.from.y})`,
        { anchor: basis.from },
      ),
    ];
  }

  const partner = otherParticipant(basis);
  if (partner !== null) {
    const separation = Math.hypot(basis.focusSeparationX, basis.focusSeparationY);
    const made = draft(
      "TWO_SHOT",
      basis,
      startTick,
      endTick,
      0,
      `${basis.activityState} with ${basis.participants.length} participants over ${minutes} sim minutes`,
      { secondarySubjectId: partner },
    );
    return [
      {
        ...made,
        framing: {
          ...made.framing,
          distance: twoShotDistance(separation, made.framing.fov),
        },
      },
    ];
  }

  if (isTravel(basis)) {
    const reason = `${basis.actionType} from (${basis.from.x}, ${basis.from.y}) to (${basis.to.x}, ${basis.to.y})`;
    // Both read the heading from behind; which one is a deterministic coin so
    // that a world of journeys is not a world of identical journeys.
    const behind: ShotKind = coinFlip(`${basis.sourceId}|travel`)
      ? "TRACKING_DOLLY"
      : "THIRD_PERSON_FOLLOW";
    const boundary = lastThirdBoundary(startTick, endTick);
    if (boundary === null) return [draft(behind, basis, startTick, endTick, 0, reason)];
    return [
      draft(behind, basis, startTick, boundary, 0, reason),
      draft("OVERHEAD_FOLLOW", basis, boundary, endTick, 1, `${reason}; route in full`),
    ];
  }

  if (isRest(basis)) {
    const kind: ShotKind = isNight(startTick) ? "ESTABLISH" : "STATIC_SITE";
    return [
      draft(
        kind,
        basis,
        startTick,
        endTick,
        0,
        `${basis.activityState} for ${minutes} sim minutes at (${basis.from.x}, ${basis.from.y})`,
        { anchor: basis.from },
      ),
    ];
  }

  const reason = `${basis.activityState} for ${minutes} sim minutes at (${basis.from.x}, ${basis.from.y})`;
  const boundary = lastThirdBoundary(startTick, endTick);
  if (boundary === null) return [draft("ORBIT", basis, startTick, endTick, 0, reason)];
  return [
    draft("ORBIT", basis, startTick, boundary, 0, reason),
    draft("CLOSE", basis, boundary, endTick, 1, `${reason}; final third`),
  ];
}

/* -------------------------------------------------------------------------- */
/* Building bases                                                              */
/* -------------------------------------------------------------------------- */

function basisFromSegment(segment: ChronicleSegment, startTick: Tick, endTick: Tick): ShotBasis {
  return {
    subjectId: segment.inhabitantId,
    participants: segment.participants,
    actionType: segment.actionType,
    activityState: segment.activityState,
    disclosure: segment.disclosure,
    from: segment.from,
    to: segment.to,
    startTick,
    endTick,
    sourceId: segment.id,
    reason: segment.caption,
    // The canonical point the activity is directed at is the best estimate of
    // where a second participant stood at planning time; resolvePose replaces
    // it with the sampled truth once both actors are on screen.
    focusSeparationX: segment.focus === null ? 0 : segment.focus.x - segment.from.x,
    focusSeparationY: segment.focus === null ? 0 : segment.focus.y - segment.from.y,
  };
}

function subjectBases(
  chronicle: Chronicle,
  subjectId: string,
  startTick: Tick,
  endTick: Tick,
): ShotBasis[] {
  const track = chronicle.byInhabitant.get(subjectId);
  if (track === undefined) return [];
  const bases: ShotBasis[] = [];
  for (const segment of track.segments) {
    const from = Math.max(segment.startTick, startTick);
    const to = Math.min(segment.endTick, endTick);
    if (to <= from) continue;
    bases.push(basisFromSegment(segment, from, to));
  }
  return bases;
}

/**
 * One thing the world feed could cut to: a beat, or a recorded activity that no
 * beat named.
 *
 * Beats rank cuts, but there is no guarantee the chronicle emits one per
 * activity — and at 9.2% occupancy the feed cannot afford to ignore an
 * inhabitant who is demonstrably mid-activity just because no beat marked them.
 * So the candidate list is the union, beats winning any collision, and every
 * candidate is by construction an inhabitant *doing* something.
 */
interface Candidate {
  readonly id: string;
  readonly startTick: Tick;
  readonly endTick: Tick;
  readonly weight: number;
  readonly basis: (from: Tick, to: Tick) => ShotBasis;
}

/** Total order: weight first, then the canonical tie-breaks. */
function betterCandidate(a: Candidate, b: Candidate): number {
  if (a.weight !== b.weight) return b.weight - a.weight;
  if (a.startTick !== b.startTick) return a.startTick - b.startTick;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Collision key: the same inhabitant occupied over the same interval. */
function occupancyKey(subjectId: string, startTick: Tick, endTick: Tick): string {
  return `${subjectId}@${startTick}:${endTick}`;
}

function worldCandidates(chronicle: Chronicle, startTick: Tick, endTick: Tick): Candidate[] {
  const byOccupancy = new Map<string, Candidate>();

  for (const beat of chronicle.beats) {
    if (beat.endTick <= startTick || beat.tick >= endTick) continue;
    if (beat.disclosure === "unrecorded") continue;
    byOccupancy.set(occupancyKey(beat.subjectId, beat.tick, beat.endTick), {
      id: beat.id,
      startTick: beat.tick,
      endTick: beat.endTick,
      weight: beat.weight,
      basis: (from, to) => ({
        subjectId: beat.subjectId,
        participants: beat.participants,
        actionType: beat.actionType,
        // A beat carries no activity state; the grammar falls back on the action.
        activityState: "",
        disclosure: beat.disclosure,
        from: beat.location,
        to: beat.location,
        startTick: from,
        endTick: to,
        sourceId: beat.id,
        reason: beat.reason,
        focusSeparationX: 0,
        focusSeparationY: 0,
      }),
    });
  }

  for (const track of chronicle.tracks) {
    for (const segment of track.segments) {
      if (segment.endTick <= startTick || segment.startTick >= endTick) continue;
      if (!isRecordedActivity(segment)) continue;
      const key = occupancyKey(segment.inhabitantId, segment.startTick, segment.endTick);
      if (byOccupancy.has(key)) continue;
      byOccupancy.set(key, {
        id: segment.id,
        startTick: segment.startTick,
        endTick: segment.endTick,
        // Below every beat: a beat is a canonical judgement that a moment is
        // notable, and an unmarked activity has made no such claim.
        weight: segment.participants.length > 1 ? 0.5 : 0,
        basis: (from, to) => basisFromSegment(segment, from, to),
      });
    }
  }

  return [...byOccupancy.values()].sort(betterCandidate);
}

/**
 * The world feed: at every tick, prefer an inhabitant who is mid-activity.
 *
 * Each slot runs at least `MIN_SHOT_MINUTES`, which is what stops the feed
 * ping-ponging between two inhabitants faster than a viewer can read. A
 * candidate is used at most once; while one is still running and nothing fresh
 * is available the current basis is extended rather than re-cut, so a
 * continuing activity does not produce a cut to itself.
 *
 * Stretches where nobody is active produce no basis at all. `fillWindow` covers
 * them with a single establishing hold over the settlement — see the occupancy
 * note in the file header for why that is the right picture rather than a
 * failure to find one.
 */
function worldBases(chronicle: Chronicle, startTick: Tick, endTick: Tick): ShotBasis[] {
  const candidates = worldCandidates(chronicle, startTick, endTick);
  const used = new Set<string>();
  const bases: ShotBasis[] = [];
  let cursor = startTick;

  for (let slot = 0; slot < MAX_WORLD_SLOTS && cursor < endTick; slot++) {
    const running = candidates.filter((candidate) => candidate.endTick > cursor);
    const chosen = running.find(
      (candidate) =>
        !used.has(candidate.id) && candidate.startTick <= cursor + WORLD_LOOKAHEAD_MINUTES,
    );

    if (chosen === undefined) {
      const nextStart = running.reduce<number | null>(
        (soonest, candidate) =>
          candidate.startTick > cursor && (soonest === null || candidate.startTick < soonest)
            ? candidate.startTick
            : soonest,
        null,
      );
      const target = Math.min(endTick, nextStart ?? endTick);
      const holding = running.some((candidate) => candidate.startTick <= cursor);
      const previous = bases[bases.length - 1];
      if (holding && previous !== undefined && target > previous.endTick) {
        previous.endTick = target;
      }
      cursor = target > cursor ? target : endTick;
      continue;
    }

    used.add(chosen.id);
    const natural = Math.min(chosen.endTick, cursor + WORLD_SHOT_MINUTES);
    const slotEnd = Math.min(endTick, Math.max(cursor + MIN_SHOT_MINUTES, natural));
    bases.push(chosen.basis(cursor, slotEnd));
    cursor = slotEnd;
  }
  return bases;
}

/**
 * The centre of recorded life in the window, in tiles.
 *
 * Where the camera goes when nobody is doing anything: the mean of the places
 * things have been happening, which is as close as a projection layer can
 * honestly get to "the settlement" without inventing a notion of one.
 */
function settlementAnchor(chronicle: Chronicle, startTick: Tick, endTick: Tick): Vec2 | null {
  let x = 0;
  let y = 0;
  let count = 0;
  for (const track of chronicle.tracks) {
    for (const segment of track.segments) {
      if (segment.endTick <= startTick || segment.startTick >= endTick) continue;
      if (!isRecordedActivity(segment)) continue;
      x += segment.from.x;
      y += segment.from.y;
      count++;
    }
  }
  if (count === 0) {
    for (const beat of chronicle.beats) {
      if (beat.endTick <= startTick || beat.tick >= endTick) continue;
      x += beat.location.x;
      y += beat.location.y;
      count++;
    }
  }
  return count === 0 ? null : { x: x / count, y: y / count };
}

/* -------------------------------------------------------------------------- */
/* Reconciling the plan                                                        */
/* -------------------------------------------------------------------------- */

function fallbackDraft(
  subjectId: string,
  anchor: Vec2 | null,
  startTick: Tick,
  endTick: Tick,
  sourceId: string,
): Draft {
  const kind: ShotKind = anchor === null ? "FALLBACK_REFERENCE" : "ESTABLISH";
  const seed = `${sourceId}|${kind}|${subjectId}`;
  return {
    kind,
    startTick,
    endTick,
    subjectId,
    secondarySubjectId: null,
    anchor,
    framing: framingFor(kind, seed),
    motion: KIND_DEFAULTS[kind].motion,
    reason:
      anchor === null
        ? "no canonical spatial anchor resolves for this interval"
        : "no canonical activity covers this interval",
    sourceId,
    anchorHint: anchor,
  };
}

/**
 * Cover every minute of the window, holding one establishing shot over each
 * stretch no basis claimed.
 *
 * One shot per hole, however long the hole: at a median gap of 300 sim minutes
 * this is the difference between a slow wide landscape and a slideshow of
 * angles on a world where nothing is happening.
 *
 * The world feed anchors those holds on the settlement, because the point of
 * the shot is the place rather than any particular inhabitant. A subject feed
 * anchors on wherever its subject last was, falling back to the settlement.
 */
function fillWindow(
  drafts: readonly Draft[],
  startTick: Tick,
  endTick: Tick,
  subjectId: string,
  settlement: Vec2 | null,
  followSubject: boolean,
): Draft[] {
  const out: Draft[] = [];
  let cursor = startTick;
  const holdAnchor = (next: Draft | undefined): Vec2 | null => {
    if (!followSubject) return settlement;
    return out[out.length - 1]?.anchorHint ?? next?.anchorHint ?? settlement;
  };
  for (const item of drafts) {
    if (item.startTick > cursor) {
      out.push(fallbackDraft(subjectId, holdAnchor(item), cursor, item.startTick, `gap@${cursor}`));
    }
    out.push({ ...item });
    cursor = Math.max(cursor, item.endTick);
  }
  if (cursor < endTick) {
    out.push(fallbackDraft(subjectId, holdAnchor(undefined), cursor, endTick, `gap@${cursor}`));
  }
  return out;
}

/** Turn the first shot of a sequence into, or precede it with, an `ESTABLISH`. */
function openWithEstablish(drafts: Draft[]): Draft[] {
  const first = drafts[0];
  if (first === undefined || first.kind === "ESTABLISH") return drafts;
  const span = first.endTick - first.startTick;
  const seed = `${first.sourceId}|ESTABLISH|open|${first.subjectId}`;
  const opener: Draft = {
    kind: "ESTABLISH",
    startTick: first.startTick,
    endTick: first.startTick + ESTABLISH_MINUTES,
    subjectId: first.subjectId,
    secondarySubjectId: null,
    anchor: first.anchor,
    framing: framingFor("ESTABLISH", seed),
    motion: KIND_DEFAULTS.ESTABLISH.motion,
    reason: `opening the sequence on ${first.subjectId}`,
    sourceId: first.sourceId,
    anchorHint: first.anchorHint,
  };
  if (span < ESTABLISH_MINUTES + MIN_SHOT_MINUTES) {
    // Too short to carry both: the whole of it establishes.
    return [{ ...opener, endTick: first.endTick }, ...drafts.slice(1)];
  }
  return [opener, { ...first, startTick: opener.endTick }, ...drafts.slice(1)];
}

/**
 * Make the plan contiguous, sorted, non-overlapping and never below the minimum
 * shot length.
 *
 * A short shot extends *forward* into what follows rather than being deleted:
 * an activity resolved in five sim minutes still deserves to be seen, and
 * holding the frame after the action completes is how that is done on film.
 * A shot the extension has swallowed entirely is dropped.
 */
function enforceMinimum(drafts: readonly Draft[], startTick: Tick, endTick: Tick): Draft[] {
  const out: Draft[] = [];
  for (const item of drafts) {
    const previous = out[out.length - 1];
    const next: Draft = { ...item };
    next.startTick = previous === undefined ? startTick : previous.endTick;
    if (next.endTick > endTick) next.endTick = endTick;
    if (next.endTick <= next.startTick) continue;
    if (next.endTick - next.startTick < MIN_SHOT_MINUTES) {
      next.endTick = Math.min(next.startTick + MIN_SHOT_MINUTES, endTick);
    }
    out.push(next);
  }
  // The tail can still fall short when the window itself ran out; it merges
  // backwards, which is the only direction left.
  while (out.length > 1) {
    const last = out[out.length - 1];
    if (last === undefined || last.endTick - last.startTick >= MIN_SHOT_MINUTES) break;
    out.pop();
    const previous = out[out.length - 1];
    if (previous !== undefined) previous.endTick = last.endTick;
  }
  const first = out[0];
  const final = out[out.length - 1];
  if (first !== undefined) first.startTick = startTick;
  if (final !== undefined) final.endTick = endTick;
  return out;
}

/**
 * A hard cut whenever the subject or the canonical source changes; an ease
 * between two angles on the same stretch of the same life, which is where an
 * ease reads as a considered move rather than as a mistake.
 */
function transitionFor(item: Draft, previous: Draft | undefined): Transition {
  if (previous === undefined) return "CUT";
  if (previous.sourceId === item.sourceId) return "EASE";

  // Nearby beats belong to the same piece of observed space. Gliding between
  // them preserves geography and avoids turning a busy settlement into a
  // slideshow merely because editorial focus passed to another inhabitant.
  // Distant beats still cut: flying the camera across the map would falsely
  // read as travel and is more disorienting than an honest edit.
  const from = previous.anchorHint;
  const to = item.anchorHint;
  if (from !== null && to !== null && Math.hypot(to.x - from.x, to.y - from.y) <= 6) {
    return "EASE";
  }
  return "CUT";
}

function toShot(item: Draft, index: number, previous: Draft | undefined): Shot {
  return {
    id: `shot-${String(index).padStart(4, "0")}-${item.subjectId}-${item.kind}`,
    kind: item.kind,
    startTick: item.startTick,
    endTick: item.endTick,
    subjectId: item.subjectId,
    secondarySubjectId: item.secondarySubjectId,
    anchor: item.anchor,
    framing: item.framing,
    motion: item.motion,
    transition: transitionFor(item, previous),
    reason: item.reason,
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function planShots(input: {
  chronicle: Chronicle;
  subjectId: string | null;
  startTick: Tick;
  endTick: Tick;
}): ShotPlan {
  const { chronicle, subjectId, startTick, endTick } = input;
  if (!(endTick > startTick)) {
    return { subjectId, startTick, endTick, shots: [] };
  }

  const bases =
    subjectId === null
      ? worldBases(chronicle, startTick, endTick)
      : subjectBases(chronicle, subjectId, startTick, endTick);

  // Something has to own the stretches no basis covers. Preferring the plan's
  // own subject keeps a subject feed on its subject even before it was born.
  const fallbackSubject = subjectId ?? bases[0]?.subjectId ?? chronicle.tracks[0]?.inhabitantId ?? "";
  const settlement = settlementAnchor(chronicle, startTick, endTick) ?? bases[0]?.from ?? null;

  const drafted = bases.flatMap(draftsForBasis);
  const filled = fillWindow(
    drafted,
    startTick,
    endTick,
    fallbackSubject,
    settlement,
    subjectId !== null,
  );
  const opened = openWithEstablish(filled);
  const reconciled = enforceMinimum(opened, startTick, endTick);

  const shots = reconciled.map((item, index) => toShot(item, index, reconciled[index - 1]));
  return { subjectId, startTick, endTick, shots };
}

/**
 * The shot covering `tick`, or null outside the plan.
 *
 * Half-open intervals, except at the very end of the plan: the final tick
 * belongs to the final shot so that a paused playhead parked on the last frame
 * still resolves a camera.
 */
export function shotAt(plan: ShotPlan, tick: Tick): Shot | null {
  const shots = plan.shots;
  if (shots.length === 0) return null;
  if (tick < plan.startTick || tick > plan.endTick) return null;
  let low = 0;
  let high = shots.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const shot = shots[mid];
    if (shot === undefined) break;
    if (tick < shot.startTick) high = mid - 1;
    else if (tick >= shot.endTick) low = mid + 1;
    else return shot;
  }
  const last = shots[shots.length - 1];
  return last !== undefined && tick === last.endTick ? last : null;
}

function actorIn(frame: WorldFrame, inhabitantId: string | null) {
  if (inhabitantId === null) return null;
  for (const actor of frame.actors) {
    if (actor.inhabitantId === inhabitantId) return actor;
  }
  return null;
}

/**
 * The last resort, matching the fallback order in
 * docs/observatory-architecture.md §7: third person, wide, overhead, reference
 * view. Targets the centroid of whoever is on screen so the reference view is
 * still a view of the world rather than of its origin.
 */
function referencePose(frame: WorldFrame, shotId: string): CameraPose {
  const present = frame.actors.filter((actor) => actor.present);
  let x = 0;
  let z = 0;
  for (const actor of present) {
    x += actor.position.x;
    z += actor.position.y;
  }
  const count = present.length === 0 ? 1 : present.length;
  const target: Vec3 = { x: x / count, y: ANCHOR_TARGET_HEIGHT, z: z / count };
  const base = KIND_DEFAULTS.FALLBACK_REFERENCE;
  return {
    position: {
      x: target.x + Math.cos(base.azimuth) * base.distance,
      y: Math.max(MIN_CAMERA_HEIGHT, base.height),
      z: target.z + Math.sin(base.azimuth) * base.distance,
    },
    target,
    fov: base.fov,
    shotId,
    kind: "FALLBACK_REFERENCE",
    cut: false,
  };
}

/**
 * Resolve the camera for one instant.
 *
 * Renderer space is metres with tile `(x, y)` at `(x, 0, y)` — canonical y is
 * renderer z, matching `reference-registry.ts`, which is the mapping the rest
 * of the Observatory already uses.
 */
export function resolvePose(plan: ShotPlan, frame: WorldFrame, tick: Tick): CameraPose {
  const shot = shotAt(plan, tick);
  if (shot === null) return referencePose(frame, "fallback-reference");

  const span = shot.endTick - shot.startTick;
  const elapsed = Math.min(Math.max(tick - shot.startTick, 0), span);

  const subject = actorIn(frame, shot.subjectId);
  const secondary = actorIn(frame, shot.secondarySubjectId);
  const twoShot = shot.kind === "TWO_SHOT" && secondary !== null && secondary.present;

  let targetTile: Vec2 | null = null;
  let facing = 0;
  let lineAngle: number | null = null;
  let separation = 0;

  if (twoShot && subject !== null && subject.present && secondary !== null) {
    targetTile = {
      x: (subject.position.x + secondary.position.x) / 2,
      y: (subject.position.y + secondary.position.y) / 2,
    };
    const dx = secondary.position.x - subject.position.x;
    const dy = secondary.position.y - subject.position.y;
    separation = Math.hypot(dx, dy);
    lineAngle = Math.atan2(dy, dx);
  } else if (subject !== null && subject.present) {
    targetTile = subject.position;
    facing = subject.facing;
  } else if (shot.anchor !== null) {
    targetTile = shot.anchor;
  }

  if (targetTile === null) {
    // The subject is not on screen and the shot names no fixed point: there is
    // nothing to look at, so the reference view is the honest answer.
    return { ...referencePose(frame, shot.id), cut: isCut(shot, tick) };
  }

  const anchored = subject === null || !subject.present;
  const fov = shot.framing.fov;
  const plannedDistance = twoShot ? twoShotDistance(separation, fov) : shot.framing.distance;

  // Motion rates are integrated over the whole shot, and a quiet world can hand
  // a single ESTABLISH a thousand sim minutes. Both axes are clamped at each end
  // so a long hold drifts to a stated limit instead of leaving the map.
  const distance = Math.min(
    MAX_CAMERA_DISTANCE,
    Math.max(MIN_CAMERA_DISTANCE, plannedDistance + shot.motion.dollyRate * elapsed),
  );
  const height = Math.min(
    MAX_CAMERA_HEIGHT,
    Math.max(MIN_CAMERA_HEIGHT, shot.framing.height + shot.motion.craneRate * elapsed),
  );

  let azimuth = shot.framing.azimuth + shot.motion.orbitRate * elapsed;
  if (lineAngle !== null) {
    // Perpendicular to the line between the two, which is the 180-degree setup;
    // the framing azimuth chooses and holds one side of that line.
    azimuth += lineAngle + Math.PI / 2;
  } else if (shot.framing.relativeToSubject) {
    azimuth += facing;
  }

  const target: Vec3 = {
    x: targetTile.x,
    y: anchored ? ANCHOR_TARGET_HEIGHT : SUBJECT_TARGET_HEIGHT,
    z: targetTile.y,
  };

  return {
    position: {
      x: target.x + Math.cos(azimuth) * distance,
      y: Math.max(MIN_CAMERA_HEIGHT, height),
      z: target.z + Math.sin(azimuth) * distance,
    },
    target,
    fov,
    shotId: shot.id,
    kind: shot.kind,
    cut: isCut(shot, tick),
  };
}

function isCut(shot: Shot, tick: Tick): boolean {
  return shot.transition === "CUT" && tick - shot.startTick < CUT_WINDOW_MINUTES;
}
