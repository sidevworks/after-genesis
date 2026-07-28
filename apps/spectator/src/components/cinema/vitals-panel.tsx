"use client";

/**
 * Vital signs, as the record stated them.
 *
 * Every figure here is a value a resolver wrote into a disclosed canonical
 * event. Nothing is modelled, smoothed or projected forward. When a reading is
 * old, the panel says how old — a hunger level last stated eleven hours ago is
 * shown as an eleven-hour-old reading, not as a current one, because the record
 * does not say what it is now (claude.md §11E, §11G).
 *
 * Needs run 0–100 in the engine, where higher is more urgent. The bar fills as
 * the need grows, so a full bar reads as pressure rather than as health.
 */

import { flowAt, readingAt, type VitalsSeries } from "@/lib/cinema/vitals";

const NEEDS = [
  { key: "hunger", label: "Hunger" },
  { key: "thirst", label: "Thirst" },
  { key: "fatigue", label: "Fatigue" },
] as const;

/** Beyond this, a reading is old enough that presenting it plainly would mislead. */
const STALE_AFTER_MINUTES = 240;

function ageLabel(ageMinutes: number | null): string {
  if (ageMinutes === null) return "never recorded";
  if (ageMinutes === 0) return "recorded now";
  if (ageMinutes < 60) return `${Math.round(ageMinutes)}m ago`;
  const hours = ageMinutes / 60;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h ago`;
  return `${(hours / 24).toFixed(1)}d ago`;
}

export function VitalsPanel({
  series,
  tick,
}: {
  readonly series: VitalsSeries | null;
  readonly tick: number;
}) {
  if (series === null) return null;

  const totals = flowAt(series.flow, tick);
  const resources = [...totals.entries()].filter(([, value]) => value !== 0).sort();

  return (
    <div className="vitals">
      <p className="eyebrow vitals__head">Last disclosed reading</p>

      <dl className="vitals__list">
        {NEEDS.map((need) => {
          const reading = readingAt(series[need.key], tick);
          const stale =
            reading.ageMinutes !== null && reading.ageMinutes > STALE_AFTER_MINUTES;
          const percent = reading.value === null ? 0 : Math.max(0, Math.min(100, reading.value));

          return (
            <div key={need.key} className={`vitals__row${stale ? " vitals__row--stale" : ""}`}>
              <dt>{need.label}</dt>
              <dd>
                <span className="vitals__bar" aria-hidden="true">
                  <span className="vitals__fill" style={{ width: `${percent}%` }} />
                </span>
                <span className="mono vitals__value">
                  {reading.value === null ? "—" : Math.round(reading.value)}
                </span>
                <small className="vitals__age">{ageLabel(reading.ageMinutes)}</small>
              </dd>
            </div>
          );
        })}
      </dl>

      {resources.length > 0 ? (
        <p className="vitals__flow">
          <span className="eyebrow">Disclosed flow</span>
          {resources.map(([resource, value]) => (
            <span key={resource} className="mono vitals__flow-item">
              {resource} {value > 0 ? "+" : ""}
              {value}
            </span>
          ))}
        </p>
      ) : null}

      <p className="vitals__note">
        Values are the last ones a disclosed canonical event stated. They are not
        projected forward, and disclosed flow is not an inventory balance.
      </p>
    </div>
  );
}
