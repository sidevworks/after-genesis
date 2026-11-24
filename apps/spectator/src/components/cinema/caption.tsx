// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
"use client";

/**
 * The lower third: what the canonical record says about the moment on screen.
 *
 * The caption comes from the chronicle segment, which builds it from canonical
 * fields only — neutral, factual, no motive and no adjective (claude.md §11G:
 * "The canonical event log must describe observable events neutrally").
 *
 * The disclosure badge is the important part of this component. Three states,
 * three different sentences, and the difference between them is never blurred:
 *
 *   disclosed      the world recorded what happened, and this is it;
 *   envelope only  the world recorded who was where, doing which activity, for
 *                  how long — all physically observable — and withheld the
 *                  contents. The picture shows the activity; the caption says
 *                  the contents are withheld and never guesses at them;
 *   unrecorded     no canonical record covers this interval at all.
 *
 * A viewer must never have to guess which of the three they are looking at.
 */

import type { ActorSample } from "@/lib/cinema/types";

const DISCLOSURE_COPY = {
  disclosed: {
    label: "canonical record",
    tone: "cinema-caption--disclosed",
    note: "Contents recorded and disclosed.",
  },
  envelope_only: {
    label: "contents withheld",
    tone: "cinema-caption--withheld",
    note: "Time, place, participants and the activity itself are observable. The contents are withheld by canonical visibility and are not reconstructed, summarised or inferred here.",
  },
  unrecorded: {
    label: "no record",
    tone: "cinema-caption--unrecorded",
    note: "No canonical record covers this interval. Nothing is depicted.",
  },
} as const;

export function CinemaCaption({ subject }: { subject: ActorSample | null }) {
  if (subject === null) {
    return (
      <div className="cinema-caption cinema-caption--unrecorded">
        <p className="cinema-caption__line">No inhabitant is in frame at this moment.</p>
      </div>
    );
  }

  const copy = DISCLOSURE_COPY[subject.disclosure];
  const progress = Math.round(subject.progress * 100);

  return (
    <div className={`cinema-caption ${copy.tone}`}>
      <div className="cinema-caption__head">
        <span className="cinema-caption__who">{subject.displayName}</span>
        <span className="cinema-caption__badge">{copy.label}</span>
        <span className="mono cinema-caption__state">
          {subject.activityState.replaceAll("_", " ")} · {progress}%
        </span>
      </div>
      <p className="cinema-caption__line">{subject.segment.caption}</p>
      <p className="cinema-caption__note">{copy.note}</p>
    </div>
  );
}
