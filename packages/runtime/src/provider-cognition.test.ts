import {
  SpendLimitExceededError,
  buildGenesis,
  type ModelAuditStore,
  type SpendReservationStore,
} from "@after-genesis/core";
import {
  ModelProviderError,
  ScriptedProvider,
  type PriceTable,
} from "@after-genesis/cognition";
import { describe, expect, it, vi } from "vitest";
import { ModelUnavailableError } from "./turn.js";
import { ProviderCognitionService } from "./provider-cognition.js";

const PRICE: PriceTable = {
  modelId: "test-model",
  inputMicrosPerMillionTokens: 100_000,
  outputMicrosPerMillionTokens: 400_000,
  verifiedOn: "1970-01-01",
};

function state() {
  return buildGenesis({
    worldId: "world_provider_test",
    seed: "provider-test-seed",
    width: 8,
    height: 8,
    founder: {
      id: "inh_founder",
      displayName: "Aster",
      modelId: "test-model",
      inventory: { energy: 800, compute: 500, food: 10, water: 10 },
      traits: { curiosity: 80 },
      values: ["learn carefully"],
      privateGoals: ["observe nearby terrain"],
    },
  }).state;
}

function audit() {
  const records: Parameters<ModelAuditStore["record"]>[0][] = [];
  const store: ModelAuditStore = {
    async record(entry) {
      const index = records.findIndex(
        (item) =>
          item.worldId === entry.worldId &&
          item.sequence === entry.sequence &&
          (item.attempt ?? 1) === (entry.attempt ?? 1),
      );
      if (index === -1) records.push(entry);
      else records[index] = entry;
    },
    async get(worldId, sequence, attempt = 1) {
      const found = records.find(
        (entry) =>
          entry.worldId === worldId &&
          entry.sequence === sequence &&
          (entry.attempt ?? 1) === attempt,
      );
      return found?.response === null || found?.response === undefined
        ? null
        : { rawText: found.response.rawText, modelId: found.response.modelId };
    },
  };
  return { store, records };
}

function service(
  provider: ScriptedProvider,
  store: ModelAuditStore,
  totalMicros = 1_000_000,
  durableSpend?: SpendReservationStore,
) {
  return new ProviderCognitionService({
    provider,
    audit: store,
    modelId: "test-model",
    prices: [PRICE],
    limits: { dailyMicros: totalMicros, totalMicros },
    dayKey: "2026-07-28",
    ...(durableSpend === undefined ? {} : { durableSpend }),
  });
}

function durableSpend() {
  const reserve = vi.fn<SpendReservationStore["reserve"]>(async () => ({
    status: "reserved",
  }));
  const settle = vi.fn<SpendReservationStore["settle"]>(async () => undefined);
  const release = vi.fn<SpendReservationStore["release"]>(async () => undefined);
  return { store: { reserve, settle, release }, reserve, settle, release };
}

describe("ProviderCognitionService", () => {
  it("turns a provider response into an audited structured proposal", async () => {
    const captured = audit();
    const cognition = service(
      new ScriptedProvider([
        {
          rawText: '{"type":"wait","payload":{"durationMinutes":30}}',
          modelId: "test-model-001",
          inputTokens: 100,
          outputTokens: 10,
        },
      ]),
      captured.store,
    );
    const result = await cognition.propose({
      state: state(),
      actorId: "inh_founder",
      simTime: 0 as never,
      sequence: 1,
    });

    expect(result.action?.type).toBe("wait");
    expect(result.modelId).toBe("test-model-001");
    expect(result.requestHash).not.toBeNull();
    expect(result.responseHash).not.toBeNull();
    expect(captured.records).toHaveLength(1);
    expect(captured.records[0]?.attempt).toBe(1);
  });

  it("audits both invalid attempts and returns a canonical no-op", async () => {
    const captured = audit();
    const cognition = service(
      new ScriptedProvider(["not json", "still not json"]),
      captured.store,
    );
    const result = await cognition.propose({
      state: state(),
      actorId: "inh_founder",
      simTime: 0 as never,
      sequence: 1,
    });

    expect(result.action).toBeNull();
    expect(result.noopReason).toContain("Two invalid responses");
    expect(captured.records.map((entry) => entry.attempt)).toEqual([1, 2]);
  });

  it("translates retryable provider failure into a deferred-turn error", async () => {
    const captured = audit();
    const cognition = service(
      new ScriptedProvider([
        {
          rawText: "",
          throws: new ModelProviderError("server_error", "temporarily unavailable", {
            provider: "test",
            modelId: "test-model",
            attempts: 1,
          }),
        },
      ]),
      captured.store,
    );
    await expect(
      cognition.propose({
        state: state(),
        actorId: "inh_founder",
        simTime: 0 as never,
        sequence: 1,
      }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(captured.records).toHaveLength(1);
    expect(captured.records[0]?.response).toBeNull();
  });

  it("refuses a request before provider contact when the spend ceiling is too low", async () => {
    const captured = audit();
    const provider = new ScriptedProvider(['{"type":"wait","payload":{}}']);
    const cognition = service(provider, captured.store, 0);
    await expect(
      cognition.propose({
        state: state(),
        actorId: "inh_founder",
        simTime: 0 as never,
        sequence: 1,
      }),
    ).rejects.toBeInstanceOf(SpendLimitExceededError);
    expect(provider.callCount).toBe(0);
    expect(captured.records).toHaveLength(0);
  });

  it("durably reserves before inference and settles the actual charge", async () => {
    const captured = audit();
    const durable = durableSpend();
    const cognition = service(
      new ScriptedProvider([
        {
          rawText: '{"type":"wait","payload":{}}',
          modelId: "test-model",
          inputTokens: 100,
          outputTokens: 10,
        },
      ]),
      captured.store,
      1_000_000,
      durable.store,
    );

    await cognition.propose({
      state: state(),
      actorId: "inh_founder",
      simTime: 0 as never,
      sequence: 1,
    });

    expect(durable.reserve).toHaveBeenCalledTimes(1);
    expect(durable.settle).toHaveBeenCalledTimes(1);
    expect(durable.release).not.toHaveBeenCalled();
    expect(durable.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      durable.settle.mock.invocationCallOrder[0]!,
    );
  });

  it("releases durable pre-authorisation when the provider gives no response", async () => {
    const captured = audit();
    const durable = durableSpend();
    const cognition = service(
      new ScriptedProvider([
        {
          rawText: "",
          throws: new ModelProviderError("server_error", "outage", {
            provider: "test",
            modelId: "test-model",
            attempts: 1,
          }),
        },
      ]),
      captured.store,
      1_000_000,
      durable.store,
    );

    await expect(
      cognition.propose({
        state: state(),
        actorId: "inh_founder",
        simTime: 0 as never,
        sequence: 1,
      }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(durable.reserve).toHaveBeenCalledTimes(1);
    expect(durable.release).toHaveBeenCalledTimes(1);
    expect(durable.settle).not.toHaveBeenCalled();
  });

  it("replays the recorded response after a crash that already settled spend", async () => {
    const captured = audit();
    captured.records.push({
      worldId: "world_provider_test",
      sequence: 1,
      attempt: 1,
      request: {
        modelId: "test-model",
        systemPrompt: "recorded",
        userPrompt: "recorded",
        maxOutputTokens: 1,
        temperature: 0,
      },
      requestHash: "a".repeat(64) as never,
      response: {
        rawText: '{"type":"wait","payload":{}}',
        modelId: "test-model-recorded",
        inputTokens: 100,
        outputTokens: 10,
        finishReason: "stop",
      },
      responseHash: "b".repeat(64) as never,
      costMicros: 42,
    });
    const durable = durableSpend();
    durable.reserve.mockResolvedValueOnce({ status: "settled", actualMicros: 42 });
    const provider = new ScriptedProvider([]);
    const cognition = service(
      provider,
      captured.store,
      1_000_000,
      durable.store,
    );

    const result = await cognition.propose({
      state: state(),
      actorId: "inh_founder",
      simTime: 0 as never,
      sequence: 1,
    });

    expect(result.action?.type).toBe("wait");
    expect(result.costMicros).toBe(42);
    expect(provider.callCount).toBe(0);
    expect(durable.settle).not.toHaveBeenCalled();
  });
});
