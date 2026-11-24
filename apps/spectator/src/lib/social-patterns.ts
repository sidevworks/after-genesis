// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import type { WorldEvent } from "./world-types";

export interface SocialPattern {
  id: string;
  label: string;
  confidence: "early signal" | "recurring";
  summary: string;
  caveat: string;
  eventCount: number;
  actorIds: string[];
  evidenceSequences: number[];
}

interface PatternRule {
  id: string;
  label: string;
  summary: string;
  caveat: string;
  matches: (event: WorldEvent) => boolean;
  minimumEvents: number;
  recurringEvents: number;
}

const includesAny = (value: string, fragments: readonly string[]): boolean =>
  fragments.some((fragment) => value.includes(fragment));

const RULES: readonly PatternRule[] = [
  {
    id: "repeated-exchange",
    label: "Repeated exchange",
    summary:
      "Material or artifacts have repeatedly moved between inhabitants. This may indicate a developing exchange practice.",
    caveat:
      "Movement alone does not establish price, debt, ownership, trade, or a medium of exchange.",
    matches: (event) =>
      includesAny(event.type.toLowerCase(), ["transfer", "exchange", "trade"]),
    minimumEvents: 2,
    recurringEvents: 5,
  },
  {
    id: "shared-symbols",
    label: "Circulating symbolic artifacts",
    summary:
      "Inhabitants are creating, publishing, copying, or moving authored artifacts. Shared interpretation may be developing.",
    caveat:
      "An artifact's words have no mechanical truth or authority, even when copied or accepted.",
    matches: (event) =>
      includesAny(event.type.toLowerCase(), ["artifact", "publish", "written", "record"]),
    minimumEvents: 3,
    recurringEvents: 7,
  },
  {
    id: "recurring-coordination",
    label: "Recurring coordination",
    summary:
      "Communication and coordinated physical activity recur across the historical record.",
    caveat:
      "Coordination is not evidence of a formal association, hierarchy, or durable authority.",
    matches: (event) =>
      includesAny(event.type.toLowerCase(), [
        "communicate",
        "announce",
        "coordinate",
        "contribute",
        "build",
      ]),
    minimumEvents: 3,
    recurringEvents: 8,
  },
  {
    id: "guarding-and-restraint",
    label: "Guarding and restraint",
    summary:
      "Inhabitants have repeatedly guarded places or physically restricted and released others.",
    caveat:
      "The record establishes physical conduct only. It does not establish lawfulness, guilt, office, or justice.",
    matches: (event) =>
      includesAny(event.type.toLowerCase(), ["guard", "restrain", "confin", "release"]),
    minimumEvents: 2,
    recurringEvents: 5,
  },
  {
    id: "commitment-language",
    label: "Commitment language",
    summary:
      "Recorded speech or writing repeatedly uses language of promises, agreement, obligation, or refusal.",
    caveat:
      "Words and signatures are claims. The engine does not enforce them or classify them as contracts.",
    matches: (event) => {
      const text = [
        event.description,
        ...event.claims.map((claim) => claim.text),
        ...Object.values(event.inputs).map(String),
      ].join(" ").toLowerCase();
      return includesAny(text, ["promise", "agree", "obligation", "refus", "commit"]);
    },
    minimumEvents: 2,
    recurringEvents: 5,
  },
] as const;

/**
 * Read-only historical interpretation. It cannot mutate canonical state and
 * deliberately reports candidates rather than declaring institutions.
 */
export function inferSocialPatterns(events: readonly WorldEvent[]): SocialPattern[] {
  const patterns: SocialPattern[] = [];
  for (const rule of RULES) {
    const evidence = events
      .filter((event) => event.resolution !== "rejected" && rule.matches(event))
      .sort((a, b) => a.sequence - b.sequence);
    if (evidence.length < rule.minimumEvents) continue;
    const actorIds = [
      ...new Set(
        evidence.flatMap((event) => [
          ...(event.actor === null ? [] : [event.actor]),
          ...event.subjects,
        ]),
      ),
    ].sort();
    patterns.push({
      id: rule.id,
      label: rule.label,
      confidence: evidence.length >= rule.recurringEvents ? "recurring" : "early signal",
      summary: rule.summary,
      caveat: rule.caveat,
      eventCount: evidence.length,
      actorIds,
      evidenceSequences: evidence.slice(-8).map((event) => event.sequence),
    });
  }
  return patterns.sort(
    (a, b) =>
      b.eventCount - a.eventCount ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
