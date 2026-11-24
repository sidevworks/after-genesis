// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Needs, decline and death (§1, §8).
 *
 * §1 requires that inhabitants "experience decline and irreversible death" and
 * names extinction as a legitimate outcome. §8 requires that "if a serious
 * condition remains unresolved beyond its defined progression, the inhabitant
 * may die." Before this module existed neither sentence was true of the engine:
 * `advanceNeeds` raised hunger and thirst, clamped them at `NEED_CEILING`, and
 * nothing anywhere read them again. A 365-day run ended with three inhabitants
 * pinned at 100/100 for a year, carrying food and water they never touched, in
 * perfect health. The death machinery — `deathTime`, `deathSequence`, the
 * `RejectionCode.Dead` guard, five clauses of `deadInhabitantsCannotAct` — was
 * complete and unreachable.
 *
 * This file makes needs bite. It is the whole model, in one place, because a
 * mortality rule scattered across resolvers would be a mortality rule nobody
 * could audit.
 *
 *
 * ## The progression
 *
 * A need at or above its ailment's `onsetThreshold` opens a `Condition` at
 * severity 1. While the need stays saturated the severity climbs on a fixed
 * clock. Relieve the need — eat, drink, sleep — and the severity falls again on
 * a faster clock. At severity `TERMINAL_SEVERITY` the inhabitant dies.
 *
 * Note what the condition *is*: it is the timer. There is no separate "how long
 * has this inhabitant been starving" counter on the inhabitant, because such a
 * counter would be a second source of truth that could disagree with the
 * condition record. The condition's `onsetAt` is when saturation began, and its
 * severity is how far the progression has run. §8's "defined progression" is
 * literally `minutesPerSeverityPoint × TERMINAL_SEVERITY`.
 *
 *
 * ## Why these numbers
 *
 * The rates are anchored to human physiology, because the point of a mortality
 * model is that the ordering is not arbitrary — an inhabitant that has to choose
 * between fetching water and fetching food should face the real trade-off.
 *
 * - **Dehydration kills in about 3 days.** The shortest fuse. 4320 minutes /
 *   100 severity points ≈ 43 minutes per point.
 * - **Starvation kills in about 21 days.** Roughly seven times longer, matching
 *   the real ratio. 30000 minutes / 100 ≈ 300 minutes per point.
 * - **Exhaustion kills in about 30 days.** Total sleep deprivation is reliably
 *   fatal in animal studies at two to four weeks and is poorly characterised in
 *   humans, so it gets the longest and least certain fuse of the three. It is
 *   terminal rather than merely unpleasant because §8 gives no third option: an
 *   unresolved condition either resolves or ends in death, and a condition that
 *   could do neither would be decoration.
 *
 * Recovery runs three times faster than decline (`RECOVERY_SPEEDUP`). This is
 * the clause that makes both survivable "if the inhabitant acts": a dehydrated
 * inhabitant at severity 90 who finds water is clear in about 18 hours rather
 * than dying in the remaining 7. It also matches the physiology loosely —
 * rehydration is fast, refeeding after prolonged starvation is not, and the
 * per-ailment rates preserve that ordering because recovery is derived from each
 * ailment's own decline rate rather than being a flat number.
 *
 * **The social need produces no condition.** Isolation is real in this world —
 * it is in the prompt, it shapes behaviour — but it is not lethal, and inventing
 * a death-by-loneliness rule would be scripting drama (§26) rather than
 * modelling physics.
 *
 *
 * ## Determinism
 *
 * Nothing here draws from an RNG, reads a clock, or uses floating point.
 * Severity is an integer function of `(now - progressedAt)` and the need's
 * current value, both of which live in canonical state. The same event log
 * therefore reproduces the same deaths at the same instants, which is what §15's
 * "replayed history produces an identical state checksum" requires of a rule
 * that can end a life.
 *
 * Remainders are carried in `progressedAt` rather than truncated: a tick that
 * earns 2 severity points advances the anchor by exactly 2 × the rate, so the
 * leftover minutes survive to the next tick. Without this, a world ticked every
 * 5 minutes would never accumulate a single point of dehydration (5 / 43 = 0)
 * and mortality would silently depend on turn spacing.
 *
 *
 * ## What death does not do
 *
 * §8: "Death must never delete history." A dying inhabitant keeps its inventory,
 * concealed holdings, memories, relationships, beliefs, reputation, skills,
 * memberships, contracts, artifacts, lineage and conditions — every field except
 * the four that record the death itself and the activity handle it can no longer
 * occupy. Nothing is redistributed: §8 leaves inheritance, debts, memorials and
 * abandoned property to the survivors, and an engine that swept a corpse's food
 * into a communal pile would be deciding that question for them.
 */
import { addDuration, duration, type SimTime } from "../time.js";
import { deriveConditionId } from "../ids.js";
import type { DerivedEvent } from "./resolvers/types.js";
import { terminateInhabitant } from "./lifecycle.js";
import {
  NEED_CEILING,
  idiv,
  insertSorted,
  putCondition,
  putInhabitant,
  sortedValues,
  type Condition,
  type Inhabitant,
  type Needs,
  type WorldState,
} from "./state.js";

/** Severity at which a terminal ailment ends the inhabitant. */
export const TERMINAL_SEVERITY = 100;

/** Severity at which a condition first becomes visible in an observation. */
export const INITIAL_SEVERITY = 1;

/**
 * How much faster a relieved condition eases than a persisting one worsens.
 *
 * Three. High enough that acting on a need genuinely saves you (§8: both must be
 * survivable), low enough that recovery still costs real simulated days and a
 * near-fatal bout leaves an inhabitant impaired for a while afterwards.
 */
export const RECOVERY_SPEEDUP = 3;

/**
 * A need whose saturation produces a condition.
 *
 * `onsetThreshold` and `reliefThreshold` are deliberately different. The gap is
 * hysteresis: without it, a need oscillating around a single threshold would
 * open and close conditions every few minutes and fill the record with noise.
 * The band also has a physical reading — you stop *getting worse* before you
 * start *getting better*.
 */
export interface Ailment {
  readonly need: keyof Needs;
  /** Condition kind, recorded on the `Condition` and shown in observations. */
  readonly kind: string;
  /** Need value at or above which the condition begins and worsens. */
  readonly onsetThreshold: number;
  /** Need value at or below which the condition eases. */
  readonly reliefThreshold: number;
  /** Simulated minutes of saturation per point of severity gained. */
  readonly minutesPerSeverityPoint: number;
  /** Whether reaching `TERMINAL_SEVERITY` kills. */
  readonly terminal: boolean;
  /** What a bystander could see, recorded on the onset event (§8, §11E). */
  readonly symptom: string;
}

/**
 * The ailment table, in a fixed order.
 *
 * Order matters twice over and is therefore part of the ruleset, not an
 * implementation detail: it decides which condition is created first (and so the
 * derived id each gets) and which one is named as the cause when two reach
 * terminal severity in the same tick. Fastest-killing first, so the cause of
 * death is the one that was always going to arrive soonest.
 */
export const AILMENTS: readonly Ailment[] = Object.freeze([
  {
    need: "thirst",
    kind: "dehydration",
    onsetThreshold: 95,
    reliefThreshold: 80,
    // ≈3 simulated days from onset to death: 4320 minutes / 100 points.
    minutesPerSeverityPoint: 43,
    // Keep tracked for narrative/decision pressure, but disable fatality.
    terminal: false,
    symptom: "cracked lips and a stumbling gait",
  },
  {
    need: "hunger",
    kind: "starvation",
    onsetThreshold: 95,
    reliefThreshold: 80,
    // ≈21 simulated days, seven times the dehydration fuse: 30000 / 100.
    minutesPerSeverityPoint: 300,
    // Keep tracked for narrative/decision pressure, but disable fatality.
    terminal: false,
    symptom: "wasted frame and slow, clumsy movement",
  },
  {
    need: "fatigue",
    kind: "exhaustion",
    onsetThreshold: 95,
    reliefThreshold: 80,
    // ≈30 simulated days: 43200 / 100.
    minutesPerSeverityPoint: 432,
    terminal: true,
    symptom: "unfocused stare and hands that will not keep still",
  },
] satisfies readonly Ailment[]);

/** Minutes of relief needed to shed one point of severity. Never zero. */
export function recoveryMinutesPerPoint(ailment: Ailment): number {
  const rate = idiv(ailment.minutesPerSeverityPoint, RECOVERY_SPEEDUP);
  return rate < 1 ? 1 : rate;
}

/**
 * The named stage of a progression, derived from severity (§8 "defined
 * progression").
 *
 * Derived rather than stored, for the reason state.ts gives at the top of the
 * file: two fields that mean the same thing can disagree, and then the checksum
 * cannot say which one is the world.
 */
export function stageForSeverity(severity: number): number {
  if (severity >= TERMINAL_SEVERITY) return 3;
  if (severity >= 75) return 2;
  if (severity >= 40) return 1;
  return 0;
}

/** Which way a condition is moving, given the need that causes it. */
export type Trend = "worsening" | "easing" | "holding";

export function trendFor(ailment: Ailment, needValue: number): Trend {
  if (needValue >= ailment.onsetThreshold) return "worsening";
  if (needValue <= ailment.reliefThreshold) return "easing";
  return "holding";
}

/**
 * What the health tick decided about one world moment.
 *
 * Events are returned rather than appended: this module has no access to hashes,
 * checksums or the previous event, exactly like a resolver (see resolvers/
 * types.ts). The turn pipeline assembles the envelopes.
 */
export interface HealthTickResult {
  readonly state: WorldState;
  readonly events: readonly DerivedEvent[];
}

/**
 * Advance every living inhabitant's conditions to `now`, and kill whoever the
 * progression has run out on.
 *
 * Runs for **every** inhabitant, not just the turn's actor. An inhabitant who
 * never receives a turn — because the scheduler is behind, because it is
 * confined, because there are simply more inhabitants than turns — must still be
 * able to starve. Mortality that only applied to whoever happened to be acting
 * would make survival a function of scheduler luck.
 *
 * `sequence` is the sequence number the current turn will occupy. It is recorded
 * on any condition or death this tick produces, so that `sequenceMonotonic` can
 * check them against the world sequence and an auditor can find the event that
 * carried them.
 */
export function advanceHealth(
  state: WorldState,
  now: SimTime,
  sequence: number,
): HealthTickResult {
  let next = state;
  const events: DerivedEvent[] = [];
  // One counter across the whole tick: condition ids are derived from
  // (worldId, sequence, discriminator), so every condition born this turn needs
  // a distinct discriminator or two of them would share an id.
  let discriminator = 0;

  for (const subject of sortedValues(state.inhabitants)) {
    // §8: the dead are preserved, not processed. A corpse does not get hungrier.
    if (subject.status !== "alive") continue;

    for (const ailment of AILMENTS) {
      const current = next.inhabitants[subject.id];
      /* c8 ignore next */
      if (current === undefined || current.status !== "alive") break;

      const step = stepAilment(next, current, ailment, now, sequence, discriminator);
      if (step === null) continue;
      discriminator += step.consumedIds;
      next = step.state;
      events.push(...step.events);
    }
  }

  return { state: next, events };
}

interface AilmentStep {
  readonly state: WorldState;
  readonly events: readonly DerivedEvent[];
  /** How many derived ids this step used up. */
  readonly consumedIds: number;
}

function stepAilment(
  state: WorldState,
  subject: Inhabitant,
  ailment: Ailment,
  now: SimTime,
  sequence: number,
  discriminator: number,
): AilmentStep | null {
  const needValue = subject.needs[ailment.need];
  const trend = trendFor(ailment, needValue);
  const existing = openConditionOf(state, subject, ailment.kind);

  if (existing === null) {
    if (trend !== "worsening") return null;
    return openCondition(state, subject, ailment, now, sequence, discriminator);
  }

  if (trend === "holding") {
    // Neither getting worse nor better. The anchor moves to now so that minutes
    // spent in the neutral band cannot later be spent as progress in either
    // direction — a needs value that hovers just under saturation should stall
    // the progression, not bank credit for it.
    if (existing.progressedAt === now) return null;
    return {
      state: putCondition(state, { ...existing, progressedAt: now }),
      events: [],
      consumedIds: 0,
    };
  }

  const rate =
    trend === "worsening"
      ? ailment.minutesPerSeverityPoint
      : recoveryMinutesPerPoint(ailment);
  const elapsed = now - existing.progressedAt;
  const points = idiv(elapsed, rate);
  if (points <= 0) return null;

  // Advance the anchor by exactly what was spent, never to `now`. The remainder
  // is the whole reason the tick can run at any spacing and still produce the
  // same progression.
  //
  // One honest imprecision: a direction change carries the previous direction's
  // leftover minutes across at the new rate. The error is bounded by a single
  // severity point, is identical on every replay, and cannot by itself cross the
  // terminal threshold, since reaching it costs a full period per point.
  const progressedAt = addDuration(existing.progressedAt, duration(points * rate));
  const severity = clampSeverity(
    trend === "worsening" ? existing.severity + points : existing.severity - points,
  );

  const updated: Condition = {
    ...existing,
    severity,
    stage: stageForSeverity(severity),
    progressedAt,
    // A condition that has run to zero is over. It stays in the record — §8
    // preserves history, and a resolved bout is part of a medical history
    // anyone who later studies this inhabitant can find.
    resolved: severity <= 0,
  };

  let next = putCondition(state, updated);
  const events: DerivedEvent[] = [];

  if (updated.resolved) {
    events.push({
      type: "health.condition_resolved",
      actor: subject.id,
      simTime: now,
      inputs: { conditionId: updated.id, kind: ailment.kind },
      resolution: {
        conditionId: updated.id,
        kind: ailment.kind,
        need: ailment.need,
        needValue,
        onsetAt: updated.onsetAt,
        minutesIll: now - updated.onsetAt,
      },
      visibility: { kind: "private", owner: subject.id },
    });
    return { state: next, events, consumedIds: 0 };
  }

  if (trend === "worsening" && severity >= TERMINAL_SEVERITY && ailment.terminal) {
    const death = killInhabitant(next, subject.id, updated, ailment, now, sequence);
    next = death.state;
    events.push(...death.events);
    return { state: next, events, consumedIds: 0 };
  }

  // Crossing a stage boundary is the observable moment of a progression: it is
  // when symptoms change and when another inhabitant might notice something is
  // wrong. Ticks inside a stage are silent, or the log would carry an event per
  // severity point per inhabitant per day.
  if (updated.stage !== existing.stage) {
    events.push({
      type: "health.condition_progressed",
      actor: subject.id,
      simTime: now,
      inputs: { conditionId: updated.id, kind: ailment.kind },
      resolution: {
        conditionId: updated.id,
        kind: ailment.kind,
        need: ailment.need,
        needValue,
        severity,
        stage: updated.stage,
        previousStage: existing.stage,
        trend,
        symptom: ailment.symptom,
      },
      visibility: { kind: "local", x: subject.location.x, y: subject.location.y },
    });
  }

  return { state: next, events, consumedIds: 0 };
}

/** The first unresolved condition of a kind this inhabitant carries, or null. */
function openConditionOf(
  state: WorldState,
  subject: Inhabitant,
  kind: string,
): Condition | null {
  for (const id of [...subject.conditions].sort()) {
    const condition = state.conditions[id];
    if (condition === undefined) continue;
    if (condition.kind === kind && !condition.resolved && condition.subject === subject.id) {
      return condition;
    }
  }
  return null;
}

function openCondition(
  state: WorldState,
  subject: Inhabitant,
  ailment: Ailment,
  now: SimTime,
  sequence: number,
  discriminator: number,
): AilmentStep {
  const condition: Condition = {
    id: deriveConditionId(state.worldId, sequence, discriminator),
    subject: subject.id,
    kind: ailment.kind,
    severity: INITIAL_SEVERITY,
    onsetAt: now,
    progressedAt: now,
    stage: stageForSeverity(INITIAL_SEVERITY),
    resolved: false,
    // §8: "Do not preassign a doctor career." Nobody has diagnosed this. The
    // subject feels it; naming it is work another inhabitant has to do.
    diagnosedBy: [],
    disclosed: false,
    createdSequence: sequence,
  };

  const next = putInhabitant(putCondition(state, condition), {
    ...subject,
    conditions: insertSorted(subject.conditions, condition.id),
  });

  return {
    state: next,
    events: [
      {
        type: "health.condition_onset",
        actor: subject.id,
        simTime: now,
        inputs: { need: ailment.need, needValue: subject.needs[ailment.need] },
        resolution: {
          conditionId: condition.id,
          kind: ailment.kind,
          need: ailment.need,
          needValue: subject.needs[ailment.need],
          severity: INITIAL_SEVERITY,
          stage: condition.stage,
          minutesToTerminal: ailment.minutesPerSeverityPoint * TERMINAL_SEVERITY,
          symptom: ailment.symptom,
        },
        // The condition record is the subject's own knowledge. What others get
        // is the chance to see symptoms, which is a separate observation (§11E).
        visibility: { kind: "private", owner: subject.id },
      },
    ],
    consumedIds: 1,
  };
}

/**
 * End an inhabitant (§8: "Death is irreversible in the initial ruleset").
 *
 * Four fields change and one handle closes. Everything else — inventory,
 * concealed holdings, memories, relationships, beliefs, reputation, skills,
 * memberships, contracts, conditions, lineage, known locations, location itself
 * — is carried through untouched, because §8 requires that death "never delete
 * history" and because the conservation invariant would otherwise report the
 * corpse's food as destroyed matter. Nothing is inherited, redistributed or
 * memorialised here: §8 leaves those to the survivors.
 */
function killInhabitant(
  state: WorldState,
  subjectId: string,
  cause: Condition,
  ailment: Ailment,
  now: SimTime,
  sequence: number,
): { readonly state: WorldState; readonly events: readonly DerivedEvent[] } {
  const terminated = terminateInhabitant(state, subjectId, now, sequence);
  if (terminated === null) return { state, events: [] };

  return {
    state: terminated.state,
    events: [
      {
        type: "inhabitant.died",
        actor: subjectId,
        simTime: now,
        inputs: { conditionId: cause.id },
        // Neutral physical facts (§11G). The log records that an inhabitant
        // stopped, of what, and after how long. It does not record grief,
        // tragedy or blame — those are interpretations, and interpretation is
        // the inhabitants' work.
        resolution: {
          conditionId: cause.id,
          kind: ailment.kind,
          need: ailment.need,
          severity: cause.severity,
          onsetAt: cause.onsetAt,
          minutesIll: now - cause.onsetAt,
          deathTime: now,
          deathSequence: sequence,
          remainsId: terminated.remainsId,
          location: terminated.location,
        },
        visibility: { kind: "local", x: terminated.location.x, y: terminated.location.y },
      },
    ],
  };
}

function clampSeverity(value: number): number {
  if (value < 0) return 0;
  if (value > TERMINAL_SEVERITY) return TERMINAL_SEVERITY;
  return value;
}

/**
 * The number of simulated minutes an inhabitant at full saturation has left
 * before a given ailment kills it.
 *
 * Exported for tests and for the spectator interface, which may legitimately
 * display how close somebody is to dying (§20 "health and mortality history").
 * It reads state; it cannot change it.
 */
export function minutesToDeath(state: WorldState, subjectId: string): number | null {
  const subject = state.inhabitants[subjectId];
  if (subject === undefined || subject.status !== "alive") return null;
  let soonest: number | null = null;
  for (const ailment of AILMENTS) {
    if (!ailment.terminal) continue;
    if (trendFor(ailment, subject.needs[ailment.need]) !== "worsening") continue;
    const condition = openConditionOf(state, subject, ailment.kind);
    const severity = condition === null ? 0 : condition.severity;
    const remaining = (TERMINAL_SEVERITY - severity) * ailment.minutesPerSeverityPoint;
    if (soonest === null || remaining < soonest) soonest = remaining;
  }
  return soonest;
}

/** Every need is a bounded integer. Used by the invariant of the same name. */
export function needsWithinBounds(needs: Needs): boolean {
  for (const value of [needs.hunger, needs.thirst, needs.fatigue, needs.social]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > NEED_CEILING) return false;
  }
  return true;
}
