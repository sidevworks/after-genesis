import {
  GENESIS_PREV_HASH,
  addGenesisInhabitant,
  computeStateChecksum,
  createWorldState,
  firstPassableTile,
  generateWorldTerrain,
  makeInhabitant,
  sealEvent,
  simTime,
  type WorldState,
} from "@after-genesis/core";
import {
  FixedClock,
  MemoryEventStore,
  MemoryIdempotencyStore,
  MemoryStateStore,
} from "@after-genesis/persistence";
import { describe, expect, it, vi } from "vitest";
import {
  ModelUnavailableError,
  executeTurn,
  type CognitionService,
  type TurnDependencies,
} from "./turn.js";

const WORLD_ID = "world_runtime_test";
const ACTOR_ID = "inh_founder";

async function setup(cognition: CognitionService): Promise<{
  deps: TurnDependencies;
  events: MemoryEventStore;
  states: MemoryStateStore<WorldState>;
}> {
  const generated = generateWorldTerrain("runtime-test-seed", 8, 8);
  const start = firstPassableTile(generated.map);
  if (start === null) throw new Error("test map has no passable tile");

  const empty = createWorldState({
    worldId: WORLD_ID,
    seed: "runtime-test-seed",
    map: generated.map,
    deposits: generated.deposits,
  });
  const state = {
    ...addGenesisInhabitant(
      empty,
      makeInhabitant({
        id: ACTOR_ID,
        displayName: "Founder",
        location: start,
        birthTime: simTime(0),
        creationSequence: 0,
        inventory: { energy: 800, compute: 500, food: 10, water: 10 },
      }),
    ),
    sequence: 0,
  };
  const checksum = computeStateChecksum(state);
  const genesis = sealEvent({
    worldId: WORLD_ID,
    sequence: 0,
    simTime: 0,
    realTimestamp: "2026-01-01T00:00:00.000Z",
    actor: null,
    type: "genesis",
    inputs: { seed: "runtime-test-seed" },
    resolution: { founderId: ACTOR_ID },
    visibility: { kind: "public" },
    preStateChecksum: checksum,
    postStateChecksum: checksum,
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
  const states = new MemoryStateStore<WorldState>({ checksum: computeStateChecksum });
  await events.append(genesis, 0);
  await states.save(WORLD_ID, state, 0, checksum);

  return {
    events,
    states,
    deps: {
      eventStore: events,
      stateStore: states,
      idempotency: new MemoryIdempotencyStore(new FixedClock()),
      clock: new FixedClock(),
      cognition,
      provenance: { sourceCommit: "test", deployedDigest: "test" },
    },
  };
}

const waitCognition = (): CognitionService => ({
  propose: vi.fn<CognitionService["propose"]>(async () => ({
    action: { type: "wait", payload: { durationMinutes: 30 } },
    modelId: "scripted-test",
    requestHash: null,
    responseHash: null,
    costMicros: 0,
    inputTokens: 0,
    outputTokens: 0,
  })),
});

describe("executeTurn", () => {
  it("commits a resolved action, state snapshot, and hash-chained event", async () => {
    const cognition = waitCognition();
    const { deps, events, states } = await setup(cognition);

    const result = await executeTurn(deps, {
      worldId: WORLD_ID,
      actorId: ACTOR_ID,
      simTime: simTime(1),
      taskId: "task-1",
    });

    expect(result.status).toBe("committed");
    expect(await events.headSequence(WORLD_ID)).toBe(1);
    expect((await states.load(WORLD_ID))?.sequence).toBe(1);
    expect(cognition.propose).toHaveBeenCalledTimes(1);
  });

  it("never re-executes a task after its successful delivery", async () => {
    const cognition = waitCognition();
    const { deps, events } = await setup(cognition);
    const request = {
      worldId: WORLD_ID,
      actorId: ACTOR_ID,
      simTime: simTime(1),
      taskId: "same-task",
    };

    expect((await executeTurn(deps, request)).status).toBe("committed");
    expect((await executeTurn(deps, request)).status).toBe("duplicate");
    expect(await events.headSequence(WORLD_ID)).toBe(1);
    expect(cognition.propose).toHaveBeenCalledTimes(1);
  });

  it("defers provider outages without changing state and permits retry", async () => {
    const propose = vi
      .fn<CognitionService["propose"]>()
      .mockRejectedValueOnce(new ModelUnavailableError("temporary outage"))
      .mockResolvedValueOnce({
        action: { type: "wait", payload: {} },
        modelId: "scripted-test",
        requestHash: null,
        responseHash: null,
        costMicros: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
    const { deps, events } = await setup({ propose });
    const request = {
      worldId: WORLD_ID,
      actorId: ACTOR_ID,
      simTime: simTime(1),
      taskId: "retryable-task",
    };

    expect((await executeTurn(deps, request)).status).toBe("deferred");
    expect(await events.headSequence(WORLD_ID)).toBe(0);
    expect((await executeTurn(deps, request)).status).toBe("committed");
    expect(await events.headSequence(WORLD_ID)).toBe(1);
  });
});
