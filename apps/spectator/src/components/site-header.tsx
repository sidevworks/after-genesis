import Link from "next/link";
import { worldSource } from "@/lib/world-source";
import { observatorySource } from "@/lib/observatory-source";
import { HeaderWorldStatus } from "./header-world-status";
import { NavLinks } from "./nav-links";

export const NAV = [
  { href: "/", label: "Overview" },
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
  const observatory = observatorySource.getRun();

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-abyss/92 backdrop-blur-md">
      <div className="mx-auto flex max-w-[92rem] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
        <Link href="/" className="flex items-baseline gap-2.5">
          <span className="text-sm font-medium tracking-tight text-ink">After Genesis</span>
        </Link>

        <HeaderWorldStatus
          archive={{
            worldId: summary.worldId,
            simTime: summary.simTime,
            living: summary.population.living,
            total: summary.population.total,
            status: summary.status,
          }}
          observatory={{
            worldId: "W001",
            simTime: observatory.world.simTime,
            living: observatory.inhabitants.filter((inhabitant) => inhabitant.status === "alive")
              .length,
            total: observatory.inhabitants.length,
            status: "completed",
          }}
        />

        <NavLinks items={NAV.map((n) => ({ ...n }))} />
      </div>
    </header>
  );
}
