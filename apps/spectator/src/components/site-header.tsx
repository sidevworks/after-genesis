import Link from "next/link";
import { worldSource } from "@/lib/world-source";
import { formatSimTime } from "@/lib/format";
import { NavLinks } from "./nav-links";

export const NAV = [
  { href: "/", label: "Overview" },
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

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-abyss/92 backdrop-blur-md">
      <div className="mx-auto flex max-w-[92rem] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 sm:px-6">
        <Link href="/" className="flex items-baseline gap-2.5">
          <span className="text-sm font-medium tracking-tight text-ink">After Genesis</span>
          <span className="mono text-[0.65rem] tracking-widest text-dim uppercase">
            {summary.worldId}
          </span>
        </Link>

        <div className="order-3 flex w-full items-center gap-4 sm:order-none sm:w-auto">
          <p className="mono text-xs text-amber" title="World clock">
            {formatSimTime(summary.simTime)}
          </p>
          <p className="mono text-xs text-muted" title="Living inhabitants / total ever created">
            pop {summary.population.living}
            <span className="text-dim">/{summary.population.total}</span>
          </p>
          <p className="flex items-center gap-1.5 text-xs text-dim">
            <span
              aria-hidden
              className={`inline-block size-1.5 rounded-full ${
                summary.status === "running" ? "bg-alive" : "bg-warn"
              }`}
            />
            {summary.status}
          </p>
        </div>

        <NavLinks items={NAV.map((n) => ({ ...n }))} />
      </div>
    </header>
  );
}
