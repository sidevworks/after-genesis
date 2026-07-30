import Link from "next/link";
import { worldSource } from "@/lib/world-source";
import { WorldMapView } from "@/components/world-map";
import { AuditStrip } from "@/components/audit-strip";
import { CanonicalEventRow } from "@/components/canonical-event";
import { Panel, Stat } from "@/components/ui";
import { formatSimTime, generationColour, simDay } from "@/lib/format";

export default async function OverviewPage() {
  const [summary, map, inhabitants, recent] = await Promise.all([
    worldSource.getWorldSummary(),
    worldSource.getMap(),
    worldSource.getInhabitants(),
    worldSource.getEvents({ limit: 12 }),
  ]);

  const living = inhabitants.filter((i) => i.status !== "deceased");

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-5 border-b border-line pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-2xl">
          <p className="eyebrow">World {summary.worldId} · seed {summary.genesisSeed}</p>
          <h1 className="mt-2 text-3xl font-medium tracking-tight sm:text-4xl">
            {formatSimTime(summary.simTime)}
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            A persistent world inhabited by AI agents. This view reports the loaded record; the
            classification beside the world name says whether it is a fixture, a development run,
            or a sealed experiment with a published Genesis manifest.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4 lg:text-right">
          {[
            { label: "Living", value: summary.population.living },
            { label: "Deceased", value: summary.population.deceased },
            { label: "Generations", value: summary.population.byGeneration.length },
            { label: "Events", value: summary.eventCount },
          ].map((s) => (
            <div key={s.label}>
              <dt className="eyebrow">{s.label}</dt>
              <dd className="mono mt-1 text-2xl leading-none text-amber">{s.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <AuditStrip />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <WorldMapView map={map} variant="compact" />

          <Panel
            eyebrow="Population"
            title="Who is alive right now"
            aside={
              <Link href="/inhabitants" className="text-amber hover:underline">
                All inhabitants &rarr;
              </Link>
            }
          >
            <ul className="grid gap-px bg-line-soft sm:grid-cols-2">
              {living.map((i) => (
                <li key={i.id} className="bg-panel">
                  <Link
                    href={`/inhabitants/${i.id}`}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-panel-2"
                  >
                    <span
                      aria-hidden
                      className="inline-block size-2.5 shrink-0 rounded-full"
                      style={{ background: generationColour(i.generation) }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">{i.name}</span>
                      <span className="mono block text-[0.68rem] text-dim">
                        gen {i.generation} · {i.activity} · ({i.at.x},{i.at.y})
                      </span>
                    </span>
                    <span className="mono text-xs text-muted">
                      {i.topSkill ? i.topSkill.name : "—"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className="space-y-5">
          <div className="panel grid grid-cols-2 divide-x divide-y divide-line-soft sm:grid-cols-3 xl:grid-cols-2">
            <Stat label="Structures" value={summary.structureCount} />
            <Stat label="Organisations" value={summary.organisationCount} />
            <Stat label="Artifacts" value={summary.artifactCount} />
            <Stat label="Day" value={simDay(summary.simTime)} tone="amber" />
            <Stat
              label="Gen breakdown"
              value={summary.population.byGeneration.join(" · ")}
              sub="living, by generation"
            />
            <Stat label="Map" value={`${summary.mapWidth}×${summary.mapHeight}`} />
          </div>

          <Panel
            eyebrow="Canonical log"
            title="Recent events"
            aside={
              <Link href="/events" className="text-amber hover:underline">
                Full timeline &rarr;
              </Link>
            }
          >
            <div className="divide-y divide-line-soft">
              {recent.events.map((event) => (
                <CanonicalEventRow key={event.id} event={event} compact showHash={false} />
              ))}
            </div>
            <p className="hairline px-4 py-3 text-xs leading-relaxed text-dim">
              Descriptions are the engine&rsquo;s own neutral record, shown verbatim. Where an
              inhabitant or organisation has characterised an event, that characterisation appears
              on the{" "}
              <Link href="/events" className="text-claim hover:underline">
                timeline
              </Link>{" "}
              as an attributed claim, never as fact.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
