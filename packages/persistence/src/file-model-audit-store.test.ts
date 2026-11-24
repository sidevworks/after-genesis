// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { HashDomain, hashValue, type ModelRequest, type ModelResponse } from "@after-genesis/core";
import { FixedClock } from "./clock.js";
import { AuditIntegrityError } from "./errors.js";
import { FileModelAuditStore, type AuditEntry } from "./file-model-audit-store.js";
import { makeTempDir } from "./test-support.js";

const WORLD = "test-world";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function makeStore(): Promise<FileModelAuditStore> {
  const { path, cleanup } = await makeTempDir("after-genesis-audit-");
  cleanups.push(cleanup);
  return FileModelAuditStore.open(path, { clock: new FixedClock() });
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    modelId: "gemini-2.5-flash-lite",
    systemPrompt: "You are an inhabitant of a world.",
    userPrompt: "It is morning. What do you do?",
    maxOutputTokens: 512,
    // A float: legitimate in an audit record, and the reason these are hashed
    // with a permissive stable encoder rather than canonicalJson.
    temperature: 0.7,
    ...overrides,
  };
}

function response(overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    rawText: '{"action":"move","to":{"x":3,"y":4}}',
    modelId: "gemini-2.5-flash-lite",
    inputTokens: 820,
    outputTokens: 31,
    finishReason: "stop",
    ...overrides,
  };
}

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  const req = overrides.request ?? request();
  const res = overrides.response === undefined ? response() : overrides.response;
  return {
    worldId: WORLD,
    sequence: 42,
    request: req,
    requestHash: hashValue(HashDomain.ModelRequest, { p: req.userPrompt }),
    response: res,
    responseHash: res === null ? null : hashValue(HashDomain.ModelResponse, { t: res.rawText }),
    costMicros: 137,
    ...overrides,
  };
}

describe("FileModelAuditStore", () => {
  it("returns null for a sequence with no record", async () => {
    const store = await makeStore();
    expect(await store.get(WORLD, 42)).toBeNull();
    expect(await store.getEntry(WORLD, 42)).toBeNull();
  });

  // This is what makes replay possible without calling a live model (§16).
  it("records a request and response and serves the response back", async () => {
    const store = await makeStore();
    await store.record(entry());

    expect(await store.get(WORLD, 42)).toEqual({
      rawText: '{"action":"move","to":{"x":3,"y":4}}',
      modelId: "gemini-2.5-flash-lite",
    });

    const stored = await store.getEntry(WORLD, 42);
    expect(stored?.request.systemPrompt).toBe("You are an inhabitant of a world.");
    expect(stored?.request.temperature).toBe(0.7);
    expect(stored?.costMicros).toBe(137);
  });

  it("stores the raw response text untouched", async () => {
    const store = await makeStore();
    const messy = '  ```json\n{"action":"speak"}\n```   trailing\n';
    await store.record(entry({ response: response({ rawText: messy }) }));
    expect((await store.get(WORLD, 42))?.rawText).toBe(messy);
  });

  it("keeps worlds and sequences separate", async () => {
    const store = await makeStore();
    await store.record(entry({ sequence: 1 }));
    await store.record(entry({ sequence: 2, worldId: "other-world" }));

    expect(await store.get(WORLD, 1)).not.toBeNull();
    expect(await store.get(WORLD, 2)).toBeNull();
    expect(await store.get("other-world", 2)).not.toBeNull();
    expect(await store.sequences(WORLD)).toEqual([1]);
  });

  it("stores format-correction attempts independently within one turn", async () => {
    const store = await makeStore();
    await store.record(entry({ attempt: 1 }));
    await store.record(
      entry({
        attempt: 2,
        request: request({ userPrompt: "Correct the previous response." }),
        requestHash: hashValue(HashDomain.ModelRequest, { p: "correction" }),
        response: response({ rawText: '{"type":"wait","payload":{}}' }),
      }),
    );

    expect((await store.get(WORLD, 42, 1))?.rawText).toContain('"action":"move"');
    expect((await store.get(WORLD, 42, 2))?.rawText).toContain('"type":"wait"');
    expect(store.pathFor(WORLD, 42, 2)).toContain("000000000042-a02.json");
  });

  it("lists sequences in numeric order", async () => {
    const store = await makeStore();
    for (const sequence of [7, 1, 100, 22]) await store.record(entry({ sequence }));
    expect(await store.sequences(WORLD)).toEqual([1, 7, 22, 100]);
  });

  describe("write-once integrity", () => {
    // The audit-integrity violation the spec calls out by name.
    it("refuses to record a different response for a sequence that already has one", async () => {
      const store = await makeStore();
      await store.record(entry());

      const forged = entry({ response: response({ rawText: '{"action":"steal"}' }) });
      await expect(store.record(forged)).rejects.toBeInstanceOf(AuditIntegrityError);

      // And nothing changed.
      expect((await store.get(WORLD, 42))?.rawText).toBe('{"action":"move","to":{"x":3,"y":4}}');
    });

    it("refuses to erase a recorded response", async () => {
      const store = await makeStore();
      await store.record(entry());
      await expect(store.record(entry({ response: null, responseHash: null }))).rejects.toBeInstanceOf(
        AuditIntegrityError,
      );
      expect(await store.get(WORLD, 42)).not.toBeNull();
    });

    it("refuses to record a different request for a sequence that already has one", async () => {
      const store = await makeStore();
      await store.record(entry());

      const differentPrompt = request({ userPrompt: "It is night. What do you do?" });
      await expect(
        store.record(entry({ request: differentPrompt, requestHash: hashValue(HashDomain.ModelRequest, { p: differentPrompt.userPrompt }) })),
      ).rejects.toBeInstanceOf(AuditIntegrityError);
    });

    it("refuses a metadata-only edit", async () => {
      const store = await makeStore();
      await store.record(entry({ response: null, responseHash: null }));
      // Same request, still no response, but a different cost. Audit records are
      // not editable, so this is refused rather than quietly rewritten.
      await expect(
        store.record(entry({ response: null, responseHash: null, costMicros: 999 })),
      ).rejects.toBeInstanceOf(AuditIntegrityError);
    });

    // §18: queued work is delivered more than once.
    it("is idempotent for an identical re-record", async () => {
      const store = await makeStore();
      await store.record(entry());
      await expect(store.record(entry())).resolves.toBeUndefined();
      await expect(store.record(entry())).resolves.toBeUndefined();
      expect(await store.sequences(WORLD)).toEqual([42]);
    });

    it("treats an omitted responseSchema and an explicit undefined as the same record", async () => {
      const store = await makeStore();
      await store.record(entry());
      // `exactOptionalPropertyTypes` keeps these apart in the type system; the
      // digest must not be able to tell them apart, or duplicate delivery would
      // look like tampering.
      await expect(
        store.record(entry({ request: { ...request(), responseSchema: undefined } })),
      ).resolves.toBeUndefined();
    });

    // §14.6 stores the request before the model is called; §14.8 stores the raw
    // response after. Exactly one such promotion is allowed.
    it("allows request-only to be promoted to request-and-response, once", async () => {
      const store = await makeStore();
      await store.record(entry({ response: null, responseHash: null }));
      expect(await store.get(WORLD, 42)).toBeNull();
      expect(await store.getEntry(WORLD, 42)).not.toBeNull();

      await store.record(entry());
      expect((await store.get(WORLD, 42))?.rawText).toBe('{"action":"move","to":{"x":3,"y":4}}');

      // The slot is now closed.
      await expect(
        store.record(entry({ response: response({ rawText: "second thoughts" }) })),
      ).rejects.toBeInstanceOf(AuditIntegrityError);
    });

    it("lets exactly one of many concurrent conflicting records win", async () => {
      const store = await makeStore();
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, async (_, i) => {
          await Promise.resolve();
          return store.record(entry({ response: response({ rawText: `{"attempt":${i}}` }) }));
        }),
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const failure of results.filter((r) => r.status === "rejected")) {
        expect((failure as PromiseRejectedResult).reason).toBeInstanceOf(AuditIntegrityError);
      }

      const stored = await store.get(WORLD, 42);
      expect(stored?.rawText).toMatch(/^\{"attempt":\d\}$/);
    });

    it("is idempotent under concurrent identical delivery", async () => {
      const store = await makeStore();
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, async () => {
          await Promise.resolve();
          return store.record(entry());
        }),
      );
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
      expect(await store.sequences(WORLD)).toEqual([42]);
    });
  });

  describe("on-disk form", () => {
    it("writes one padded, sequence-ordered file per entry", async () => {
      const store = await makeStore();
      await store.record(entry({ sequence: 42 }));
      const path = store.pathFor(WORLD, 42);
      expect(path.endsWith("000000000042.json")).toBe(true);

      const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      expect(raw["sequence"]).toBe(42);
      expect(raw["recordedAt"]).toBe("2026-01-01T00:00:00.000Z");
      expect(typeof raw["entryDigest"]).toBe("string");
    });

    it("refuses a sequence too large for the file name", async () => {
      const store = await makeStore();
      await expect(store.record(entry({ sequence: 1e13 }))).rejects.toBeInstanceOf(RangeError);
      await expect(store.record(entry({ sequence: -1 }))).rejects.toBeInstanceOf(RangeError);
    });
  });
});
