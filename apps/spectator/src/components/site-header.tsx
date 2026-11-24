// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import Link from "next/link";
import { worldSource } from "@/lib/world-source";
import { HeaderWorldStatus } from "./header-world-status";
import { DevWorldControls } from "./dev-world-controls";
import { NavGroups } from "./nav-groups";
import { TierBadge } from "./tier-badge";
import { ViewerBadge } from "./auth/viewer-badge";
import { publicRunClassification } from "@/lib/run-classification";

export const NAV = [
  { href: "/overview", label: "Overview" },
  { href: "/watch", label: "Watch" },
  { href: "/observatory", label: "Observatory" },
  { href: "/map", label: "Map" },
  { href: "/inhabitants", label: "Inhabitants" },
  { href: "/lineage", label: "Lineage" },
  { href: "/events", label: "Events" },
  { href: "/patterns", label: "Patterns" },
  { href: "/organisations", label: "Organisations" },
  { href: "/economy", label: "Economy" },
  { href: "/artifacts", label: "Artifacts" },
  { href: "/audit", label: "Audit" },
] as const;

export async function SiteHeader() {
  const summary = await worldSource.getWorldSummary();
  const classification = publicRunClassification();

  // `TierProvider` deliberately lives in the root layout rather than here.
  // Wrapping only the header put every page body outside the context, so
  // `useTier()` there always fell back to the free tier and no page content
  // could respond to a subscription — including the Watch voice player.
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-abyss/92 backdrop-blur-md">
        <div className="mx-auto flex max-w-[96rem] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
          <div className="flex items-center gap-4">
            <Link href="/overview" className="flex items-baseline gap-2.5">
              <span className="text-sm font-medium tracking-tight text-ink">After Genesis</span>
            </Link>
            <span className="rounded border border-line px-2 py-1 font-mono text-[0.55rem] tracking-[0.12em] text-dim">
              {classification}
            </span>

            <HeaderWorldStatus
              archive={{
                worldId: summary.worldId,
                simTime: summary.simTime,
                living: summary.population.living,
                total: summary.population.total,
                status: summary.status,
              }}
              observatory={{
                worldId: summary.worldId,
                simTime: summary.simTime,
                living: summary.population.living,
                total: summary.population.total,
                status: summary.status,
              }}
            />
          </div>

          <NavGroups />

          <div className="flex items-center gap-2">
            <TierBadge />
            <ViewerBadge />
          </div>
        </div>
      </header>
      <DevWorldControls />
    </>
  );
}
