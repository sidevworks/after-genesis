// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import Link from "next/link";
import { CHARACTER_PROFILES } from "@/lib/character-profiles";
import { assetUrl } from "@/lib/asset-url";

export function CharacterProfileToolbar({ currentId }: { currentId: string }) {
  return (
    <nav aria-label="Genesis character quick switcher" className="w-full overflow-x-auto py-1">
      <ul className="flex w-max min-w-full items-center justify-between gap-[clamp(0.75rem,2.5vw,5rem)] py-3">
        {CHARACTER_PROFILES.map((profile) => {
          const active = profile.id === currentId;
          return (
            <li key={profile.id} className="shrink-0">
              <Link
                href={`/inhabitants/${profile.id}`}
                aria-current={active ? "page" : undefined}
                aria-label={`View ${profile.name} profile`}
                className={`group relative block size-[clamp(3.75rem,5.5vw,6rem)] overflow-hidden rounded-sm border transition-all duration-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber ${
                  active
                    ? "z-10 scale-110 border-amber ring-2 ring-amber/80 shadow-[0_0_28px_rgba(244,184,56,0.6)]"
                    : "border-line opacity-80 hover:scale-105 hover:border-amber-dim hover:opacity-100"
                }`}
              >
                {active && <span className="pointer-events-none absolute inset-0 z-10 animate-pulse bg-amber/15" aria-hidden />}
                <video
                  className="pointer-events-none size-full object-cover transition-transform duration-300 group-hover:scale-105"
                  src={assetUrl(`/character-profile/${profile.file}`)}
                  autoPlay
                  loop
                  muted
                  playsInline
                  preload="metadata"
                  disablePictureInPicture
                  controlsList="nofullscreen nodownload noremoteplayback"
                  aria-hidden
                />
                <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 to-transparent px-1 pb-1 pt-5 text-center font-mono text-[clamp(0.52rem,0.6vw,0.66rem)] tracking-[0.06em] text-white">
                  {profile.name}
                </span>
                {active && (
                  <span className="pointer-events-none absolute inset-x-0 top-1 z-20 text-center font-mono text-[0.48rem] font-medium uppercase tracking-[0.14em] text-amber">
                    Selected
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
