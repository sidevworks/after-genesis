// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * The Watch-mode voice player (§21, §12, §20).
 *
 * ## What it plays
 *
 * Audio rendered ahead of time by `scripts/render-voice.mts` and published as
 * static files under `public/voice/<reel>/`. This component performs no
 * synthesis: the spectator app is a static export with no server, so a live
 * provider call would mean shipping `ELEVENLABS_API_KEY` to every viewer.
 *
 * It looks a clip up by the chronicle segment currently on screen, so the audio
 * tracks the 3D camera exactly — when the director cuts to a different moment,
 * the voice follows.
 *
 * ## What it will not do
 *
 * If no clip exists for the current segment, it says so and stays silent.
 *
 * An earlier version of this component fell back to `window.speechSynthesis` —
 * the browser's built-in voice — while displaying an ElevenLabs voice id next
 * to a waveform animation. Nothing was ever sent to ElevenLabs. That is a
 * demonstration of a feature rather than the feature, and §26 is explicit:
 * "Do not claim a feature works unless it has been tested." Silence with an
 * honest label is the correct behaviour for an unrendered line.
 *
 * ## Narration and dialogue stay distinguishable
 *
 * §21 requires verbatim canonical dialogue, condensed summaries and dramatised
 * narration to be told apart. The manifest carries each clip's `kind` and the
 * exact text spoken, and both are labelled on screen. Narration is the world
 * narrator reading a derived caption; it is never presented as an inhabitant
 * speaking.
 */

import { useEffect, useRef, useState } from "react";
import type { ActorSample } from "@/lib/cinema/types";
import { useVoiceManifest, type VoiceClip } from "@/lib/cinema/use-voice-manifest";
import { useTier } from "./tier-context";

export function ElevenLabsVoicePlayer({
  subject = null,
  isVideoPlaying = false,
  reel,
  onVoiceActivityChange,
}: {
  readonly subject?: ActorSample | null;
  readonly isVideoPlaying?: boolean;
  readonly reel: string;
  readonly onVoiceActivityChange?: (speaking: boolean) => void;
}) {
  const { isPro, openUpgradeModal } = useTier();
  const { manifest, status: manifestStatus } = useVoiceManifest(reel, isPro);

  const [autoplay, setAutoplay] = useState(true);
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioStatus, setAudioStatus] = useState("Ready");
  const [playingClip, setPlayingClip] = useState<VoiceClip | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastPlayedRef = useRef<string | null>(null);
  const playingKindRef = useRef<VoiceClip["kind"] | null>(null);
  const activeSrcRef = useRef<string | null>(null);
  const queueRef = useRef<Array<{ clip: VoiceClip; src: string }>>([]);

  const segmentId = subject?.segment.id ?? null;
  const clip: VoiceClip | null =
    manifest === null || segmentId === null ? null : (manifest.clips[segmentId] ?? null);
  const clipSrc = clip === null ? null : `/voice/${reel}/${clip.file}`;

  /* --------------------------------------------------------------------- */
  /* Playback                                                              */
  /* --------------------------------------------------------------------- */

  const pause = () => {
    audioRef.current?.pause();
    setIsPlaying(false);
    onVoiceActivityChange?.(false);
  };

  const playClip = (nextClip: VoiceClip, nextSrc: string) => {
    activeSrcRef.current = nextSrc;
    lastPlayedRef.current = nextSrc;
    playingKindRef.current = nextClip.kind;
    setPlayingClip(nextClip);
    const element = audioRef.current;
    if (element === null) return;
    element.src = nextSrc;
    element.load();

    void element
        .play()
        .then(() => {
          setIsPlaying(true);
          onVoiceActivityChange?.(true);
          setAudioStatus("Playing rendered ElevenLabs audio");
        })
        .catch((cause: unknown) => {
          // Browsers reject playback until the user has interacted with the page.
          // Reporting it is better than an animation that implies sound.
          setIsPlaying(false);
          playingKindRef.current = null;
          activeSrcRef.current = null;
          onVoiceActivityChange?.(false);
          setAudioStatus(
            cause instanceof Error && cause.name === "NotAllowedError"
              ? "Blocked by the browser — press Play"
              : "Audio failed to start",
          );
        });
  };

  const playCurrent = () => {
    if (clip === null || clipSrc === null) return;
    playClip(clip, clipSrc);
  };

  const playNextQueued = () => {
    const next = queueRef.current.shift();
    if (next === undefined) {
      activeSrcRef.current = null;
      playingKindRef.current = null;
      setPlayingClip(null);
      setIsPlaying(false);
      onVoiceActivityChange?.(false);
      setAudioStatus("Playback complete");
      return;
    }
    playClip(next.clip, next.src);
  };

  const unlockAudio = () => {
    setIsAudioUnlocked(true);
    setAudioStatus(clipSrc === null ? "Ready — no audio for this moment" : "Audio unlocked");
  };

  // Follow the canonical timeline. A clip already speaking is never cut off by
  // the next camera shot: later dialogue and narration queue in encounter order
  // and play automatically. One user gesture unlocks the whole continuous reel.
  useEffect(() => {
    if (!isPro || !autoplay || !isAudioUnlocked || !isVideoPlaying) return;
    if (clip === null || clipSrc === null) return;
    if (activeSrcRef.current === clipSrc || lastPlayedRef.current === clipSrc) return;
    if (queueRef.current.some((entry) => entry.src === clipSrc)) return;

    const element = audioRef.current;
    if (element !== null && !element.ended && activeSrcRef.current !== null) {
      queueRef.current.push({ clip, src: clipSrc });
      setAudioStatus(`Playing voice · ${queueRef.current.length} queued`);
      return;
    }
    playClip(clip, clipSrc);
    // `playClip` closes over refs and setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPro, autoplay, isAudioUnlocked, isVideoPlaying, clip, clipSrc]);

  // Pausing the 3D playback pauses rather than discards the current sentence;
  // resuming continues it, then drains the queued conversation in order.
  useEffect(() => {
    const element = audioRef.current;
    if (element === null || activeSrcRef.current === null) return;
    if (!isVideoPlaying) {
      element.pause();
      setIsPlaying(false);
      onVoiceActivityChange?.(false);
      return;
    }
    if (isAudioUnlocked && autoplay && element.paused && !element.ended) {
      void element.play().then(() => {
        setIsPlaying(true);
        onVoiceActivityChange?.(true);
      }).catch(() => {
        onVoiceActivityChange?.(false);
        setAudioStatus("Audio failed to resume");
      });
    }
  }, [isVideoPlaying]);

  /* --------------------------------------------------------------------- */
  /* Free tier                                                             */
  /* --------------------------------------------------------------------- */

  if (!isPro) {
    return (
      <div className="mx-auto max-w-[84rem] rounded-md border border-line bg-panel/90 p-4 backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="mono rounded bg-panel-2 px-2 py-0.5 text-[0.65rem] text-dim uppercase">
              ElevenLabs AI Voice
            </span>
            <span className="text-xs text-muted">Included with Genesis Pro</span>
          </div>
          <button
            type="button"
            onClick={openUpgradeModal}
            className="mono cursor-pointer rounded-sm border border-amber/50 bg-amber/10 px-4 py-1 text-xs font-medium text-amber hover:border-amber hover:bg-amber/20"
          >
            Upgrade to listen
          </button>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Narration and inhabitant dialogue for this recording are voiced with ElevenLabs. The map,
          the 3D playback and the full canonical record stay free for every observer — audio is the
          only part behind the subscription.
        </p>
      </div>
    );
  }

  /* --------------------------------------------------------------------- */
  /* Pro tier                                                              */
  /* --------------------------------------------------------------------- */

  const displayedClip = playingClip ?? clip;
  const isDialogue = displayedClip?.kind === "dialogue";
  const speakerName = displayedClip?.speakerName ?? "World Narrator";

  const unavailableReason =
    manifestStatus === "loading"
      ? "Loading rendered audio…"
      : manifestStatus === "missing"
        ? "No audio has been rendered for this reel yet. Run `npm run voice:render`."
        : manifestStatus === "error"
          ? "The audio manifest could not be read."
          : segmentId === null
            ? "No inhabitant is in frame."
            : (manifest?.skipped[segmentId] ??
              "This moment has no rendered audio. Nothing is spoken for it.");

  return (
    <div className="mx-auto max-w-[84rem] relative overflow-hidden rounded-md border border-amber/30 bg-panel/90 p-4 shadow-xl backdrop-blur-md">
      <audio
          ref={audioRef}
          preload="auto"
          onEnded={() => {
            playNextQueued();
          }}
          onError={() => {
            playingKindRef.current = null;
            setIsPlaying(false);
            activeSrcRef.current = null;
            onVoiceActivityChange?.(false);
            setAudioStatus("Audio file missing from this build");
          }}
        />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft pb-3">
        <div className="flex items-center gap-2">
          <span className="mono rounded bg-amber/20 px-2 py-0.5 text-[0.65rem] font-medium text-amber uppercase">
            ElevenLabs AI Voice
          </span>
          <span className="text-xs text-muted">
            {isDialogue
              ? "Verbatim canonical dialogue"
              : clip?.styled === true
                ? "Dramatised narration"
                : "Derived narration"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isAudioUnlocked ? (
            <button
              type="button"
              disabled={clip === null}
              onClick={() => {
                unlockAudio();
                playCurrent();
              }}
              className="mono flex cursor-pointer items-center gap-1.5 rounded bg-amber px-4 py-1 text-xs font-medium text-abyss shadow-[0_0_12px_rgba(217,164,65,0.4)] hover:bg-amber-bright"
            >
              🔊 Play continuous voice
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setAutoplay((value) => !value)}
              className={`mono cursor-pointer rounded border px-2.5 py-1 text-xs transition-colors ${
                autoplay
                  ? "border-amber/50 bg-amber/10 font-medium text-amber"
                  : "border-line text-dim hover:text-ink"
              }`}
            >
              Follow camera: {autoplay ? "ON" : "OFF"}
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink">{speakerName}</span>
            <span
              className={`mono rounded px-1.5 py-0.5 text-[0.6rem] uppercase ${
                isDialogue ? "bg-amber/20 text-amber" : "bg-panel-2 text-dim"
              }`}
            >
              {isDialogue ? "Dialogue" : "Narration"}
            </span>
          </div>

            {displayedClip !== null && (
            <span className="mono text-[0.68rem] text-dim">
              {displayedClip.voiceHandle ?? "narration"} → {displayedClip.providerVoiceId}
            </span>
          )}
        </div>

        {displayedClip !== null ? (
          <div className="space-y-2">
            <p className="rounded border border-line-soft bg-abyss/80 p-3 text-sm leading-relaxed text-ink italic shadow-inner">
              &ldquo;{displayedClip.text}&rdquo;
            </p>

            {/* §12: generated media must stay distinguishable from canonical
                action. When a line was rewritten, the record's own words are
                shown directly beneath it — never replaced by the rewrite. */}
            {displayedClip.styled && displayedClip.canonicalText !== displayedClip.text && (
              <div className="rounded border border-line-soft border-dashed bg-panel-2/40 px-3 py-2">
                <p className="eyebrow mb-1">Canonical record</p>
                <p className="mono text-[0.7rem] leading-relaxed text-dim">{displayedClip.canonicalText}</p>
                <p className="mt-1 text-[0.65rem] text-dim">
                  Spoken line rewritten from this record by{" "}
                  <span className="mono">{displayedClip.styleModelId ?? "a language model"}</span>. It adds
                  no fact the record does not contain.
                </p>
              </div>
            )}
          </div>
        ) : (
          <p className="rounded border border-line-soft border-dashed bg-abyss/40 p-3 text-sm leading-relaxed text-dim">
            {unavailableReason}
          </p>
        )}

        <p className="mono text-[0.65rem] text-dim">{audioStatus}</p>

        <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
          <div className="flex h-6 items-center gap-1.5">
            {[14, 26, 18, 30, 16, 24, 32, 18, 22, 12, 28, 20].map((height, index) => (
              <span
                key={index}
                className={`w-1 rounded-full bg-amber transition-all duration-300 ${
                  isPlaying ? "animate-pulse shadow-[0_0_8px_rgba(217,164,65,0.6)]" : "opacity-35"
                }`}
                style={{
                  height: isPlaying
                    ? `${Math.max(6, (height * ((index % 4) + 1)) % 28)}px`
                    : `${height / 2}px`,
                }}
              />
            ))}
          </div>

          <button
            type="button"
            disabled={clipSrc === null}
            onClick={() => {
              if (!isAudioUnlocked) unlockAudio();
              if (isPlaying) pause();
              else if (
                audioRef.current !== null &&
                activeSrcRef.current !== null &&
                !audioRef.current.ended
              ) {
                void audioRef.current.play().then(() => {
                  setIsPlaying(true);
                  onVoiceActivityChange?.(true);
                });
              } else {
                playCurrent();
              }
            }}
            className={`mono flex cursor-pointer items-center gap-1.5 rounded border px-5 py-1 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-dim ${
              isPlaying
                ? "border-amber bg-amber text-abyss shadow-[0_0_12px_rgba(217,164,65,0.4)]"
                : "border-amber/50 bg-amber/10 text-amber hover:border-amber hover:bg-amber/20"
            }`}
          >
            {isPlaying ? "Pause ❚❚" : "Play voice ▶"}
          </button>
        </div>
      </div>
    </div>
  );
}
