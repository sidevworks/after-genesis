import type { Metadata } from "next";
import { readFile } from "node:fs/promises";
import { ObservatoryScene } from "@/components/observatory-scene";
import { ObservatorySearch } from "@/components/observatory-search";
import { Badge, Panel, Stat } from "@/components/ui";
import { liveObservatoryPath } from "@/lib/dev-world-paths";
import { formatSimTime } from "@/lib/format";
import { observatorySource } from "@/lib/observatory-source";
import { buildReferenceRegistry } from "@/lib/reference-registry";
import { buildSceneDescription } from "@/lib/scene-adapter";
import type { ObservatoryRun } from "@/lib/observatory-types";

export const metadata: Metadata = {
  title: "Observatory",
  description: "A read-only, universal view of the completed After Genesis run.",
};

async function readRun(): Promise<ObservatoryRun> {
  if (process.env.NEXT_PUBLIC_DEV_WORLD_CONTROLS !== "true") {
    return observatorySource.getRun();
  }

  return JSON.parse(await readFile(liveObservatoryPath(), "utf8")) as ObservatoryRun;
}

export default async function ObservatoryPage() {
  const run = await readRun();
  const registry = buildReferenceRegistry(run);
  const scene = buildSceneDescription(run, registry, run.world.simTime);
  const records = registry.records;
  const entities = records.filter((record) => record.referenceClass === "ENT");
  const events = records.filter((record) => record.referenceClass === "EVT");
  const actions = records.filter((record) => record.referenceClass === "ACT");
  const locations = records.filter((record) => record.referenceClass === "LOC");
  const latestVisibleEvents = events
    .filter((record) => record.canonicalType !== "withheld_event")
    .slice(-8)
    .reverse();

  return (
    <div className="space-y-6">
      <header className="grid gap-6 border-b border-line pb-6 lg:grid-cols-[1fr_22rem] lg:items-end">
        <div className="max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <p className="eyebrow">Universal Observatory · world W001</p>
            <Badge tone="alive">completed run</Badge>
          </div>
          <h1 className="mt-3 text-3xl font-medium tracking-tight text-ink sm:text-5xl">
            The world exists independently.
            <span className="mt-1 block text-muted">This is how we witness it.</span>
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
            A renderer-neutral, permanent index over the real 600-turn civilisation run.
            Everything addressable has an immutable reference. Private contents remain private;
            Observatory interpretations are always labelled and never enter canonical history.
          </p>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-line-soft rounded-sm border border-line bg-panel/70">
          <Stat label="World time" value={formatSimTime(run.world.simTime)} tone="amber" />
          <Stat label="References" value={records.length.toLocaleString()} />
          <Stat label="Events" value={events.length} />
          <Stat label="Actions" value={actions.length} />
        </div>
      </header>

      <ObservatoryScene scene={scene} />

      <div className="grid gap-5 xl:grid-cols-[minmax(20rem,.7fr)_minmax(0,1.3fr)]">
        <Panel eyebrow="Universal index" title="Search the world">
          <div className="p-4">
            <ObservatorySearch
              worldId="W001"
              entries={records.map((record) => ({
                refId: record.refId,
                displayName: record.displayName,
                referenceClass: record.referenceClass,
                canonicalType: record.canonicalType,
              }))}
            />
          </div>
          <p className="hairline px-4 py-3 text-xs leading-relaxed text-dim">
            Exact Reference ID searches resolve one record. Names can change; IDs cannot.
          </p>
        </Panel>

        <Panel
          eyebrow="Canonical history"
          title="Latest spatially disclosed events"
          aside={`${run.disclosurePolicy}`}
        >
          <ol className="divide-y divide-line-soft">
            {latestVisibleEvents.map((event) => (
              <li key={event.refId}>
                <a
                  href={`/world/W001/event/${encodeURIComponent(event.refId)}`}
                  className="grid gap-1 px-4 py-3 hover:bg-panel-2 sm:grid-cols-[6rem_1fr_auto] sm:items-baseline"
                >
                  <span className="mono text-xs text-amber">
                    {formatSimTime(event.firstObservedAt.worldTick)}
                  </span>
                  <span className="text-sm text-ink">{event.displayName}</span>
                  <span className="mono text-[0.62rem] text-dim">
                    #{String(event.canonicalMetadata.sequence)}
                  </span>
                </a>
              </li>
            ))}
          </ol>
        </Panel>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Autonomous entities",
            value: entities.length,
            copy: "Persistent identity, current location, activity, and stable camera anchors.",
          },
          {
            label: "Spatial locations",
            value: locations.length,
            copy: "Every tile is permanently addressable, independent of later meaning.",
          },
          {
            label: "Canonical events",
            value: events.length,
            copy: "Append-only history with visibility boundaries preserved.",
          },
          {
            label: "Resolved actions",
            value: actions.length,
            copy: "Every attempt is referenceable without becoming permanent map clutter.",
          },
        ].map((item) => (
          <div key={item.label} className="panel p-4">
            <p className="eyebrow">{item.label}</p>
            <p className="mono mt-2 text-3xl text-amber">{item.value.toLocaleString()}</p>
            <p className="mt-3 text-xs leading-relaxed text-muted">{item.copy}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
