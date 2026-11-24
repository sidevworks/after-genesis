// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { broadcastStoryFor } from "@/lib/cinema/broadcast";
import type { ActorSample } from "@/lib/cinema/types";

export function BroadcastOverlay({
  day,
  clock,
  subject,
  skipped,
}: {
  readonly day: number;
  readonly clock: string;
  readonly subject: ActorSample | null;
  readonly skipped: string | null;
}) {
  const story = broadcastStoryFor(subject);
  return (
    <div className="broadcast-overlay">
      <div className="broadcast-overlay__top">
        <span className="broadcast-overlay__brand">After Genesis · Live record</span>
        <strong>Day {day}</strong>
        <span>{clock}</span>
      </div>
      <div className="broadcast-overlay__story">
        <p className="broadcast-overlay__actor">{story.actor}</p>
        <h2 id="cinema-title">{story.action}</h2>
        <p className="broadcast-overlay__caption">{story.story}</p>
        {story.processStage !== null ? (
          <div className="broadcast-overlay__process">
            <span>{story.processStage}</span>
            <strong>{Math.round(story.progress * 100)}%</strong>
            <div
              role="progressbar"
              aria-label={`${story.processStage} process`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(story.progress * 100)}
            >
              <i style={{ width: `${story.progress * 100}%` }} />
            </div>
          </div>
        ) : null}
        {skipped !== null ? <p className="broadcast-overlay__skip">{skipped}</p> : null}
      </div>
    </div>
  );
}
