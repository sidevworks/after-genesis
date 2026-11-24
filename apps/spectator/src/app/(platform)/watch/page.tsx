// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import type { Metadata } from "next";
import { readFile } from "node:fs/promises";
import type { ChannelSubject } from "@/components/cinema/cinema-channel";
import { WatchExperience } from "@/components/cinema/watch-experience";
import { Badge, Panel } from "@/components/ui";
import runFixture from "@/fixtures/pre-genesis-run.json";
import { liveObservatoryPath } from "@/lib/dev-world-paths";
import { buildReferenceRegistry } from "@/lib/reference-registry";
import type { ObservatoryRun } from "@/lib/observatory-types";

export const metadata: Metadata = {
  title: "Watch",
  description:
    "A continuous, camera-tracked rendering of the canonical After Genesis record. Read-only.",
};

async function readRun(): Promise<ObservatoryRun> {
  if (process.env.NEXT_PUBLIC_DEV_WORLD_CONTROLS !== "true") {
    return runFixture as unknown as ObservatoryRun;
  }
  return JSON.parse(await readFile(liveObservatoryPath(), "utf8")) as ObservatoryRun;
}

export default async function WatchPage() {
  const run = await readRun();
  const entities = buildReferenceRegistry(run).records.filter(
    (record) => record.referenceClass === "ENT",
  );
  const disclosure = run.disclosure;
  const activities = run.activities ?? [];
  const withheld = activities.filter((activity) => !activity.contentsDisclosed).length;

  const subjects: ChannelSubject[] = run.inhabitants.map((inhabitant) => {
    const record = entities.find(
      (entity) => entity.canonicalMetadata.canonicalId === inhabitant.id,
    );
    return {
      id: inhabitant.id,
      displayName: inhabitant.displayName,
      status: inhabitant.status,
      generation: inhabitant.generation,
      refId: record?.refId ?? null,
    };
  });

  return (
    <div className="mx-auto max-w-[84rem] space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-medium tracking-tight text-ink">
            Every recorded hour, watchable
          </h1>
          <Badge tone="alive">completed run</Badge>
          <Badge tone="warn">Genesis Pro Feature</Badge>
        </div>
        <p className="eyebrow">
          {activities.length.toLocaleString()} activities · {run.events.length.toLocaleString()}{" "}
          events · {Math.floor(run.world.simTime / 1440)} world days
        </p>
      </header>

      <WatchExperience
        run={run}
        subjects={subjects}
        activities={activities}
        endTick={run.world.simTime}
      />

      <p className="max-w-3xl border-t border-line pt-5 text-sm leading-relaxed text-muted">
        The canonical record stores {activities.length.toLocaleString()} activities across{" "}
        {run.events.length.toLocaleString()} events. This view turns that discrete record into a
        continuous one: for any minute of world time it can say where every inhabitant stood, what
        activity occupied them, and how far through it they were. The camera reads that projection.
        It cannot enter the world, and the world cannot perceive it.
      </p>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel eyebrow="Disclosure" title={`Policy version ${disclosure?.policyVersion ?? 1}`}>
          <div className="space-y-3 px-4 py-4 text-sm leading-relaxed text-muted">
            <p>{disclosure?.envelope ?? run.disclosurePolicy}</p>
            <p>{disclosure?.contents ?? ""}</p>
            <p className="text-dim">
              {withheld.toLocaleString()} of {activities.length.toLocaleString()} activities have
              withheld contents. Those intervals are rendered as an occupied figure in a neutral
              posture, and the caption says so. No withheld content is reconstructed, summarised or
              guessed at anywhere in this application.
            </p>
          </div>
        </Panel>

        <Panel eyebrow="What you are seeing" title="Canonical fact and derived presentation">
          <dl className="divide-y divide-line-soft text-sm">
            {[
              ["Canonical", "Positions, activities, participants, start and end times, world clock, resource outcomes where disclosed, and the disclosure state itself."],
              ["Derived", "Camera framing and movement, shot selection, legible night exposure, walking gait, work gestures, personal-space offsets, and the block-by-block staging used to make recorded gathering, crafting and construction processes visible."],
              ["ElevenLabs AI Voice", "Rendered ahead of time from the record and played in step with the camera, for Genesis Pro subscribers. The narrator reads the derived caption of a canonical activity; an inhabitant's own voice is used only where the record discloses words it actually said. Withheld conversations are never voiced, summarised or reconstructed."],
            ].map(([term, copy]) => (
              <div key={term} className="grid gap-1 px-4 py-3 sm:grid-cols-[8rem_1fr]">
                <dt className="eyebrow">{term}</dt>
                <dd className="leading-relaxed text-muted">{copy}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </div>
  );
}
