"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTier } from "./tier-context";

export const NAV_ITEMS = [
  { href: "/overview", label: "Overview", category: "Main" },
  { href: "/observatory", label: "Observatory 3D", category: "Main" },
  { href: "/watch", label: "Watch 3D", category: "Main", proOnly: true },
  { href: "/events", label: "Events", category: "Civilisation" },
  { href: "/inhabitants", label: "Inhabitants", category: "Civilisation" },
  { href: "/lineage", label: "Lineage", category: "Civilisation" },
  { href: "/organisations", label: "Organisations", category: "Civilisation" },
  { href: "/map", label: "World Map", category: "World" },
  { href: "/economy", label: "Economy", category: "World" },
  { href: "/artifacts", label: "Artifacts", category: "World" },
  { href: "/audit", label: "Audit", category: "Verification" },
];

export function NavGroups() {
  const pathname = usePathname() ?? "/";
  const normalised = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  const { isPro, openUpgradeModal } = useTier();

  return (
    <nav aria-label="Main navigation" className="mx-2 overflow-x-auto">
      <ul className="flex items-center gap-1">
        {NAV_ITEMS.map((item, index) => {
          const active = normalised === item.href || normalised.startsWith(`${item.href}/`);

          const isCategoryStart =
            index > 0 && item.category !== NAV_ITEMS[index - 1]?.category;

          return (
            <li key={item.href} className="flex items-center">
              {isCategoryStart && (
                <span aria-hidden className="mx-1.5 h-3 w-px bg-line-soft opacity-60" />
              )}
              <Link
                href={item.href}
                onClick={(e) => {
                  if (item.proOnly && !isPro) {
                    e.preventDefault();
                    openUpgradeModal();
                  }
                }}
                aria-current={active ? "page" : undefined}
                className={`group flex items-center gap-1 rounded px-2.5 py-1 text-xs whitespace-nowrap transition-colors ${
                  active
                    ? "bg-panel-2 font-medium text-amber shadow-sm"
                    : "text-muted hover:bg-panel hover:text-ink"
                }`}
              >
                <span>{item.label}</span>
                {item.proOnly && (
                  <span
                    className={`mono text-[0.55rem] font-bold px-1 py-0.2 rounded ${
                      isPro ? "bg-amber/20 text-amber" : "bg-line text-dim"
                    }`}
                  >
                    PRO
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
