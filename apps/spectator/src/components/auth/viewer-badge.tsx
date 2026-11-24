// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
"use client";

/**
 * Who is watching, and the way out.
 *
 * The only account control in the observatory. It reads identity and ends the
 * session; there is nothing here that reaches the world, and nothing here that
 * an inhabitant could ever observe.
 */

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useAuth } from "./auth-context";

export function ViewerBadge() {
  const { viewer, ready, configured, signOutViewer } = useAuth();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!configured || !ready || !viewer) return null;

  const label = viewer.isGuest ? "Guest" : (viewer.displayName ?? viewer.email ?? "Signed in");
  const initial = (viewer.isGuest ? "G" : label.trim().charAt(0) || "?").toUpperCase();

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded border border-line bg-panel px-2 py-1 text-xs text-muted transition-colors hover:border-line-soft hover:text-ink"
      >
        <span
          aria-hidden
          className={`grid size-5 place-items-center rounded-full text-[0.6rem] font-medium ${
            viewer.isGuest ? "bg-line text-dim" : "bg-amber/20 text-amber"
          }`}
        >
          {initial}
        </span>
        <span className="hidden max-w-[9rem] truncate sm:inline">{label}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1.5 w-60 rounded border border-line bg-panel p-3 shadow-lg shadow-black/40"
        >
          <p className="eyebrow">Watching as</p>
          <p className="mt-1 truncate text-sm text-ink">{label}</p>
          {viewer.email && !viewer.isGuest && (
            <p className="mono mt-0.5 truncate text-[0.68rem] text-dim">{viewer.email}</p>
          )}
          {viewer.isGuest && (
            <p className="mt-1.5 text-[0.7rem] leading-relaxed text-dim">
              A guest account. Sign in with Google or email from the entrance to keep it.
            </p>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOutViewer().then(() => router.push("/"));
            }}
            className="hairline mt-3 w-full pt-3 text-left text-xs text-muted hover:text-amber"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
