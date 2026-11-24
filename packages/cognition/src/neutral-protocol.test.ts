// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
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
  const state = buildGenesis({
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
  const founder = state.inhabitants.inh_founder!;
  const other = state.inhabitants.inh_other!;
  return {
    ...state,
    inhabitants: { ...state.inhabitants, [other.id]: { ...other, location: founder.location } },
  };
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

  it("normalizes permissive Gemini drift for duration, target ids and basis ids", () => {
    const raw = JSON.parse(
      response("communicate", {}),
    ) as {
      attempt: { requested_duration_ticks: unknown; target_ids: unknown[]; message: string | null };
      decision_record: { basis_ids: unknown[]; uncertainties: unknown };
      future_note: { kind: string; text: string };
    };

    raw.attempt.requested_duration_ticks = null;
    raw.attempt.target_ids = ["observed:inhabitant:inh_founder", "inhabitant:inh_lumen"];
    raw.decision_record.basis_ids = ["basis:turn:1", "basis:self:inh_ember", "observed:inhabitant:inh_founder"];
    raw.decision_record.uncertainties = "Will they answer my greeting?";
    raw.attempt.message = "Hello?";

    const parsed = parseNeutralModelResponse(
      JSON.stringify(raw),
      new Set([
        ...visibleTargets("inh_founder"),
        "self:inh_ember",
        "observed:inhabitant:inh_lumen",
        "turn:1",
      ]),
    );
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.action.submittedAttempt?.requestedDurationTicks).toBe(1);
    expect(parsed.action.payload).toMatchObject({
      recipients: ["inh_founder", "inh_lumen"],
      message: "Hello?",
    });
    expect(parsed.action.decisionRecord?.uncertainties).toEqual(["Will they answer my greeting?"]);
  });

  it("normalizes numeric priority_now into schema-compatible string", () => {
    const raw = JSON.parse(response("communicate", {})) as {
      decision_record: { priority_now: unknown; basis_ids: readonly string[] };
      attempt: { message: string | null };
    };
    raw.attempt.message = "Hello.";
    raw.decision_record.basis_ids = ["turn:1", "self:inh_ember", "observed:inhabitant:inh_lumen"];
    raw.decision_record.priority_now = 70;

    const parsed = parseNeutralModelResponse(
      JSON.stringify(raw),
      new Set(["turn:1", "self:inh_ember", "observed:inhabitant:inh_lumen"]),
    );

    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.action.decisionRecord?.priorityNow).toBe("70");
  });

  it("normalizes future note kind synonyms", () => {
    const raw = JSON.parse(response("communicate", {})) as {
      attempt: { message: string | null };
      future_note: { kind: string; text: string };
    };
    raw.attempt.message = "Hello.";
    raw.future_note.kind = "intent";
    raw.future_note.text = "Listen for replies.";

    const parsed = parseNeutralModelResponse(JSON.stringify(raw), new Set(["turn:1"]));
    expect(parsed.ok).toBe(true);
  });

  it("normalizes uncommon future note kinds to intention", () => {
    const raw = JSON.parse(response("communicate", {})) as {
      attempt: { message: string | null };
      future_note: { kind: string; text: string };
    };
    raw.attempt.message = "Hello.";
    raw.future_note.kind = "plan";
    raw.future_note.text = "Let us coordinate next steps.";

    const parsed = parseNeutralModelResponse(
      JSON.stringify(raw),
      new Set(["turn:1", "self:inh_founder", "observed:inhabitant:inh_lumen"]),
    );
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.action.futureNote?.kind).toBe("intention");
  });

  it("parses a historical no-op response pattern from model-audit", () => {
    const rawText = JSON.parse(
      '{"attempt":{"capability":"communicate","target_ids":["inhabitant:inh_ember","inhabitant:inh_lumen"],"parameters":{},"requested_duration_ticks":null,"message":"Greetings, Ember and Lumen. I am Aster. We share this location at (4, 0). Would either of you be interested in discussing cooperation and material acquisition?"},"decision_record":{"priority_now":"Initiate social contact with nearby inhabitants Ember and Lumen to explore cooperation during the bootstrap phase.","basis_ids":["turn:11","self:inh_founder","observed:inhabitant:inh_ember","observed:inhabitant:inh_lumen"],"basis_summary":"Aster is at (4, 0) alongside Ember and Lumen. Cognition mode is conversation, aligning with starting communication to satisfy social/cooperative needs.","expected_local_change":"A message will be transmitted locally to Ember and Lumen, potentially eliciting a response.","success_test":"The communication attempt is successfully recorded and delivered to the target inhabitants.","uncertainties":["Whether Ember or Lumen will reply or cooperate."]},"future_note":{"kind":"observation","text":"Observe responses from Ember and Lumen to gauge their willingness to cooperate on survival and material gathering."}}',
    );

    const parsed = parseNeutralModelResponse(JSON.stringify(rawText), new Set([
      "turn:11",
      "self:inh_founder",
      "observed:inhabitant:inh_ember",
      "observed:inhabitant:inh_lumen",
    ]));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.action.type).toBe("communicate");
  });

  it("recovers an action when the response truncates after attempt", () => {
    const truncated =
      '{"attempt":{"capability":"separate","target_ids":[],"parameters":{"resource":"water","quantity":1,"coord":{"x":4,"y":0}},"requested_duration_ticks":1,"message":"I should take water."},"decision_"';

    const parsed = parseNeutralModelResponse(truncated, new Set());
    expect(parsed).toMatchObject({ ok: true, action: { type: "gather", submittedAttempt: { capability: "separate" } } });
  });

  it("recovers an action when the attempt itself truncates mid-parameter", () => {
    const truncated =
      '{"attempt":{"capability":"separate","parameters":{"resource":"water","coord":{"x":4,"y":0}},"requested_duration_ticks":1,"message":"Collect water"';

    const parsed = parseNeutralModelResponse(truncated, new Set());
    expect(parsed).toMatchObject({
      ok: true,
      action: { type: "gather", submittedAttempt: { capability: "separate" } },
    });
  });

  it("fills missing optional fields from a truncated attempt before schema validation", () => {
    const truncated =
      '{"attempt":{"capability":"separate","parameters":{"resource":"water","coord":{"x":4,"y":0}}';

    const parsed = parseNeutralModelResponse(truncated, new Set());
    expect(parsed).toMatchObject({
      ok: true,
      action: { type: "gather", submittedAttempt: { capability: "separate" } },
    });
  });

  it("recovers from schema-mismatch when only attempt is stable", () => {
    const raw = JSON.parse(response("communicate", {})) as {
      attempt: { message: string | null };
    };
    raw.attempt.message = "Hello, I can still recover.";

    const malformed = `{"attempt":${JSON.stringify(raw.attempt)},"decision_record":null,"future_note":null`;
    const parsed = parseNeutralModelResponse(malformed, new Set());

    expect(parsed).toMatchObject({ ok: true, action: { type: "announce" } });
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

  it("rejects a build without both an approved form and descriptive label", () => {
    const missingLabel = parseNeutralModelResponse(
      response("combine", { coord: { x: 2, y: 3 }, materials: { wood: 2 }, form: "smelter" }),
      new Set(),
    );
    const invalidForm = parseNeutralModelResponse(
      response("place", { coord: { x: 2, y: 3 }, materials: { wood: 2 }, form: "assembly", label: "Loose test" }),
      new Set(),
    );
    for (const parsed of [missingLabel, invalidForm]) {
      expect(parsed).toMatchObject({
        ok: false,
        code: "invalid_shape",
        reason: expect.stringContaining("Build action failed"),
      });
    }
  });

  it("rejects an ore name used where refine requires a canonical recipe id", () => {
    const parsed = parseNeutralModelResponse(
      response("refine", { recipe_id: "iron_ore" }, ["observed:structure:str_smelter"]),
      new Set(["observed:structure:str_smelter"]),
    );
    expect(parsed).toMatchObject({
      ok: false,
      code: "invalid_shape",
      reason: expect.stringContaining("recipe_refine_iron"),
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
        resources: { food: 30, water: 20, wood: 20, stone: 50 },
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
      { coord: { x: 2, y: 3 }, materials: { wood: 1 }, form: "workshop", label: "joined pieces" },
      [],
    ],
    [
      "combine",
      { coord: { x: 2, y: 3 }, materials: { wood: 1 }, form: "smelter", label: "combined pieces" },
      [],
    ],
    [
      "place",
      { coord: { x: 2, y: 3 }, materials: { stone: 1 }, form: "shelter", label: "placed pieces" },
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
        resources: { food: 30, water: 20, wood: 20, stone: 50 },
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
