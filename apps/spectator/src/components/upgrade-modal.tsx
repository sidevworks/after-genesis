// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useTier } from "./tier-context";

export function UpgradeModal() {
  const { isUpgradeModalOpen, closeUpgradeModal, setTier, isPro } = useTier();

  if (!isUpgradeModalOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-abyss/80 p-4 backdrop-blur-md animate-in fade-in duration-200"
      onClick={closeUpgradeModal}
    >
      <div
        className="relative max-w-lg rounded-md border border-amber/30 bg-panel/95 p-6 shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={closeUpgradeModal}
          className="mono absolute top-4 right-4 text-xs text-dim hover:text-ink"
          aria-label="Close modal"
        >
          [ESC / ✕]
        </button>

        <div className="flex items-center gap-2">
          <span className="mono rounded-full border border-amber/40 bg-amber/10 px-2.5 py-0.5 text-xs text-amber uppercase">
            Membership Plan
          </span>
        </div>

        <h2 className="mt-3 text-2xl font-medium tracking-tight text-ink">
          Upgrade to Genesis Pro
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Unlock the full immersive experience of the After Genesis civilisation run.
        </p>

        <div className="mt-6 space-y-4 divide-y divide-line-soft border-y border-line-soft py-4 text-sm">
          <div className="flex items-start gap-3">
            <span className="mono text-amber">✓</span>
            <div>
              <p className="font-medium text-ink">Cinematic 3D Watch Mode</p>
              <p className="text-xs text-dim">
                Watch full 3D playback of every turn across 167 days with automatic camera direction.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 pt-3">
            <span className="mono text-amber">✓</span>
            <div>
              <p className="font-medium text-ink">ElevenLabs Voice Narration</p>
              <p className="text-xs text-dim">
                Every notable moment of the record, voiced by the world narrator and played in step
                with the camera. Inhabitants speak in their own assigned voices wherever the record
                discloses their words.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 pt-3">
            <span className="mono text-amber">✓</span>
            <div>
              <p className="font-medium text-ink">Inhabitant Follow & Director Camera</p>
              <p className="text-xs text-dim">
                Track specific agents through their daily routines, journeys, and trades.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={closeUpgradeModal}
            className="rounded-sm border border-line px-4 py-2 text-xs text-muted hover:text-ink"
          >
            Keep Free Observer
          </button>
          <button
            type="button"
            onClick={() => {
              setTier("pro");
              closeUpgradeModal();
            }}
            className="mono rounded-sm border border-amber bg-amber px-5 py-2 text-xs font-medium text-abyss hover:bg-amber-bright"
          >
            {isPro ? "You are Pro" : "Activate Genesis Pro"}
          </button>
        </div>
      </div>
    </div>
  );
}
