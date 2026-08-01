"use client";

import { useEffect, useRef, useState } from "react";
import { assetUrl } from "@/lib/asset-url";

export function CharacterSpeechButton({
  name,
  line,
  file,
}: {
  name: string;
  line: string;
  file: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState("Ready to play");

  useEffect(() => () => audioRef.current?.pause(), []);

  const toggle = async () => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    try {
      await audio.play();
      setStatus("Playing supplied character speech");
    } catch {
      setStatus("Audio could not play in this browser");
    }
  };

  return (
    <section className="border-l-2 border-amber bg-panel/70 px-4 py-4">
      <p className="eyebrow">Supplied character speech</p>
      <blockquote className="mt-2 text-sm leading-relaxed text-ink">“{line}”</blockquote>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void toggle()}
          aria-pressed={playing}
          className="mono rounded-sm border border-amber-dim bg-amber/10 px-3 py-2 text-xs text-amber transition-colors hover:bg-amber hover:text-abyss focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber"
        >
          {playing ? "Pause speech" : `Play ${name} speech`}
        </button>
        <span className="mono text-[0.68rem] text-dim">{status}</span>
      </div>
      <audio
        ref={audioRef}
        src={assetUrl(`/character-profile/speech/${file}`)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setStatus("Ready to play");
        }}
        onError={() => setStatus("Audio file is unavailable")}
      />
    </section>
  );
}
