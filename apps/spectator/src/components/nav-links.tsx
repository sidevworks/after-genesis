// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Navigation. Every item is a link to a page that reads. There is no item here
 * that acts on the world, and by construction there is nowhere for one to go.
 */
export function NavLinks({ items }: { items: Array<{ href: string; label: string }> }) {
  const pathname = usePathname() ?? "/";
  const normalised = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;

  return (
    <nav aria-label="Sections" className="ml-auto w-full overflow-x-auto sm:w-auto">
      <ul className="flex items-center gap-0.5">
        {items.map((item) => {
          const active =
            item.href === "/" ? normalised === "/" : normalised.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`block rounded-sm px-2.5 py-1.5 text-xs whitespace-nowrap transition-colors ${
                  active
                    ? "bg-panel-2 text-amber"
                    : "text-muted hover:bg-panel hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
