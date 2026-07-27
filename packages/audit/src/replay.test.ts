import {
  GENESIS_PREV_HASH,
  buildGenesis,
  computeStateChecksum,
  runAction,
  sealEvent,
  simTime,
  type CanonicalEvent,
  type GenesisConfig,
} from "@after-genesis/core";
import { describe, expect, it } from "vitest";
import { replayHistory } from "./replay.js";

const config: GenesisConfig = {
  worldId: "world_replay_test",
  seed: "replay-seed",
  width: 8,
  height: 8,
  founder: {
    id: "inh_founder",
    displayName: "Aster",
    modelId: "recorded-model",
    inventory: { energy: 800, compute: 500, food: 10, water: 10 },
    traits: {},
    values: [],
    privateGoals: [],
  },
};

function history(): CanonicalEvent[] {
  const built = buildGenesis(config);
  const genesis = sealEvent({
    worldId: config.worldId,
    sequence: 0,
    simTime: 0,
    realTimestamp: "2026-01-01T00:00:00.000Z",
    actor: null,
    type: "genesis",
    inputs: { genesis: config },
    resolution: { founderId: config.founder.id },
    visibility: { kind: "public" },
    preStateChecksum: built.emptyStateChecksum,
    postStateChecksum: built.stateChecksum,
    provenance: {
      sourceCommit: "test",
      deployedDigest: "test",
      modelRequestHash: null,
      modelResponseHash: null,
      modelId: null,
    },
    schemaVersion: 1,
    prevHash: GENESIS_PREV_HASH,
  });
  const action = { type: "wait" as const, payload: { durationMinutes: 30 } };
  const resolved = runAction({
    state: built.state,
    actorId: config.founder.id,
    action,
    simTime: simTime(1),
    sequence: 1,
  });
  const turn = sealEvent({
    worldId: config.worldId,
    sequence: 1,
    simTime: 1,
    realTimestamp: "2026-01-01T00:00:01.000Z",
    actor: config.founder.id,
    type: "action.wait",
    inputs: { taskId: "task-1", action },
    resolution: { outcome: resolved.outcome },
    visibility: { kind: "private", owner: config.founder.id },
    preStateChecksum: built.stateChecksum,
    postStateChecksum: computeStateChecksum(resolved.state),
    provenance: {
      sourceCommit: "test",
      deployedDigest: "test",
      modelRequestHash: null,
      modelResponseHash: null,
      modelId: "recorded-model",
    },
    schemaVersion: 1,
    prevHash: genesis.hash,
  });
  return [genesis, turn];
}

describe("replayHistory", () => {
  it("reconstructs the exact recorded state checksum", () => {
    const report = replayHistory(history());
    expect(report.ok).toBe(true);
    expect(report.finalChecksum).toBe(report.expectedChecksum);
    expect(report.replayedEvents).toBe(2);
  });

  it("reports a state transition that cannot be reproduced", () => {
    const events = history();
    const turn = events[1]!;
    events[1] = sealEvent({
      ...turn,
      resolution: { outcome: { status: "resolved", detail: "forged" } },
      postStateChecksum: events[0]!.postStateChecksum,
    });
    const report = replayHistory(events);
    expect(report.ok).toBe(false);
    expect(report.mismatches.some((item) => item.stage === "post-state")).toBe(true);
  });
});
