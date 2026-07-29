"use client";

import { useMemo, useState } from "react";
import { buildChronicle } from "@/lib/cinema/chronicle";
import { physicalDemoRun, physicalSettlementSource } from "@/lib/cinema/physical-demo";
import { CinemaChannel, type ChannelActivity, type ChannelSubject } from "./cinema-channel";

export function WatchExperience({
  subjects,
  activities,
  endTick,
}: {
  readonly subjects: readonly ChannelSubject[];
  readonly activities: readonly ChannelActivity[];
  readonly endTick: number;
}) {
  const [reel, setReel] = useState<"month" | "physical">("physical");
  const physicalChronicle = useMemo(() => buildChronicle(physicalDemoRun), []);
  const physicalSubjects = physicalDemoRun.inhabitants.map((inhabitant) => ({
    id: inhabitant.id,
    displayName: inhabitant.displayName,
    status: inhabitant.status,
    generation: inhabitant.generation,
    refId: null,
  }));
  const physicalActivities = physicalDemoRun.activities ?? [];

  return (
    <div className="space-y-4">
      <div className="reel-picker" role="group" aria-label="Watch recording">
        <button type="button" aria-pressed={reel === "physical"} onClick={() => setReel("physical")}>
          <strong>Physical civilisation</strong>
          <small>30-day village · buildings, roads, logistics and visible production</small>
        </button>
        <button type="button" aria-pressed={reel === "month"} onClick={() => setReel("month")}>
          <strong>Recorded month</strong>
          <small>Original canonical run · complete historical record</small>
        </button>
      </div>

      {reel === "physical" ? (
        <CinemaChannel
          key="physical"
          subjects={physicalSubjects}
          activities={physicalActivities}
          endTick={physicalDemoRun.world.simTime}
          chronicle={physicalChronicle}
          map={physicalDemoRun.map}
          settlementSource={physicalSettlementSource}
          voiceReel="physical"
        />
      ) : (
        <CinemaChannel
          key="month"
          subjects={subjects}
          activities={activities}
          endTick={endTick}
          voiceReel="month"
        />
      )}
    </div>
  );
}
