// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import type { ReferenceRecord } from "@/lib/observatory-types";
import { Badge, KeyValue, Panel } from "./ui";

const CONTROL_LABELS: Record<string, string> = {
  view: "View",
  locate: "Locate",
  track: "Track",
  follow: "Follow",
  listen: "Listen",
  replay: "Replay",
  inspect: "Inspect",
  watch_action: "Watch action",
};

function readable(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function ReferencePanel({
  record,
  related,
}: {
  record: ReferenceRecord;
  related: ReferenceRecord[];
}) {
  const availableControls = Object.entries(record.capabilityManifest).filter(
    ([name, capability]) => CONTROL_LABELS[name] && capability?.available,
  );
  const unavailableReasons = Object.entries(record.capabilityManifest).filter(
    ([, capability]) => capability?.available === false && capability.reason,
  );
  const position = record.spatial.position;
  const voice = record.canonicalMetadata.voiceReference as
    | { source: string; canonicalVoiceId: string; live: boolean }
    | undefined;

  return (
    <article className="space-y-5">
      <header className="panel overflow-hidden">
        <div className="reference-header-grid p-5 sm:p-7">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={record.referenceClass === "ENT" ? "alive" : "amber"}>
                {record.referenceClass}
              </Badge>
              <Badge>{record.status}</Badge>
              <Badge title="This is supported directly by the canonical record">canonical</Badge>
            </div>
            <h1 className="mt-4 text-2xl font-medium tracking-tight text-ink sm:text-4xl">
              {record.displayName}
            </h1>
            <p className="mono mt-2 overflow-hidden text-xs text-ellipsis text-amber">
              {record.refId}
            </p>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
              {record.canonicalType.replaceAll("_", " ")}. First recorded on world day{" "}
              {record.firstObservedAt.worldDay}. Observatory labels and visual seeds remain
              separate from canonical metadata.
            </p>
          </div>
          <div className="reference-glyph" aria-hidden>
            <span>{record.referenceClass}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-line-soft px-5 py-3 sm:px-7">
          {availableControls.map(([name]) => {
            const watch = name === "track" || name === "follow" || name === "replay";
            return (
              <a
                key={name}
                href={
                  watch
                    ? `/world/${record.worldId}/watch/${encodeURIComponent(record.refId)}`
                    : `/observatory?focus=${encodeURIComponent(record.refId)}`
                }
                className="rounded-sm border border-line bg-panel-2 px-3 py-1.5 text-xs text-ink hover:border-amber-dim hover:text-amber"
              >
                {CONTROL_LABELS[name]}
              </a>
            );
          })}
        </div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(18rem,.75fr)]">
        <div className="space-y-5">
          <Panel eyebrow="Current state" title="Canonical facts">
            <KeyValue
              rows={[
                { key: "Status", value: record.status },
                {
                  key: "Location",
                  value: position
                    ? `(${position.x}, ${position.z})`
                    : "No canonical spatial position is available.",
                  mono: true,
                },
                {
                  key: "Location reference",
                  value: record.spatial.locationRef ? (
                    <a
                      href={`/world/${record.worldId}/ref/${encodeURIComponent(record.spatial.locationRef)}`}
                      className="text-amber hover:underline"
                    >
                      {record.spatial.locationRef}
                    </a>
                  ) : (
                    "—"
                  ),
                  mono: true,
                },
                {
                  key: "World tick",
                  value: record.firstObservedAt.worldTick,
                  mono: true,
                },
                {
                  key: "Canonical timestamp",
                  value: record.firstObservedAt.canonicalTimestamp ?? "—",
                  mono: true,
                },
              ]}
            />
          </Panel>

          <Panel eyebrow="Provenance" title="Creation and related records">
            <KeyValue
              rows={[
                {
                  key: "Creation event",
                  value: record.createdByEventRef ? (
                    <a
                      href={`/world/${record.worldId}/event/${encodeURIComponent(record.createdByEventRef)}`}
                      className="text-amber hover:underline"
                    >
                      {record.createdByEventRef}
                    </a>
                  ) : (
                    "Not recorded as a separate event."
                  ),
                  mono: true,
                },
                {
                  key: "Creators",
                  value:
                    record.provenance.creatorRefs.length > 0
                      ? record.provenance.creatorRefs.join(", ")
                      : "No canonical creator relation is recorded.",
                },
                {
                  key: "Components",
                  value:
                    record.composition.componentRefs.length > 0
                      ? record.composition.componentRefs.join(", ")
                      : "No canonical components are recorded.",
                },
              ]}
            />
            {related.length > 0 && (
              <ul className="grid gap-px border-t border-line-soft bg-line-soft sm:grid-cols-2">
                {related.slice(0, 20).map((item) => (
                  <li key={item.refId} className="bg-panel">
                    <a
                      href={`/world/${item.worldId}/ref/${encodeURIComponent(item.refId)}`}
                      className="block px-4 py-3 hover:bg-panel-2"
                    >
                      <span className="block text-sm text-ink">{item.displayName}</span>
                      <span className="mono mt-1 block text-[0.62rem] text-dim">{item.refId}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-5">
          <Panel eyebrow="Technical record" title="Reference">
            <KeyValue
              rows={[
                { key: "Reference class", value: record.referenceClass, mono: true },
                { key: "Canonical type", value: record.canonicalType, mono: true },
                { key: "Schema", value: record.schemaVersion, mono: true },
                {
                  key: "Visual seed",
                  value: record.observatoryMetadata.visualSeed,
                  mono: true,
                },
                {
                  key: "Renderer",
                  value: record.observatoryMetadata.rendererVersion,
                  mono: true,
                },
                {
                  key: "Fallback level",
                  value: record.observatoryMetadata.fallbackLevel,
                  mono: true,
                },
              ]}
            />
          </Panel>

          {voice && (
            <Panel eyebrow="Available media" title="Listening provenance">
              <KeyValue
                rows={[
                  { key: "Source", value: voice.source, mono: true },
                  { key: "Voice assignment", value: voice.canonicalVoiceId, mono: true },
                  { key: "Live", value: voice.live ? "yes" : "no", mono: true },
                ]}
              />
              <p className="hairline px-4 py-3 text-xs leading-relaxed text-dim">
                This is a presentation-layer voice assignment, not captured canonical audio.
              </p>
            </Panel>
          )}

          {unavailableReasons.length > 0 && (
            <Panel eyebrow="Availability" title="Why some views are absent">
              <ul className="space-y-2 px-4 py-3">
                {unavailableReasons.map(([name, capability]) => (
                  <li key={name} className="text-xs leading-relaxed text-dim">
                    <span className="mono text-muted">{name}</span> — {capability?.reason}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel eyebrow="Canonical metadata" title="Recorded fields">
            <KeyValue
              rows={Object.entries(record.canonicalMetadata).map(([key, value]) => ({
                key,
                value: readable(value),
                mono: true,
              }))}
            />
          </Panel>
        </div>
      </div>
    </article>
  );
}
