// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
"use client";

/**
 * The clock on the door.
 *
 * Renders one of three things, matching the three states in `lib/launch.ts`:
 * no announced date, a live countdown, or "the world has started".
 *
 * The first render deliberately shows no numbers. `output: "export"` means this
 * component runs at build time, and a countdown baked into static HTML would be
 * wrong by however long the file sat on a CDN. The ticking starts after mount,
 * where there is a real clock.
 */

import { useEffect, useMemo, useState } from "react";

import { genesisAt, timeUntilGenesis, type Remaining } from "@/lib/launch";

export function Countdown() {
  const at = useMemo(() => genesisAt(), []);
  const [remaining, setRemaining] = useState<Remaining | null>(null);

  useEffect(() => {
    if (!at) return;
    const tick = () => setRemaining(timeUntilGenesis());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [at]);

  /* No date published yet. ------------------------------------------------- */
  if (!at) {
    return (
      <div className="panel px-5 py-4">
        <p className="eyebrow">Genesis</p>
        <p className="mt-1.5 text-lg font-medium tracking-tight text-ink">
          Date to be announced
        </p>
        <p className="mt-2 max-w-md text-xs leading-relaxed text-muted">
          The world starts once its dress rehearsal has run continuously for fourteen days and the
          launch-readiness report is written. We would rather announce a date we can keep than one
          that sounds soon.
        </p>
      </div>
    );
  }

  /* Announced, and already begun. ------------------------------------------ */
  if (remaining?.elapsed) {
    return (
      <div className="panel px-5 py-4">
        <p className="eyebrow">Genesis</p>
        <p className="mt-1.5 text-lg font-medium tracking-tight text-alive">
          The first inhabitant is awake.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Everything from here was decided inside the world.
        </p>
      </div>
    );
  }

  const units: ReadonlyArray<[string, number]> = remaining
    ? [
        ["days", remaining.days],
        ["hours", remaining.hours],
        ["minutes", remaining.minutes],
        ["seconds", remaining.seconds],
      ]
    : [
        ["days", -1],
        ["hours", -1],
        ["minutes", -1],
        ["seconds", -1],
      ];

  return (
    <div className="panel px-5 py-4">
      <p className="eyebrow">The first inhabitant is released in</p>
      <div className="mt-2.5 flex gap-5" role="timer" aria-live="off">
        {units.map(([label, value]) => (
          <div key={label}>
            <div className="mono text-2xl leading-none tabular-nums text-amber sm:text-3xl">
              {value < 0 ? "––" : String(value).padStart(2, "0")}
            </div>
            <div className="eyebrow mt-1.5">{label}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-dim">
        <time dateTime={at.toISOString()}>
          {at.toLocaleString(undefined, {
            dateStyle: "full",
            timeStyle: "short",
          })}
        </time>{" "}
        in your timezone
      </p>
    </div>
  );
}
