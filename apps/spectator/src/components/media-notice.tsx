// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import type { GeneratedMedia } from "@/lib/world-types";
import { Badge } from "./ui";

/**
 * claude.md §12 and §21: generated media must be clearly distinguishable from
 * canonical world actions, and verbatim dialogue, condensed summaries and
 * dramatised narration must be distinguished from one another.
 *
 * Rendered on a hatched surface with an explicit label, never inline with
 * canonical text, and always carrying the statement that it changed nothing.
 */

const LABEL: Record<GeneratedMedia["kind"], { title: string; tone: "amber" | "warn" | "neutral" }> = {
  verbatim_dialogue: { title: "Verbatim canonical dialogue", tone: "neutral" },
  condensed_summary: { title: "Condensed summary — generated", tone: "amber" },
  dramatised_narration: { title: "Dramatised narration — generated", tone: "warn" },
};

export function MediaNotice({ media }: { media: GeneratedMedia }) {
  const label = LABEL[media.kind];
  const canonical = media.kind === "verbatim_dialogue";

  return (
    <figure
      className="rounded-sm border border-dashed border-warn/40 px-3 py-2.5"
      style={{
        backgroundImage:
          "repeating-linear-gradient(135deg, rgba(224,138,95,0.05) 0 6px, transparent 6px 12px)",
      }}
    >
      <figcaption className="flex flex-wrap items-center gap-2">
        <Badge tone={label.tone}>{canonical ? "Canonical audio" : "Generated media"}</Badge>
        <span className="text-xs text-warn">{label.title}</span>
        <span className="mono text-[0.65rem] text-dim">
          {media.id}
          {media.durationSeconds ? ` · ${media.durationSeconds}s` : ""} · {media.producedBy}
        </span>
      </figcaption>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">{media.note}</p>
      {!canonical && (
        <p className="mono mt-1.5 text-[0.65rem] text-dim">
          Produced outside the world. No inhabitant perceived it. No canonical state changed.
        </p>
      )}
    </figure>
  );
}
