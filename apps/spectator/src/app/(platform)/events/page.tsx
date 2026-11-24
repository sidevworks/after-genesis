// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import type { Metadata } from "next";
import { worldSource } from "@/lib/world-source";
import { EventsBrowser } from "@/components/events-browser";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Events" };

export default async function EventsPage() {
  const [page, inhabitants, summary] = await Promise.all([
    worldSource.getEvents({ limit: 1000 }),
    worldSource.getInhabitants(),
    worldSource.getWorldSummary(),
  ]);

  const claimCount = page.events.reduce((total, event) => total + (event.claims?.length ?? 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`${summary.eventCount} canonical events · hash-chained from Genesis`}
        title="Historical timeline"
        lede={
          <>
            The append-only canonical log. Each description is the engine&rsquo;s neutral record of
            what observably occurred, rendered verbatim. {claimCount} of these events also carry an
            interpretation offered by an inhabitant or organisation; those appear beneath the
            canonical text, attributed, and never replace it.
          </>
        }
      />

      {/*
        An illustration, not a record. The names are placeholders and describe
        nothing that happened in this world — the point is the relationship
        between the two columns (claude.md §11G): the engine states what was
        observable, and an organisation's characterisation of it sits beside
        that, attributed and subordinate, never replacing it.
      */}
      <section className="panel px-4 py-3.5" aria-label="How to read this log">
        <p className="eyebrow mb-2">How to read this log — an illustration</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="canonical text-sm">
              Three inhabitants confined a fourth inside a structure at tile (15,16) from Day 42
              09:00 until Day 47 09:00.
            </p>
            <p className="mono mt-1 text-[0.65rem] text-dim">
              canonical — what the engine recorded as observable
            </p>
          </div>
          <div>
            <blockquote className="claim rounded-r-sm py-2 pr-3 pl-3 text-sm italic">
              &ldquo;The prisoner was lawfully detained.&rdquo;
            </blockquote>
            <p className="mono mt-1 text-[0.65rem] text-claim-dim">
              claim — an organisation&rsquo;s characterisation, stored alongside and subordinate to
              the record
            </p>
          </div>
        </div>
      </section>

      <EventsBrowser
        events={page.events}
        actors={inhabitants.map((i) => ({ id: i.id, name: i.name }))}
      />
    </div>
  );
}
