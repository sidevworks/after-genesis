"use client";

/**
 * The channel: pick who the camera follows, or let the director cut.
 *
 * The world feed (`subjectId === null`) is not a highlight reel someone curated.
 * The director ranks moments by canonical facts — how many inhabitants took
 * part, how long an activity lasted, whether it was the first of its kind — and
 * cuts to them in world-time order. It cannot skip an outcome for being dull or
 * linger on one for being dramatic, because it never sees an interpretation of
 * either. claude.md §26: "Do not create fake behaviours merely to make the world
 * entertaining."
 */

import { useState } from "react";
import { CinemaViewport } from "./cinema-viewport";

export interface ChannelSubject {
  readonly id: string;
  readonly displayName: string;
  readonly status: string;
  readonly generation: number;
  readonly refId: string | null;
}

export function CinemaChannel({
  subjects,
  initialSubjectId = null,
}: {
  readonly subjects: readonly ChannelSubject[];
  readonly initialSubjectId?: string | null;
}) {
  const [subjectId, setSubjectId] = useState<string | null>(initialSubjectId);

  return (
    <div className="space-y-4">
      <div className="channel-picker" role="group" aria-label="Camera subject">
        <button
          type="button"
          aria-pressed={subjectId === null}
          onClick={() => setSubjectId(null)}
          className="channel-picker__option"
        >
          <span className="channel-picker__name">World record</span>
          <small>Cuts between inhabitants by canonical significance</small>
        </button>

        {subjects.map((subject) => (
          <button
            key={subject.id}
            type="button"
            aria-pressed={subjectId === subject.id}
            onClick={() => setSubjectId(subject.id)}
            className="channel-picker__option"
          >
            <span className="channel-picker__name">{subject.displayName}</span>
            <small>
              Generation {subject.generation} · {subject.status}
            </small>
          </button>
        ))}
      </div>

      {/* Remounting on subject change resets the shot plan and the rig pool
          cleanly, and a channel change is exactly when a hard reset is correct. */}
      <CinemaViewport key={subjectId ?? "world"} subjectId={subjectId} />
    </div>
  );
}
