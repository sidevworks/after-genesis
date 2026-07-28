/**
 * Vital signs, read out of the canonical record.
 *
 * ## Why this exists
 *
 * The engine's resolvers already record physiology in their resolution detail —
 * `rest` records `fatigueBefore`/`fatigueAfter`, `consume` records a `need` with
 * its level before and after, `wait` records `hungerAfter` and `thirstAfter`.
 * None of it was surfaced anywhere. It is the most human material in the whole
 * export: it is what makes a gather at hour 14 legible as a response to a hunger
 * reading at hour 9, rather than as an arbitrary event in a log.
 *
 * ## The honesty problem, and how it is solved
 *
 * Needs change continuously in the engine (`advanceNeeds` runs on every resolved
 * action), but the *record* only exposes their value at the moments a resolver
 * happened to write one down. So we know Ember's hunger was 16 at Day 10 14:00
 * and we do not know what it was at 14:30.
 *
 * This module therefore does **not** interpolate, extrapolate or model decay.
 * It reports the last disclosed value and how old it is, and the interface shows
 * the age. A stale reading is presented as a stale reading. Inventing a smooth
 * curve between two disclosed samples would look better and would be a claim the
 * record does not make (claude.md §11G).
 *
 * Samples are taken only from events whose contents were disclosed. A withheld
 * event contributes nothing, not even a timestamp.
 */
import type { ObservatoryRun } from "../observatory-types";
import type { Tick } from "./types";

/** A need level as the record stated it, at the tick it was stated. */
export interface VitalSample {
  readonly tick: Tick;
  readonly value: number;
  /** The canonical event type the reading came from. */
  readonly source: string;
  readonly sequence: number;
}

export type VitalKind = "hunger" | "thirst" | "fatigue";

export interface VitalsSeries {
  readonly inhabitantId: string;
  readonly hunger: readonly VitalSample[];
  readonly thirst: readonly VitalSample[];
  readonly fatigue: readonly VitalSample[];
  /**
   * Cumulative units of each resource this inhabitant was recorded gathering
   * minus units recorded consumed, from disclosed events only.
   *
   * This is deliberately *not* an inventory balance. Undisclosed transfers,
   * gifts and losses exist and are not counted here, so the running figure can
   * differ from the inhabitant's true holdings. The interface must label it as
   * disclosed flow, never as a balance (claude.md §11E: private holdings are not
   * exposed without a valid disclosure path).
   */
  readonly flow: readonly FlowSample[];
}

export interface FlowSample {
  readonly tick: Tick;
  readonly resource: string;
  /** Positive for a recorded gather, negative for a recorded consumption. */
  readonly delta: number;
  readonly sequence: number;
}

export interface VitalsReading {
  readonly value: number | null;
  /** Sim-minutes since the reading was recorded. Null when there is no reading. */
  readonly ageMinutes: number | null;
  readonly source: string | null;
}

function numberAt(detail: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = detail[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Walk the disclosed events once and collect every physiological reading the
 * resolvers wrote down.
 *
 * The key mapping, taken from the resolvers themselves:
 *
 *   `action.rest`    → `fatigueAfter`                        (resolvers/basic.ts)
 *   `action.consume` → `needAfter`, keyed by `need`          (resolvers/basic.ts)
 *   `action.wait`    → `hungerAfter`, `thirstAfter`          (resolvers/basic.ts)
 *   `action.gather`  → `amount` of `resource`                (resolvers/gather.ts)
 *
 * Anything a resolver did not record is simply absent. Nothing is filled in.
 */
export function buildVitals(run: ObservatoryRun): ReadonlyMap<string, VitalsSeries> {
  const hunger = new Map<string, VitalSample[]>();
  const thirst = new Map<string, VitalSample[]>();
  const fatigue = new Map<string, VitalSample[]>();
  const flow = new Map<string, FlowSample[]>();

  const push = (
    bucket: Map<string, VitalSample[]>,
    id: string,
    sample: VitalSample,
  ): void => {
    const existing = bucket.get(id);
    if (existing === undefined) bucket.set(id, [sample]);
    else existing.push(sample);
  };

  for (const event of run.events) {
    const actor = event.actorId;
    const detail = event.detail;
    if (actor === null || detail === null) continue;

    if (event.canonicalType === "action.rest") {
      const after = numberAt(detail, "fatigueAfter");
      if (after !== null) {
        push(fatigue, actor, {
          tick: event.simTime,
          value: after,
          source: "rest",
          sequence: event.sequence,
        });
      }
    }

    if (event.canonicalType === "action.consume") {
      const after = numberAt(detail, "needAfter");
      const need = detail["need"];
      if (after !== null && (need === "hunger" || need === "thirst")) {
        push(need === "hunger" ? hunger : thirst, actor, {
          tick: event.simTime,
          value: after,
          source: "consume",
          sequence: event.sequence,
        });
      }
      const amount = numberAt(detail, "amount");
      const resource = detail["resource"];
      if (amount !== null && typeof resource === "string") {
        const bucket = flow.get(actor) ?? [];
        bucket.push({
          tick: event.simTime,
          resource,
          delta: -amount,
          sequence: event.sequence,
        });
        flow.set(actor, bucket);
      }
    }

    if (event.canonicalType === "action.wait") {
      const hungerAfter = numberAt(detail, "hungerAfter");
      const thirstAfter = numberAt(detail, "thirstAfter");
      if (hungerAfter !== null) {
        push(hunger, actor, {
          tick: event.simTime,
          value: hungerAfter,
          source: "wait",
          sequence: event.sequence,
        });
      }
      if (thirstAfter !== null) {
        push(thirst, actor, {
          tick: event.simTime,
          value: thirstAfter,
          source: "wait",
          sequence: event.sequence,
        });
      }
    }

    if (event.canonicalType === "action.gather") {
      const amount = numberAt(detail, "amount");
      const resource = detail["resource"];
      if (amount !== null && typeof resource === "string") {
        const bucket = flow.get(actor) ?? [];
        bucket.push({
          tick: event.simTime,
          resource,
          delta: amount,
          sequence: event.sequence,
        });
        flow.set(actor, bucket);
      }
    }
  }

  const byTick = (left: { tick: number }, right: { tick: number }): number =>
    left.tick - right.tick;

  const series = new Map<string, VitalsSeries>();
  for (const inhabitant of run.inhabitants) {
    series.set(inhabitant.id, {
      inhabitantId: inhabitant.id,
      hunger: (hunger.get(inhabitant.id) ?? []).sort(byTick),
      thirst: (thirst.get(inhabitant.id) ?? []).sort(byTick),
      fatigue: (fatigue.get(inhabitant.id) ?? []).sort(byTick),
      flow: (flow.get(inhabitant.id) ?? []).sort(byTick),
    });
  }
  return series;
}

/**
 * The most recent disclosed reading at or before `tick`.
 *
 * Binary search: this is read once per interface update per vital, and the
 * series can hold hundreds of samples over a long run.
 */
export function readingAt(
  samples: readonly VitalSample[],
  tick: Tick,
): VitalsReading {
  if (samples.length === 0) return { value: null, ageMinutes: null, source: null };

  let low = 0;
  let high = samples.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = samples[mid];
    if (candidate === undefined) break;
    if (candidate.tick <= tick) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const sample = found >= 0 ? samples[found] : undefined;
  if (sample === undefined) return { value: null, ageMinutes: null, source: null };
  return {
    value: sample.value,
    ageMinutes: tick - sample.tick,
    source: sample.source,
  };
}

/** Disclosed net flow of every resource at or before `tick`. */
export function flowAt(
  samples: readonly FlowSample[],
  tick: Tick,
): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const sample of samples) {
    if (sample.tick > tick) break;
    totals.set(sample.resource, (totals.get(sample.resource) ?? 0) + sample.delta);
  }
  return totals;
}
