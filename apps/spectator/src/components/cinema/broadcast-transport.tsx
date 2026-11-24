// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
"use client";

export function BroadcastTransport({
  playing,
  progress,
  onPlayingChange,
  onStep,
}: {
  readonly playing: boolean;
  readonly progress: number;
  readonly onPlayingChange: (playing: boolean) => void;
  readonly onStep: (direction: 1 | -1) => void;
}) {
  return (
    <div className="broadcast-transport" aria-label="Broadcast playback">
      <button type="button" onClick={() => onStep(-1)} aria-label="Previous story beat">←</button>
      <button
        type="button"
        className="broadcast-transport__play"
        aria-pressed={playing}
        onClick={() => onPlayingChange(!playing)}
      >
        {playing ? "Pause" : "Play story"}
      </button>
      <button type="button" onClick={() => onStep(1)} aria-label="Next story beat">→</button>
      <div className="broadcast-transport__progress" aria-hidden="true">
        <i style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} />
      </div>
      <span>Idle gaps skip automatically</span>
    </div>
  );
}

