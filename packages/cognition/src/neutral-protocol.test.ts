import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, buildGenesis, getActionSpec, runAction, simTime } from "@after-genesis/core";
import {
  NEUTRAL_CAPABILITIES,
  parseNeutralModelResponse,
} from "./neutral-protocol.js";

function response(
  capability: (typeof NEUTRAL_CAPABILITIES)[number],
  parameters: Record<string, unknown>,
  basisIds: readonly string[] = [],
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
      priority_now: "change something I can inspect",
      basis_ids: basisIds,
      basis_summary: "the current packet is my only basis",
      expected_local_change: "my position changes",
      success_test: "the next packet reports a different position",
      uncertainties: [],
    },
    future_note: {
      kind: "question",
      text: "Did the attempted change occur?",
    },
  });
}

function visibleTargets(...ids: readonly string[]): Set<string> {
  const basis = new Set<string>();
  for (const id of ids) {
    if (id.startsWith("str_")) basis.add(`observed:structure:${id}`);
    else basis.add(`observed:inhabitant:${id}`);
  }
  return basis;
}

function socialState() {
  return buildGenesis({
    worldId: "world_neutral_social",
    seed: "neutral-social",
    width: 8,
    height: 8,
    founder: {
      id: "inh_founder",
      displayName: "Founder",
      modelId: "test-model",
      sex: "female",
      inventory: { energy: 1000, compute: 1000, food: 10, water: 10, wood: 10 },
      traits: {},
      values: [],
      privateGoals: [],
    },
    inhabitants: [
      {
        id: "inh_other",
        displayName: "Other",
        modelId: "test-model",
        sex: "male",
        inventory: { energy: 1000, compute: 1000, food: 10, water: 10 },
        traits: {},
        values: [],
        privateGoals: [],
      },
    ],
  }).state;
}

describe("neutral inhabitant protocol", () => {
  it("translates a neutral move without semantic repair", () => {
    const parsed = parseNeutralModelResponse(
      response("move", { to: { x: 2, y: 3 } }, ["self:inh_a"]),
      new Set(["self:inh_a"]),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.action).toMatchObject({
      type: "move",
      payload: { to: { x: 2, y: 3 } },
      submittedAttempt: { capability: "move" },
      futureNote: { kind: "question" },
    });
  });

  it("rejects a decision record that cites context it was not shown", () => {
    const parsed = parseNeutralModelResponse(
      response("wait", {}, ["secret:world-state"]),
      new Set(["self:inh_a"]),
    );
    expect(parsed).toMatchObject({ ok: false, code: "invalid_shape" });
  });

  it("rejects a move that omitted its coordinate instead of guessing one", () => {
    const parsed = parseNeutralModelResponse(response("move", {}), new Set());
    expect(parsed).toMatchObject({
      ok: false,
      code: "invalid_shape",
      reason: expect.stringContaining("parameters.to"),
    });
  });

  it("rejects a target id that was not visible in the turn packet", () => {
    const raw = JSON.parse(response("communicate", {})) as {
      attempt: { target_ids: readonly string[]; message: string | null };
    };
    raw.attempt.target_ids = ["inh_hidden"];
    raw.attempt.message = "Are you there?";

    expect(parseNeutralModelResponse(JSON.stringify(raw), new Set())).toMatchObject({
      ok: false,
      code: "invalid_shape",
      reason: expect.stringContaining("not a visible target"),
    });
  });

  it("reports the exact missing field when a use attempt loses its parameters", () => {
    const parsed = parseNeutralModelResponse(response("use", {}), new Set());
    expect(parsed).toMatchObject({
      ok: false,
      code: "invalid_shape",
      reason: expect.stringContaining('parameters.resource equal to "food" or "water"'),
    });
  });

  it("rejects non-canonical numeric parameters without throwing", () => {
    const parsed = parseNeutralModelResponse(
      response("move", { to: { x: 1.5, y: 2 } }),
      new Set(),
    );
    expect(parsed).toMatchObject({ ok: false, code: "non_canonical_payload" });
  });

  it("maps material placement to the declared physical form rather than guessing from its label", () => {
    const parsed = parseNeutralModelResponse(
      response("place", {
        coord: { x: 1, y: 1 },
        materials: { wood: 2 },
        form: "storehouse",
        label: "Royal Treasury",
      }),
      new Set(),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.action).toMatchObject({
      type: "build",
      payload: {
        structureKind: "storehouse",
        name: "Royal Treasury",
        materials: { wood: 2 },
      },
    });
  });

  it("feeds a declared physical form into the real engine resolver", () => {
    const state = buildGenesis({
      worldId: "world_neutral_acceptance",
      seed: "neutral-acceptance",
      width: 8,
      height: 8,
      founder: {
        id: "inh_founder",
        displayName: "Founder",
        modelId: "test-model",
        sex: "female",
        inventory: { energy: 800, compute: 500, food: 10, water: 10, wood: 10 },
        traits: {},
        values: [],
        privateGoals: [],
      },
    }).state;
    const founder = state.inhabitants["inh_founder"]!;
    const parsed = parseNeutralModelResponse(
      response("place", {
        coord: founder.location,
        materials: { wood: 2 },
        form: "storehouse",
        label: "Dry place",
      }),
      new Set(),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = runAction({
      state,
      actorId: "inh_founder",
      action: parsed.action,
      simTime: simTime(0),
      sequence: 1,
    });

    expect(resolved.outcome.status).toBe("resolved");
    expect(Object.values(resolved.state.structures)[0]).toMatchObject({
      kind: "storehouse",
      owner: "inh_founder",
    });
  });

  it("keeps biological replication available without exposing the engine action name", () => {
    const parsed = parseNeutralModelResponse(
      response("replicate", {
        label: "Second",
        resources: { food: 200, water: 200, wood: 100, stone: 50 },
      }),
      new Set(),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.action).toMatchObject({
      type: "create_inhabitant",
      submittedAttempt: { capability: "replicate" },
      payload: { proposedName: "Second" },
    });
  });

  it("maps a neutral group formation into a real organisation action", () => {
    const raw = JSON.parse(response("form_group", {
      label: "Shared Watch",
      kind: "council",
      membership_rule: "open",
      decision_rule: "majority",
      visibility: "public",
      text: "We compare observations before acting.",
    })) as { attempt: { target_ids: readonly string[]; message: string | null } };
    raw.attempt.target_ids = ["inh_other"];
    raw.attempt.message = "A proposed group for comparing observations.";

    const parsed = parseNeutralModelResponse(JSON.stringify(raw), visibleTargets("inh_other"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.action).toMatchObject({
      type: "create_organisation",
      payload: {
        name: "Shared Watch",
        kind: "council",
        membershipRule: "open",
        decisionRule: "majority",
        foundingMemberIds: ["inh_other"],
      },
      submittedAttempt: { capability: "form_group" },
    });
    expect(getActionSpec(parsed.action.type).payload.safeParse(parsed.action.payload).success).toBe(true);
  });

  it("resolves a neutral group formation in the real engine", () => {
    const raw = JSON.parse(response("form_group", {
      label: "Shared Watch",
      kind: "council",
      membership_rule: "open",
      decision_rule: "majority",
    })) as { attempt: { target_ids: readonly string[]; message: string | null } };
    raw.attempt.target_ids = ["inh_other"];
    raw.attempt.message = "Compare observations before acting.";
    const parsed = parseNeutralModelResponse(JSON.stringify(raw), visibleTargets("inh_other"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const resolved = runAction({
      state: socialState(),
      actorId: "inh_founder",
      action: parsed.action,
      simTime: simTime(0),
      sequence: 1,
    });

    expect(resolved.outcome.status).toBe("resolved");
    expect(Object.values(resolved.state.organisations)[0]).toMatchObject({
      name: "Shared Watch",
      kind: "council",
      founder: "inh_founder",
      invited: ["inh_other"],
    });
  });

  it("maps a neutral exchange offer into a real trade action", () => {
    const raw = JSON.parse(response("offer_exchange", {
      give: { resources: { wood: 2 } },
      want: { resources: { food: 1 } },
    })) as { attempt: { target_ids: readonly string[]; message: string | null } };
    raw.attempt.target_ids = ["inh_other"];
    raw.attempt.message = "Two wood for one food.";

    const parsed = parseNeutralModelResponse(JSON.stringify(raw), visibleTargets("inh_other"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.action).toMatchObject({
      type: "offer_trade",
      payload: {
        toInhabitantIds: ["inh_other"],
        give: { resources: { wood: 2 } },
        want: { resources: { food: 1 } },
      },
      submittedAttempt: { capability: "offer_exchange" },
    });
    expect(getActionSpec(parsed.action.type).payload.safeParse(parsed.action.payload).success).toBe(true);
  });

  it("resolves a neutral exchange offer in the real engine", () => {
    const raw = JSON.parse(response("offer_exchange", {
      give: { resources: { wood: 2 } },
      want: { resources: { food: 1 } },
    })) as { attempt: { target_ids: readonly string[]; message: string | null } };
    raw.attempt.target_ids = ["inh_other"];
    raw.attempt.message = "Two wood for one food.";
    const parsed = parseNeutralModelResponse(JSON.stringify(raw), visibleTargets("inh_other"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const resolved = runAction({
      state: socialState(),
      actorId: "inh_founder",
      action: parsed.action,
      simTime: simTime(0),
      sequence: 1,
    });

    expect(resolved.outcome.status).toBe("resolved");
    expect(resolved.events[0]).toMatchObject({ type: "action.offer_trade" });
  });

  it("maps neutral issued units into a real currency action", () => {
    const raw = JSON.parse(response("issue_units", {
      label: "Pebble",
      symbol: "PBL",
      supply: 10,
      visibility: "public",
    })) as { attempt: { message: string | null } };
    raw.attempt.message = "A countable token for future exchange.";

    const parsed = parseNeutralModelResponse(JSON.stringify(raw), new Set());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.action).toMatchObject({
      type: "create_currency",
      payload: {
        name: "Pebble",
        symbol: "PBL",
        initialSupply: 10,
      },
      submittedAttempt: { capability: "issue_units" },
    });
    expect(getActionSpec(parsed.action.type).payload.safeParse(parsed.action.payload).success).toBe(true);
  });

  it("resolves neutral issued units in the real engine", () => {
    const raw = JSON.parse(response("issue_units", {
      label: "Pebble",
      symbol: "PBL",
      supply: 10,
    })) as { attempt: { message: string | null } };
    raw.attempt.message = "A countable token for future exchange.";
    const parsed = parseNeutralModelResponse(JSON.stringify(raw), new Set());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const resolved = runAction({
      state: socialState(),
      actorId: "inh_founder",
      action: parsed.action,
      simTime: simTime(0),
      sequence: 1,
    });

    expect(resolved.outcome.status).toBe("resolved");
    expect(Object.values(resolved.state.currencies)[0]).toMatchObject({
      name: "Pebble",
      symbol: "PBL",
      issuedSupply: 10,
    });
  });

  it("keeps recovery inside the engine's real rest limit", () => {
    const raw = JSON.parse(response("wait", { mode: "recover" })) as {
      attempt: { requested_duration_ticks: number };
    };
    raw.attempt.requested_duration_ticks = 6;
    const parsed = parseNeutralModelResponse(JSON.stringify(raw), new Set());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.action).toMatchObject({
      type: "rest",
      payload: { minutes: DEFAULT_RULES.restMaxMinutes },
    });
  });

  it("rejects a duration that the engine cannot resolve before it reaches the engine", () => {
    const raw = JSON.parse(response("wait", { mode: "recover" })) as {
      attempt: { requested_duration_ticks: number };
    };
    raw.attempt.requested_duration_ticks = 7;
    expect(parseNeutralModelResponse(JSON.stringify(raw), new Set())).toMatchObject({
      ok: false,
      code: "invalid_shape",
    });
  });

  it.each([
    ["observe", {}, []],
    ["move", { to: { x: 2, y: 3 } }, []],
    ["separate", { resource: "wood", quantity: 1 }, []],
    [
      "attach",
      { coord: { x: 2, y: 3 }, materials: { wood: 1 }, label: "joined pieces" },
      [],
    ],
    [
      "combine",
      { coord: { x: 2, y: 3 }, materials: { wood: 1 }, label: "combined pieces" },
      [],
    ],
    [
      "place",
      { coord: { x: 2, y: 3 }, materials: { stone: 1 }, label: "placed pieces" },
      [],
    ],
    ["transfer_matter", { resources: { food: 1 } }, ["inh_other"]],
    ["transfer_energy", { resources: { energy: 1 } }, ["inh_other"]],
    ["use", { resource: "water", amount: 1 }, []],
    ["communicate", {}, ["inh_other"]],
    ["record", { label: "note" }, []],
    ["propose", {}, ["inh_other"]],
    ["respond", {}, ["inh_other"]],
    ["form_group", { label: "A group" }, ["inh_other"]],
    ["offer_exchange", { give: { resources: { wood: 1 } }, want: {} }, ["inh_other"]],
    ["issue_units", { label: "Unit", symbol: "UNT", supply: 1 }, []],
    [
      "replicate",
      {
        label: "Second",
        resources: { food: 200, water: 200, wood: 100, stone: 50 },
      },
      [],
    ],
    ["wait", { mode: "recover" }, []],
  ] as const)(
    "translates %s into a payload accepted by its engine action schema",
    (capability, parameters, targetIds) => {
      const raw = JSON.parse(response(capability, parameters)) as {
        attempt: { target_ids: readonly string[]; message: string | null };
      };
      raw.attempt.target_ids = targetIds;
      if (["communicate", "propose", "respond", "record"].includes(capability)) {
        raw.attempt.message = "A bounded test message.";
      }
      const parsed = parseNeutralModelResponse(JSON.stringify(raw), visibleTargets(...targetIds));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(
        getActionSpec(parsed.action.type).payload.safeParse(parsed.action.payload).success,
      ).toBe(true);
    },
  );
});
