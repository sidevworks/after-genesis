import {
  GENESIS_PREV_HASH,
  buildGenesis,
  sealEvent,
  type WorldState,
} from "@after-genesis/core";
import {
  MemoryEventStore,
  MemoryStateStore,
} from "@after-genesis/persistence";
import { describe, expect, it } from "vitest";
import { MemoryTurnQueue, scheduleNextTurn } from "./scheduler.js";

async function setup() {
  const built = buildGenesis({
    worldId: "world_scheduler",
    seed: "scheduler-seed",
    width: 8,
    height: 8,
    founder: {
      id: "inh_founder",
      displayName: "Aster",
      modelId: "test",
      sex: "female",
      inventory: { energy: 100, compute: 100 },
      traits: {},
      values: [],
      privateGoals: [],
    },
  });
  const genesis = sealEvent({
    worldId: built.config.worldId,
    sequence: 0,
    simTime: 0,
    realTimestamp: "2026-01-01T00:00:00.000Z",
    actor: null,
    type: "genesis",
    inputs: { genesis: built.config },
    resolution: {},
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
  const events = new MemoryEventStore();
  // This store's default checksum includes forensics; Genesis has empty
  // forensics, so use the exact canonical checksum supplied by buildGenesis.
  const compatibleStates = new MemoryStateStore<WorldState>({
    checksum: () => built.stateChecksum,
  });
  await events.append(genesis, 0);
  await compatibleStates.save(built.config.worldId, built.state, 0, built.stateChecksum);
  return {
    events,
    states: compatibleStates,
    queue: new MemoryTurnQueue(),
    worldId: built.config.worldId,
  };
}

describe("scheduleNextTurn", () => {
  it("creates a stable task for the next eligible inhabitant", async () => {
    const fixture = await setup();
    const result = await scheduleNextTurn(
      {
        eventStore: fixture.events,
        stateStore: fixture.states,
        queue: fixture.queue,
      },
      fixture.worldId,
    );
    expect(result.status).toBe("scheduled");
    if (result.status === "scheduled") {
      expect(result.task.taskId).toBe("world_scheduler:inh_founder:1");
      expect(result.task.expectedSequence).toBe(1);
    }
  });

  it("converges duplicate scheduling attempts on one queue task", async () => {
    const fixture = await setup();
    const deps = {
      eventStore: fixture.events,
      stateStore: fixture.states,
      queue: fixture.queue,
    };
    expect((await scheduleNextTurn(deps, fixture.worldId)).status).toBe("scheduled");
    const second = await scheduleNextTurn(deps, fixture.worldId);
    expect(second).toMatchObject({ status: "scheduled", duplicate: true });
    expect(fixture.queue.tasks()).toHaveLength(1);
  });

  it("refuses to schedule against a stale state snapshot", async () => {
    const fixture = await setup();
    const head = (await fixture.events.head(fixture.worldId))!;
    const second = sealEvent({
      ...head,
      sequence: 1,
      prevHash: head.hash,
    });
    await fixture.events.append(second, 1);
    const result = await scheduleNextTurn(
      {
        eventStore: fixture.events,
        stateStore: fixture.states,
        queue: fixture.queue,
      },
      fixture.worldId,
    );
    expect(result).toMatchObject({ status: "idle" });
  });
});
