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

      <section className="panel px-4 py-3.5" aria-label="How to read this log">
        <p className="eyebrow mb-2">How to read this log</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="canonical text-sm">
              Berrun, Dovie and Jarn confined Iolen inside Stone Hall (STR-004) at tile (15,16)
              from Day 42 09:00.
            </p>
            <p className="mono mt-1 text-[0.65rem] text-dim">
              canonical — what the engine recorded as observable
            </p>
          </div>
          <div>
            <blockquote className="claim rounded-r-sm py-2 pr-3 pl-3 text-sm italic">
              &ldquo;Agent 12 was lawfully imprisoned.&rdquo;
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
