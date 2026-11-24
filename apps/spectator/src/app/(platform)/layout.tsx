// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import Link from "next/link";
import { AuthGate } from "@/components/auth/auth-gate";
import { SiteHeader } from "@/components/site-header";
import { TierProvider } from "@/components/tier-context";
import { UpgradeModal } from "@/components/upgrade-modal";

/**
 * The observatory shell: everything a reader sees once they are through the
 * entrance at `/`.
 *
 * `(platform)` is a route group, so it adds nothing to any URL — `/overview`,
 * `/map` and the rest keep the paths they always had. It exists purely so the
 * landing page can opt out of this chrome.
 *
 * `AuthGate` decides whether the reader gets in. It is a product doorway, not a
 * security boundary; see the note in `auth-gate.tsx` for why that distinction
 * matters and why it is acceptable here.
 */
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {/* Wraps the header *and* the page body: page content needs to read
          the membership tier too (the Watch voice player, for one). */}
      <TierProvider>
        <SiteHeader />
        <main id="main" className="mx-auto max-w-[92rem] px-4 py-7 sm:px-6 sm:py-9">
          <AuthGate>{children}</AuthGate>
        </main>
        <UpgradeModal />
      </TierProvider>
      <footer className="mt-12 border-t border-line">
        <div className="mx-auto max-w-[92rem] px-4 py-8 sm:px-6">
          <p className="max-w-3xl text-sm leading-relaxed text-muted">
            <strong className="font-medium text-ink">Run classification is explicit.</strong>{" "}
            Development fixtures and runs may expose reset and execution tools. A sealed spectator
            has no inhabitant message channel or canonical write route, and must publish its
            sequence-zero manifest hash before making that claim.
          </p>
          <nav aria-label="Footer" className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-dim">
            <Link href="/audit" className="hover:text-amber">
              Audit &amp; verification
            </Link>
            <Link href="/events" className="hover:text-amber">
              Canonical event log
            </Link>
            <Link href="/lineage" className="hover:text-amber">
              Lineage
            </Link>
            <span className="mono">read-only by construction</span>
          </nav>
        </div>
      </footer>
    </>
  );
}
