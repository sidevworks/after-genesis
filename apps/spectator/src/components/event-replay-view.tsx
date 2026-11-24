// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
"use client";

import { useEffect, useMemo, useState } from "react";
import type { ObservatoryRun, ReferenceRecord } from "@/lib/observatory-types";
import { Badge } from "./ui";
import { VoxelWorldViewport } from "./voxel-world-viewport";

const PHASES = ["BEFORE", "DURING", "AFTER"] as const;
type ReplayPhase = (typeof PHASES)[number];

function eventRef(sequence: number): string {
  return `AG:W001:EVT:${String(sequence + 1).padStart(12, "0")}`;
}

function actionLabel(type: string, visibility: string): string {
  if (type === "withheld_event") {
    return visibility === "participants"
      ? "Participant-only event"
      : "Private canonical event";
  }
  return type.replace(/^action\./, "").replaceAll("_", " ");
}

export function EventReplayView({
  record,
  run,
}: {
  record: ReferenceRecord;
  run: ObservatoryRun;
}) {
  const sequence = Number(record.canonicalMetadata.sequence ?? -1);
  const event = run.events.find((candidate) => candidate.sequence === sequence) ?? null;
  const [phase, setPhase] = useState<ReplayPhase>("DURING");
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing) return;
    setPhase("BEFORE");
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      if (index >= PHASES.length) {
        window.clearInterval(timer);
        setPlaying(false);
        return;
      }
      setPhase(PHASES[index] ?? "AFTER");
    }, 1600);
    return () => window.clearInterval(timer);
  }, [playing]);

  const sameDayEvents = useMemo(() => {
    if (!event) return [];
    const day = Math.floor(event.simTime / 1440);
    return run.events.filter((candidate) => Math.floor(candidate.simTime / 1440) === day);
  }, [event, run.events]);

  if (!event) {
    return (
      <section className="panel px-4 py-8 text-sm text-dim">
        The canonical event envelope is unavailable in this export.
      </section>
    );
  }

  const detail = event.detail ?? {};
  const from =
    typeof detail.from === "object" && detail.from !== null
      ? (detail.from as { x?: number; y?: number })
      : null;
  const to =
    typeof detail.to === "object" && detail.to !== null
      ? (detail.to as { x?: number; y?: number })
      : null;
  const location =
    phase === "BEFORE" && typeof from?.x === "number" && typeof from.y === "number"
      ? { x: from.x, y: from.y }
      : phase === "AFTER" && typeof to?.x === "number" && typeof to.y === "number"
        ? { x: to.x, y: to.y }
        : event.location;
  const actor = run.inhabitants.find((inhabitant) => inhabitant.id === event.actorId) ?? null;
  const withheld = event.canonicalType === "withheld_event";
  const label = actionLabel(event.canonicalType, event.visibility);
  const isCreation = /build|construct|create|shape|join|modify/.test(event.canonicalType);

  return (
    <section className="event-player" aria-labelledby="event-player-title">
      <header className="event-player__header">
        <div>
          <p className="eyebrow">
            Canonical replay · event {event.sequence} · tick {event.simTime}
          </p>
          <h2 id="event-player-title" className="mt-1 text-xl font-medium text-ink">
            {label}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={withheld ? "warn" : "alive"}>
            {withheld ? "content withheld" : "canonical record"}
          </Badge>
          <Badge>{event.visibility}</Badge>
        </div>
      </header>

      <div className="event-player__stage">
        {location ? (
          <VoxelWorldViewport
            run={run}
            focus={location}
            targetId={event.actorId}
            targetName={actor?.displayName ?? "Canonical event"}
            visualSeed={record.observatoryMetadata.visualSeed}
            mode="event"
            phase={phase}
            movement={
              typeof from?.x === "number" &&
              typeof from.y === "number" &&
              typeof to?.x === "number" &&
              typeof to.y === "number"
                ? { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } }
                : null
            }
          />
        ) : (
          <div className="event-player__unlocated">
            <span aria-hidden>◇</span>
            <strong>No disclosed spatial record</strong>
            <small>The event remains replayable as a canonical envelope.</small>
          </div>
        )}
        <div className="event-player__phase">
          <span>{phase}</span>
          <p>
            {phase === "BEFORE"
              ? "State immediately before resolution"
              : phase === "DURING"
                ? withheld
                  ? "Canonical occurrence; protected contents are not rendered"
                  : `Recorded ${label} resolution`
                : "State immediately after resolution"}
          </p>
        </div>
      </div>

      <div className="event-player__controls">
        <button
          type="button"
          onClick={() => setPlaying((current) => !current)}
          className="event-player__play"
        >
          {playing ? "Pause" : "Play replay"}
        </button>
        <div className="event-player__phases" aria-label="Replay phase">
          {PHASES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              aria-pressed={phase === candidate}
              onClick={() => {
                setPlaying(false);
                setPhase(candidate);
              }}
            >
              {candidate.toLowerCase()}
            </button>
          ))}
        </div>
        <p className="text-xs text-dim">
          {isCreation
            ? "Creation replay uses recorded action and provenance stages."
            : "No meaning, emotion, or missing physical detail is invented."}
        </p>
      </div>

      <div className="event-player__day">
        <div className="flex items-baseline justify-between gap-3">
          <p className="eyebrow">Earlier and later that world day</p>
          <span className="mono text-[0.62rem] text-dim">
            {sameDayEvents.length} canonical events
          </span>
        </div>
        <div className="event-player__timeline">
          {sameDayEvents.map((candidate) => (
            <a
              key={candidate.sequence}
              href={`/world/W001/watch/${encodeURIComponent(eventRef(candidate.sequence))}`}
              aria-current={candidate.sequence === event.sequence ? "true" : undefined}
              title={`Event ${candidate.sequence} · tick ${candidate.simTime}`}
            >
              <span>{candidate.sequence}</span>
              <small>{actionLabel(candidate.canonicalType, candidate.visibility)}</small>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
