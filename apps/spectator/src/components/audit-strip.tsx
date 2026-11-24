// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import Link from "next/link";
import { worldSource } from "@/lib/world-source";
import { shortHash } from "@/lib/format";

/**
 * The audit strip (claude.md §20): current commit, event-chain status, current
 * state checksum. Present on the landing page so the first thing a spectator
 * sees is how to check the second thing they see.
 */
export async function AuditStrip() {
  const [summary, audit] = await Promise.all([
    worldSource.getWorldSummary(),
    worldSource.getAuditStatus(),
  ]);

  const ok = audit.chain.verified;

  return (
    <section
      aria-label="Audit status"
      className="panel flex flex-wrap items-stretch divide-x divide-line-soft overflow-hidden"
    >
      <div className="flex items-center gap-2.5 px-4 py-3">
        <span
          aria-hidden
          className={`inline-block size-2 rounded-full ${ok ? "bg-alive" : "bg-warn"}`}
        />
        <div>
          <p className="eyebrow">Event chain</p>
          <p className={`mono text-sm ${ok ? "text-alive" : "text-warn"}`}>
            {ok
              ? `verified · ${audit.chain.eventCount} events`
              : `broken at #${audit.chain.brokenAtSequence}`}
          </p>
        </div>
      </div>

      <div className="px-4 py-3">
        <p className="eyebrow">Chain head</p>
        <p className="mono text-sm text-muted" title={audit.chain.head}>
          {shortHash(audit.chain.head, 16)}
        </p>
      </div>

      <div className="px-4 py-3">
        <p className="eyebrow">State checksum</p>
        <p className="mono text-sm text-muted" title={audit.stateChecksum}>
          {shortHash(audit.stateChecksum, 16)}
        </p>
      </div>

      <div className="px-4 py-3">
        <p className="eyebrow">Source commit</p>
        <p className="mono text-sm text-muted" title={summary.sourceCommit}>
          {shortHash(summary.sourceCommit, 12)}
        </p>
      </div>

      <div className="px-4 py-3">
        <p className="eyebrow">Schema</p>
        <p className="mono text-sm text-muted">{summary.schemaVersion}</p>
      </div>

      <div className="ml-auto flex items-center px-4 py-3">
        <Link
          href="/audit"
          className="text-xs text-amber underline decoration-amber-dim underline-offset-4 hover:decoration-amber"
        >
          Verify this yourself &rarr;
        </Link>
      </div>
    </section>
  );
}
