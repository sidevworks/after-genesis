/**
 * The Cinema contract — a continuous, watchable projection of canonical history.
 *
 * ## Why this layer exists
 *
 * The canonical world is a sequence of discrete resolved events. Each one says
 * *what changed* at a sim-minute. It does not say what the world looked like
 * between two of them, which is precisely what watching requires. The Chronicle
 * turns the discrete record into a continuous one: for any fractional sim-minute
 * it can answer "where was every inhabitant, what were they doing, and how far
 * through it were they".
 *
 * ## The boundary this layer must never cross
 *
 * Every value here is either copied from canonical state or derived by a pure,
 * deterministic, documented rule over canonical state. Nothing is invented to
 * make the result more watchable.
 *
 *   - A position between two canonical positions is **interpolated**, and marked
 *     as such. The engine recorded that an inhabitant walked from A to B over
 *     40 minutes; showing them halfway at minute 20 is reading the record, not
 *     embellishing it.
 *   - Time an inhabitant spent in an activity whose contents were withheld is
 *     shown as *occupied and undisclosed* — never as invented behaviour, and
 *     never as an empty gap that implies they did nothing.
 *   - Gait, gesture, camera movement, lighting and tree placement are
 *     presentation. They carry `derived: true` and the UI must label them.
 *
 * claude.md §12: "Generated media must be clearly distinguishable from canonical
 * world actions." claude.md §11G: the canonical log describes events neutrally;
 * interpretation belongs to inhabitants, not to the renderer.
 *
 * ## Ownership
 *
 * This file is the contract between four independent implementations:
 *
 *   chronicle.ts  — canonical record  →  continuous tracks and frames
 *   director.ts   — tracks            →  a shot plan and per-tick camera poses
 *   lib/stage/*   — frames + poses    →  three.js rendering (no React)
 *   components/cinema/* — the React transport, captions and provenance UI
 *
 * Nothing in this file may import three.js, React, or Node built-ins.
 */

/** A sim-time minute. Fractional between canonical instants. */
export type Tick = number;

/** Minutes in one world day. Canonical: see packages/core/src/time.ts. */
export const MINUTES_PER_DAY = 1440;

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/* -------------------------------------------------------------------------- */
/* Disclosure                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How much of a stretch of an inhabitant's life the Observatory may show.
 *
 * The distinction is load-bearing. `envelope_only` is the honest rendering of
 * "we know they were here doing something for this long, and we do not know
 * what" — it must look different on screen from `disclosed`, and must never be
 * silently upgraded to it.
 */
export type Disclosure =
  /** Canonical contents are public or local: the action may be depicted. */
  | "disclosed"
  /** Canonical envelope only: occupied time, undisclosed contents. */
  | "envelope_only"
  /** No canonical record covers this interval for this inhabitant. */
  | "unrecorded";

/* -------------------------------------------------------------------------- */
/* Chronicle — the continuous projection                                       */
/* -------------------------------------------------------------------------- */

/**
 * One contiguous stretch of one inhabitant's life.
 *
 * Segments within a track are sorted, non-overlapping and gapless: consecutive
 * segments satisfy `previous.endTick === next.startTick`. Gaps in the canonical
 * record become explicit `unrecorded` segments rather than holes, so that
 * sampling any tick in the track's lifetime always yields a defined state.
 */
export interface ChronicleSegment {
  /** Deterministic and stable across rebuilds. */
  readonly id: string;
  readonly inhabitantId: string;
  /** Canonical activity id, or null for a synthesised gap segment. */
  readonly activityId: string | null;
  /** Canonical event sequence, or null for a synthesised gap segment. */
  readonly sequence: number | null;
  /** Canonical action type, or "unrecorded" for a synthesised gap segment. */
  readonly actionType: string;
  /** Canonical `ActivityState`, or "unrecorded". */
  readonly activityState: string;
  readonly startTick: Tick;
  /** Always `>= startTick`. Zero-length canonical activities are widened to the minimum. */
  readonly endTick: Tick;
  /** Canonical position at `startTick`. */
  readonly from: Vec2;
  /** Canonical position at `endTick`. Equal to `from` for stationary activities. */
  readonly to: Vec2;
  /**
   * Canonical movement polyline, including origin and destination. Present
   * only for disclosed moves whose event recorded its resolved route.
   */
  readonly route?: readonly Vec2[];
  /**
   * A second canonical point the activity is directed at — the tile a gather
   * drew from, the tile a conversation partner stood on. Drives where the actor
   * turns to face. Null when the record names none.
   */
  readonly focus: Vec2 | null;
  /** Sorted canonical participant ids. Length > 1 means a shared activity. */
  readonly participants: readonly string[];
  readonly disclosure: Disclosure;
  /** Canonical event visibility kind, or null for a synthesised segment. */
  readonly visibility: string | null;
  readonly outcomeStatus: string | null;
  /** Canonical resolution detail. Always null unless `disclosure === "disclosed"`. */
  readonly detail: Readonly<Record<string, unknown>> | null;
  /**
   * A neutral factual sentence built only from canonical fields — no adjectives,
   * no motive, no interpretation (claude.md §11G). For `envelope_only` this
   * states that the contents are withheld rather than guessing at them.
   */
  readonly caption: string;
}

export interface ChronicleTrack {
  readonly inhabitantId: string;
  readonly displayName: string;
  readonly refId: string | null;
  readonly bornTick: Tick;
  /** Null while the inhabitant is alive in the exported record. */
  readonly diedTick: Tick | null;
  readonly segments: readonly ChronicleSegment[];
}

/**
 * A moment the world feed can cut to.
 *
 * `weight` ranks beats for automatic shot selection. It is computed from
 * canonical facts only — how many participants, whether the activity was shared,
 * whether it was the first of its kind — never from how dramatic it would look.
 */
export interface ChronicleBeat {
  readonly id: string;
  readonly tick: Tick;
  readonly endTick: Tick;
  readonly subjectId: string;
  readonly participants: readonly string[];
  readonly actionType: string;
  readonly location: Vec2;
  readonly disclosure: Disclosure;
  readonly weight: number;
  /** Why the projection considers this notable. Shown in the UI as derived. */
  readonly reason: string;
}

export interface Chronicle {
  readonly worldId: string;
  readonly startTick: Tick;
  readonly endTick: Tick;
  readonly tracks: readonly ChronicleTrack[];
  readonly byInhabitant: ReadonlyMap<string, ChronicleTrack>;
  readonly beats: readonly ChronicleBeat[];
  /** Ticks at which any canonical activity starts. Drives scrubbing to a cut. */
  readonly cutTicks: readonly Tick[];
}

/* -------------------------------------------------------------------------- */
/* Frames — what the renderer draws                                            */
/* -------------------------------------------------------------------------- */

/**
 * One inhabitant, sampled at one fractional tick.
 *
 * `position` may be interpolated between canonical endpoints; `interpolated`
 * says whether it was. `progress` is the fraction of the current segment
 * elapsed, which is what drives an animation clip's phase.
 */
export interface ActorSample {
  readonly inhabitantId: string;
  readonly displayName: string;
  readonly refId: string | null;
  /** World tile coordinates, fractional. */
  readonly position: Vec2;
  /** Radians. 0 faces +x. Derived from movement direction or `focus`. */
  readonly facing: number;
  /** Tiles per minute along the segment. 0 when stationary. */
  readonly speed: number;
  readonly activityState: string;
  readonly actionType: string;
  /** 0..1 through the current segment. */
  readonly progress: number;
  readonly disclosure: Disclosure;
  readonly segment: ChronicleSegment;
  /** False before birth and after death: the actor is not drawn. */
  readonly present: boolean;
  readonly interpolated: boolean;
}

export interface WorldFrame {
  readonly tick: Tick;
  readonly day: number;
  /** 0..1 through the world day. 0 is midnight. Drives the sun and sky. */
  readonly dayFraction: number;
  readonly actors: readonly ActorSample[];
}

/* -------------------------------------------------------------------------- */
/* Performance — how an action is depicted                                     */
/* -------------------------------------------------------------------------- */

/**
 * The animation clips the actor rig can play.
 *
 * Every clip is a body posture, not a story. `undisclosed` is the clip for
 * occupied-but-withheld time: a present, plausibly-occupied figure that
 * deliberately depicts no identifiable task.
 */
export type ClipName =
  | "idle"
  | "walk"
  | "harvest"
  | "drink"
  | "eat"
  | "sleep"
  | "sit"
  | "talk"
  | "listen"
  | "build"
  | "craft"
  | "write"
  | "read"
  | "teach"
  | "study"
  | "examine"
  | "carry"
  | "reach"
  | "perform"
  | "guard"
  | "restrained"
  | "undisclosed"
  | "unknown";

/** A prop the rig may hold. Presentation only. */
export type PropName = "none" | "bundle" | "vessel" | "tool" | "tablet" | "instrument";

/**
 * How one canonical action type is depicted.
 *
 * Every field is presentation metadata. `derived` is always true and exists so
 * that no consumer can mistake this for canonical fact.
 */
export interface PerformanceSpec {
  readonly clip: ClipName;
  readonly prop: PropName;
  /** Whether the actor travels along `from → to` or stays put. */
  readonly locomotion: "path" | "stationary";
  /** Whether the actor turns to face `focus` rather than the direction of travel. */
  readonly faceFocus: boolean;
  /** Cycles per minute of sim time for looping clips. */
  readonly cycleRate: number;
  readonly derived: true;
}

/* -------------------------------------------------------------------------- */
/* Director — camera choreography                                              */
/* -------------------------------------------------------------------------- */

export type ShotKind =
  /** High, slow, wide. Opens a sequence or covers a long stationary stretch. */
  | "ESTABLISH"
  /** Behind and above the subject, following their heading. */
  | "THIRD_PERSON_FOLLOW"
  /** Loose, further back, holds surroundings in frame. */
  | "WIDE_FOLLOW"
  /** Straight down. Reads paths and spatial relationships. */
  | "OVERHEAD_FOLLOW"
  /** Circles a stationary subject at working distance. */
  | "ORBIT"
  /** Tight on the subject's upper body during detailed work. */
  | "CLOSE"
  /** Frames two participants of a shared activity together. */
  | "TWO_SHOT"
  /** Camera translates alongside a moving subject. */
  | "TRACKING_DOLLY"
  /** Locked off on a location, subject may enter and leave frame. */
  | "STATIC_SITE"
  /** No spatial anchor resolves: the reference view. */
  | "FALLBACK_REFERENCE";

export type Transition = "CUT" | "EASE";

export interface ShotFraming {
  /** Metres from the look-at target. */
  readonly distance: number;
  /** Metres above the ground plane at the target. */
  readonly height: number;
  /** Radians. Relative to the subject's facing when `relativeToSubject`. */
  readonly azimuth: number;
  readonly relativeToSubject: boolean;
  /** Vertical field of view in degrees. Longer lens = smaller number. */
  readonly fov: number;
}

export interface ShotMotion {
  /** Radians of azimuth per sim minute. Signed. */
  readonly orbitRate: number;
  /** Metres of distance change per sim minute. Negative pushes in. */
  readonly dollyRate: number;
  /** Metres of height change per sim minute. */
  readonly craneRate: number;
}

export interface Shot {
  readonly id: string;
  readonly kind: ShotKind;
  readonly startTick: Tick;
  readonly endTick: Tick;
  readonly subjectId: string;
  readonly secondarySubjectId: string | null;
  /** Fixed world point for STATIC_SITE and ESTABLISH. Null means track the subject. */
  readonly anchor: Vec2 | null;
  readonly framing: ShotFraming;
  readonly motion: ShotMotion;
  readonly transition: Transition;
  /** Which canonical fact prompted this shot. Displayed as derived reasoning. */
  readonly reason: string;
}

export interface ShotPlan {
  readonly subjectId: string | null;
  readonly startTick: Tick;
  readonly endTick: Tick;
  readonly shots: readonly Shot[];
}

/** Camera coordinates are renderer-space metres: +x east, +y up, +z south. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A fully resolved camera at one instant, ready to apply to a three.js camera.
 * Contains no engine reference: the camera cannot act on the world, and the
 * world cannot perceive the camera (claude.md §20, observatory-architecture §7).
 */
export interface CameraPose {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly fov: number;
  readonly shotId: string;
  readonly kind: ShotKind;
  /** True on the first frame of a hard cut, so the rig skips its smoothing. */
  readonly cut: boolean;
}

/* -------------------------------------------------------------------------- */
/* Playback                                                                    */
/* -------------------------------------------------------------------------- */

/** Sim minutes advanced per real second. 60 ≈ one world hour per second. */
export type PlaybackRate = number;

export const PLAYBACK_RATES: readonly { readonly label: string; readonly rate: PlaybackRate }[] = [
  { label: "1×", rate: 1 },
  { label: "10×", rate: 10 },
  { label: "60×", rate: 60 },
  { label: "240×", rate: 240 },
  { label: "1440×", rate: 1440 },
];

export interface PlaybackState {
  readonly tick: Tick;
  readonly rate: PlaybackRate;
  readonly playing: boolean;
}
