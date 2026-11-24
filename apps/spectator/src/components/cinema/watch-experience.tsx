// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useMemo } from "react";
import { buildChronicle } from "@/lib/cinema/chronicle";
import type { ObservatoryRun } from "@/lib/observatory-types";
import { CinemaChannel, type ChannelActivity, type ChannelSubject } from "./cinema-channel";

export function WatchExperience({
  run,
  subjects,
  activities,
  endTick,
}: {
  readonly run: ObservatoryRun;
  readonly subjects: readonly ChannelSubject[];
  readonly activities: readonly ChannelActivity[];
  readonly endTick: number;
}) {
  const chronicle = useMemo(() => buildChronicle(run), [run]);

  return (
    <CinemaChannel
      key={run.world.chainHead}
      subjects={subjects}
      activities={activities}
      endTick={endTick}
      chronicle={chronicle}
      run={run}
      map={run.map}
      voiceReel="month"
    />
  );
}
