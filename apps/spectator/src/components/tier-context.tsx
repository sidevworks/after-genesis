// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
"use client";

/**
 * Membership tiers for the spectator application.
 *
 * ## Two tiers
 *
 * `free` — the whole canonical record. Map, inhabitants, events, lineage,
 * organisations, economy, artifacts, audit, 3D Watch playback. §20 lists these
 * as the spectator experience, and none of them is gated: a public world whose
 * history is paywalled is not publicly auditable (§16, §28).
 *
 * `pro` — rendered ElevenLabs audio, and anything else added to
 * `PREMIUM_FEATURES` later. Audio is the natural paid tier because it is the
 * one part of the experience with a per-character marginal cost to produce
 * (§21, §15 spend limits); everything else is a static file that costs the
 * same to serve to one viewer or a million.
 *
 * ## What this does and does not enforce
 *
 * This is presentation state in `localStorage`. It decides what the interface
 * offers. It is **not** an entitlement check, and anyone who opens the
 * developer console can set it. That is acceptable only because of what sits
 * behind it today: pre-rendered audio published as public static files.
 *
 * Turning this into a real paywall requires the audio to stop being publicly
 * fetchable, which the static export cannot do by itself. The shape that works
 * without giving the spectator app a server:
 *
 *   1. Publish clips to Cloud Storage instead of `public/voice/` (§3 already
 *      names Cloud Storage as the media home).
 *   2. Deny public reads in the Storage rules (§17).
 *   3. Have subscribers sign in with Firebase Auth and mint short-lived signed
 *      URLs from a Cloud Function that verifies the subscription.
 *
 * None of that touches the world: the media layer stays read-only with respect
 * to canonical state (§15), and no authenticated route may ever gain a
 * canonical write path (§17, §28).
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type MembershipTier = "free" | "pro";

/** Capabilities that require a subscription. Everything else is free. */
export const PREMIUM_FEATURES = ["watch:voice"] as const;
export type PremiumFeature = (typeof PREMIUM_FEATURES)[number];

interface TierContextType {
  tier: MembershipTier;
  setTier: (tier: MembershipTier) => void;
  isPro: boolean;
  /** Whether the current tier includes a capability. */
  hasFeature: (feature: PremiumFeature) => boolean;
  isUpgradeModalOpen: boolean;
  openUpgradeModal: () => void;
  closeUpgradeModal: () => void;
}

const TierContext = createContext<TierContextType | null>(null);

const TIER_STORAGE_KEY = "after_genesis_membership_tier";

/** Free is the default everywhere, including before hydration reads storage. */
const FREE_CONTEXT: TierContextType = {
  tier: "free",
  setTier: () => {},
  isPro: false,
  hasFeature: () => false,
  isUpgradeModalOpen: false,
  openUpgradeModal: () => {},
  closeUpgradeModal: () => {},
};

export function TierProvider({ children }: { children: ReactNode }) {
  const [tier, setTierState] = useState<MembershipTier>("free");
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(TIER_STORAGE_KEY);
      if (saved === "pro" || saved === "free") setTierState(saved);
    } catch {
      // Storage is unavailable in some embedded and privacy-restricted
      // contexts. Staying on the free tier is the correct failure direction.
    }
  }, []);

  const setTier = (nextTier: MembershipTier) => {
    setTierState(nextTier);
    try {
      localStorage.setItem(TIER_STORAGE_KEY, nextTier);
    } catch {
      // As above: the session still works, it just will not be remembered.
    }
  };

  const isPro = tier === "pro";

  return (
    <TierContext.Provider
      value={{
        tier,
        setTier,
        isPro,
        hasFeature: (feature) => isPro && PREMIUM_FEATURES.includes(feature),
        isUpgradeModalOpen,
        openUpgradeModal: () => setIsUpgradeModalOpen(true),
        closeUpgradeModal: () => setIsUpgradeModalOpen(false),
      }}
    >
      {children}
    </TierContext.Provider>
  );
}

export function useTier(): TierContextType {
  return useContext(TierContext) ?? FREE_CONTEXT;
}
