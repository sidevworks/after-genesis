"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { openCamera } from "@/lib/camera-director";
import { observatorySource } from "@/lib/observatory-source";
import type { CameraMode } from "@/lib/observatory-types";
import { resolveReferenceAddress } from "@/lib/reference-address";
import { ReferencePanel } from "./reference-panel";
import { CinemaViewport } from "./cinema/cinema-viewport";
import { Badge, KeyValue, Panel } from "./ui";

/**
 * Where a `watch` deep link should drop the playhead.
 *
 * Following an inhabitant starts at their first canonical record, so the link
 * plays a life rather than a final freeze-frame. Watching an event starts a
 * short lead-in before it, so the moment arrives on screen instead of being
 * already over — the lead-in shows canonical record like any other interval and
 * is not a reconstruction of anything.
 */
const EVENT_LEAD_IN_MINUTES = 45;

interface WatchTarget {
  readonly subjectId: string | null;
  readonly initialTick: number;
}

function watchTargetFor(
  record: { referenceClass: string; canonicalMetadata: Record<string, unknown> },
  run: ReturnType<typeof observatorySource.getRun>,
): WatchTarget {
  if (record.referenceClass === "ENT") {
    const canonicalId = record.canonicalMetadata.canonicalId;
    const id = typeof canonicalId === "string" ? canonicalId : null;
    const inhabitant = run.inhabitants.find((candidate) => candidate.id === id);
    return { subjectId: id, initialTick: inhabitant?.birthTime ?? 0 };
  }

  const sequence = Number(record.canonicalMetadata.sequence ?? Number.NaN);
  const event = run.events.find((candidate) => candidate.sequence === sequence);
  if (event === undefined) return { subjectId: null, initialTick: 0 };
  return {
    subjectId: event.actorId,
    initialTick: Math.max(0, event.simTime - EVENT_LEAD_IN_MINUTES),
  };
}

export function ReferenceResolver() {
  const [address, setAddress] = useState<ReturnType<typeof resolveReferenceAddress>>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setAddress(resolveReferenceAddress(window.location.pathname, window.location.search));
    setReady(true);
  }, []);

  if (!ready) {
    return <p className="py-16 text-center text-sm text-dim">Resolving permanent reference…</p>;
  }

  const record = address ? observatorySource.getReference(address.refId) : null;
  if (!address || !record || address.worldId !== record.worldId) {
    return (
      <Panel eyebrow="Universal reference" title="Reference not found">
        <div className="px-4 py-6">
          <p className="text-sm text-muted">
            This address does not resolve to a record in the current Observatory export.
          </p>
          <Link href="/observatory" className="mt-3 inline-block text-sm text-amber hover:underline">
            Search the Observatory &rarr;
          </Link>
        </div>
      </Panel>
    );
  }

  const related = record.relatedRefs
    .map((relatedRef) => observatorySource.getReference(relatedRef))
    .filter((item) => item !== null);

  if (address.view !== "watch") {
    return <ReferencePanel record={record} related={related} />;
  }

  const scene = observatorySource.getScene();
  const sceneTarget = scene.references.find((reference) => reference.refId === record.refId);
  const requestedMode: CameraMode =
    record.referenceClass === "ENT"
      ? "THIRD_PERSON_FOLLOW"
      : record.referenceClass === "ACT" || record.referenceClass === "EVT"
        ? "PATH_REPLAY"
        : "INSPECT";
  const view = openCamera(
    {
      targetRef: record.refId,
      mode: requestedMode,
      worldTick: scene.worldTick,
      relatedEventRef: record.createdByEventRef,
    },
    record,
    sceneTarget?.cameraAnchors ?? [],
  );

  return (
    <div className="space-y-5">
      <header className="border-b border-line pb-5">
        <p className="eyebrow">Universal camera · read-only follower rig</p>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-medium tracking-tight text-ink">{record.displayName}</h1>
          <Badge tone="alive">{view.resolvedMode.replaceAll("_", " ")}</Badge>
        </div>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
          This camera exists only in the Observatory. It cannot collide, navigate, act, or become
          perceptible inside canonical space.
        </p>
      </header>
      {record.referenceClass === "ENT" ||
      record.referenceClass === "EVT" ||
      record.referenceClass === "ACT" ? (
        (() => {
          const target = watchTargetFor(record, observatorySource.getRun());
          return (
            <CinemaViewport
              subjectId={target.subjectId}
              initialTick={target.initialTick}
              voiceReel="month"
            />
          );
        })()
      ) : (
        <Panel eyebrow="Camera resolution" title="Stable camera protocol">
          <KeyValue
            rows={[
              { key: "Target", value: record.refId, mono: true },
              { key: "Requested mode", value: requestedMode, mono: true },
              { key: "Resolved mode", value: view.resolvedMode, mono: true },
              { key: "World tick", value: scene.worldTick, mono: true },
              { key: "Anchor", value: view.anchor?.anchorId ?? "No valid spatial anchor", mono: true },
              { key: "Fallback", value: view.fallbackReason ?? "None" },
              { key: "World write path", value: "ABSENT", mono: true },
            ]}
          />
        </Panel>
      )}
      <ReferencePanel record={record} related={related} />
    </div>
  );
}
