/**
 * Clips — body postures as pure functions of phase, sim time and identity.
 *
 * ## What this file is
 *
 * Every function here maps a clip and a moment to a set of joint rotations.
 * There is no three.js here, no scene, no mutable state, no time source: a clip
 * is a mathematical curve, and `actor.ts` is the only thing that knows how to
 * hang a mesh off one. That split exists so the animation craft — the part a
 * reader judges instantly and a test usually cannot — can be exercised in a
 * node process with no WebGL.
 *
 * ## What this file is not
 *
 * None of this is canonical. The engine records that an inhabitant gathered
 * from a tile over forty minutes; it records nothing about how they stood, what
 * they did with their arms, or whether they crouched. Gait and gesture are
 * presentation and are labelled `derived: true` all the way up the chain
 * (cinema/types.ts, `PerformanceSpec`). claude.md §12 requires generated media
 * to stay clearly distinguishable from canonical world actions — so the rule
 * this file follows is: a clip may depict *that* an activity was happening at a
 * plausible tempo, and may never depict a specific fact the record does not
 * contain.
 *
 * ## Why `idle` is the most important clip here
 *
 * Measured against the exported run: only about 9% of inhabitant-time is
 * covered by a recorded activity. The median gap between one inhabitant's
 * activities is around five sim-hours. Those gaps are not holes — the engine's
 * activity settlement returns an inhabitant to `idle` at a known location, so
 * the canonical state during them is known and is exactly `idle`.
 *
 * Which means a spectator spends roughly nine tenths of their watching time
 * looking at `idle`. It carries the whole realism budget of the scene, and it
 * gets the treatment to match: breathing, slow weight transfer, infrequent
 * head turns, settled arms, and per-inhabitant posture so that three figures
 * standing in a field are three people rather than three copies of one mesh.
 *
 * What it must *not* do is imply an activity. No leaning on a tool, no sitting,
 * no dozing, no looking busy. The canonical state is "idle at a location" and
 * the body must read as present and unoccupied — anything more specific would
 * be a claim the record does not make (§11G: interpretation belongs to
 * inhabitants, not to the renderer).
 *
 * ## The `undisclosed` rule (claude.md §11E, §12)
 *
 * `envelope_only` time is "occupied, contents withheld". Its clip is the one
 * place in this renderer where a stylistic choice would be a privacy failure:
 * an inhabitant whose activity was withheld must not be drawn crouching (which
 * reads as gathering), gesturing (which reads as conversation), or bent over a
 * surface (which reads as making something). `undisclosed` therefore holds
 * *every* joint at exactly zero at every phase, takes no per-inhabitant
 * variation, and moves only the root, by about a centimetre, to breathe. That
 * is enforced by construction below and asserted in `clips.test.ts`, so no
 * future tuning pass can quietly give the posture a readable shape.
 *
 * ## Coordinate and sign convention
 *
 * These angles are ordinary three.js Euler angles in each joint's local frame,
 * applied in XYZ order and with no sign flips anywhere in `actor.ts`. The rig
 * faces its own local **−Z**, its local **+X** is the rig's right, and **+Y**
 * is up. Therefore, for a joint whose free end hangs or points away from its
 * pivot:
 *
 *   - `x > 0` swings the free end **forward** (toward −Z, the way the rig faces)
 *   - `y > 0` yaws it toward the rig's **left**
 *   - `z > 0` swings it toward the rig's **right**
 *
 * The right arm sits at local +X, so `armR.z > 0` lifts it away from the body
 * and `armR.z < 0` brings it across the chest; the left arm is the mirror.
 *
 * `root` is a translation in metres in the same local frame (`z` negative is
 * forward), applied to the whole figure. `rootTilt` rotates the whole figure —
 * only `sleep` uses it, to lie down.
 *
 * ## Looping and continuity
 *
 * Activity clips are cyclic in `phase`: `poseFor(clip, 0, …)` and
 * `poseFor(clip, 1, …)` agree to within floating-point noise, because the Stage
 * derives phase from sim time with `fract(tick × cycleRate)`, which wraps, and
 * any clip that did not close its loop would snap once per cycle.
 *
 * `idle` is the exception, and deliberately: its motion is periodic in **sim
 * time**, not in segment progress. Breathing that completed a fixed number of
 * cycles per activity segment would speed up or slow down according to how long
 * the inhabitant happened to stand there, which is nonsense. So `idle` reads
 * `tick` and ignores `phase`, and its continuity obligation is in tick instead.
 */

import type { ClipName } from "../cinema/types";

const TAU = Math.PI * 2;

/* -------------------------------------------------------------------------- */
/* Pose shape                                                                  */
/* -------------------------------------------------------------------------- */

export interface Joint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * One frame of one body.
 *
 * The rig is deliberately shallow — no knees, no elbows — because the voxel
 * figures are about 1.75 m tall on a 32 m map and a spectator will almost never
 * be close enough to miss the joints. Shallowness is also what keeps the pose
 * cheap enough to evaluate for every actor on every frame.
 */
export interface ActorPose {
  /** Whole-figure translation, metres, rig-local. */
  readonly root: Joint;
  /** Whole-figure rotation. Only `sleep` leaves this at anything but zero. */
  readonly rootTilt: Joint;
  /** Pelvis. Carries the torso; the legs hang from the figure root, not from here. */
  readonly hips: Joint;
  readonly torso: Joint;
  readonly head: Joint;
  readonly armL: Joint;
  readonly armR: Joint;
  readonly legL: Joint;
  readonly legR: Joint;
  /**
   * False when the clip forbids a held prop regardless of what the
   * `PerformanceSpec` asked for. Withheld and unrecorded time show nothing in
   * the hands, because a prop is a claim about what the inhabitant was doing.
   */
  readonly showProp: boolean;
}

type MutableJoint = { x: number; y: number; z: number };

interface MutablePose {
  root: MutableJoint;
  rootTilt: MutableJoint;
  hips: MutableJoint;
  torso: MutableJoint;
  head: MutableJoint;
  armL: MutableJoint;
  armR: MutableJoint;
  legL: MutableJoint;
  legR: MutableJoint;
  showProp: boolean;
}

function joint(): MutableJoint {
  return { x: 0, y: 0, z: 0 };
}

/** The neutral figure: standing, arms down, facing forward, nothing rotated. */
export function restPose(): MutablePose {
  return {
    root: joint(),
    rootTilt: joint(),
    hips: joint(),
    torso: joint(),
    head: joint(),
    armL: joint(),
    armR: joint(),
    legL: joint(),
    legR: joint(),
    showProp: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Per-inhabitant variation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How one inhabitant's body differs from the generic one.
 *
 * Derived from a hash of the inhabitant id, so it is stable for a lifetime,
 * identical for every spectator, and costs nothing to store. Nothing here is
 * canonical: the record contains no posture, and none of these numbers is ever
 * read back as a fact about the inhabitant. They exist for one reason — a field
 * of identical figures breathing in lockstep looks like a screensaver, and this
 * is the cheapest correction to that in the whole scene.
 *
 * All ranges are small on purpose. Variation must read as *individuality*, not
 * as a difference in condition: a spectator must never infer that one figure is
 * injured, elderly or impaired from how it stands, because the record does not
 * say so (§11E — private state does not become visible without a disclosure).
 */
export interface ActorVariation {
  /** Extra stance width, radians added to each leg's outward swing. */
  readonly stance: number;
  /** Habitual head tilt, radians. */
  readonly headTilt: number;
  /** Habitual head heading, radians. Where "straight ahead" sits for them. */
  readonly headBias: number;
  /** Multiplier on idle sway amplitude. */
  readonly sway: number;
  /** Multiplier on the breathing period. Some people breathe slower. */
  readonly breath: number;
  /** Multiplier on the interval between head turns. */
  readonly gaze: number;
  /** How far the arms hang from the body, radians. */
  readonly shoulder: number;
  /** 0..1 phase offset, so no two figures breathe or shift in unison. */
  readonly offset: number;
  /** Integer seed for the discrete gaze-target hash. */
  readonly seed: number;
}

/** The generic body. Used when no inhabitant identity is supplied. */
export const NEUTRAL_VARIATION: ActorVariation = {
  stance: 0,
  headTilt: 0,
  headBias: 0,
  sway: 1,
  breath: 1,
  gaze: 1,
  shoulder: 0,
  offset: 0,
  seed: 0,
};

/** FNV-1a over a string with a salt, mapped to 0..1. Deterministic, no state. */
function hashSeed(seed: string, salt: string): number {
  let hash = 0x811c9dc5;
  const combined = `${seed}:${salt}`;
  for (let index = 0; index < combined.length; index += 1) {
    hash = Math.imul(hash ^ combined.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0) / 0x100000000;
}

/** An integer mix, for discrete choices indexed by a counter. */
function hashInt(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ b, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

/**
 * Build one inhabitant's posture signature. Pure and cheap, but the Stage still
 * computes it once per rig rather than per frame.
 */
export function variationFor(inhabitantId: string): ActorVariation {
  const span = (salt: string, lo: number, hi: number): number =>
    lo + hashSeed(inhabitantId, salt) * (hi - lo);
  return {
    stance: span("stance", 0, 0.09),
    headTilt: span("tilt", -0.06, 0.06),
    headBias: span("bias", -0.13, 0.13),
    sway: span("sway", 0.7, 1.35),
    breath: span("breath", 0.82, 1.24),
    gaze: span("gaze", 0.72, 1.45),
    shoulder: span("shoulder", -0.04, 0.06),
    offset: hashSeed(inhabitantId, "offset"),
    seed: Math.floor(hashSeed(inhabitantId, "seed") * 0x7fffffff),
  };
}

/* -------------------------------------------------------------------------- */
/* Anatomical limits                                                           */
/* -------------------------------------------------------------------------- */

export interface JointLimit {
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
  readonly z: readonly [number, number];
}

/**
 * The range each joint may occupy, in radians (metres for `root`).
 *
 * These are stated rather than discovered: a clip that exceeds them is a bug,
 * and `poseFor` clamps rather than trusting the author. The figures should look
 * like bodies under load, never like broken puppets — a body bending the wrong
 * way would read as a malfunction of the world rather than of the renderer.
 *
 * `rootTilt.x` reaches slightly past −π/2 because `sleep` lies the whole figure
 * down; nothing else comes near it.
 */
export const JOINT_LIMITS: Readonly<Record<string, JointLimit>> = {
  root: { x: [-0.25, 0.25], y: [-1, 0.35], z: [-0.35, 0.35] },
  rootTilt: { x: [-1.62, 0.25], y: [-0.5, 0.5], z: [-0.4, 0.4] },
  hips: { x: [-0.5, 0.7], y: [-0.5, 0.5], z: [-0.35, 0.35] },
  torso: { x: [-0.7, 0.9], y: [-0.8, 0.8], z: [-0.5, 0.5] },
  head: { x: [-0.9, 0.9], y: [-1.2, 1.2], z: [-0.6, 0.6] },
  arm: { x: [-2.2, 2.2], y: [-0.8, 0.8], z: [-1.8, 1.8] },
  leg: { x: [-1.6, 1.6], y: [-0.5, 0.5], z: [-0.7, 0.7] },
};

function clamp(value: number, range: readonly [number, number]): number {
  return value < range[0] ? range[0] : value > range[1] ? range[1] : value;
}

function clampJoint(target: MutableJoint, limit: JointLimit): void {
  target.x = clamp(target.x, limit.x);
  target.y = clamp(target.y, limit.y);
  target.z = clamp(target.z, limit.z);
}

/* -------------------------------------------------------------------------- */
/* Curve helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Signed oscillation, −1 → +1 → −1, `cycles` times per phase revolution. */
function wave(phase: number, cycles = 1): number {
  return Math.sin(TAU * phase * cycles);
}

/**
 * Unsigned swell, 0 → 1 → 0, `cycles` times per phase revolution.
 *
 * This is the workhorse for every reach-and-return motion: it starts and ends
 * at rest with zero derivative, so a crouch, a bite or a hammer blow eases in
 * and out instead of snapping, and the clip closes its loop exactly.
 */
function swell(phase: number, cycles = 1): number {
  return (1 - Math.cos(TAU * phase * cycles)) / 2;
}

/** Hermite ease on 0..1, flat at both ends. */
function smoothstep01(t: number): number {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
}

/**
 * A soft square wave on −1..1: long holds at each extreme, smooth transfers
 * between them. This is the shape of standing weight, which is not a sine —
 * a person rests on one hip for a while, moves across, and rests again.
 * Smooth everywhere, so it never trips the continuity suite.
 */
function softSquare(cycles: number): number {
  const k = 2.6;
  return Math.tanh(k * Math.sin(TAU * cycles)) / Math.tanh(k);
}

/**
 * Tiles of sim-world travel per sim minute that counts as an ordinary walk.
 *
 * A canonical `move` covers a tile in roughly ten minutes, so 0.1 is the pace a
 * healthy inhabitant crossing open ground actually keeps in this world. It is
 * used only to scale the gait; it is not a rule and nothing canonical reads it.
 */
export const REFERENCE_WALK_SPEED = 0.1;

/**
 * Strides per phase revolution, as a function of speed.
 *
 * Frequency has to scale with speed or fast travel looks like a moonwalk. But
 * it must scale in **whole strides**, because a fractional stride count would
 * leave the legs mid-swing at phase 1 and pop on the wrap. So a faster
 * inhabitant takes more, shorter-period strides per cycle rather than a
 * continuously higher frequency, and the loop stays closed.
 */
export function strideCount(speed: number): number {
  const scaled = Math.round(1 + (2 * Math.max(speed, 0)) / REFERENCE_WALK_SPEED);
  return scaled < 1 ? 1 : scaled > 4 ? 4 : scaled;
}

/* -------------------------------------------------------------------------- */
/* Idle timing                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Sim minutes per breath.
 *
 * A real breath is four or five seconds. Sim time does not run at wall-clock
 * speed and the spectator chooses the ratio: the playback rates in the cinema
 * contract span 1× to 1440×. There is no period that reads correctly at all of
 * them, so this is tuned for **60×** — the contract's own "one world hour per
 * second" default. At 60×, 96 sim minutes is one breath every 1.6 real seconds,
 * which reads as calm breathing. At 1× it becomes an almost imperceptible
 * drift, which is the right answer for someone watching a single sim minute
 * unfold. At 1440× it blurs, which is also right: nobody is reading a chest at
 * a day per second.
 *
 * Stating the tuning target is the point. This is presentation, labelled
 * derived, and chosen for legibility rather than fidelity (claude.md §12).
 */
export const IDLE_BREATH_MINUTES = 96;

/** Sim minutes per full weight-shift cycle: hip to hip and back. */
export const IDLE_SHIFT_MINUTES = 900;

/** Sim minutes a gaze heading is held before the next one is chosen. */
export const IDLE_GAZE_MINUTES = 380;

/** Fraction of a gaze interval spent turning; the rest is the hold. */
const GAZE_TURN_FRACTION = 0.18;

/**
 * Where an idle inhabitant is looking at `tick`.
 *
 * Heads turn on a bucketed schedule: each interval picks a heading from a hash
 * of `(bucket, inhabitant seed)`, eases onto it over the first fifth of the
 * interval, and holds. Alternate buckets return to the inhabitant's habitual
 * forward, so the pattern reads as "glance away, hold, come back" rather than
 * as continuous scanning — which would look like searching, an activity the
 * record does not report.
 *
 * Continuous across bucket boundaries by construction: a bucket eases *from*
 * the heading the previous bucket ended on. Deterministic in `tick` and the
 * inhabitant id, never from a clock or a random source, so two spectators
 * scrubbed to the same sim minute see the same head.
 */
export function gazeHeading(tick: number, variation: ActorVariation): number {
  const interval = IDLE_GAZE_MINUTES * variation.gaze;
  const u = tick / interval + variation.offset;
  const bucket = Math.floor(u);
  const target = (index: number): number => {
    const parity = ((index % 2) + 2) % 2;
    if (parity === 0) return variation.headBias;
    return variation.headBias + (hashInt(index, variation.seed) - 0.5) * 1.3;
  };
  const from = target(bucket - 1);
  const to = target(bucket);
  return from + (to - from) * smoothstep01((u - bucket) / GAZE_TURN_FRACTION);
}

/* -------------------------------------------------------------------------- */
/* Clip inputs                                                                 */
/* -------------------------------------------------------------------------- */

interface ClipContext {
  /** 0..1 through the clip's cycle. Ignored by `idle`. */
  readonly phase: number;
  /** Tiles per sim minute. Only `walk` reads it. */
  readonly speed: number;
  /** Sim minute. Only clips with behaviour longer than one cycle read it. */
  readonly tick: number;
  readonly variation: ActorVariation;
}

type ClipFn = (ctx: ClipContext) => MutablePose;

/* -------------------------------------------------------------------------- */
/* The clips                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Standing in a place, for hours, alive.
 *
 * Four layers, all periodic in sim time and all desynchronised between
 * inhabitants by their variation offset:
 *
 *   1. breath — chest and shoulders rise, about a centimetre of lift;
 *   2. weight — a slow transfer hip to hip, the head counter-balancing it;
 *   3. gaze   — infrequent head turns, held, returning to habitual forward;
 *   4. settle — arms hanging with a small sway that trails the weight shift.
 *
 * Nothing here implies an occupation. There is no tool, no lean, no crouch and
 * no sag: the figure is unmistakably a person waiting, which is exactly what
 * the canonical `idle` state says and no more (§11G).
 */
const idle: ClipFn = ({ tick, variation }) => {
  const pose = restPose();

  const breathCycles = tick / (IDLE_BREATH_MINUTES * variation.breath) + variation.offset;
  const breath = (1 - Math.cos(TAU * breathCycles)) / 2;

  const shift = softSquare(tick / IDLE_SHIFT_MINUTES + variation.offset) * variation.sway;
  // The arms trail the hips slightly: an eighth of a cycle of lag is enough to
  // stop the whole body reading as one rigid piece.
  const trail = softSquare(tick / IDLE_SHIFT_MINUTES + variation.offset - 0.12) * variation.sway;

  const look = gazeHeading(tick, variation);

  // 1. Breath.
  pose.root.y = 0.012 * breath;
  pose.torso.x = 0.03 * breath;
  pose.armL.z = -0.02 * breath;
  pose.armR.z = 0.02 * breath;

  // 2. Weight transfer, and the head counter-balancing it.
  pose.root.x = 0.045 * shift;
  pose.hips.z = 0.05 * shift;
  pose.torso.z = 0.035 * shift;
  pose.head.z = -0.05 * shift;
  pose.legL.z = -0.03 - 0.035 * shift;
  pose.legR.z = 0.03 - 0.035 * shift;

  // 3. Gaze.
  pose.head.y = look;
  // A turned head takes a little of the shoulders with it.
  pose.torso.y = 0.16 * look;
  pose.head.x = -0.02 + 0.03 * breath;

  // 4. Arms settle.
  pose.armL.x = 0.04 * breath + 0.05 * trail;
  pose.armR.x = 0.04 * breath - 0.05 * trail;
  pose.armL.z += -0.07 - 0.03 * trail;
  pose.armR.z += 0.07 - 0.03 * trail;

  return pose;
};

/**
 * A stride: contralateral arm and leg swing, pelvis counter-rotating against
 * the shoulders, and a double hip bob — the body rises twice per stride pair,
 * once at each mid-stance. Amplitude and stride count both grow with speed, so
 * a hurrying inhabitant reads as hurrying rather than as the same walk sped up.
 */
const walk: ClipFn = ({ phase, speed }) => {
  const pose = restPose();
  const strides = strideCount(speed);
  const w = TAU * phase * strides;
  const swing = Math.sin(w);
  const gait = Math.min(Math.max(speed / REFERENCE_WALK_SPEED, 0), 1.4);
  const amp = 0.4 + 0.3 * gait;

  pose.legL.x = amp * swing;
  pose.legR.x = -amp * swing;
  // Arms oppose the legs on the same side: the signature of a real gait.
  pose.armL.x = -amp * 0.7 * swing;
  pose.armR.x = amp * 0.7 * swing;
  pose.armL.z = -0.1;
  pose.armR.z = 0.1;

  pose.hips.y = 0.09 * swing;
  pose.torso.y = -0.11 * swing;
  pose.torso.x = 0.05 + 0.09 * gait;
  pose.head.y = 0.04 * swing;
  pose.root.y = 0.035 * (0.5 - 0.5 * Math.cos(2 * w));
  pose.root.x = 0.018 * Math.cos(w);
  return pose;
};

/** Kneel, pick, and stow. Kept asymmetric to avoid a repetitive pelvic hinge. */
const harvest: ClipFn = ({ phase }) => {
  const pose = restPose();
  const kneel = smoothstep01(Math.min(phase * 3, 1)) *
    (1 - smoothstep01(Math.max((phase - 0.72) / 0.28, 0)));
  const pick = swell(Math.min(Math.max((phase - 0.2) / 0.48, 0), 1));
  const stow = swell(Math.min(Math.max((phase - 0.52) / 0.48, 0), 1));
  pose.root.y = -0.3 * kneel;
  pose.legL.x = 0.62 * kneel;
  pose.legR.x = 0.14 * kneel;
  pose.legL.z = -0.18 * kneel;
  pose.legR.z = 0.12 * kneel;
  pose.hips.x = 0.12 * kneel;
  pose.torso.x = 0.34 * kneel;
  pose.torso.z = -0.08 * kneel;
  pose.head.x = 0.2 * kneel;
  pose.armL.x = 0.15 + 1.05 * pick;
  pose.armR.x = 0.12 + 0.5 * pick - 0.35 * stow;
  pose.armL.z = -0.3;
  pose.armR.z = 0.22 + 0.35 * stow;
  return pose;
};

/** Hand to mouth, twice per revolution. */
const eat: ClipFn = ({ phase }) => {
  const pose = restPose();
  const bite = swell(phase, 2);
  pose.armR.x = 0.55 + 1.3 * bite;
  pose.armR.z = 0.2 - 0.45 * bite;
  pose.armL.x = 0.2;
  pose.armL.z = -0.14;
  pose.head.x = 0.16 + 0.1 * bite;
  pose.torso.x = 0.1;
  pose.root.y = -0.01 * bite;
  return pose;
};

/** Vessel raised, head tipped back, once per revolution. */
const drink: ClipFn = ({ phase }) => {
  const pose = restPose();
  const sip = swell(phase);
  pose.armR.x = 0.7 + 1.2 * sip;
  pose.armR.z = 0.22 - 0.5 * sip;
  pose.armL.x = 0.15;
  pose.armL.z = -0.14;
  pose.head.x = 0.1 - 0.42 * sip;
  pose.torso.x = -0.06 * sip;
  return pose;
};

/**
 * Lying down, breathing slowly. The whole figure tips onto its back about the
 * hip pivot and drops to the ground; the limbs settle rather than fold, because
 * a folded voxel figure at this scale reads as a heap rather than as a sleeper.
 *
 * Distinct from `idle` at night on purpose: `rest` is its own canonical
 * activity with its own records, so a sleeping body is a depiction of a
 * recorded fact. An inhabitant who is merely idle after dark keeps standing.
 */
const sleep: ClipFn = ({ phase }) => {
  const pose = restPose();
  const breath = swell(phase);
  pose.rootTilt.x = -Math.PI / 2 + 0.02 * breath;
  pose.root.y = -0.66;
  pose.root.z = 0.18;
  pose.torso.x = 0.06 + 0.03 * breath;
  pose.head.x = 0.16;
  pose.head.y = 0.22;
  pose.armL.x = 0.1;
  pose.armL.z = -0.5;
  pose.armR.x = 0.1;
  pose.armR.z = 0.5;
  pose.legL.z = -0.1;
  pose.legR.z = 0.1;
  return pose;
};

/** Seated, thighs forward, weight settled. */
const sit: ClipFn = ({ phase }) => {
  const pose = restPose();
  const breath = swell(phase);
  pose.root.y = -0.42;
  pose.legL.x = 1.45;
  pose.legR.x = 1.45;
  pose.legL.z = -0.06;
  pose.legR.z = 0.06;
  pose.torso.x = 0.1 + 0.03 * breath;
  pose.head.x = 0.05;
  pose.head.y = 0.14 * wave(phase);
  pose.armL.x = 0.28;
  pose.armL.z = -0.18;
  pose.armR.x = 0.28;
  pose.armR.z = 0.18;
  return pose;
};

/**
 * Speaking: an unhurried gesture with the leading hand and small head motion.
 *
 * Two talkers face each other because the sampler resolved each one's `facing`
 * from the canonical `focus` of the shared activity — that orientation is read
 * from the record, not invented here. This clip supplies only the motion.
 */
const talk: ClipFn = ({ phase }) => {
  const pose = restPose();
  const beat = wave(phase, 2);
  const flutter = wave(phase, 3);
  pose.armR.x = 0.42 + 0.26 * beat;
  pose.armR.z = 0.34 + 0.14 * beat;
  pose.armL.x = 0.14 + 0.06 * flutter;
  pose.armL.z = -0.16;
  pose.torso.y = 0.07 * beat;
  pose.torso.x = 0.06;
  pose.head.x = 0.04 * flutter;
  pose.head.y = 0.1 * beat;
  pose.root.y = 0.008 * swell(phase, 2);
  return pose;
};

/** Attending: still, weight shifting, an occasional nod. */
const listen: ClipFn = ({ phase }) => {
  const pose = restPose();
  const shift = wave(phase);
  pose.head.x = 0.1 + 0.06 * swell(phase, 2);
  pose.head.y = 0.06 * shift;
  pose.head.z = 0.05;
  pose.torso.x = 0.05;
  pose.armL.x = 0.08;
  pose.armL.z = -0.1;
  pose.armR.x = 0.08;
  pose.armR.z = 0.1;
  pose.root.x = 0.012 * shift;
  return pose;
};

/** A two-handed overhead swing, driven down through the body and back up. */
const build: ClipFn = ({ phase }) => {
  const pose = restPose();
  const strike = swell(phase);
  pose.armL.x = -1.55 + 2.05 * strike;
  pose.armR.x = -1.55 + 2.05 * strike;
  pose.armL.z = -0.16;
  pose.armR.z = 0.16;
  pose.torso.x = 0.1 + 0.34 * strike;
  pose.hips.x = 0.06 + 0.12 * strike;
  pose.head.x = 0.16 + 0.16 * strike;
  pose.root.y = -0.1 * strike;
  pose.legL.x = 0.12;
  pose.legR.x = -0.12;
  return pose;
};

/** Close work at chest height: hands together, small quick counter-motion. */
const craft: ClipFn = ({ phase }) => {
  const pose = restPose();
  const work = wave(phase, 3);
  pose.torso.x = 0.3;
  pose.hips.x = 0.1;
  pose.head.x = 0.44;
  pose.armL.x = 1.05 + 0.1 * work;
  pose.armL.z = -0.22 - 0.05 * work;
  pose.armR.x = 1.05 - 0.1 * work;
  pose.armR.z = 0.22 + 0.05 * work;
  pose.root.y = -0.06;
  pose.legL.x = 0.06;
  pose.legR.x = 0.06;
  return pose;
};

/** Bent over a surface, one hand travelling, the other steadying. */
const write: ClipFn = ({ phase }) => {
  const pose = restPose();
  const stroke = wave(phase, 4);
  pose.torso.x = 0.34;
  pose.hips.x = 0.08;
  pose.head.x = 0.52;
  pose.armR.x = 1.08 + 0.06 * stroke;
  pose.armR.z = -0.18 + 0.06 * stroke;
  pose.armL.x = 0.92;
  pose.armL.z = -0.3;
  pose.root.y = -0.05;
  return pose;
};

/** Holding something at reading height; one hand releases to turn a page. */
const read: ClipFn = ({ phase }) => {
  const pose = restPose();
  const turn = swell(phase);
  pose.armL.x = 1.15;
  pose.armL.z = -0.3;
  pose.armR.x = 1.15 - 0.1 * turn;
  pose.armR.z = 0.3 - 0.16 * turn;
  pose.head.x = 0.36 + 0.03 * swell(phase, 2);
  pose.torso.x = 0.14;
  return pose;
};

/** Upright and open: an arm sweeping outward, the head scanning an audience. */
const teach: ClipFn = ({ phase }) => {
  const pose = restPose();
  const sweep = wave(phase);
  pose.armR.x = 0.62 + 0.3 * sweep;
  pose.armR.z = 0.72 + 0.22 * sweep;
  pose.armL.x = 0.1;
  pose.armL.z = -0.14;
  pose.head.y = 0.22 * sweep;
  pose.torso.y = 0.06 * sweep;
  pose.torso.x = -0.03;
  pose.root.x = 0.02 * sweep;
  return pose;
};

/** Reading, with a periodic lift of the head — the shape of trying to recall. */
const study: ClipFn = ({ phase }) => {
  const pose = restPose();
  const lift = swell(phase);
  pose.head.x = 0.46 - 0.44 * lift;
  pose.head.y = 0.1 * lift;
  pose.torso.x = 0.2 - 0.12 * lift;
  pose.armL.x = 1.05;
  pose.armL.z = -0.28;
  pose.armR.x = 1.02 - 0.3 * lift;
  pose.armR.z = 0.26 - 0.1 * lift;
  pose.root.y = -0.03;
  return pose;
};

/** Leaning in over something, one hand extended, head cocked. */
const examine: ClipFn = ({ phase }) => {
  const pose = restPose();
  const probe = swell(phase);
  pose.torso.x = 0.26 + 0.1 * probe;
  pose.hips.x = 0.1;
  pose.head.x = 0.28;
  pose.head.z = 0.14;
  pose.head.y = -0.1 + 0.14 * wave(phase, 2);
  pose.armR.x = 1.05 + 0.42 * probe;
  pose.armR.z = 0.06;
  pose.armL.x = 0.24;
  pose.armL.z = -0.16;
  pose.root.z = -0.05 * probe;
  return pose;
};

/** Both arms out in front under load; the torso leans back to balance it. */
const carry: ClipFn = ({ phase }) => {
  const pose = restPose();
  const sway = wave(phase);
  pose.torso.x = -0.14;
  pose.hips.x = -0.05;
  pose.armL.x = 1.18;
  pose.armL.z = -0.24;
  pose.armR.x = 1.18;
  pose.armR.z = 0.24;
  pose.head.x = 0.06;
  pose.root.y = 0.015 * swell(phase, 2);
  pose.root.x = 0.014 * sway;
  pose.legL.x = 0.1 * sway;
  pose.legR.x = -0.1 * sway;
  return pose;
};

/** Extend and withdraw: the generic "acting on something at arm's length". */
const reach: ClipFn = ({ phase }) => {
  const pose = restPose();
  const extend = swell(phase);
  pose.armR.x = 0.85 + 0.85 * extend;
  pose.armR.z = 0.12 - 0.06 * extend;
  pose.armL.x = 0.18;
  pose.armL.z = -0.14;
  pose.torso.x = 0.1 * extend;
  pose.hips.y = -0.1 * extend;
  pose.head.x = 0.1 * extend;
  pose.root.z = -0.06 * extend;
  return pose;
};

/** Expansive and rhythmic: arms wide, weight shifting on the beat. */
const perform: ClipFn = ({ phase }) => {
  const pose = restPose();
  const beat = wave(phase, 2);
  const lift = swell(phase);
  pose.armL.x = 0.2 * beat - 0.3 * lift;
  pose.armL.z = -(0.85 + 0.35 * lift);
  pose.armR.x = -0.2 * beat - 0.3 * lift;
  pose.armR.z = 0.85 + 0.35 * lift;
  pose.torso.y = 0.16 * beat;
  pose.torso.x = -0.08 * lift;
  pose.head.x = -0.12 * lift;
  pose.head.y = 0.14 * beat;
  pose.root.y = 0.05 * lift;
  pose.root.x = 0.05 * beat;
  pose.legL.x = 0.16 * beat;
  pose.legR.x = -0.16 * beat;
  return pose;
};

/** Planted, alert, scanning slowly. Nothing about the posture is threatening. */
const guard: ClipFn = ({ phase }) => {
  const pose = restPose();
  const scan = wave(phase);
  pose.legL.z = -0.12;
  pose.legR.z = 0.12;
  pose.armL.x = 0.06;
  pose.armL.z = -0.2;
  pose.armR.x = 0.06;
  pose.armR.z = 0.2;
  pose.head.y = 0.42 * scan;
  pose.torso.y = 0.08 * scan;
  pose.root.y = 0.006 * swell(phase);
  return pose;
};

/**
 * Confined: hands together low in front, weight settled, almost no motion.
 *
 * claude.md §11G and §11H: confinement is a physical fact the engine records
 * neutrally, and the renderer inherits that obligation. This posture must not
 * editorialise in either direction — no cowering that implies guilt or
 * suffering, no defiance that implies a cause. It is a person standing still
 * with restricted movement, and the caption carries the facts.
 */
const restrained: ClipFn = ({ phase }) => {
  const pose = restPose();
  const shift = wave(phase);
  pose.armL.x = 0.55;
  pose.armL.z = 0.1;
  pose.armR.x = 0.55;
  pose.armR.z = -0.1;
  pose.torso.x = 0.1;
  pose.head.x = 0.16;
  pose.legL.z = -0.04;
  pose.legR.z = 0.04;
  pose.root.x = 0.01 * shift;
  return pose;
};

/**
 * Occupied, contents withheld — the privacy clip (claude.md §11E, §12).
 *
 * Every joint is exactly zero at every phase, and per-inhabitant variation is
 * not applied. The figure is a still, upright, symmetric column: no crouch, no
 * reach, no gesture, no lean, no held object, nothing that could be read back
 * as a task. The only motion is about a centimetre of vertical breathing, which
 * says "present and alive" and nothing else.
 *
 * This is a constraint, not a style. `envelope_only` means the canonical record
 * withheld the contents of the activity; a posture that *looked* like gathering
 * or conversation would leak a guess as though it were an observation, and a
 * spectator has no way to tell a renderer's guess from a canonical fact once it
 * is on screen. The uniformity is deliberate too: withheld time looks the same
 * on every body, so nothing about the figure invites reading who it is or what
 * they were doing. `clips.test.ts` asserts the all-zero property directly, so
 * any future edit that gives this clip a shape fails the suite.
 */
const undisclosed: ClipFn = ({ phase }) => {
  const pose = restPose();
  pose.root.y = 0.01 * swell(phase);
  pose.showProp = false;
  return pose;
};

/**
 * No canonical record covers this interval for this inhabitant.
 *
 * Distinct from `undisclosed` on purpose: withheld time and unrecorded time are
 * different epistemic states and must not share a silhouette. This one drifts
 * — a slow lateral weight change and a faint arm sway — which reads as
 * "we are not sure" rather than as the deliberate stillness of a withheld
 * activity. Like `undisclosed` it shows no prop.
 */
const unknown: ClipFn = ({ phase }) => {
  const pose = restPose();
  const drift = wave(phase);
  pose.root.x = 0.03 * drift;
  pose.armL.z = -0.14 - 0.05 * drift;
  pose.armR.z = 0.14 - 0.05 * drift;
  pose.torso.z = 0.03 * drift;
  pose.head.y = 0.05 * drift;
  pose.showProp = false;
  return pose;
};

/**
 * The clip table. Typing it as a total `Record<ClipName, ClipFn>` makes the
 * compiler the thing that guarantees every clip in the cinema contract has an
 * implementation — adding a clip name to `types.ts` breaks the build here
 * rather than silently falling back to `idle` at runtime.
 */
const CLIPS: Readonly<Record<ClipName, ClipFn>> = {
  idle,
  walk,
  harvest,
  drink,
  eat,
  sleep,
  sit,
  talk,
  listen,
  build,
  craft,
  write,
  read,
  teach,
  study,
  examine,
  carry,
  reach,
  perform,
  guard,
  restrained,
  undisclosed,
  unknown,
};

export const CLIP_NAMES: readonly ClipName[] = Object.keys(CLIPS) as ClipName[];

/* -------------------------------------------------------------------------- */
/* Variation application                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Fold an inhabitant's posture signature into a pose.
 *
 * Applied to every clip except `undisclosed`, where any individual shape at all
 * would work against the uniformity that keeps withheld time unreadable.
 * Offsets are additive and small; the clamp in `poseFor` runs afterwards, so
 * variation can never push a joint past its anatomical range.
 */
function applyVariation(pose: MutablePose, variation: ActorVariation): void {
  pose.legL.z -= variation.stance;
  pose.legR.z += variation.stance;
  pose.head.z += variation.headTilt;
  pose.armL.z -= variation.shoulder;
  pose.armR.z += variation.shoulder;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

/** Wrap any real number into [0, 1). Phase arrives as `fract(tick × rate)`. */
export function wrapPhase(phase: number): number {
  if (!Number.isFinite(phase)) return 0;
  const wrapped = phase % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
}

/**
 * Evaluate a clip.
 *
 * Pure: the same four arguments always produce the same pose, with no clock,
 * no randomness and no hidden state. That is what lets the Stage stay
 * reproducible for a given tick — two spectators scrubbed to the same sim
 * minute see the same bodies.
 *
 * The returned pose is freshly allocated. These are nine small objects per
 * actor per frame, which the nursery handles without a collection; the
 * allocations the Stage genuinely must avoid are geometries, materials and
 * textures, and this file creates none of those.
 */
export function poseFor(
  clip: ClipName,
  phase: number,
  speed: number,
  variation: ActorVariation = NEUTRAL_VARIATION,
  tick = 0,
): ActorPose {
  const fn = CLIPS[clip];
  const pose = fn({
    phase: wrapPhase(phase),
    speed: Number.isFinite(speed) && speed > 0 ? speed : 0,
    tick: Number.isFinite(tick) ? tick : 0,
    variation,
  });

  if (clip !== "undisclosed") applyVariation(pose, variation);

  clampJoint(pose.root, JOINT_LIMITS["root"]!);
  clampJoint(pose.rootTilt, JOINT_LIMITS["rootTilt"]!);
  clampJoint(pose.hips, JOINT_LIMITS["hips"]!);
  clampJoint(pose.torso, JOINT_LIMITS["torso"]!);
  clampJoint(pose.head, JOINT_LIMITS["head"]!);
  clampJoint(pose.armL, JOINT_LIMITS["arm"]!);
  clampJoint(pose.armR, JOINT_LIMITS["arm"]!);
  clampJoint(pose.legL, JOINT_LIMITS["leg"]!);
  clampJoint(pose.legR, JOINT_LIMITS["leg"]!);

  return pose;
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Sim minutes a clip change takes to complete.
 *
 * Because idle dominates the runtime, the cuts *into* and *out of* activity are
 * most of what a spectator actually watches happen. A rig that snapped from a
 * standing idle into a mid-stride walk would pop on every one of them. Six sim
 * minutes is short enough to feel like a decision and long enough to hide the
 * discontinuity at every playback rate above 1×.
 */
export const CLIP_BLEND_MINUTES = 6;

/** Eased 0..1 for a transition. Flat at both ends, so neither clip jerks. */
export function easeBlend(t: number): number {
  return smoothstep01(t);
}

function blendJoint(from: Joint, to: Joint, t: number): MutableJoint {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: from.z + (to.z - from.z) * t,
  };
}

/**
 * Cross-fade two poses.
 *
 * `t` is raw progress through the transition; the ease is applied here so every
 * caller gets the same curve. Joint angles interpolate linearly, which is
 * correct for this rig: the angles involved are small enough that the shortest
 * Euler path is the visually right one, and a figure lying down for `sleep`
 * simply tips over the window rather than rotating the long way round.
 *
 * The prop is withheld for the whole of any transition that touches a clip
 * which forbids it. Conservative on purpose — a prop flickering into existence
 * halfway out of `undisclosed` would be exactly the leak the clip prevents.
 */
export function blendPose(from: ActorPose, to: ActorPose, t: number): ActorPose {
  if (t <= 0) return from;
  if (t >= 1) return to;
  const k = easeBlend(t);
  return {
    root: blendJoint(from.root, to.root, k),
    rootTilt: blendJoint(from.rootTilt, to.rootTilt, k),
    hips: blendJoint(from.hips, to.hips, k),
    torso: blendJoint(from.torso, to.torso, k),
    head: blendJoint(from.head, to.head, k),
    armL: blendJoint(from.armL, to.armL, k),
    armR: blendJoint(from.armR, to.armR, k),
    legL: blendJoint(from.legL, to.legL, k),
    legR: blendJoint(from.legR, to.legR, k),
    showProp: from.showProp && to.showProp,
  };
}

/** Which limit applies to which pose channel. Exported for the test suite. */
export const LIMIT_OF: Readonly<Record<keyof Omit<ActorPose, "showProp">, string>> = {
  root: "root",
  rootTilt: "rootTilt",
  hips: "hips",
  torso: "torso",
  head: "head",
  armL: "arm",
  armR: "arm",
  legL: "leg",
  legR: "leg",
};
