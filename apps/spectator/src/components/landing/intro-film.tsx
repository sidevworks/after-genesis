"use client";

/**
 * The opening film.
 *
 * Behaviour worth stating, because it is easy to get subtly wrong:
 *
 *  - Autoplay with sound is blocked by every current browser unless the origin
 *    already has a media-engagement history. So the film always *starts* muted
 *    and unmutes immediately afterwards if the reader has previously chosen
 *    sound on. If that unmute is rejected, we fall back to muted playback and
 *    show the control rather than failing the whole intro.
 *  - Muted autoplay is *usually* permitted but is not guaranteed. When even
 *    that is refused, a play button appears over the poster; without it the
 *    reader is left facing a still frame with nothing to click.
 *  - Two separate remembered choices, because they are genuinely separate
 *    questions: "do you want sound" and "do you want to see this at all".
 *    Each is only persisted when its Remember toggle is on, so a reader who
 *    mutes once is not silently opted out for ever.
 *  - `prefers-reduced-motion` skips the film outright. A 58-second fullscreen
 *    video is exactly the thing that setting exists for.
 *  - Any failure to load the video resolves the intro instead of trapping the
 *    reader behind a black screen.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

const SOUND_KEY = "after_genesis_intro_sound";
const SKIP_KEY = "after_genesis_intro_skip";

function readStored(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* Private browsing: the choice simply does not persist. */
  }
}

/** Whether a returning reader has asked never to see the film again. */
export function introIsRemembered(): boolean {
  return readStored(SKIP_KEY) === "always";
}

export function IntroFilm({ onFinished }: { onFinished: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [soundOn, setSoundOn] = useState(false);
  const [rememberSound, setRememberSound] = useState(() => readStored(SOUND_KEY) !== null);
  const [rememberSkip, setRememberSkip] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  /**
   * True when the browser refused to start playback on its own. Muted autoplay
   * is normally permitted, but it is not guaranteed — some browsers and most
   * automation environments block it outright, and a reader in that case would
   * otherwise be left staring at a still frame with no obvious way forward.
   */
  const [needsGesture, setNeedsGesture] = useState(false);

  const soundChoiceId = useId();
  const skipChoiceId = useId();

  /** Guards against `onFinished` firing twice (ended + skip racing). */
  const done = useRef(false);
  const finish = useCallback(() => {
    if (done.current) return;
    done.current = true;
    onFinished();
  }, [onFinished]);

  /* Apply the remembered sound preference once the element exists. ---------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }

    const wantsSound = readStored(SOUND_KEY) === "on";
    // Start muted regardless: this is the only reliably autoplayable state.
    video.muted = true;
    const started = video.play();

    if (started) {
      void started
        .then(() => {
          if (!wantsSound) return;
          video.muted = false;
          setSoundOn(true);
        })
        .catch(() => {
          // Refused. Ask for the one gesture that will unblock it.
          setNeedsGesture(true);
        });
    }
  }, [finish]);

  /** Start playback in response to a real gesture, honouring the sound choice. */
  function play(withSound: boolean) {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !withSound;
    if (withSound) video.volume = 1;
    setSoundOn(withSound);
    setNeedsGesture(false);
    void video.play().catch(() => setNeedsGesture(true));
  }

  function toggleSound() {
    const next = !soundOn;
    if (rememberSound) writeStored(SOUND_KEY, next ? "on" : "off");
    // Doubles as the unblock: a click is the gesture a blocked video wants.
    play(next);
  }

  function toggleRememberSound(next: boolean) {
    setRememberSound(next);
    writeStored(SOUND_KEY, next ? (soundOn ? "on" : "off") : null);
  }

  function toggleRememberSkip(next: boolean) {
    setRememberSkip(next);
    writeStored(SKIP_KEY, next ? "always" : null);
  }

  function skip() {
    videoRef.current?.pause();
    finish();
  }

  /* Escape skips, space toggles sound. ------------------------------------- */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        skip();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- skip is stable enough
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <video
        ref={videoRef}
        className="size-full object-cover"
        src="/intro.mp4"
        poster="/intro-poster.jpg"
        playsInline
        preload="auto"
        muted={!soundOn}
        onEnded={finish}
        onError={() => {
          setFailed(true);
          finish();
        }}
        onTimeUpdate={(event) => {
          const el = event.currentTarget;
          if (el.duration > 0) setProgress(el.currentTime / el.duration);
        }}
      />

      {/* Autoplay refused: offer the gesture that unblocks it. ------------- */}
      {needsGesture && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => play(readStored(SOUND_KEY) === "on")}
              aria-label="Play the opening film"
              className="grid size-16 place-items-center rounded-full border border-white/30 bg-black/45 text-white backdrop-blur-sm transition-colors hover:bg-black/65"
            >
              <svg aria-hidden viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 size-6">
                <path d="M8 5.5v13l11-6.5-11-6.5Z" />
              </svg>
            </button>
            <p className="text-xs text-white/60">Your browser paused the opening film.</p>
          </div>
        </div>
      )}

      {/* Title, so the film is never an unexplained black rectangle. -------- */}
      <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent px-5 pt-5 pb-16 sm:px-8 sm:pt-7">
        <p className="eyebrow text-white/55">After Genesis</p>
        <p className="mt-1 max-w-md text-sm leading-relaxed text-white/70">
          A world that runs whether or not anyone is watching.
        </p>
      </div>

      {/* Controls ---------------------------------------------------------- */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-5 pb-6 pt-20 sm:px-8">
        <div
          className="mx-auto flex max-w-[92rem] flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"
          role="group"
          aria-label="Intro playback controls"
        >
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={toggleSound}
              aria-pressed={soundOn}
              className="flex items-center gap-2 rounded-full border border-white/20 bg-white/8 px-4 py-2 text-xs text-white backdrop-blur-sm transition-colors hover:bg-white/16"
            >
              {soundOn ? <SoundOnIcon /> : <SoundOffIcon />}
              {soundOn ? "Sound on" : "Sound off"}
            </button>

            <input
              id={soundChoiceId}
              type="checkbox"
              checked={rememberSound}
              onChange={(event) => toggleRememberSound(event.target.checked)}
              className="size-3.5 accent-[var(--color-amber)]"
            />
            <label htmlFor={soundChoiceId} className="text-[0.7rem] text-white/60">
              Remember sound choice
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 sm:justify-end">
            <input
              id={skipChoiceId}
              type="checkbox"
              checked={rememberSkip}
              onChange={(event) => toggleRememberSkip(event.target.checked)}
              className="size-3.5 accent-[var(--color-amber)]"
            />
            <label htmlFor={skipChoiceId} className="text-[0.7rem] text-white/60">
              Don&rsquo;t show this again
            </label>

            <button
              type="button"
              onClick={skip}
              className="flex items-center gap-2 rounded-full border border-white/25 bg-white/12 px-5 py-2 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-white/24"
            >
              Skip intro
              <span aria-hidden className="mono text-white/50">
                esc
              </span>
            </button>
          </div>
        </div>

        {/* Progress. Presentational; the video element owns the truth. ------ */}
        <div
          aria-hidden
          className="mx-auto mt-4 h-px max-w-[92rem] overflow-hidden bg-white/15"
        >
          <div
            className="h-full bg-amber transition-[width] duration-200 ease-linear"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>

        {failed && (
          <p role="status" className="mt-3 text-center text-xs text-white/50">
            The opening film could not load. Continuing.
          </p>
        )}
      </div>
    </div>
  );
}

function SoundOnIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-3.5">
      <path d="M11 5 6 9H3v6h3l5 4V5Z" strokeLinejoin="round" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" strokeLinecap="round" />
    </svg>
  );
}

function SoundOffIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-3.5">
      <path d="M11 5 6 9H3v6h3l5 4V5Z" strokeLinejoin="round" />
      <path d="m16 9 5 6M21 9l-5 6" strokeLinecap="round" />
    </svg>
  );
}
