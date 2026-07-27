import { describe, expect, it } from "vitest";
import { verifyChain, type CanonicalEvent } from "@after-genesis/core";
import { ChainIntegrityError, SequenceConflictError } from "./errors.js";
import { MemoryEventStore } from "./memory-event-store.js";
import { MemoryIdempotencyStore } from "./memory-idempotency-store.js";
import { buildChain, nextEvent } from "./test-support.js";

const WORLD = "test-world";

async function drain(iterable: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe("MemoryEventStore", () => {
  it("starts empty", async () => {
    const store = new MemoryEventStore();
    expect(await store.headSequence(WORLD)).toBe(-1);
    expect(await store.head(WORLD)).toBeNull();
    expect(await drain(store.read(WORLD, 0))).toEqual([]);
  });

  it("appends a chain and reads it back in order", async () => {
    const store = new MemoryEventStore();
    const events = buildChain(WORLD, 5);
    for (const event of events) await store.append(event, event.sequence);

    expect(await store.headSequence(WORLD)).toBe(4);
    expect(await store.head(WORLD)).toEqual(events[4]);
    expect(await drain(store.read(WORLD, 0))).toEqual(events);
    expect((await drain(store.read(WORLD, 1, 3))).map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it("keeps worlds independent", async () => {
    const store = new MemoryEventStore();
    const a = buildChain("world-a", 2);
    const b = buildChain("world-b", 3);
    for (const e of a) await store.append(e, e.sequence);
    for (const e of b) await store.append(e, e.sequence);

    expect(await store.headSequence("world-a")).toBe(1);
    expect(await store.headSequence("world-b")).toBe(2);
    expect(store.worlds().sort()).toEqual(["world-a", "world-b"]);
  });

  it("rejects an append at a sequence that is already occupied", async () => {
    const store = new MemoryEventStore();
    const [genesis] = buildChain(WORLD, 1);
    await store.append(genesis!, 0);

    const rival = nextEvent(WORLD, null, { type: "action.rival" });
    await expect(store.append(rival, 0)).rejects.toBeInstanceOf(SequenceConflictError);
  });

  it("rejects an append that would leave a hole", async () => {
    const store = new MemoryEventStore();
    const events = buildChain(WORLD, 3);
    await store.append(events[0]!, 0);
    await expect(store.append(events[2]!, 2)).rejects.toBeInstanceOf(SequenceConflictError);
  });

  it("rejects an event whose own sequence disagrees with the reservation", async () => {
    const store = new MemoryEventStore();
    const events = buildChain(WORLD, 2);
    await store.append(events[0]!, 0);
    // The caller reserved slot 1 but handed over the event stamped 0.
    await expect(store.append(events[0]!, 1)).rejects.toBeInstanceOf(SequenceConflictError);
  });

  it("rejects an event that does not chain from the head", async () => {
    const store = new MemoryEventStore();
    const events = buildChain(WORLD, 2);
    await store.append(events[0]!, 0);

    const orphan: CanonicalEvent = {
      ...events[1]!,
      prevHash: events[0]!.postStateChecksum, // a real hash, but not the head's
    };
    await expect(store.append(orphan, 1)).rejects.toBeInstanceOf(ChainIntegrityError);
  });

  // §15: "each task can commit at most once".
  it("lets exactly one of many concurrent appends at the same sequence succeed", async () => {
    const store = new MemoryEventStore();
    const [genesis] = buildChain(WORLD, 1);
    await store.append(genesis!, 0);

    const contenders = Array.from({ length: 32 }, (_, i) =>
      nextEvent(WORLD, genesis!, { type: `action.contender-${i}` }),
    );

    // Yield to the microtask queue first so the appends genuinely interleave
    // rather than running one after another in call order.
    const results = await Promise.allSettled(
      contenders.map(async (event) => {
        await Promise.resolve();
        return store.append(event, 1);
      }),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(31);
    for (const failure of rejected) {
      expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(SequenceConflictError);
    }

    expect(await store.headSequence(WORLD)).toBe(1);
    expect(await drain(store.read(WORLD, 0))).toHaveLength(2);
  });

  // §18: queued work is delivered more than once and must not duplicate history.
  it("cannot produce duplicate events from duplicate task delivery", async () => {
    const store = new MemoryEventStore();
    const claims = new MemoryIdempotencyStore();
    const committed: string[] = [];

    /** A miniature turn runner, exactly as §14 describes it. */
    async function deliverTurn(deliveryId: string): Promise<"committed" | "abandoned"> {
      const idempotencyKey = `${WORLD}:inh_alice:turn-7`;
      if (!(await claims.claim(idempotencyKey, 60))) return "abandoned";

      const head = await store.head(WORLD);
      const sequence = (await store.headSequence(WORLD)) + 1;
      const event = nextEvent(WORLD, head, { actor: "inh_alice", type: "action.move" });
      try {
        await store.append(event, sequence);
      } catch (error) {
        // Losing the race is the expected outcome of a duplicate delivery, not
        // a failure to retry.
        if (error instanceof SequenceConflictError) return "abandoned";
        throw error;
      }
      committed.push(deliveryId);
      return "committed";
    }

    const outcomes = await Promise.all([
      deliverTurn("delivery-1"),
      deliverTurn("delivery-2"),
      deliverTurn("delivery-3"),
    ]);

    expect(outcomes.filter((o) => o === "committed")).toHaveLength(1);
    expect(committed).toHaveLength(1);

    const log = await drain(store.read(WORLD, 0));
    expect(log).toHaveLength(1);
    expect(verifyChain(log, { expectedWorldId: WORLD })).toEqual([]);
  });

  it("survives duplicate delivery even when the idempotency claim is lost", async () => {
    // The claim store is an optimisation. The sequence conflict is the guarantee.
    const store = new MemoryEventStore();

    async function deliverTurn(): Promise<boolean> {
      const head = await store.head(WORLD);
      const sequence = (await store.headSequence(WORLD)) + 1;
      const event = nextEvent(WORLD, head, { actor: "inh_alice", type: "action.move" });
      try {
        await store.append(event, sequence);
        return true;
      } catch (error) {
        if (error instanceof SequenceConflictError || error instanceof ChainIntegrityError) {
          return false;
        }
        throw error;
      }
    }

    const outcomes = await Promise.all([deliverTurn(), deliverTurn(), deliverTurn(), deliverTurn()]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await store.headSequence(WORLD)).toBe(0);
  });

  it("does not extend a read that is already in flight", async () => {
    const store = new MemoryEventStore();
    const events = buildChain(WORLD, 3);
    for (const e of events) await store.append(e, e.sequence);

    const iterator = store.read(WORLD, 0)[Symbol.asyncIterator]();
    await iterator.next(); // begin iterating, fixing the range at 0..2

    const extra = nextEvent(WORLD, events[2]!);
    await store.append(extra, 3);

    const rest: CanonicalEvent[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) break;
      rest.push(step.value);
    }
    expect(rest.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it("produces a log that verifyChain accepts", async () => {
    const store = new MemoryEventStore();
    for (const event of buildChain(WORLD, 200)) await store.append(event, event.sequence);
    expect(verifyChain(await drain(store.read(WORLD, 0)), { expectedWorldId: WORLD })).toEqual([]);
  });
});
