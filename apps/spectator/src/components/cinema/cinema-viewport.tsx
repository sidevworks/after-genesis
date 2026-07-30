"use client";

/**
 * The Cinema viewport — a continuous, watchable rendering of canonical history.
 *
 * ## The one architectural rule
 *
 * The animation loop never calls `setState`. At 60fps a React re-render per
 * frame would cost more than the rendering itself and would make the transport
 * controls stutter. Instead:
 *
 *   - `requestAnimationFrame` advances a tick held in a ref, samples the
 *     chronicle, resolves a camera pose and hands both to the Stage;
 *   - a slow interval copies a snapshot of that same state into React state,
 *     purely so the caption, clock and vitals can be displayed.
 *
 * So the picture runs at frame rate and the interface updates at reading rate.
 *
 * ## What is canonical here and what is not
 *
 * Canonical: every position, every activity, every duration, every participant,
 * the world clock, the physiological readings, and whether an activity's
 * contents were disclosed at all. Derived: the camera, the lighting, the
 * day/night colour, the gait, the gestures, the terrain scatter. The provenance
 * strip under the picture says so on screen, permanently, because claude.md §12
 * requires generated media to be distinguishable from canonical world actions.
 *
 * This component contains no control that can reach the world. It scrubs a
 * finished recording (claude.md §20).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { planShots, resolvePose } from "@/lib/cinema/director";
import { performanceFor } from "@/lib/cinema/performances";
import { effectivePlaybackRate } from "@/lib/cinema/playback";
import { sampleFrame } from "@/lib/cinema/sample";
import { getChronicle, getMap, openingTick } from "@/lib/cinema/source";
import type { ActorSample, PerformanceSpec, ShotPlan, WorldFrame } from "@/lib/cinema/types";
import type { Chronicle } from "@/lib/cinema/types";
import type { TerrainMap } from "@/lib/stage/terrain";
import type { SettlementProjectionSource } from "@/lib/city/project-settlement";
import { MINUTES_PER_DAY } from "@/lib/cinema/types";
import { buildVitals, type VitalsSeries } from "@/lib/cinema/vitals";
import type { ObservatoryRun } from "@/lib/observatory-types";
import { observatorySource } from "@/lib/observatory-source";
import { Stage } from "@/lib/stage/stage";
import { CinemaCaption } from "./caption";
import { BroadcastOverlay } from "./broadcast-overlay";
import { BroadcastTransport } from "./broadcast-transport";
import { CinemaTransport } from "./transport";
import { ElevenLabsVoicePlayer } from "../elevenlabs-voice-player";
import { VitalsPanel } from "./vitals-panel";

/** How often the interface catches up with the picture. 6Hz reads comfortably. */
const HUD_INTERVAL_MS = 160;

/** Never advance more than a quarter second of real time in one frame. */
const MAX_FRAME_SECONDS = 0.25;

/** Idle stretches shorter than this play through; jumping them would be jarring. */
const IDLE_SKIP_THRESHOLD_MINUTES = 90;

/** Land this far before an activity starts, so it is seen beginning. */
const SKIP_LEAD_IN_MINUTES = 15;

export interface CinemaViewportProps {
  /** Canonical inhabitant id to follow, or null for the world feed. */
  readonly subjectId: string | null;
  readonly initialTick?: number;
  readonly initialRate?: number;
  readonly chronicleOverride?: Chronicle;
  readonly runOverride?: ObservatoryRun;
  readonly mapOverride?: TerrainMap;
  readonly settlementSource?: SettlementProjectionSource;
  readonly broadcast?: boolean;
  /** Names the folder under `public/voice/` holding this reel's rendered audio. */
  readonly voiceReel: string;
}

interface Interval {
  readonly start: number;
  readonly end: number;
}

export interface CinemaHud {
  readonly tick: number;
  readonly day: number;
  readonly clock: string;
  readonly subject: ActorSample | null;
  readonly shotKind: string;
  readonly shotReason: string;
  readonly playing: boolean;
  readonly rate: number;
  readonly effectiveRate: number;
  readonly skipIdle: boolean;
  /** Sim-minutes of idle time the last skip jumped, for the on-screen notice. */
  readonly skipped: number | null;
}

function clockOf(tick: number): string {
  const minuteOfDay = Math.floor(tick) % MINUTES_PER_DAY;
  const hours = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const minutes = String(minuteOfDay % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function durationLabel(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} minutes`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

function actorPerformance(actor: ActorSample): PerformanceSpec {
  return performanceFor(actor.actionType, actor.activityState, actor.disclosure);
}

function pickSubject(frame: WorldFrame, subjectId: string | null): ActorSample | null {
  if (subjectId !== null) {
    return frame.actors.find((actor) => actor.inhabitantId === subjectId) ?? null;
  }
  // The world feed has no fixed subject; report whoever is mid-activity, since
  // that is who the director will have chosen to frame.
  return (
    frame.actors.find((actor) => actor.present && actor.activityState !== "idle") ??
    frame.actors.find((actor) => actor.present) ??
    null
  );
}

/**
 * Intervals in which a recorded activity was under way.
 *
 * Idle is a canonically *known* state, not a gap — `settleExpiredActivities`
 * returns an inhabitant to idle when an activity ends — so these intervals are
 * "something was recorded happening", not "the record exists here".
 */
function activityIntervals(
  chronicle: ReturnType<typeof getChronicle>,
  subjectId: string | null,
): readonly Interval[] {
  const tracks =
    subjectId === null
      ? chronicle.tracks
      : chronicle.tracks.filter((track) => track.inhabitantId === subjectId);

  const raw: Interval[] = [];
  for (const track of tracks) {
    for (const segment of track.segments) {
      if (segment.activityState === "idle" || segment.disclosure === "unrecorded") continue;
      raw.push({ start: segment.startTick, end: segment.endTick });
    }
  }
  raw.sort((left, right) => left.start - right.start);

  // Merge overlaps so the world feed does not treat two simultaneous activities
  // as two separate things to stop for.
  const merged: Interval[] = [];
  for (const interval of raw) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.start <= last.end) {
      merged[merged.length - 1] = {
        start: last.start,
        end: Math.max(last.end, interval.end),
      };
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

export function CinemaViewport({
  subjectId,
  initialTick,
  initialRate = 240,
  chronicleOverride,
  runOverride,
  mapOverride,
  settlementSource,
  broadcast = false,
  voiceReel,
}: CinemaViewportProps) {
  const chronicle = chronicleOverride ?? getChronicle();
  const mountRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const planRef = useRef<ShotPlan | null>(null);
  const frameRef = useRef<WorldFrame | null>(null);
  const skippedRef = useRef<number | null>(null);

  const startTick = chronicle.startTick;
  const endTick = chronicle.endTick;

  const intervals = useMemo(
    () => activityIntervals(chronicle, subjectId),
    [chronicle, subjectId],
  );
  const intervalsRef = useRef(intervals);
  intervalsRef.current = intervals;

  const vitals = useMemo(
    () => buildVitals(runOverride ?? observatorySource.getRun()),
    [runOverride],
  );
  const [vitalsSeries, setVitalsSeries] = useState<VitalsSeries | null>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "x" || event.key === "X") {
        setIsFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  const overrideOpening =
    chronicle.cutTicks[0] === undefined
      ? chronicle.startTick
      : Math.max(chronicle.startTick, chronicle.cutTicks[0] - 10);
  const tickRef = useRef(
    initialTick ?? (chronicleOverride === undefined ? openingTick(subjectId) : overrideOpening),
  );
  const totalDays = Math.max(1, Math.ceil(endTick / MINUTES_PER_DAY));
  const playingRef = useRef(false);
  const voiceHoldingRef = useRef(false);
  const rateRef = useRef(initialRate);
  const skipIdleRef = useRef(true);

  const [hud, setHud] = useState<CinemaHud>(() => ({
    tick: tickRef.current,
    day: Math.min(totalDays, Math.floor(tickRef.current / MINUTES_PER_DAY) + 1),
    clock: clockOf(tickRef.current),
    subject: null,
    shotKind: "ESTABLISH",
    shotReason: "Opening the sequence.",
    playing: false,
    rate: initialRate,
    effectiveRate: initialRate,
    skipIdle: true,
    skipped: null,
  }));

  /* --------------------------------------------------------------------- */
  /* Shot plan — recomputed only when the subject changes.                  */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    planRef.current = planShots({ chronicle, subjectId, startTick, endTick });
  }, [chronicle, subjectId, startTick, endTick]);

  /* --------------------------------------------------------------------- */
  /* Stage lifetime — created once, disposed once.                          */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;

    const stage = new Stage(mount, {
      map: mapOverride ?? getMap(),
      chronicle,
      ...(settlementSource === undefined ? {} : { settlementSource }),
    });
    stageRef.current = stage;

    const observer = new ResizeObserver(() => stage.resize());
    observer.observe(mount);
    stage.resize();

    return () => {
      observer.disconnect();
      stage.dispose();
      stageRef.current = null;
    };
  }, [chronicle, mapOverride, settlementSource]);

  useEffect(() => {
    stageRef.current?.setHighlight(subjectId);
  }, [subjectId]);

  useEffect(() => {
    if (!broadcast) return;
    skipIdleRef.current = true;
    playingRef.current = true;
    setHud((current) => ({ ...current, skipIdle: true, playing: true }));
  }, [broadcast]);

  /* --------------------------------------------------------------------- */
  /* The picture: one rAF loop, no React state.                             */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    let raf = 0;
    let previous = performance.now();

    /**
     * Advance the playhead, jumping idle stretches when asked to.
     *
     * The jump is an edit, not a redaction: the interval skipped is canonically
     * idle, it stays scrubbable, and turning the toggle off plays every minute
     * of it in order. Without it, 91% of the running time is a motionless figure.
     */
    const advance = (from: number, elapsed: number): number => {
      const effectiveRate = effectivePlaybackRate(
        from,
        rateRef.current,
        intervalsRef.current,
      );
      const next = from + elapsed * effectiveRate;
      if (!skipIdleRef.current) return next;

      const list = intervalsRef.current;
      if (list.length === 0) return next;

      const inside = list.some((interval) => next >= interval.start && next < interval.end);
      if (inside) return next;

      const upcoming = list.find((interval) => interval.start > next);
      if (upcoming === undefined) return next;

      const landing = upcoming.start - SKIP_LEAD_IN_MINUTES;
      const gap = landing - next;
      if (gap < IDLE_SKIP_THRESHOLD_MINUTES) return next;

      skippedRef.current = gap;
      return landing;
    };

    const draw = (now: number) => {
      raf = window.requestAnimationFrame(draw);
      const stage = stageRef.current;
      const plan = planRef.current;
      if (stage === null || plan === null) return;

      const elapsed = Math.min((now - previous) / 1000, MAX_FRAME_SECONDS);
      previous = now;

      if (playingRef.current && !voiceHoldingRef.current) {
        const next = advance(tickRef.current, elapsed);
        tickRef.current = next >= endTick ? endTick : next;
      }

      const frame = sampleFrame(chronicle, tickRef.current);
      frameRef.current = frame;
      stage.render(frame, resolvePose(plan, frame, tickRef.current), actorPerformance);
    };

    raf = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(raf);
  }, [chronicle, endTick]);

  /* --------------------------------------------------------------------- */
  /* The interface: a slow sample of the same state.                        */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    const sync = () => {
      const frame = frameRef.current;
      const plan = planRef.current;
      const tick = tickRef.current;
      if (tick >= endTick && playingRef.current) playingRef.current = false;

      const shot = plan?.shots.find(
        (candidate) => tick >= candidate.startTick && tick < candidate.endTick,
      );
      const framedSubjectId = subjectId ?? shot?.subjectId ?? null;
      const subject = frame === null ? null : pickSubject(frame, framedSubjectId);
      const skipped = skippedRef.current;
      skippedRef.current = null;

      setHud((current) => ({
        tick,
        day: Math.min(totalDays, Math.floor(tick / MINUTES_PER_DAY) + 1),
        clock: clockOf(tick),
        subject,
        shotKind: shot?.kind ?? "ESTABLISH",
        shotReason: shot?.reason ?? "No shot planned for this interval.",
        playing: playingRef.current,
        rate: rateRef.current,
        effectiveRate: effectivePlaybackRate(tick, rateRef.current, intervalsRef.current),
        skipIdle: skipIdleRef.current,
        skipped: skipped ?? (current.skipped !== null && playingRef.current ? null : current.skipped),
      }));

      if (subject !== null) {
        setVitalsSeries(vitals.get(subject.inhabitantId) ?? null);
      }
    };

    sync();
    const timer = window.setInterval(sync, HUD_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [endTick, subjectId, totalDays, vitals]);

  /* --------------------------------------------------------------------- */
  /* Transport — all of it writes to refs, none of it reaches the world.    */
  /* --------------------------------------------------------------------- */

  const setPlaying = useCallback(
    (playing: boolean) => {
      if (playing && tickRef.current >= endTick) tickRef.current = startTick;
      playingRef.current = playing;
      setHud((current) => ({ ...current, playing }));
    },
    [endTick, startTick],
  );

  const seek = useCallback(
    (tick: number) => {
      tickRef.current = tick < startTick ? startTick : tick > endTick ? endTick : tick;
      skippedRef.current = null;
    },
    [endTick, startTick],
  );

  const setRate = useCallback((rate: number) => {
    rateRef.current = rate;
    setHud((current) => ({ ...current, rate }));
  }, []);

  const setSkipIdle = useCallback((skipIdle: boolean) => {
    skipIdleRef.current = skipIdle;
    setHud((current) => ({ ...current, skipIdle, skipped: null }));
  }, []);

  const stepCut = useCallback(
    (direction: 1 | -1) => {
      const cuts = chronicle.cutTicks;
      const current = tickRef.current;
      if (direction === 1) {
        seek(cuts.find((cut) => cut > current + 0.5) ?? endTick);
        return;
      }
      let previousCut = startTick;
      for (const cut of cuts) {
        if (cut >= current - 0.5) break;
        previousCut = cut;
      }
      seek(previousCut);
    },
    [chronicle.cutTicks, endTick, seek, startTick],
  );

  const subjectLabel =
    subjectId === null ? "World record" : hud.subject?.displayName ?? subjectId;

  return (
    <section
      className={`cinema${broadcast ? " cinema--broadcast" : ""}${
        isFullscreen ? " fixed inset-0 z-50 bg-abyss p-4 shadow-2xl flex flex-col justify-between" : ""
      }`}
      aria-labelledby="cinema-title"
    >
      <div className={`cinema__frame ${isFullscreen ? "h-[calc(100vh-8rem)] min-h-[30rem]" : "max-h-[30rem]"}`}>
        <div
          ref={mountRef}
          className="cinema__canvas"
          role="img"
          aria-label={
            subjectId === null
              ? "Continuous rendering of the canonical world record"
              : `Continuous rendering of the canonical record, following ${subjectLabel}`
          }
        />

        {broadcast ? (
          <BroadcastOverlay
            day={hud.day}
            clock={hud.clock}
            subject={hud.subject}
            skipped={
              hud.skipped === null
                ? null
                : `Jumped ${durationLabel(hud.skipped)} to the next recorded story beat`
            }
          />
        ) : (
          <div className="cinema__overlay cinema__overlay--top">
            <div>
              <p className="eyebrow">
                Day {hud.day} · {hud.clock} · world tick {Math.floor(hud.tick).toLocaleString()}
              </p>
              <h2 id="cinema-title" className="cinema__title">
                {subjectLabel}
              </h2>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setIsFullscreen((prev) => !prev)}
                className="mono pointer-events-auto rounded border border-line-soft bg-abyss/80 px-2.5 py-1 text-xs text-ink hover:border-amber hover:text-amber"
                title="Toggle Fullscreen View (Press ESC or X to exit)"
              >
                {isFullscreen ? "✕ Exit Fullscreen (ESC / X)" : "⛶ Fullscreen"}
              </button>

              <div className="cinema__shot hidden sm:block">
                <span className="cinema__shot-kind">{hud.shotKind.replaceAll("_", " ")}</span>
                <small>{hud.shotReason}</small>
              </div>
            </div>
          </div>
        )}

        {!broadcast ? (
          <div className="cinema__side">
            <VitalsPanel series={vitalsSeries} tick={hud.tick} />
          </div>
        ) : null}

        {!broadcast && hud.playing && hud.effectiveRate < hud.rate ? (
          <p className="cinema__process-speed" role="status">
            process view · {hud.effectiveRate.toFixed(1)} sim min/s
          </p>
        ) : null}

        {!broadcast && hud.skipped !== null ? (
          <p className="cinema__skip" role="status">
            skipped {durationLabel(hud.skipped)} in which no activity was recorded
          </p>
        ) : null}

        {!broadcast ? <CinemaCaption subject={hud.subject} /> : null}
      </div>

      {broadcast ? (
        <BroadcastTransport
          playing={hud.playing}
          progress={(hud.tick - startTick) / Math.max(endTick - startTick, 1)}
          onPlayingChange={setPlaying}
          onStep={stepCut}
        />
      ) : <CinemaTransport
        tick={hud.tick}
        startTick={startTick}
        endTick={endTick}
        playing={hud.playing}
        rate={hud.rate}
        skipIdle={hud.skipIdle}
        cutTicks={chronicle.cutTicks}
        onPlayingChange={setPlaying}
        onSeek={seek}
        onRateChange={setRate}
        onSkipIdleChange={setSkipIdle}
        onStepCut={stepCut}
      />}

      <ElevenLabsVoicePlayer
        subject={hud.subject}
        isVideoPlaying={hud.playing}
        reel={voiceReel}
        onVoiceActivityChange={(speaking) => {
          voiceHoldingRef.current = speaking;
        }}
      />

      <p className={broadcast ? "cinema__provenance cinema__provenance--broadcast" : "cinema__provenance"}>
        <strong>Canonical</strong> — position, activity, participants, duration, world clock,
        physiological readings, and whether contents were disclosed.{" "}
        <strong>Derived presentation</strong> — camera movement, shot selection, lighting, gait,
        gesture, terrain detail, and personal-space offsets when canonical positions overlap.{" "}
        <strong>Edited</strong> — idle intervals are skipped while
        &ldquo;skipping idle&rdquo; is on; switch it off to play every recorded minute in order.
        Recorded actions are time-dilated to at least three seconds so their physical process
        remains visible.
        Nothing on screen adds a fact to the record, and nothing here can reach the world.
      </p>
    </section>
  );
}
