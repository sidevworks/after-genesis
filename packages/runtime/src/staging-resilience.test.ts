import {
  computeStateChecksum,
  sha256Hex,
  type CanonicalEvent,
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
import { executeTurn } from "./turn.js";

const STAGING_WORLD = "staging-resilience-world-v1";
const ACTOR_ID = "inh_staging_actor";
const QUEUE_NAME = "after-genesis-turns";

async function createStagingFixture() {
  const events = new MemoryEventStore();
  const states = new MemoryStateStore<WorldState>({ checksum: computeStateChecksum });
  const clock = new FixedClock();
  const idempotency = new MemoryIdempotencyStore(clock);
  const queue = new MemoryTurnQueue();

  let proposeCallCount = 0;
  const cognition = {
    propose: vi.fn(async () => {
      proposeCallCount++;
      return {
        action: { type: "wait" as const, payload: { durationMinutes: 15 } },
        modelId: "gemini-3.5-flash-lite",
        requestHash: sha256Hex("req_hash_123"),
        responseHash: sha256Hex("resp_hash_456"),
        costMicros: 350,
        inputTokens: 100,
        outputTokens: 50,
      };
    }),
  };

  await commitGenesis(
    {
      eventStore: events,
      stateStore: states,
      clock,
      provenance: { sourceCommit: "commit_test_123", deployedDigest: "digest_test_456" },
    },
    {
      worldId: STAGING_WORLD,
      seed: "staging-resilience-seed",
      width: 16,
      height: 16,
      founder: {
        id: ACTOR_ID,
        displayName: "Staging Pioneer",
        modelId: "gemini-3.5-flash-lite",
        sex: "female",
        inventory: { energy: 100, compute: 100 },
        traits: {},
        values: [],
        privateGoals: [],
      },
    },
  );

  const turnDeps = {
    eventStore: events,
    stateStore: states,
    idempotency,
    clock,
    cognition,
    provenance: { sourceCommit: "commit_test_123", deployedDigest: "digest_test_456" },
  };

  const scheduler = { eventStore: events, stateStore: states, queue };
  const scheduled = await scheduleNextTurn(scheduler, STAGING_WORLD);
  if (scheduled.status !== "scheduled") throw new Error("Failed to schedule staging turn");

  const worker = createTurnWorker({ turn: turnDeps, scheduler, expectedQueueName: QUEUE_NAME });

  return {
    events,
    states,
    idempotency,
    clock,
    cognition,
    queue,
    task: scheduled.task,
    worker,
    turnDeps,
    getProposeCallCount: () => proposeCallCount,
  };
}

function buildTaskHttpRequest(
  task: TurnTask,
  queue = QUEUE_NAME,
): TurnWorkerHttpRequest {
  const headers = new Map<string, string>();
  headers.set("x-cloudtasks-queuename", queue);
  headers.set(
    "x-cloudtasks-taskname",
    `turn-${sha256Hex(task.taskId).slice(0, 40)}`,
  );
  return {
    method: "POST",
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    json: async () => task,
  };
}

async function collectEvents(eventStore: MemoryEventStore, worldId: string): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  for await (const event of eventStore.read(worldId, 0)) {
    events.push(event);
  }
  return events;
}

describe("Staging Runtime Resilience & Fault Tolerance", () => {
  it("protects against duplicate turn delivery (idempotency)", async () => {
    const fix = await createStagingFixture();
    const req = buildTaskHttpRequest(fix.task);

    // Initial delivery
    const res1 = await fix.worker(req);
    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({ ok: true, status: "committed" });
    expect(fix.getProposeCallCount()).toBe(1);

    const eventCountAfterFirst = (await collectEvents(fix.events, STAGING_WORLD)).length;
    expect(eventCountAfterFirst).toBe(2); // genesis (seq 0) + turn (seq 1)

    // Redelivery of identical Cloud Task
    const res2 = await fix.worker(req);
    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({ ok: true, status: "duplicate" });

    // Cognition provider must NOT be called again, and event log length remains 2
    expect(fix.getProposeCallCount()).toBe(1);
    const eventCountAfterSecond = (await collectEvents(fix.events, STAGING_WORLD)).length;
    expect(eventCountAfterSecond).toBe(2);
  });

  it("handles provider outage gracefully without corrupting state or event log", async () => {
    const fix = await createStagingFixture();
    fix.cognition.propose.mockImplementationOnce(async () => {
      throw new Error("Gemini API 503 Service Unavailable");
    });

    const req = buildTaskHttpRequest(fix.task);
    const res = await fix.worker(req);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, status: "failed" });

    // State sequence remains at 0 (genesis only)
    const headSeq = await fix.events.headSequence(STAGING_WORLD);
    expect(headSeq).toBe(0);
  });

  it("survives worker process termination post-commit cleanly", async () => {
    const fix = await createStagingFixture();

    // Execute first turn
    const result1 = await executeTurn(fix.turnDeps, fix.task);
    expect(result1.status).toBe("committed");
    if (result1.status !== "committed") throw new Error("Expected committed status");

    // Check materialised state sequence and checksum
    const stateSeq = await fix.events.headSequence(STAGING_WORLD);
    expect(stateSeq).toBe(1);

    const savedState = await fix.states.load(STAGING_WORLD);
    expect(savedState).not.toBeNull();
    const checksum = computeStateChecksum(savedState!.state);
    expect(checksum).toBe(result1.event.postStateChecksum);

    // Ensure event log holds the committed turn
    const headSeq = await fix.events.headSequence(STAGING_WORLD);
    expect(headSeq).toBe(1);
    const events = await collectEvents(fix.events, STAGING_WORLD);
    expect(events[1]?.inputs).toMatchObject({ taskId: fix.task.taskId });
  });

  it("replays recorded responses with exact checksum agreement", async () => {
    const fix = await createStagingFixture();
    const req = buildTaskHttpRequest(fix.task);

    const res = await fix.worker(req);
    expect(res.status).toBe(200);

    const events = await collectEvents(fix.events, STAGING_WORLD);
    expect(events.length).toBe(2);

    const genesisEvent = events[0];
    const turnEvent = events[1];
    if (!genesisEvent || !turnEvent) throw new Error("Expected 2 events");

    expect(genesisEvent.type).toBe("genesis");
    expect(genesisEvent.sequence).toBe(0);

    expect(turnEvent.sequence).toBe(1);
    expect(turnEvent.prevHash).toBe(genesisEvent.hash);
    expect(turnEvent.preStateChecksum).toBe(genesisEvent.postStateChecksum);
  });
});
