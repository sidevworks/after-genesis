"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type MembershipTier = "free" | "pro";

interface TierContextType {
  tier: MembershipTier;
  setTier: (tier: MembershipTier) => void;
  isPro: boolean;
  isUpgradeModalOpen: boolean;
  openUpgradeModal: () => void;
  closeUpgradeModal: () => void;
}

const TierContext = createContext<TierContextType | null>(null);

const TIER_STORAGE_KEY = "after_genesis_membership_tier";

export function TierProvider({ children }: { children: ReactNode }) {
  const [tier, setTierState] = useState<MembershipTier>("free");
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(TIER_STORAGE_KEY);
      if (saved === "pro" || saved === "free") {
        setTierState(saved);
      }
    } catch {
      // Ignore localStorage errors in restricted environments
    }
  }, []);

  const setTier = (nextTier: MembershipTier) => {
    setTierState(nextTier);
    try {
      localStorage.setItem(TIER_STORAGE_KEY, nextTier);
    } catch {
      // Ignore localStorage errors
    }
  };

  const openUpgradeModal = () => setIsUpgradeModalOpen(true);
  const closeUpgradeModal = () => setIsUpgradeModalOpen(false);

  return (
    <TierContext.Provider
      value={{
        tier,
        setTier,
        isPro: tier === "pro",
        isUpgradeModalOpen,
        openUpgradeModal,
        closeUpgradeModal,
      }}
    >
      {children}
    </TierContext.Provider>
  );
}

export function useTier(): TierContextType {
  const context = useContext(TierContext);
  if (!context) {
    // Default fallback if used outside Provider
    return {
      tier: "free",
      setTier: () => {},
      isPro: false,
      isUpgradeModalOpen: false,
      openUpgradeModal: () => {},
      closeUpgradeModal: () => {},
    };
  }
  return context;
}
