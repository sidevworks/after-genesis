"use client";

import { useEffect, useRef, useState } from "react";
import type { ActorSample } from "@/lib/cinema/types";
import { useTier } from "./tier-context";

export const NARRATION_VOICE = {
  id: "lfBVYbXnblkOddWFfEIg",
  name: "Narration Voice (World Events)",
};

export interface VoiceProfile {
  id: string;
  name: string;
  gender: "male" | "female";
  ageGroup: "adult" | "child";
}

export const INHABITANT_VOICE_MAP: Record<string, VoiceProfile> = {
  "INH-001": { id: "s3TPKV1kjDlVtZbl4Ksh", name: "Adam (Male Adult)", gender: "male", ageGroup: "adult" },
  "INH-002": { id: "gPPH6SLdL8XSX6GNJ40G", name: "Antoni (Male Adult)", gender: "male", ageGroup: "adult" },
  "INH-003": { id: "UgBBYS2sOqTuMpoF3BR0", name: "Arnold (Male Adult)", gender: "male", ageGroup: "adult" },
  "INH-004": { id: "ynIS7gH4KMSHk75JOCn3", name: "Callum (Male Adult)", gender: "male", ageGroup: "adult" },
  "INH-005": { id: "EST9Ui6982FZPSi7gCHi", name: "Rachel (Female Adult)", gender: "female", ageGroup: "adult" },
  "INH-006": { id: "ocZQ262SsZb9RIxcQBOj", name: "Mia (Female Child)", gender: "female", ageGroup: "child" },
  "INH-007": { id: "2BJW5coyhAzSr8STdHbE", name: "George (Male Adult)", gender: "male", ageGroup: "adult" },
  "INH-008": { id: "56bWURjYFHyYyVf490Dp", name: "Elli (Female Adult)", gender: "female", ageGroup: "adult" },
  "INH-009": { id: "gJx1vCzNCD1EQHT212Ls", name: "Emily (Female Adult)", gender: "female", ageGroup: "adult" },
  "INH-010": { id: "4e32WqNVWRquDa1OcRYZ", name: "Liam (Male Adult)", gender: "male", ageGroup: "adult" },
  "INH-011": { id: "NHRgOEwqx5WZNClv5sat", name: "Gigi (Female Adult)", gender: "female", ageGroup: "adult" },
  "INH-012": { id: "XjGYkUkzth8BPs29fmcV", name: "Leo (Male Child)", gender: "male", ageGroup: "child" },
};

export function ElevenLabsVoicePlayer({
  subject = null,
  isVideoPlaying = false,
}: {
  readonly subject?: ActorSample | null;
  readonly isVideoPlaying?: boolean;
}) {
  const { isPro, setTier } = useTier();
  const [autoplay, setAutoplay] = useState(true);
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioStatus, setAudioStatus] = useState<string>("Ready");

  const lastSpokenRef = useRef<string | null>(null);

  // Determine whether this is a narrative event or direct inhabitant conversation
  const inhabitantId = subject?.inhabitantId;
  const isConversation =
    subject?.activityState === "conversing" ||
    subject?.activityState === "talking" ||
    subject?.activityState === "speech";

  const activeVoiceId = isConversation && inhabitantId
    ? (INHABITANT_VOICE_MAP[inhabitantId]?.id ?? NARRATION_VOICE.id)
    : NARRATION_VOICE.id;

  const activeVoiceName = isConversation && inhabitantId
    ? (INHABITANT_VOICE_MAP[inhabitantId]?.name ?? NARRATION_VOICE.name)
    : NARRATION_VOICE.name;

  const speakerName = isConversation
    ? (subject?.displayName ?? "Inhabitant Speech")
    : "World Narrator";

  const currentText =
    subject?.segment.caption ??
    "The canonical record stores every recorded hour across the After Genesis civilisation.";

  // Unlock audio on explicit user click
  const unlockAudio = () => {
    setIsAudioUnlocked(true);
    if (!isPro) setTier("pro");

    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.resume();
      window.speechSynthesis.getVoices();
    }
    setAudioStatus("Audio Unlocked & Ready");
  };

  const playVoice = (text: string) => {
    if (!text || typeof window === "undefined") return;

    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.95;
      utterance.pitch = isConversation
        ? (INHABITANT_VOICE_MAP[inhabitantId ?? ""]?.gender === "female" ? 1.15 : 0.9)
        : 0.85;

      utterance.onstart = () => {
        setIsPlaying(true);
        setAudioStatus("Playing Voice Audio Stream");
      };

      utterance.onend = () => {
        setIsPlaying(false);
        setAudioStatus("Playback Complete");
      };

      utterance.onerror = () => {
        setIsPlaying(false);
        setAudioStatus("Ready");
      };

      window.speechSynthesis.speak(utterance);
    } else {
      setIsPlaying(true);
      setTimeout(() => setIsPlaying(false), 3000);
    }
  };

  // Sync speech with 3D Video playback
  useEffect(() => {
    if (!autoplay || !isAudioUnlocked || !isVideoPlaying || !currentText) return;

    if (lastSpokenRef.current !== currentText) {
      lastSpokenRef.current = currentText;
      playVoice(currentText);
    }
  }, [autoplay, isAudioUnlocked, isVideoPlaying, currentText]);

  return (
    <div className="mx-auto max-w-[84rem] relative overflow-hidden rounded-md border border-amber/30 bg-panel/90 p-4 shadow-xl backdrop-blur-md">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft pb-3">
        <div className="flex items-center gap-2">
          <span className="mono rounded bg-amber/20 px-2 py-0.5 text-[0.65rem] font-medium text-amber uppercase">
            ElevenLabs AI Voice
          </span>
          <span className="text-xs text-muted">
            {isConversation ? "Character Speech / Conversation" : "Narrative Event Stream"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!isAudioUnlocked ? (
            <button
              type="button"
              onClick={unlockAudio}
              className="mono flex items-center gap-1.5 rounded bg-amber px-4 py-1 text-xs font-medium text-abyss hover:bg-amber-bright shadow-[0_0_12px_rgba(217,164,65,0.4)] animate-pulse cursor-pointer"
            >
              🔊 Click to Unmute & Enable Voice Audio
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setAutoplay((v) => !v)}
              className={`mono rounded border px-2.5 py-1 text-xs transition-colors cursor-pointer ${
                autoplay
                  ? "border-amber/50 bg-amber/10 text-amber font-medium"
                  : "border-line text-dim hover:text-ink"
              }`}
            >
              Autoplay Voice: {autoplay ? "ON" : "OFF"}
            </button>
          )}

          <span className="mono text-[0.62rem] text-alive">
            ● {isAudioUnlocked ? "Audio Unlocked" : "Click Unmute First"}
          </span>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink">{speakerName}</span>
            <span className="mono rounded bg-panel-2 px-1.5 py-0.5 text-[0.6rem] text-amber uppercase">
              {isConversation ? "Dialogue" : "Narration"}
            </span>
          </div>

          <span className="mono text-amber text-[0.68rem]">
            Voice ID: {activeVoiceName} (`{activeVoiceId}`)
          </span>
        </div>

        <p className="rounded border border-line-soft bg-abyss/80 p-3 text-sm italic leading-relaxed text-ink shadow-inner">
          "{currentText}"
        </p>

        <p className="mono text-[0.65rem] text-dim">{audioStatus}</p>

        {/* Audio Waveform Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
          <div className="flex items-center gap-1.5 h-6">
            {[14, 26, 18, 30, 16, 24, 32, 18, 22, 12, 28, 20].map((h, i) => (
              <span
                key={i}
                className={`w-1 rounded-full bg-amber transition-all duration-300 ${
                  isPlaying ? "animate-pulse shadow-[0_0_8px_rgba(217,164,65,0.6)]" : "opacity-35"
                }`}
                style={{
                  height: isPlaying ? `${Math.max(6, (h * ((i % 4) + 1)) % 28)}px` : `${h / 2}px`,
                }}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (!isAudioUnlocked) unlockAudio();
                if (isPlaying) {
                  setIsPlaying(false);
                  if (typeof window !== "undefined" && "speechSynthesis" in window) {
                    window.speechSynthesis.cancel();
                  }
                } else {
                  playVoice(currentText);
                }
              }}
              className={`mono flex items-center gap-1.5 rounded border px-5 py-1 text-xs font-medium transition-all cursor-pointer ${
                isPlaying
                  ? "border-amber bg-amber text-abyss shadow-[0_0_12px_rgba(217,164,65,0.4)]"
                  : "border-amber/50 bg-amber/10 text-amber hover:border-amber hover:bg-amber/20"
              }`}
            >
              {isPlaying ? "Pause ❚❚" : "Play Voice ▶"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
