// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { inferSocialPatterns } from "./social-patterns";
import type { WorldEvent } from "./world-types";

function event(sequence: number, type: string, description = ""): WorldEvent {
  return {
    id: `evt_${sequence}`,
    worldId: "world",
    sequence,
    simTime: sequence,
    realTime: "2026-01-01T00:00:00.000Z",
    actor: `inh_${sequence % 2}`,
    actorName: null,
    type,
    description,
    subjects: [`inh_${(sequence + 1) % 2}`],
    inputs: {},
    resolution: "applied",
    visibility: "public",
    preStateChecksum: "a",
    postStateChecksum: "b",
    prevHash: "c",
    hash: "d",
    sourceCommit: "local",
    imageDigest: "local",
    schemaVersion: "1",
    claims: [],
  };
}

describe("spectator social pattern inference", () => {
  it("does not declare a pattern from a single event", () => {
    expect(inferSocialPatterns([event(1, "action.transfer")])).toEqual([]);
  });

  it("reports repeated exchange as an interpretation with evidence", () => {
    const patterns = inferSocialPatterns([
      event(1, "action.transfer"),
      event(2, "action.transfer"),
    ]);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toMatchObject({
      id: "repeated-exchange",
      confidence: "early signal",
      eventCount: 2,
      evidenceSequences: [1, 2],
    });
    expect(patterns[0]!.caveat).toContain("does not establish");
  });

  it("ignores rejected actions and upgrades only repeated evidence", () => {
    const rejected = { ...event(6, "action.transfer"), resolution: "rejected" as const };
    const patterns = inferSocialPatterns([
      ...Array.from({ length: 5 }, (_, index) => event(index + 1, "action.transfer")),
      rejected,
    ]);
    expect(patterns[0]?.confidence).toBe("recurring");
    expect(patterns[0]?.eventCount).toBe(5);
  });
});
