/**
 * The performance catalogue — how a canonical activity is *depicted*.
 *
 * Nothing in this file is canonical. Every `PerformanceSpec` carries
 * `derived: true` precisely so no consumer can mistake a body posture for a
 * recorded fact (claude.md §12: "Generated media must be clearly
 * distinguishable from canonical world actions").
 *
 * ## Envelope and contents are different things
 *
 * The export keeps two things apart, and so must this file.
 *
 *   - The **envelope** — participants, location, start and end time, and
 *     `activityState` — is always disclosed. §11E lists "nearby inhabitants"
 *     and "public activity" as *directly observable*: anyone standing there
 *     would have seen two figures talking for ninety minutes. Depicting that is
 *     depicting a disclosed fact.
 *   - The **contents** — speech, reasoning, quantities, resolution detail —
 *     follow canonical event visibility and are frequently withheld.
 *
 * So `activityState` selects the clip, always. Rendering a neutral standing
 * figure for a canonical `conversing` segment would be *less* faithful to the
 * record than rendering a talking posture, not more — it would deny a fact the
 * world disclosed.
 *
 * **Rule 2 — the action type refines the clip only when
 * `disclosure === "disclosed"`.** `consume` resolves to `eat` or `drink`
 * according to `detail.resource`, and that resource is content. When the
 * contents are withheld the depiction falls back to the activity-state clip
 * rather than picking one of the two and thereby implying which it was.
 *
 * **Rule 3 — contents are never depicted, by any mechanism.** No speech
 * bubbles, no text, no glyphs, no quantities, and no prop that encodes what was
 * said or exchanged. A `talk` posture says "they conversed", which the envelope
 * discloses; it must never say what about (§11E, §12).
 *
 * The `undisclosed` clip is narrower than it sounds: it fires only for
 * `disclosure === "unrecorded"`, an interval no canonical record covers at all.
 * That is the one case where the Observatory genuinely does not know what the
 * body was doing.
 *
 * ## What a clip may say
 *
 * Every clip is a posture, never a story. `attempt_transfer_without_consent`
 * gets `reach`, not a furtive crouch; `impose_confinement` gets `reach`, not a
 * triumphant stance. Whether an instance of one is theft or justice is an
 * interpretation inhabitants argue about, and the renderer has no standing in
 * that argument (§11F, §11G: "The canonical event log must describe observable
 * events neutrally").
 *
 * ## How `cycleRate` composes with `ActorSample.speed`
 *
 * Two units share the field, distinguished by `locomotion`:
 *
 *   - `stationary` clips: cycles per sim minute, used directly.
 *   - `path` clips: cycles per *tile travelled*. The rig multiplies by
 *     `ActorSample.speed` (tiles per minute) to get cycles per sim minute:
 *
 *         cyclesPerSimMinute = locomotion === "path"
 *           ? spec.cycleRate * sample.speed
 *           : spec.cycleRate;
 *
 * Tying the gait to distance rather than to time is what stops the feet from
 * sliding: a figure that halves its speed takes half as many strides over the
 * same ground. `WALK_CYCLES_PER_TILE` is one gait cycle per 1.5 tiles, the
 * renderer mapping one tile to one metre and a stride pair to ~1.5 m.
 *
 * Absolute legibility depends on `PlaybackRate`, which this layer does not
 * know. At the reference rate of 60 sim minutes per real second, an inhabitant
 * crossing a tile every 10 sim minutes covers 6 tiles per real second and the
 * foot-locked gait lands near 4 cycles per real second. At 1× the same figure
 * genuinely crawls, which is the honest depiction of how slowly they move.
 * Clamping the result into a legible band at extreme playback rates is the
 * rig's decision and is presentation, like everything else here.
 */
import type { ChronicleSegment, ClipName, Disclosure, PerformanceSpec, PropName } from "./types";

/** Cycles per tile travelled. See the composition note above. */
const WALK_CYCLES_PER_TILE = 0.667;

/**
 * Cycles per sim minute for stationary clips, chosen to read at the reference
 * playback rate of 60 sim minutes per real second: `STEADY` is roughly two
 * cycles per real second there.
 */
const BARELY = 0.004;
const SLOW = 0.012;
const STEADY = 0.033;
const BRISK = 0.05;

function spec(
  clip: ClipName,
  prop: PropName,
  locomotion: "path" | "stationary",
  faceFocus: boolean,
  cycleRate: number,
): PerformanceSpec {
  return { clip, prop, locomotion, faceFocus, cycleRate, derived: true };
}

/**
 * The spec for an interval no canonical record covers.
 *
 * `locomotion: "path"` looks like a leak and is not: a segment's `from` and `to`
 * are canonical whatever its contents, and for a stationary stretch they are
 * equal, so following the path degenerates to standing still. Choosing
 * `stationary` instead would be the leak — it would freeze an inhabitant whose
 * recorded movement the world *did* disclose.
 */
const UNDISCLOSED_PERFORMANCE: PerformanceSpec = spec("undisclosed", "none", "path", false, SLOW);

/** Returned when neither layer matches. Visible in the test as a failure, by design. */
const UNKNOWN_PERFORMANCE: PerformanceSpec = spec("unknown", "none", "path", false, SLOW);

/**
 * The envelope layer: one entry per member of `ActivityStateSchema`
 * (packages/core/src/schema/action-spec.ts).
 *
 * This is what an observer standing nearby would have seen, and it applies at
 * every disclosure level except `unrecorded`. Props here stay minimal for the
 * reason in rule 3 — a prop must describe the posture, never the transaction.
 * `caring` gets no vessel and `performing` no instrument, because a vessel would
 * assert feeding and an instrument would assert music, and neither is in the
 * envelope.
 *
 * `confined` is a posture of circumstance, not of suspension. §11H is explicit
 * that a confined inhabitant "may retain the ability to converse, think,
 * write"; when the canonical activity state is one of those, that state is what
 * appears here, and the confinement is shown by where they are and what
 * encloses them.
 */
const ACTIVITY_PERFORMANCE: Readonly<Record<string, PerformanceSpec>> = Object.freeze({
  idle: spec("idle", "none", "stationary", false, BARELY),
  working: spec("craft", "tool", "stationary", true, STEADY),
  gathering: spec("harvest", "bundle", "stationary", true, STEADY),
  building: spec("build", "tool", "stationary", true, BRISK),
  crafting: spec("craft", "tool", "stationary", true, STEADY),
  travelling: spec("walk", "none", "path", false, WALK_CYCLES_PER_TILE),
  studying: spec("study", "tablet", "stationary", false, SLOW),
  teaching: spec("teach", "none", "stationary", true, SLOW),
  caring: spec("reach", "none", "stationary", true, SLOW),
  conversing: spec("talk", "none", "stationary", true, SLOW),
  performing: spec("perform", "none", "stationary", false, STEADY),
  guarding: spec("guard", "none", "stationary", false, BARELY),
  investigating: spec("examine", "none", "stationary", false, SLOW),
  receiving_treatment: spec("sit", "none", "stationary", true, BARELY),
  recovering: spec("sit", "none", "stationary", false, BARELY),
  sleeping: spec("sleep", "none", "stationary", false, BARELY),
  confined: spec("restrained", "none", "stationary", false, BARELY),
  /* The chronicle's own name for a synthesised gap. Its segments carry
     `disclosure: "unrecorded"` and are caught before this map is consulted;
     the entry exists so the two names agree if that ever changes. */
  unrecorded: UNDISCLOSED_PERFORMANCE,
});

/**
 * The refinement layer: one entry per member of `ActionTypeSchema`
 * (packages/core/src/schema/action-spec.ts).
 *
 * Consulted **only** when `disclosure === "disclosed"` (rule 2). Written out in
 * full rather than generated from patterns so that a vocabulary change shows up
 * as a missing key rather than as a silent fallback. The action vocabulary is
 * frozen at Genesis (§13), so this map is too.
 *
 * Many entries deliberately restate their activity state's clip: `gather` and
 * `gathering` both harvest. Restating costs nothing and makes the alternative —
 * an action whose depiction is *narrower* than its activity state, and so
 * withholdable — explicit at each key rather than inferred from an absence.
 */
export const PERFORMANCE_CATALOGUE: Readonly<Record<string, PerformanceSpec>> = Object.freeze({
  /* §13 — minimum action vocabulary */
  observe: spec("examine", "none", "stationary", true, SLOW),
  move: spec("walk", "none", "path", false, WALK_CYCLES_PER_TILE),
  gather: spec("harvest", "bundle", "stationary", true, STEADY),
  // eat vs drink is decided by `detail.resource` in performanceForSegment, and
  // only when the contents are disclosed. This entry is the disclosed default.
  consume: spec("eat", "none", "stationary", false, STEADY),
  rest: spec("sleep", "none", "stationary", false, BARELY),
  communicate: spec("talk", "none", "stationary", true, SLOW),
  announce: spec("talk", "none", "stationary", false, SLOW),
  build: spec("build", "tool", "stationary", true, BRISK),
  craft: spec("craft", "tool", "stationary", true, STEADY),
  create_artifact: spec("write", "tablet", "stationary", false, STEADY),
  publish: spec("write", "tablet", "stationary", false, SLOW),
  study: spec("study", "tablet", "stationary", false, SLOW),
  teach: spec("teach", "none", "stationary", true, SLOW),
  inspect_agent: spec("examine", "none", "stationary", true, SLOW),
  diagnose_condition: spec("examine", "none", "stationary", true, SLOW),
  design_treatment: spec("write", "tablet", "stationary", false, STEADY),
  apply_treatment: spec("reach", "vessel", "stationary", true, SLOW),
  offer_trade: spec("talk", "bundle", "stationary", true, SLOW),
  accept_trade: spec("reach", "bundle", "stationary", true, SLOW),
  reject_trade: spec("talk", "none", "stationary", true, SLOW),
  transfer_property: spec("carry", "bundle", "stationary", true, SLOW),
  transfer: spec("carry", "bundle", "stationary", true, SLOW),
  copy_artifact: spec("write", "tablet", "stationary", false, STEADY),
  restrain: spec("reach", "none", "stationary", true, STEADY),
  release: spec("reach", "none", "stationary", true, SLOW),
  offer_contract: spec("talk", "tablet", "stationary", true, SLOW),
  accept_contract: spec("write", "tablet", "stationary", true, SLOW),
  reject_contract: spec("talk", "tablet", "stationary", true, SLOW),
  perform_contract: spec("carry", "bundle", "stationary", true, STEADY),
  terminate_contract: spec("talk", "tablet", "stationary", true, SLOW),
  create_organisation: spec("write", "tablet", "stationary", false, SLOW),
  invite_member: spec("talk", "none", "stationary", true, SLOW),
  join_organisation: spec("talk", "none", "stationary", true, SLOW),
  leave_organisation: spec("talk", "none", "stationary", true, SLOW),
  propose_rule: spec("talk", "tablet", "stationary", false, SLOW),
  vote: spec("write", "tablet", "stationary", false, SLOW),
  create_currency: spec("write", "tablet", "stationary", false, SLOW),
  transfer_currency: spec("reach", "tablet", "stationary", true, SLOW),
  // Creation is a world action with a resource cost and a duration (§7); the rig
  // depicts an inhabitant attending to something, and nothing more than that.
  create_inhabitant: spec("reach", "none", "stationary", false, SLOW),
  wait: spec("idle", "none", "stationary", false, BARELY),

  /* §11I — care, information, security, law */
  care_for_dependant: spec("reach", "vessel", "stationary", true, SLOW),
  supervise: spec("examine", "none", "stationary", true, BARELY),
  interrupt_activity: spec("talk", "none", "stationary", true, SLOW),
  coordinate_work: spec("talk", "none", "stationary", true, SLOW),
  contribute_to_group: spec("carry", "bundle", "stationary", true, STEADY),
  inspect_inventory: spec("examine", "bundle", "stationary", false, SLOW),
  audit_records: spec("read", "tablet", "stationary", false, SLOW),
  // Concealing and revealing are the same posture with opposite direction: a
  // figure handling their own property. Nothing about the depiction judges it.
  conceal_asset: spec("carry", "bundle", "stationary", false, STEADY),
  reveal_asset: spec("reach", "bundle", "stationary", false, SLOW),
  investigate_event: spec("examine", "none", "stationary", false, SLOW),
  report_findings: spec("talk", "tablet", "stationary", true, SLOW),
  secure_storage: spec("build", "tool", "stationary", true, STEADY),
  guard_location: spec("guard", "none", "stationary", false, BARELY),
  attempt_transfer_without_consent: spec("reach", "bundle", "stationary", true, STEADY),
  accuse: spec("talk", "none", "stationary", true, SLOW),
  present_evidence: spec("reach", "tablet", "stationary", true, SLOW),
  request_restitution: spec("talk", "none", "stationary", true, SLOW),
  impose_confinement: spec("reach", "none", "stationary", true, STEADY),
  maintain_confinement: spec("guard", "none", "stationary", false, BARELY),
  release_from_confinement: spec("reach", "none", "stationary", true, SLOW),
  visit_confined_agent: spec("talk", "none", "stationary", true, SLOW),
  appeal_decision: spec("talk", "tablet", "stationary", true, SLOW),
  // Escape is travel. The world records an inhabitant leaving a place; whether
  // that leaving was permitted is an interpretation, not a posture (§11G).
  attempt_escape: spec("walk", "none", "path", false, WALK_CYCLES_PER_TILE),
  resist_enforcement: spec("reach", "none", "stationary", true, STEADY),
});

/**
 * How to depict one stretch of an inhabitant's life.
 *
 * Precedence, in order:
 *
 *   1. `unrecorded` — no canonical record covers the interval, so no posture is
 *      justified and the `undisclosed` clip is the answer.
 *   2. `disclosed` — the action type may refine the envelope's clip (rule 2).
 *   3. the activity state — canonical, disclosed at every level, and the answer
 *      whenever the contents are withheld.
 *   4. `unknown` — a future constitutional world named an activity state this
 *      build predates. Not `undisclosed`: nothing was withheld, we simply do
 *      not recognise the word.
 *
 * The `listen` clip is deliberately unreachable from these arguments alone. It
 * belongs to the participant of a shared `conversing` segment who is not the
 * speaker, which this function cannot know; the rig selects it from the
 * segment's participant list.
 */
export function performanceFor(
  actionType: string,
  activityState: string,
  disclosure: Disclosure,
): PerformanceSpec {
  if (disclosure === "unrecorded") return UNDISCLOSED_PERFORMANCE;
  if (disclosure === "disclosed") {
    const refined = PERFORMANCE_CATALOGUE[actionType];
    if (refined !== undefined) return refined;
  }
  return ACTIVITY_PERFORMANCE[activityState] ?? UNKNOWN_PERFORMANCE;
}

/**
 * The same decision, refined by canonical resolution detail.
 *
 * `ChronicleSegment.detail` is null unless the segment is disclosed, so the
 * disclosure gate holds here without a second check — but it is written out
 * anyway rather than relied upon, because this rule must not depend on another
 * module keeping its promise.
 *
 * The only refinement at Genesis is the one the resolver makes available:
 * `action.consume` records the `resource` it destroyed
 * (packages/core/src/engine/resolvers/basic.ts). Drinking water is a different
 * posture from eating food, and which of the two it was is content — so this
 * distinction appears only here, on the disclosed path.
 */
export function performanceForSegment(segment: ChronicleSegment): PerformanceSpec {
  const base = performanceFor(segment.actionType, segment.activityState, segment.disclosure);
  if (segment.disclosure !== "disclosed" || segment.detail === null) return base;
  if (segment.actionType !== "consume") return base;
  if (segment.detail["resource"] === "water") {
    return spec("drink", "vessel", "stationary", false, base.cycleRate);
  }
  return base;
}
