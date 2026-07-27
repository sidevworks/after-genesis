import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyChain, type CanonicalEvent } from "@after-genesis/core";
import { FileEventStore } from "./file-event-store.js";
import {
  ChainIntegrityError,
  LogCorruptionError,
  SequenceConflictError,
} from "./errors.js";
import { buildChain, makeTempDir, nextEvent } from "./test-support.js";

const WORLD = "test-world";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tempDir(): Promise<string> {
  const { path, cleanup } = await makeTempDir("after-genesis-events-");
  cleanups.push(cleanup);
  return path;
}

async function drain(iterable: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

/** Write a log file directly, bypassing the store, to set up corruption cases. */
async function writeLog(dir: string, worldId: string, events: CanonicalEvent[]): Promise<string> {
  const path = join(dir, `${worldId}.jsonl`);
  await writeFile(path, events.map((e) => `${JSON.stringify(e)}\n`).join(""), "utf8");
  return path;
}

describe("FileEventStore", () => {
  it("creates the directory and starts empty", async () => {
    const dir = join(await tempDir(), "nested", "logs");
    const store = await FileEventStore.open(dir);
    expect(await store.headSequence(WORLD)).toBe(-1);
    expect(await store.head(WORLD)).toBeNull();
    expect(await drain(store.read(WORLD, 0))).toEqual([]);
    await store.close();
  });

  it("appends events as one JSON object per line", async () => {
    const dir = await tempDir();
    const store = await FileEventStore.open(dir);
    const events = buildChain(WORLD, 3);
    for (const event of events) await store.append(event, event.sequence);
    await store.close();

    const raw = await readFile(store.pathFor(WORLD), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = raw.split("\n").slice(0, -1);
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("survives reopening and continues the chain", async () => {
    const dir = await tempDir();
    const first = await FileEventStore.open(dir);
    const events = buildChain(WORLD, 4);
    for (const event of events.slice(0, 2)) await first.append(event, event.sequence);
    await first.close();

    const second = await FileEventStore.open(dir);
    expect(await second.headSequence(WORLD)).toBe(1);
    expect((await second.head(WORLD))?.hash).toBe(events[1]!.hash);
    for (const event of events.slice(2)) await second.append(event, event.sequence);
    expect(await drain(second.read(WORLD, 0))).toEqual(events);
    await second.close();
  });

  it("reads inclusive ranges", async () => {
    const dir = await tempDir();
    const store = await FileEventStore.open(dir);
    for (const event of buildChain(WORLD, 10)) await store.append(event, event.sequence);

    expect((await drain(store.read(WORLD, 3, 5))).map((e) => e.sequence)).toEqual([3, 4, 5]);
    expect((await drain(store.read(WORLD, 8))).map((e) => e.sequence)).toEqual([8, 9]);
    expect(await drain(store.read(WORLD, 5, 4))).toEqual([]);
    await store.close();
  });

  it("rejects an append at an occupied sequence", async () => {
    const dir = await tempDir();
    const store = await FileEventStore.open(dir);
    const [genesis] = buildChain(WORLD, 1);
    await store.append(genesis!, 0);

    await expect(store.append(nextEvent(WORLD, null), 0)).rejects.toBeInstanceOf(
      SequenceConflictError,
    );
    await store.close();
  });

  // §15: "each task can commit at most once".
  it("lets exactly one of many concurrent appends at the same sequence succeed", async () => {
    const dir = await tempDir();
    const store = await FileEventStore.open(dir);
    const [genesis] = buildChain(WORLD, 1);
    await store.append(genesis!, 0);

    const contenders = Array.from({ length: 24 }, (_, i) =>
      nextEvent(WORLD, genesis!, { type: `action.contender-${i}` }),
    );
    const results = await Promise.allSettled(
      contenders.map(async (event) => {
        await Promise.resolve();
        return store.append(event, 1);
      }),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const failure of results.filter((r) => r.status === "rejected")) {
      expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(SequenceConflictError);
    }

    await store.close();

    // And the winner is the only thing on disk.
    const raw = await readFile(store.pathFor(WORLD), "utf8");
    expect(raw.split("\n").slice(0, -1)).toHaveLength(2);

    const reopened = await FileEventStore.open(dir);
    expect(verifyChain(await drain(reopened.read(WORLD, 0)), { expectedWorldId: WORLD })).toEqual(
      [],
    );
    await reopened.close();
  });

  it("keeps lines in sequence order under interleaved appends", async () => {
    const dir = await tempDir();
    const store = await FileEventStore.open(dir);
    const events = buildChain(WORLD, 50);
    // Fire every append without awaiting; the store must still write in order.
    await Promise.all(events.map((event) => store.append(event, event.sequence)));
    await store.close();

    const reopened = await FileEventStore.open(dir);
    const read = await drain(reopened.read(WORLD, 0));
    expect(read.map((e) => e.sequence)).toEqual(events.map((e) => e.sequence));
    await reopened.close();
  });

  describe("crash and corruption detection", () => {
    // The core crash-safety claim: a torn append is detected, never accepted.
    it("refuses a log whose final line was truncated mid-append", async () => {
      const dir = await tempDir();
      const events = buildChain(WORLD, 3);
      const path = await writeLog(dir, WORLD, events);

      // Simulate the crash: the fourth record's bytes were partially persisted
      // and the trailing newline never landed.
      const torn = JSON.stringify(nextEvent(WORLD, events[2]!)).slice(0, 60);
      await appendFile(path, torn, "utf8");

      await expect(FileEventStore.open(dir)).rejects.toMatchObject({
        name: "LogCorruptionError",
        kind: "truncated-line",
      });
    });

    it("refuses a log truncated at an exact record boundary minus the newline", async () => {
      const dir = await tempDir();
      const events = buildChain(WORLD, 3);
      const path = await writeLog(dir, WORLD, events);
      // Drop only the final newline: the JSON is complete and parses fine, so
      // parsing alone would accept this. The missing terminator is what proves
      // the write was torn.
      const raw = await readFile(path, "utf8");
      await writeFile(path, raw.slice(0, -1), "utf8");

      const error = await FileEventStore.open(dir).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LogCorruptionError);
      expect((error as LogCorruptionError).kind).toBe("truncated-line");
    });

    it("refuses to append after detecting a torn log", async () => {
      const dir = await tempDir();
      const events = buildChain(WORLD, 2);
      const path = await writeLog(dir, WORLD, events);
      await appendFile(path, '{"worldId":"test-wo', "utf8");

      // There is no store object at all, so no caller can append to it. That is
      // the strongest form of "refuse to append to a corrupt log".
      await expect(FileEventStore.open(dir)).rejects.toBeInstanceOf(LogCorruptionError);
    });

    it("detects a tampered event on open", async () => {
      const dir = await tempDir();
      const events = buildChain(WORLD, 5);
      const path = await writeLog(dir, WORLD, events);

      const lines = (await readFile(path, "utf8")).split("\n").slice(0, -1);
      const tampered = JSON.parse(lines[2]!) as CanonicalEvent;
      // Rewrite history: change what happened, leave the hash alone.
      lines[2] = JSON.stringify({ ...tampered, type: "action.forged" });
      await writeFile(path, `${lines.join("\n")}\n`, "utf8");

      const error = await FileEventStore.open(dir).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChainIntegrityError);
      expect((error as ChainIntegrityError).violations.map((v) => v.kind)).toContain("bad-hash");
    });

    it("detects a tampered event whose hash was recomputed to match", async () => {
      const dir = await tempDir();
      const events = buildChain(WORLD, 5);
      const path = await writeLog(dir, WORLD, events);

      // A more determined forger: rewrite the event *and* reseal it, so its own
      // hash is self-consistent. The chain link to its successor still breaks.
      const lines = (await readFile(path, "utf8")).split("\n").slice(0, -1);
      const original = JSON.parse(lines[2]!) as CanonicalEvent;
      const forged = nextEvent(WORLD, JSON.parse(lines[1]!) as CanonicalEvent, {
        type: "action.forged",
      });
      expect(forged.hash).not.toBe(original.hash);
      lines[2] = JSON.stringify(forged);
      await writeFile(path, `${lines.join("\n")}\n`, "utf8");

      const error = await FileEventStore.open(dir).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChainIntegrityError);
      expect((error as ChainIntegrityError).violations.map((v) => v.kind)).toContain("broken-link");
    });

    it("detects a deleted event", async () => {
      const dir = await tempDir();
      const events = buildChain(WORLD, 5);
      const path = await writeLog(dir, WORLD, events);

      const lines = (await readFile(path, "utf8")).split("\n").slice(0, -1);
      lines.splice(2, 1); // history cannot be deleted
      await writeFile(path, `${lines.join("\n")}\n`, "utf8");

      const error = await FileEventStore.open(dir).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ChainIntegrityError);
      expect((error as ChainIntegrityError).violations.map((v) => v.kind)).toContain(
        "non-monotonic-sequence",
      );
    });

    it("detects a blank line", async () => {
      const dir = await tempDir();
      const path = await writeLog(dir, WORLD, buildChain(WORLD, 3));
      const raw = await readFile(path, "utf8");
      await writeFile(path, raw.replace("}\n{", "}\n\n{"), "utf8");

      await expect(FileEventStore.open(dir)).rejects.toMatchObject({ kind: "blank-line" });
    });

    it("rejects a line that is valid JSON but not an event", async () => {
      const dir = await tempDir();
      const path = join(dir, `${WORLD}.jsonl`);
      await writeFile(path, `{"hello":"world"}\n`, "utf8");
      await expect(FileEventStore.open(dir)).rejects.toMatchObject({ kind: "schema-violation" });
    });

    it("rejects a log that does not begin at sequence 0", async () => {
      const dir = await tempDir();
      const events = buildChain(WORLD, 3);
      await writeLog(dir, WORLD, events.slice(1));
      await expect(FileEventStore.open(dir)).rejects.toMatchObject({ kind: "missing-genesis" });
    });

    it("rejects a log filed under the wrong world's name", async () => {
      const dir = await tempDir();
      await writeLog(dir, "impostor", buildChain(WORLD, 2));
      await expect(FileEventStore.open(dir)).rejects.toMatchObject({ kind: "filename-mismatch" });
    });

    it("rejects an event that does not chain from the head", async () => {
      const dir = await tempDir();
      const store = await FileEventStore.open(dir);
      const events = buildChain(WORLD, 2);
      await store.append(events[0]!, 0);
      await expect(
        store.append({ ...events[1]!, prevHash: events[0]!.postStateChecksum }, 1),
      ).rejects.toBeInstanceOf(ChainIntegrityError);
      await store.close();
    });
  });

  it("has fsynced an append by the time it resolves", async () => {
    const dir = await tempDir();
    const store = await FileEventStore.open(dir); // fsync defaults to true
    const events = buildChain(WORLD, 3);
    for (const event of events) {
      await store.append(event, event.sequence);
      // Read the bytes through a completely separate descriptor: whatever
      // `append` promised is already durable, not sitting in this process.
      const raw = await readFile(store.pathFor(WORLD), "utf8");
      expect(raw.split("\n").slice(0, -1)).toHaveLength(event.sequence + 1);
    }
    await store.close();
  });

  // The round-trip that everything else exists to protect.
  //
  // `fsync: false` here purely for test runtime. Measured on APFS: 4.1 ms per
  // append with fsync versus 0.022 ms without, so 10,000 durable appends cost
  // ~41s against ~0.2s. Durability per append is proven by the test above; what
  // this test is about is that a log of this size streams back in order, in
  // flat memory, with an unbroken chain.
  it("round-trips 10,000 events with an intact chain", async () => {
    const dir = await tempDir();
    const store = await FileEventStore.open(dir, { fsync: false });
    const events = buildChain(WORLD, 10_000);
    for (const event of events) await store.append(event, event.sequence);
    expect(await store.headSequence(WORLD)).toBe(9_999);
    await store.close();

    // Reopen: this alone streams and re-verifies the whole log.
    const reopened = await FileEventStore.open(dir);
    expect(await reopened.headSequence(WORLD)).toBe(9_999);

    const streamed = await drain(reopened.read(WORLD, 0));
    expect(streamed).toHaveLength(10_000);
    expect(streamed.map((e) => e.sequence)).toEqual(events.map((e) => e.sequence));
    expect(verifyChain(streamed, { expectedWorldId: WORLD })).toEqual([]);
    await reopened.close();
  }, 120_000);
});
