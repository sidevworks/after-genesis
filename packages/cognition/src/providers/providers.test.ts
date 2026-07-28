/**
 * Provider tests.
 *
 * NO TEST IN THIS FILE MAKES A NETWORK CALL. `fetch` is injected, and the
 * suite installs a global `fetch` that throws, so a provider that reached for
 * the real one would fail loudly rather than quietly contacting Google from CI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelAuditStore, ModelRequest } from "@after-genesis/core";
import { GeminiProvider, geminiFromEnv, resolveModelRouting } from "./gemini.js";
import { ReplayProvider } from "./replay.js";
import { ScriptedProvider, scriptAction } from "./scripted.js";
import {
  MissingRecordedResponseError,
  ModelProviderError,
  ReplayCursorError,
  ScriptedProviderExhaustedError,
} from "./errors.js";

const request: ModelRequest = {
  modelId: "test-model",
  systemPrompt: "system",
  userPrompt: "user",
  maxOutputTokens: 256,
  temperature: 0,
};

/**
 * Global fetch is replaced with a landmine for the whole suite.
 *
 * This is the actual assertion behind "no test may make a real network call":
 * not that we remembered to inject a stub everywhere, but that forgetting to is
 * a test failure.
 */
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("A test attempted a real network call.");
  }) as unknown as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------

describe("ScriptedProvider", () => {
  it("returns responses in order", async () => {
    const provider = new ScriptedProvider([
      scriptAction("wait"),
      scriptAction("gather", { resource: "wood" }),
    ]);
    expect((await provider.generate(request)).rawText).toBe(scriptAction("wait"));
    expect((await provider.generate(request)).rawText).toBe(
      scriptAction("gather", { resource: "wood" }),
    );
  });

  it("records every request it received", async () => {
    const provider = new ScriptedProvider(["a", "b"]);
    await provider.generate(request);
    await provider.generate({ ...request, userPrompt: "second" });
    expect(provider.callCount).toBe(2);
    expect(provider.calls[1]?.userPrompt).toBe("second");
  });

  it("defaults the model id to the requested one, keeping audit records coherent", async () => {
    const provider = new ScriptedProvider(["{}"]);
    expect((await provider.generate(request)).modelId).toBe("test-model");
  });

  it("honours an explicit model id and token counts", async () => {
    const provider = new ScriptedProvider([
      { rawText: "{}", modelId: "other", inputTokens: 11, outputTokens: 7, finishReason: "stop" },
    ]);
    const response = await provider.generate(request);
    expect(response).toMatchObject({ modelId: "other", inputTokens: 11, outputTokens: 7 });
  });

  it("throws rather than inventing a response when exhausted", async () => {
    const provider = new ScriptedProvider(["only one"]);
    await provider.generate(request);
    await expect(provider.generate(request)).rejects.toBeInstanceOf(
      ScriptedProviderExhaustedError,
    );
  });

  it("can repeat its last response for long mechanical soak runs", async () => {
    const provider = new ScriptedProvider([scriptAction("wait")], {
      onExhausted: "repeat_last",
    });
    for (let i = 0; i < 1_000; i++) {
      expect((await provider.generate(request)).rawText).toBe(scriptAction("wait"));
    }
  });

  it("can simulate provider unavailability", async () => {
    const boom = new Error("upstream down");
    const provider = new ScriptedProvider([{ rawText: "", throws: boom }]);
    await expect(provider.generate(request)).rejects.toBe(boom);
  });

  it("is deterministic across identical runs", async () => {
    const script = [scriptAction("wait"), scriptAction("rest"), "garbage"];
    const runOne = new ScriptedProvider(script);
    const runTwo = new ScriptedProvider(script);
    for (let i = 0; i < script.length; i++) {
      expect((await runOne.generate(request)).rawText).toBe(
        (await runTwo.generate(request)).rawText,
      );
    }
  });
});

// ---------------------------------------------------------------------------

/** An in-memory audit store. Implements only what ReplayProvider uses. */
function makeAuditStore(
  recorded: ReadonlyMap<number, { rawText: string; modelId: string }>,
): ModelAuditStore {
  return {
    record: async () => undefined,
    get: async (_worldId, sequence, attempt = 1) =>
      attempt === 1 ? recorded.get(sequence) ?? null : null,
  };
}

describe("ReplayProvider", () => {
  const recorded = new Map([
    [10, { rawText: scriptAction("wait"), modelId: "test-model" }],
    [11, { rawText: scriptAction("rest"), modelId: "test-model" }],
  ]);

  it("serves the recorded response for the sought sequence", async () => {
    const provider = new ReplayProvider({ audit: makeAuditStore(recorded), worldId: "w" });
    provider.seek(11);
    const response = await provider.generate(request);
    expect(response.rawText).toBe(scriptAction("rest"));
    expect(response.finishReason).toBe("replayed");
  });

  it("THROWS on a missing recorded response rather than calling live", async () => {
    // The central guarantee of this class. A fallback to a live model would mint
    // a response that was never part of history and let the audit chain attest
    // to it (§16).
    const provider = new ReplayProvider({ audit: makeAuditStore(recorded), worldId: "w" });
    provider.seek(99);
    await expect(provider.generate(request)).rejects.toBeInstanceOf(
      MissingRecordedResponseError,
    );
  });

  it("does not fall back even when a live provider would be available", async () => {
    // Global fetch is a landmine for this suite, so if ReplayProvider ever grew
    // a network fallback this would surface as "attempted a real network call"
    // rather than as a silent success.
    const provider = new ReplayProvider({ audit: makeAuditStore(new Map()), worldId: "w" });
    provider.seek(0);
    await expect(provider.generate(request)).rejects.toBeInstanceOf(
      MissingRecordedResponseError,
    );
  });

  it("refuses to generate without a cursor", async () => {
    const provider = new ReplayProvider({ audit: makeAuditStore(recorded), worldId: "w" });
    await expect(provider.generate(request)).rejects.toBeInstanceOf(ReplayCursorError);
  });

  it("does not re-serve attempt one as a correction response", async () => {
    // Guards the off-by-one that would answer sequence N with N-1's response and
    // produce a plausible, wrong, fully hash-chained history.
    const provider = new ReplayProvider({ audit: makeAuditStore(recorded), worldId: "w" });
    provider.seek(10);
    await provider.generate(request);
    await expect(provider.generate(request)).rejects.toBeInstanceOf(
      MissingRecordedResponseError,
    );
  });

  it("refuses a recorded response from a different model", async () => {
    const provider = new ReplayProvider({
      audit: makeAuditStore(new Map([[5, { rawText: "{}", modelId: "some-other-model" }]])),
      worldId: "w",
    });
    provider.seek(5);
    await expect(provider.generate(request)).rejects.toBeInstanceOf(ModelProviderError);
  });

  it("can be told to accept a different model id", async () => {
    const provider = new ReplayProvider({
      audit: makeAuditStore(new Map([[5, { rawText: "{}", modelId: "other" }]])),
      worldId: "w",
      enforceModelIdMatch: false,
    });
    provider.seek(5);
    expect((await provider.generate(request)).modelId).toBe("other");
  });

  it("detects a prompt that no longer matches the recorded request hash", async () => {
    const provider = new ReplayProvider({
      audit: makeAuditStore(recorded),
      worldId: "w",
      verifyRequestHash: true,
    });
    provider.seek({ sequence: 10, expectRequestHash: "0".repeat(64) });
    await expect(provider.generate(request)).rejects.toBeInstanceOf(ModelProviderError);
  });

  it("reports nothing spent, so a replay cannot double-charge a ceiling", async () => {
    const provider = new ReplayProvider({ audit: makeAuditStore(recorded), worldId: "w" });
    provider.seek(10);
    const response = await provider.generate(request);
    expect(response.inputTokens).toBe(0);
    expect(response.outputTokens).toBe(0);
  });

  it("counts what it served", async () => {
    const provider = new ReplayProvider({ audit: makeAuditStore(recorded), worldId: "w" });
    provider.seek(10);
    await provider.generate(request);
    provider.seek(11);
    await provider.generate(request);
    expect(provider.servedCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------

/** Build a fake `Response`-alike sufficient for the provider. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const geminiOk = {
  candidates: [{ content: { parts: [{ text: '{"type":"wait","payload":{}}' }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 18 },
  modelVersion: "test-model-001",
};

describe("GeminiProvider", () => {
  it("sends the key in a header, never in the URL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, geminiOk));
    const provider = new GeminiProvider({ apiKey: "SECRET_KEY", fetchImpl });
    await provider.generate(request);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // A key in a query string ends up in proxy logs and error messages.
    expect(url).not.toContain("SECRET_KEY");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("SECRET_KEY");
  });

  it("puts the configured model id in the path, not a hardcoded one", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, geminiOk));
    const provider = new GeminiProvider({ apiKey: "k", fetchImpl });
    await provider.generate({ ...request, modelId: "some-future-model-42" });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain("some-future-model-42");
  });

  it("omits deprecated sampling parameters for Gemini 3.5+ models", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, geminiOk));
    const provider = new GeminiProvider({ apiKey: "k", fetchImpl });
    await provider.generate({
      ...request,
      modelId: "gemini-3.5-flash-lite",
      temperature: 0.7,
      responseSchema: { type: "object" },
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      generationConfig: Record<string, unknown>;
    };
    expect(body.generationConfig).not.toHaveProperty("temperature");
    expect(body.generationConfig["responseMimeType"]).toBe("application/json");
    expect(body.generationConfig).toHaveProperty("responseJsonSchema");
    expect(body.generationConfig).not.toHaveProperty("responseSchema");
  });

  it("records the version the provider actually used (§3)", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse(200, geminiOk),
    });
    const response = await provider.generate(request);
    // The requested id was an alias; the concrete build is what thought.
    expect(response.modelId).toBe("test-model-001");
    expect(response.inputTokens).toBe(120);
    expect(response.outputTokens).toBe(18);
  });

  it("never leaks the key through JSON serialisation", () => {
    const provider = new GeminiProvider({ apiKey: "SECRET_KEY", fetchImpl: async () => jsonResponse(200, {}) });
    expect(JSON.stringify(provider)).not.toContain("SECRET_KEY");
    expect(Object.keys(provider)).not.toContain("apiKey");
  });

  it("retries a 429 with exponential backoff and then succeeds", async () => {
    const sleeps: number[] = [];
    let call = 0;
    const provider = new GeminiProvider({
      apiKey: "k",
      backoffBaseMs: 100,
      fetchImpl: async () => {
        call += 1;
        return call < 3 ? jsonResponse(429, {}) : jsonResponse(200, geminiOk);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const response = await provider.generate(request);
    expect(response.rawText).toContain('"wait"');
    expect(sleeps).toEqual([100, 200]);
  });

  it("retries a 503", async () => {
    let call = 0;
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () => {
        call += 1;
        return call === 1 ? jsonResponse(503, {}) : jsonResponse(200, geminiOk);
      },
      sleep: async () => undefined,
    });
    await expect(provider.generate(request)).resolves.toBeDefined();
    expect(call).toBe(2);
  });

  it("gives up after maxAttempts and reports a retryable error", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      maxAttempts: 3,
      fetchImpl: async () => jsonResponse(500, {}),
      sleep: async () => undefined,
    });
    const error = await provider.generate(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelProviderError);
    const typed = error as ModelProviderError;
    expect(typed.kind).toBe("server_error");
    // §14: the scheduler must reschedule rather than resolve the turn.
    expect(typed.retryable).toBe(true);
    expect(typed.detail.attempts).toBe(3);
  });

  it("does not retry a 400", async () => {
    let calls = 0;
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(400, {});
      },
      sleep: async () => undefined,
    });
    const error = (await provider.generate(request).catch((e: unknown) => e)) as ModelProviderError;
    expect(calls).toBe(1);
    expect(error.kind).toBe("client_error");
    expect(error.retryable).toBe(false);
  });

  it("surfaces a timeout as a retryable error", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      timeoutMs: 5,
      maxAttempts: 1,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
      sleep: async () => undefined,
    });
    const error = (await provider.generate(request).catch((e: unknown) => e)) as ModelProviderError;
    expect(error.kind).toBe("timeout");
    expect(error.retryable).toBe(true);
  });

  it("never includes the key in an error message", async () => {
    const provider = new GeminiProvider({
      apiKey: "SECRET_KEY",
      maxAttempts: 1,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED with header x-goog-api-key: SECRET_KEY");
      },
      sleep: async () => undefined,
    });
    const error = (await provider.generate(request).catch((e: unknown) => e)) as ModelProviderError;
    // The cause's message is deliberately not interpolated: fetch errors
    // sometimes quote the request, and the request carries the key header.
    expect(error.message).not.toContain("SECRET_KEY");
    expect(JSON.stringify(error.detail)).not.toContain("SECRET_KEY");
  });

  it("raises a distinct error when the prompt is safety-blocked", async () => {
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse(200, { promptFeedback: { blockReason: "SAFETY" } }),
    });
    const error = (await provider.generate(request).catch((e: unknown) => e)) as ModelProviderError;
    // A block is not the inhabitant deciding to do nothing, so it must not
    // become a no-op.
    expect(error.kind).toBe("blocked");
  });

  it("returns an empty completion rather than throwing", async () => {
    // An empty answer IS an answer. parse.ts turns it into a no-op after one
    // correction (§14.11); throwing here would reschedule the turn forever.
    const provider = new GeminiProvider({
      apiKey: "k",
      fetchImpl: async () => jsonResponse(200, { candidates: [{ content: { parts: [] } }] }),
    });
    const response = await provider.generate(request);
    expect(response.rawText).toBe("");
  });

  it("refuses to construct with an empty key", () => {
    expect(() => new GeminiProvider({ apiKey: "  " })).toThrow(ModelProviderError);
  });
});

describe("configuration (§3: model ids are never hardcoded)", () => {
  it("resolves both routing ids from the environment", () => {
    expect(
      resolveModelRouting({ AG_MODEL_ROUTINE: "a", AG_MODEL_DELIBERATE: "b" }),
    ).toEqual({ routine: "a", deliberate: "b" });
  });

  it("refuses to start without AG_MODEL_ROUTINE", () => {
    expect(() => resolveModelRouting({ AG_MODEL_DELIBERATE: "b" })).toThrow(ModelProviderError);
  });

  it("refuses to start without AG_MODEL_DELIBERATE", () => {
    expect(() => resolveModelRouting({ AG_MODEL_ROUTINE: "a" })).toThrow(ModelProviderError);
  });

  it("refuses to build a provider without GEMINI_API_KEY", () => {
    expect(() => geminiFromEnv({})).toThrow(ModelProviderError);
    expect(() => geminiFromEnv({ GEMINI_API_KEY: "" })).toThrow(ModelProviderError);
  });

  it("contains no hardcoded model identifier", async () => {
    // The spec names "Gemini 3.5 Flash-Lite" and "3.6 Flash" but permits an
    // equivalent replacement, which makes the id pure configuration. If a
    // literal ever appears in the source this fails.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./gemini.ts", import.meta.url), "utf8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(codeOnly).not.toMatch(/["'`]gemini-[\w.-]+["'`]/);
  });
});
