// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import {
  GENESIS_PREV_HASH,
  addGenesisInhabitant,
  computeStateChecksum,
  createWorldState,
  firstPassableTile,
  putStructure,
  generateWorldTerrain,
  IMPASSABLE_TERRAIN,
  setDeposit,
  makeInhabitant,
  terrainAt,
  updateInhabitant,
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

async function setup(
  cognition: CognitionService,
  customizeState?: (state: WorldState) => WorldState,
): Promise<{
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
  const preparedState = customizeState?.(state) ?? state;
  const preparedChecksum = computeStateChecksum(preparedState);
  const preparedGenesis = { ...genesis, postStateChecksum: preparedChecksum };
  await events.append(preparedGenesis, 0);
  await states.save(WORLD_ID, preparedState, 0, preparedChecksum);

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

function findAdjacentPassableTile(map: WorldState["map"], anchor: { x: number; y: number }) {
  const candidates = [
    { x: anchor.x + 1, y: anchor.y },
    { x: anchor.x - 1, y: anchor.y },
    { x: anchor.x, y: anchor.y + 1 },
    { x: anchor.x, y: anchor.y - 1 },
  ];
  for (const candidate of candidates) {
    const terrain = terrainAt(map, candidate);
    if (terrain === null || IMPASSABLE_TERRAIN.has(terrain)) {
      continue;
    }
    return candidate;
  }
  return null;
}

function withStorehouseStorage(
  state: WorldState,
  location: { x: number; y: number },
  storage: { water?: number; food?: number; wood?: number; stone?: number },
): WorldState {
  return putStructure(state, {
    id: "str_test_storehouse",
    kind: "storehouse",
    location,
    owner: ACTOR_ID,
    ownerOrganisation: null,
    integrity: 100,
    capacity: 100,
    storage,
    ownershipPublic: true,
    storagePublic: true,
    secured: false,
    occupants: [],
    createdSequence: state.sequence + 1,
    createdAt: state.simTime,
  });
}

describe("executeTurn", () => {
  it("commits a resolved action, state snapshot, and hash-chained event", async () => {
    const cognition = waitCognition();
    const { deps, events, states } = await setup(cognition);

    const result = await executeTurn(deps, {
      worldId: WORLD_ID,
      actorId: ACTOR_ID,
      expectedSequence: 1,
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
      expectedSequence: 1,
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
      expectedSequence: 1,
      simTime: simTime(1),
      taskId: "retryable-task",
    };

    expect((await executeTurn(deps, request)).status).toBe("deferred");
    expect(await events.headSequence(WORLD_ID)).toBe(0);
    expect((await executeTurn(deps, request)).status).toBe("committed");
    expect(await events.headSequence(WORLD_ID)).toBe(1);
  });

  it("rejects a stale scheduled sequence before cognition", async () => {
    const cognition = waitCognition();
    const { deps, events } = await setup(cognition);

    const result = await executeTurn(deps, {
      worldId: WORLD_ID,
      actorId: ACTOR_ID,
      expectedSequence: 2,
      simTime: simTime(1),
      taskId: "stale-task",
    });

    expect(result.status).toBe("duplicate");
    expect(await events.headSequence(WORLD_ID)).toBe(0);
    expect(cognition.propose).not.toHaveBeenCalled();
  });

  it("forces critical thirst to a survival action even when model proposes social chatter", async () => {
    const cognition: CognitionService = {
      propose: vi.fn<CognitionService["propose"]>(async () => ({
        action: {
          type: "announce",
          payload: { scope: "local", message: "I am thirsty, but I am choosing to wait" },
        },
        modelId: "scripted-test",
        requestHash: null,
        responseHash: null,
        costMicros: 0,
        inputTokens: 0,
        outputTokens: 0,
      })),
    };

    const { deps, events } = await setup(cognition, (state) => {
      const actor = state.inhabitants[ACTOR_ID];
      if (actor === undefined) {
        throw new Error("actor missing");
      }

      const nearbyWater = findAdjacentPassableTile(state.map, actor.location);
      if (nearbyWater === null) {
        throw new Error("no passable adjacent tile to seed");
      }

      const withDeposit = setDeposit(state, nearbyWater, { water: 4 });
      return updateInhabitant(withDeposit, ACTOR_ID, () => ({
        ...actor,
        needs: {
          ...actor.needs,
          thirst: 100,
        },
        inventory: {
          ...actor.inventory,
          water: 0,
        },
      }));
    });

    const result = await executeTurn(deps, {
      worldId: WORLD_ID,
      actorId: ACTOR_ID,
      expectedSequence: 1,
      simTime: simTime(1),
      taskId: "thirst-overridden",
    });

    expect(result.status).toBe("committed");
    const head = await events.head(WORLD_ID);
    expect((head?.inputs as { action?: { type?: string } } | undefined)?.action).toMatchObject({
      type: "gather",
    });
  });

  it("prefers withdrawing from nearby storage when critically thirsty", async () => {
    const cognition: CognitionService = {
      propose: vi.fn<CognitionService["propose"]>(async () => ({
        action: {
          type: "announce",
          payload: { scope: "local", message: "I am thirsty, but I am choosing to be philosophical" },
        },
        modelId: "scripted-test",
        requestHash: null,
        responseHash: null,
        costMicros: 0,
        inputTokens: 0,
        outputTokens: 0,
      })),
    };

    const { deps, events } = await setup(cognition, (state) => {
      const actor = state.inhabitants[ACTOR_ID];
      if (actor === undefined) throw new Error("actor missing");
      return withStorehouseStorage(
        setDeposit(
          updateInhabitant(state, ACTOR_ID, () => ({
            ...actor,
            needs: { ...actor.needs, thirst: 95 },
            inventory: {
              ...actor.inventory,
              water: 0,
            },
          })),
          actor.location,
          {},
        ),
        actor.location,
        { water: 5 },
      );
    });

    const result = await executeTurn(deps, {
      worldId: WORLD_ID,
      actorId: ACTOR_ID,
      expectedSequence: 1,
      simTime: simTime(1),
      taskId: "storage-withdraw",
    });

    expect(result.status).toBe("committed");
    const head = await events.head(WORLD_ID);
    expect((head?.inputs as { action?: { type?: string } } | undefined)?.action).toMatchObject({
      type: "store_goods",
      payload: { direction: "withdraw" },
    });
  });

  it("moves toward stored survival resources when no carry and no source", async () => {
    const cognition: CognitionService = {
      propose: vi.fn<CognitionService["propose"]>(async () => ({
        action: {
          type: "announce",
          payload: { scope: "local", message: "I am thirsty, but I am choosing not to act" },
        },
        modelId: "scripted-test",
        requestHash: null,
        responseHash: null,
        costMicros: 0,
        inputTokens: 0,
        outputTokens: 0,
      })),
    };

    const { deps, events, states } = await setup(cognition, (state) => {
      const actor = state.inhabitants[ACTOR_ID];
      if (actor === undefined) {
        throw new Error("actor missing");
      }
      const storageTile = findAdjacentPassableTile(state.map, actor.location);
      if (storageTile === null) {
        throw new Error("no adjacent passable tile");
      }
      return withStorehouseStorage(
        setDeposit(
          updateInhabitant(state, ACTOR_ID, () => ({
            ...actor,
            needs: { ...actor.needs, thirst: 95 },
            inventory: {
              ...actor.inventory,
              water: 0,
            },
          })),
          actor.location,
          {},
        ),
        storageTile,
        { water: 3 },
      );
    });

    const first = await executeTurn(deps, {
      worldId: WORLD_ID,
      actorId: ACTOR_ID,
      expectedSequence: 1,
      simTime: simTime(1),
      taskId: "storage-move-step-1",
    });
    expect(first.status).toBe("committed");
    const firstState = (await states.load(WORLD_ID))?.state;
    const actor = firstState?.inhabitants[ACTOR_ID];
    expect(actor?.location).not.toEqual(undefined);
    const eventsHead = await events.head(WORLD_ID);
    expect((eventsHead?.inputs as { action?: { type?: string } } | undefined)?.action).toMatchObject({
      type: "move",
    });

    if (actor === undefined) throw new Error("actor missing after first turn");
    const second = await executeTurn(deps, {
      worldId: WORLD_ID,
      actorId: ACTOR_ID,
      expectedSequence: 2,
      simTime: simTime(31),
      taskId: "storage-move-step-2",
    });
    expect(second.status).toBe("committed");
    const finalState = (await states.load(WORLD_ID))?.state;
    const afterSecond = finalState?.inhabitants[ACTOR_ID];
    expect(afterSecond?.location).toEqual(actor.location);
    const secondHead = await events.head(WORLD_ID);
    expect(secondHead?.inputs).toEqual(
      expect.objectContaining({
        action: expect.objectContaining({ type: "store_goods" }),
      }),
    );
  });
});
