"use client";

/**
 * Playback transport for the Cinema viewport.
 *
 * Every control here moves a playhead over a finished recording. None of them
 * proposes, schedules, influences or reaches anything in the canonical world —
 * the spectator interface must never contain a control capable of influencing
 * inhabitants (claude.md §20), and "rewind" is the strongest verb available.
 *
 * The scrub track is marked with the tick of every canonical activity start, so
 * scrubbing lands on the moments the record actually contains rather than on
 * arbitrary minutes. That is a reading aid derived from canonical sequence data,
 * not an interpretation of it.
 */

import { useMemo } from "react";
import { MINUTES_PER_DAY, PLAYBACK_RATES } from "@/lib/cinema/types";

export interface CinemaTransportProps {
  readonly tick: number;
  readonly startTick: number;
  readonly endTick: number;
  readonly playing: boolean;
  readonly rate: number;
  readonly skipIdle: boolean;
  readonly cutTicks: readonly number[];
  readonly onPlayingChange: (playing: boolean) => void;
  readonly onSeek: (tick: number) => void;
  readonly onRateChange: (rate: number) => void;
  readonly onSkipIdleChange: (skipIdle: boolean) => void;
  readonly onStepCut: (direction: 1 | -1) => void;
}

/**
 * Cut marks are drawn into a single SVG rather than as one element each: a long
 * run can contain thousands of activity starts, and thousands of DOM nodes on a
 * 6Hz-updating strip is a measurable cost for no visual gain.
 */
function CutMarks({
  cutTicks,
  startTick,
  span,
}: {
  cutTicks: readonly number[];
  startTick: number;
  span: number;
}) {
  const marks = useMemo(
    () =>
      cutTicks.map((cut) => ((cut - startTick) / span) * 1000).filter(
        (position) => position >= 0 && position <= 1000,
      ),
    [cutTicks, startTick, span],
  );

  return (
    <svg
      className="transport__marks"
      viewBox="0 0 1000 12"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {marks.map((position, index) => (
        <line
          // Positions are derived from canonical ticks and are stable across
          // renders; the index is a legitimate key for a static derived list.
          key={`${position}-${index}`}
          x1={position}
          x2={position}
          y1={3}
          y2={9}
          stroke="currentColor"
          strokeWidth="1"
        />
      ))}
    </svg>
  );
}

export function CinemaTransport({
  tick,
  startTick,
  endTick,
  playing,
  rate,
  skipIdle,
  cutTicks,
  onPlayingChange,
  onSeek,
  onRateChange,
  onSkipIdleChange,
  onStepCut,
}: CinemaTransportProps) {
  const span = Math.max(endTick - startTick, 1);
  const day = Math.floor(tick / MINUTES_PER_DAY) + 1;
  const totalDays = Math.floor(endTick / MINUTES_PER_DAY) + 1;

  return (
    <div className="transport">
      <div className="transport__row">
        <button
          type="button"
          className="transport__play"
          aria-pressed={playing}
          onClick={() => onPlayingChange(!playing)}
        >
          {playing ? "Pause" : "Play"}
        </button>

        <button
          type="button"
          className="transport__step"
          onClick={() => onStepCut(-1)}
          aria-label="Previous recorded activity"
        >
          ⟵ cut
        </button>
        <button
          type="button"
          className="transport__step"
          onClick={() => onStepCut(1)}
          aria-label="Next recorded activity"
        >
          cut ⟶
        </button>

        <div className="transport__rates" role="group" aria-label="Playback speed">
          {PLAYBACK_RATES.map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={rate === option.rate}
              onClick={() => onRateChange(option.rate)}
              title={`${option.rate} sim minutes per real second`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {/*
          Only 9.2% of inhabitant-time in the exported run is occupied by a
          recorded activity — the median gap between one inhabitant's activities
          is five hours. Playing that back minute by minute means watching
          someone stand still for most of the running time.

          Skipping idle time is an *edit*, and it is labelled as one. It removes
          nothing from the record and adds nothing to it: the intervals it jumps
          are canonically idle, they remain scrubbable, and turning this off
          plays every minute in order. It is the difference between a film and
          the uncut security footage it was cut from, and the viewer is told
          which one they are watching.
        */}
        <button
          type="button"
          className="transport__toggle"
          aria-pressed={skipIdle}
          onClick={() => onSkipIdleChange(!skipIdle)}
          title="Jump the playhead over intervals in which no activity was recorded"
        >
          {skipIdle ? "Skipping idle" : "Every minute"}
        </button>

        <p className="transport__position mono">
          Day {day} of {totalDays}
        </p>
      </div>

      <div className="transport__track">
        <CutMarks cutTicks={cutTicks} startTick={startTick} span={span} />
        <input
          type="range"
          className="transport__scrub"
          min={startTick}
          max={endTick}
          step={1}
          value={Math.round(tick)}
          onChange={(event) => onSeek(Number(event.target.value))}
          aria-label="World time"
          aria-valuetext={`Day ${day} of ${totalDays}`}
        />
      </div>
    </div>
  );
}
