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
import { MINUTES_PER_DAY } from "@/lib/cinema/types";
import { ActivityBrowser } from "./activity-browser";
import type { Chronicle } from "@/lib/cinema/types";
import type { TerrainMap } from "@/lib/stage/terrain";
import type { SettlementProjectionSource } from "@/lib/city/project-settlement";

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
  chronicle,
  map,
  settlementSource,
  initialSubjectId = null,
}: {
  readonly subjects: readonly ChannelSubject[];
  readonly activities: readonly ChannelActivity[];
  readonly endTick: number;
  readonly chronicle?: Chronicle;
  readonly map?: TerrainMap;
  readonly settlementSource?: SettlementProjectionSource;
  readonly initialSubjectId?: string | null;
}) {
  const [subjectId, setSubjectId] = useState<string | null>(initialSubjectId);
  const [jumpTick, setJumpTick] = useState<number | undefined>(undefined);
  const [jumpKey, setJumpKey] = useState(0);
  const [dayDraft, setDayDraft] = useState("");
  const [broadcast, setBroadcast] = useState(false);
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
          aria-pressed={broadcast}
          onClick={() => setBroadcast((value) => !value)}
          className="channel-picker__option channel-picker__broadcast"
        >
          <span className="channel-picker__name">{broadcast ? "Exit broadcast" : "Broadcast / TikTok"}</span>
          <small>9:16 story view · automatically skips idle gaps</small>
        </button>
        {!broadcast ? <button
          type="button"
          aria-pressed={subjectId === null}
          onClick={() => setSubjectId(null)}
          className="channel-picker__option"
        >
          <span className="channel-picker__name">World record</span>
          <small>Cuts between inhabitants by canonical significance</small>
        </button> : null}

        {!broadcast ? subjects.map((subject) => (
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
        )) : null}
      </div>

      {!broadcast ? <div className="panel p-4" aria-label="Replay navigator">
        <label className="text-sm text-muted">
          <span className="eyebrow mb-1 block">Go to world day</span>
          <span className="flex gap-2">
            <input
              type="number"
              min={1}
              max={maxDay}
              value={dayDraft}
              onChange={(event) => setDayDraft(event.currentTarget.value)}
              placeholder={`1–${maxDay}`}
              className="w-full rounded-sm border border-line bg-panel-2 px-2.5 py-1.5 text-ink"
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                const day = Number(dayDraft);
                if (Number.isFinite(day) && day >= 1 && day <= maxDay) {
                  jump((day - 1) * MINUTES_PER_DAY);
                }
              }}
            />
            <button
              type="button"
              className="transport__step"
              onClick={() => {
                const day = Number(dayDraft);
                if (Number.isFinite(day) && day >= 1 && day <= maxDay) {
                  jump((day - 1) * MINUTES_PER_DAY);
                }
              }}
            >
              Go
            </button>
          </span>
          <small>Jump to any available day from 1 to {maxDay}.</small>
        </label>
      </div> : null}

      {!broadcast ? (
        <ActivityBrowser activities={activities} subjects={subjects} onSelect={(activity) => jump(activity.startedAt)} />
      ) : null}

      {/* Remounting on subject change resets the shot plan and the rig pool
          cleanly, and a channel change is exactly when a hard reset is correct. */}
      <CinemaViewport
        key={`${subjectId ?? "world"}:${jumpKey}`}
        subjectId={subjectId}
        {...(jumpTick === undefined ? {} : { initialTick: jumpTick })}
        initialRate={60}
        {...(chronicle === undefined ? {} : { chronicleOverride: chronicle })}
        {...(map === undefined ? {} : { mapOverride: map })}
        {...(settlementSource === undefined ? {} : { settlementSource })}
        broadcast={broadcast}
      />
    </div>
  );
}
