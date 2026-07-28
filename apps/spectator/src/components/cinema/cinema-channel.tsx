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

import { useMemo, useState } from "react";
import { CinemaViewport } from "./cinema-viewport";
import { MINUTES_PER_DAY } from "@/lib/cinema/types";

export interface ChannelSubject {
  readonly id: string;
  readonly displayName: string;
  readonly status: string;
  readonly generation: number;
  readonly refId: string | null;
}

export interface ChannelActivity {
  readonly id: string;
  readonly sequence: number;
  readonly actionType: string;
  readonly activityState: string;
  readonly participants: readonly string[];
  readonly startedAt: number;
  readonly contentsDisclosed: boolean;
}

export function CinemaChannel({
  subjects,
  activities,
  endTick,
  initialSubjectId = null,
}: {
  readonly subjects: readonly ChannelSubject[];
  readonly activities: readonly ChannelActivity[];
  readonly endTick: number;
  readonly initialSubjectId?: string | null;
}) {
  const [subjectId, setSubjectId] = useState<string | null>(initialSubjectId);
  const [jumpTick, setJumpTick] = useState<number | undefined>(undefined);
  const [jumpKey, setJumpKey] = useState(0);
  const conversations = useMemo(
    () => activities.filter((activity) => activity.activityState === "conversing"),
    [activities],
  );
  const maxDay = Math.floor(endTick / MINUTES_PER_DAY) + 1;
  const jump = (tick: number) => {
    setJumpTick(Math.max(0, Math.min(tick, endTick)));
    setJumpKey((value) => value + 1);
  };

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

      <div className="panel grid gap-3 p-4 sm:grid-cols-2" aria-label="Replay navigator">
        <label className="text-sm text-muted">
          <span className="eyebrow mb-1 block">Go to world day</span>
          <input
            type="number"
            min={1}
            max={maxDay}
            placeholder={`1–${maxDay}`}
            className="w-full rounded-sm border border-line bg-panel-2 px-2.5 py-1.5 text-ink"
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              const day = Number(event.currentTarget.value);
              if (Number.isFinite(day)) jump((day - 1) * MINUTES_PER_DAY);
            }}
          />
          <small>Enter a day and press Return.</small>
        </label>
        <label className="text-sm text-muted">
          <span className="eyebrow mb-1 block">Replay a conversation</span>
          <select
            defaultValue=""
            className="w-full rounded-sm border border-line bg-panel-2 px-2.5 py-1.5 text-ink"
            onChange={(event) => {
              const activity = conversations.find((item) => item.id === event.target.value);
              if (activity !== undefined) jump(activity.startedAt);
            }}
          >
            <option value="">Choose a recorded conversation…</option>
            {conversations.map((activity) => (
              <option key={activity.id} value={activity.id}>
                Day {Math.floor(activity.startedAt / MINUTES_PER_DAY) + 1} · event{" "}
                {activity.sequence} · {activity.participants.length} participant
                {activity.participants.length === 1 ? "" : "s"}
                {activity.contentsDisclosed ? "" : " · contents withheld"}
              </option>
            ))}
          </select>
          <small>{conversations.length.toLocaleString()} conversation records retained.</small>
        </label>
      </div>

      {/* Remounting on subject change resets the shot plan and the rig pool
          cleanly, and a channel change is exactly when a hard reset is correct. */}
      <CinemaViewport
        key={`${subjectId ?? "world"}:${jumpKey}`}
        subjectId={subjectId}
        {...(jumpTick === undefined ? {} : { initialTick: jumpTick })}
        initialRate={60}
      />
    </div>
  );
}
