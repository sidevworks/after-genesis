import {
  computeStateChecksum,
  sha256Hex,
  type WorldState,
} from "@after-genesis/core";
import {
  FixedClock,
  MemoryEventStore,
  MemoryIdempotencyStore,
  MemoryStateStore,
} from "@after-genesis/persistence";
import { describe, expect, it, vi } from "vitest";
import { commitGenesis } from "./genesis.js";
import { MemoryTurnQueue, scheduleNextTurn, type TurnTask } from "./scheduler.js";
import { createTurnWorker, type TurnWorkerHttpRequest } from "./turn-worker.js";

const WORLD = "worker_world";
const ACTOR = "inh_founder";
const QUEUE = "turns";

async function fixture() {
  const events = new MemoryEventStore();
  const states = new MemoryStateStore<WorldState>({ checksum: computeStateChecksum });
  const clock = new FixedClock();
  const idempotency = new MemoryIdempotencyStore(clock);
  const queue = new MemoryTurnQueue();
  const cognition = {
    propose: vi.fn(async () => ({
      action: { type: "wait" as const, payload: { durationMinutes: 30 } },
      modelId: "test",
      requestHash: null,
      responseHash: null,
      costMicros: 0,
      inputTokens: 0,
      outputTokens: 0,
    })),
  };
  await commitGenesis(
    {
      eventStore: events,
      stateStore: states,
      clock,
      provenance: { sourceCommit: "test", deployedDigest: "test" },
    },
    {
      worldId: WORLD,
      seed: "worker-seed",
      width: 8,
      height: 8,
      founder: {
        id: ACTOR,
        displayName: "Aster",
        modelId: "test",
        sex: "female",
        inventory: { energy: 100, compute: 100 },
        traits: {},
        values: [],
        privateGoals: [],
      },
    },
  );
  const turn = {
    eventStore: events,
    stateStore: states,
    idempotency,
    clock,
    cognition,
    provenance: { sourceCommit: "test", deployedDigest: "test" },
  };
  const scheduler = { eventStore: events, stateStore: states, queue };
  const scheduled = await scheduleNextTurn(scheduler, WORLD);
  if (scheduled.status !== "scheduled") throw new Error("fixture did not schedule");
  return {
    events,
    cognition,
    queue,
    task: scheduled.task,
    worker: createTurnWorker({ turn, scheduler, expectedQueueName: QUEUE }),
  };
}

function request(
  task: TurnTask,
  overrides: {
    method?: string;
    queue?: string | null;
    taskName?: string | null;
    body?: unknown;
  } = {},
): TurnWorkerHttpRequest {
  const headers = new Map<string, string>();
  if (overrides.queue !== null) {
    headers.set("x-cloudtasks-queuename", overrides.queue ?? QUEUE);
  }
  if (overrides.taskName !== null) {
    headers.set(
      "x-cloudtasks-taskname",
      overrides.taskName ?? `turn-${sha256Hex(task.taskId).slice(0, 40)}`,
    );
  }
  return {
    method: overrides.method ?? "POST",
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    json: async () => overrides.body ?? task,
  };
}

describe("turn worker", () => {
  it("commits a task, schedules its successor, and makes duplicate delivery harmless", async () => {
    const setup = await fixture();

    const first = await setup.worker(request(setup.task));
    const duplicate = await setup.worker(request(setup.task));

    expect(first).toMatchObject({ status: 200, body: { status: "committed" } });
    expect(duplicate).toMatchObject({ status: 200, body: { status: "duplicate" } });
    expect(await setup.events.headSequence(WORLD)).toBe(1);
    expect(setup.cognition.propose).toHaveBeenCalledTimes(1);
    expect(setup.queue.tasks().map((task) => task.expectedSequence)).toEqual([1, 2]);
  });

  it("rejects requests from a different queue before cognition", async () => {
    const setup = await fixture();
    const result = await setup.worker(
      request(setup.task, {
        queue: "other",
      }),
    );

    expect(result.status).toBe(403);
    expect(setup.cognition.propose).not.toHaveBeenCalled();
    expect(await setup.events.headSequence(WORLD)).toBe(0);
  });

  it("rejects a task whose delivery name does not bind to its body", async () => {
    const setup = await fixture();
    const result = await setup.worker(request(setup.task, { taskName: "turn-forged" }));

    expect(result.status).toBe(403);
    expect(setup.cognition.propose).not.toHaveBeenCalled();
  });

  it("rejects an internally inconsistent task body", async () => {
    const setup = await fixture();
    const result = await setup.worker(
      request(setup.task, {
        body: { ...setup.task, actorId: "inh_other" },
      }),
    );

    expect(result.status).toBe(400);
    expect(setup.cognition.propose).not.toHaveBeenCalled();
  });
});
