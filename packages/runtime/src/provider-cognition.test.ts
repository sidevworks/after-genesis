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
      sex: "female",
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

function neutralResponse(
  capability: "wait" | "observe" = "wait",
  parameters: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    attempt: {
      capability,
      target_ids: [],
      parameters,
      requested_duration_ticks: 1,
      message: null,
    },
    decision_record: {
      priority_now: "test the next local change",
      basis_ids: [],
      basis_summary: "bounded test response",
      expected_local_change: "one engine resolution",
      success_test: "the engine records an outcome",
      uncertainties: [],
    },
    future_note: null,
  });
}

describe("ProviderCognitionService", () => {
  it("does not expose named civilisational outcomes or their engine requirements", async () => {
    const captured = audit();
    const cognition = service(
      new ScriptedProvider([neutralResponse()]),
      captured.store,
    );

    await cognition.propose({
      state: state(),
      actorId: "inh_founder",
      simTime: 0 as never,
      sequence: 1,
    });

    const prompt = captured.records[0]?.request.systemPrompt ?? "";
    expect(prompt).toContain("NEUTRAL CAPABILITIES");
    expect(prompt).not.toContain("create_inhabitant");
    expect(prompt).not.toContain("create_currency");
    expect(prompt).not.toContain("create_organisation");
  });

  it("shows mechanical parameters without assigning a survival objective", async () => {
    const captured = audit();
    const cognition = service(
      new ScriptedProvider([neutralResponse()]),
      captured.store,
    );

    await cognition.propose({
      state: state(),
      actorId: "inh_founder",
      simTime: 0 as never,
      sequence: 1,
    });

    const prompt = captured.records[0]?.request.systemPrompt ?? "";
    expect(prompt).toContain('- move: parameters must contain {"to"');
    expect(prompt).toContain('- use: parameters must contain {"resource":"food"|"water"');
    expect(prompt).toContain("No civilisational, social, creative, reproductive or survival outcome");
  });

  it("turns a provider response into an audited structured proposal", async () => {
    const captured = audit();
    const cognition = service(
      new ScriptedProvider([
        {
          rawText: neutralResponse(),
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
    const provider = new ScriptedProvider([neutralResponse()]);
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
          rawText: neutralResponse(),
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
        rawText: neutralResponse(),
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

/* ------------------------------------------------------------------------- */
/* Model routing by cognition level (§3, §11B)                                */
/* ------------------------------------------------------------------------- */

const DELIBERATE_PRICE: PriceTable = {
  modelId: "deliberate-model",
  inputMicrosPerMillionTokens: 300_000,
  outputMicrosPerMillionTokens: 1_200_000,
  verifiedOn: "1970-01-01",
};

function routedService(provider: ScriptedProvider, store: ModelAuditStore) {
  return new ProviderCognitionService({
    provider,
    audit: store,
    modelId: "test-model",
    deliberateModelId: "deliberate-model",
    prices: [PRICE, DELIBERATE_PRICE],
    limits: { dailyMicros: 1_000_000, totalMicros: 1_000_000 },
    dayKey: "2026-07-28",
  });
}

/** The model id actually put on the request, as recorded in the audit store. */
async function requestedModel(level: "deliberate" | "routine"): Promise<string> {
  const captured = audit();
  const cognition = routedService(
    new ScriptedProvider([
      { rawText: neutralResponse("observe"), modelId: "whatever-responded" },
    ]),
    captured.store,
  );
  const base = state();
  const world =
    level === "deliberate"
      ? base
      : {
          ...base,
          inhabitants: {
            ...base.inhabitants,
            inh_founder: {
              ...base.inhabitants["inh_founder"]!,
              needs: { ...base.inhabitants["inh_founder"]!.needs, thirst: 70 },
            },
          },
        };
  await cognition.propose({
    state: world,
    actorId: "inh_founder",
    simTime: 0 as never,
    sequence: 1,
  });
  return captured.records[0]?.request.modelId ?? "(none)";
}

describe("cognition level selects the model", () => {
  it("sends a calm turn to the deliberate planning model", async () => {
    expect(await requestedModel("deliberate")).toBe("deliberate-model");
  });

  it("sends a pressed turn to the routine model", async () => {
    expect(await requestedModel("routine")).toBe("test-model");
  });

  it("uses one model for every level when no deliberate model is configured", async () => {
    const captured = audit();
    const cognition = service(
      new ScriptedProvider([
        { rawText: neutralResponse("observe"), modelId: "whatever-responded" },
      ]),
      captured.store,
    );
    await cognition.propose({
      state: state(),
      actorId: "inh_founder",
      simTime: 0 as never,
      sequence: 1,
    });
    expect(captured.records[0]?.request.modelId).toBe("test-model");
  });

  it("rejects an empty deliberate model rather than silently ignoring it", () => {
    expect(
      () =>
        new ProviderCognitionService({
          provider: new ScriptedProvider([]),
          audit: audit().store,
          modelId: "test-model",
          deliberateModelId: "   ",
          prices: [PRICE],
          limits: { dailyMicros: 1, totalMicros: 1 },
          dayKey: "2026-07-28",
        }),
    ).toThrow(/deliberateModelId/);
  });
});
