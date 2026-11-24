// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import type { Metadata } from "next";
import { Badge, Empty, PageHeader, Panel } from "@/components/ui";
import { inferSocialPatterns } from "@/lib/social-patterns";
import { worldSource } from "@/lib/world-source";

export const metadata: Metadata = { title: "Emergent patterns" };

export default async function PatternsPage() {
  const [page, summary] = await Promise.all([
    worldSource.getEvents({ limit: 1000 }),
    worldSource.getWorldSummary(),
  ]);
  const patterns = inferSocialPatterns(page.events);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`${page.events.length} visible events examined · spectator analysis only`}
        title="Emergent patterns"
        lede={
          <>
            Candidate social abstractions inferred from repeated observable behaviour. These labels
            are produced by the spectator interface, never written into world physics, and never
            shown to inhabitants as canonical truth.
          </>
        }
      />

      <section className="panel px-4 py-3.5">
        <p className="text-sm text-muted">
          A pattern appears only after repeated evidence. Absence means &ldquo;not yet supported by
          the visible record,&rdquo; not &ldquo;impossible.&rdquo; Every card states what the evidence
          cannot prove.
        </p>
      </section>

      {patterns.length === 0 ? (
        <Panel title="No supported pattern yet">
          <Empty>The world has not produced enough repeated visible behaviour for a candidate.</Empty>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {patterns.map((pattern) => (
            <Panel
              key={pattern.id}
              title={pattern.label}
              eyebrow={`${pattern.eventCount} supporting events`}
              aside={<Badge tone={pattern.confidence === "recurring" ? "amber" : "neutral"}>{pattern.confidence}</Badge>}
              className="overflow-hidden"
            >
              <div className="space-y-4 px-4 py-4">
                <p className="text-sm text-ink">{pattern.summary}</p>
                <div>
                  <p className="eyebrow mb-1">Epistemic limit</p>
                  <p className="text-sm text-muted">{pattern.caveat}</p>
                </div>
                <div className="grid gap-3 text-xs sm:grid-cols-2">
                  <div>
                    <p className="eyebrow">Actors or subjects</p>
                    <p className="mono mt-1 text-dim">{pattern.actorIds.length}</p>
                  </div>
                  <div>
                    <p className="eyebrow">Recent evidence sequences</p>
                    <p className="mono mt-1 text-dim">
                      {pattern.evidenceSequences.map((sequence) => `#${sequence}`).join(" · ")}
                    </p>
                  </div>
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}

      <p className="mono text-xs text-dim">
        World {summary.worldId} · inference is disposable and excluded from the canonical hash chain.
      </p>
    </div>
  );
}
