"use client";

import { useTier } from "./tier-context";

export function TierBadge() {
  const { setTier, isPro, openUpgradeModal } = useTier();

  return (
    <div className="flex items-center gap-2">
      <div
        className={`mono flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.68rem] font-medium tracking-wider uppercase transition-all ${
          isPro
            ? "border-amber/40 bg-amber/10 text-amber shadow-[0_0_12px_rgba(217,164,65,0.2)]"
            : "border-line bg-panel text-muted"
        }`}
      >
        <span
          aria-hidden
          className={`inline-block size-2 rounded-full ${
            isPro ? "bg-amber animate-pulse" : "bg-dim"
          }`}
        />
        <span>{isPro ? "Genesis Pro" : "Free Observer"}</span>
      </div>

      <button
        type="button"
        onClick={() => {
          if (isPro) {
            setTier("free");
          } else {
            openUpgradeModal();
          }
        }}
        className={`mono rounded-sm border px-2 py-1 text-[0.62rem] font-medium tracking-wider uppercase transition-colors ${
          isPro
            ? "border-line text-dim hover:border-line-soft hover:text-muted"
            : "border-amber-dim/50 bg-amber/10 text-amber hover:border-amber hover:bg-amber/20"
        }`}
      >
        {isPro ? "Switch to Free" : "Upgrade Pro"}
      </button>
    </div>
  );
}
