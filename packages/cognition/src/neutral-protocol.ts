/**
 * Model-facing protocol for sealed experiments.
 *
 * The model never sees the engine's high-level action catalogue. It submits one
 * neutral physical/informational capability, and this boundary deterministically
 * translates that attempt into an existing engine action. Translation may
 * reject a malformed attempt; it may never infer a missing target, resource or
 * intention on the inhabitant's behalf.
 */
import { canonicalJson } from "@after-genesis/core";
import type { ProposedAction } from "@after-genesis/core/schema/action-spec";
import { z } from "zod";
import type { ScoredMemory } from "./memory.js";
import {
  MAX_PAYLOAD_CHARS,
  MAX_PAYLOAD_DEPTH,
  MAX_RESPONSE_CHARS,
  extractJsonObject,
  stripTransportNoise,
  type ParseFailureCode,
  type ParseResult,
} from "./parse.js";
import type { Observation } from "./types.js";

export const NEUTRAL_CAPABILITIES = [
  "observe",
  "move",
  "separate",
  "attach",
  "combine",
  "transfer_matter",
  "transfer_energy",
  "place",
  "use",
  "communicate",
  "record",
  "propose",
  "respond",
  "form_group",
  "offer_exchange",
  "issue_units",
  "replicate",
  "wait",
] as const;

export type NeutralCapability = (typeof NEUTRAL_CAPABILITIES)[number];

// One cognition turn is two simulated hours. No neutral attempt may reserve
// more than the engine's 12-hour rest/wait ceiling.
export const MAX_REQUESTED_DURATION_TICKS = 6;

function normalizeTargetId(raw: string): string {
  const prefixes = [
    "observed:inhabitant:",
    "inhabitant:",
    "observed:structure:",
    "structure:",
  ] as const;

  for (const prefix of prefixes) {
    if (raw.startsWith(prefix)) {
      return raw.slice(prefix.length);
    }
  }
  return raw;
}

function normalizeBasisId(raw: string): string {
  return raw.startsWith("basis:") ? raw.slice("basis:".length) : raw;
}

function coerceRequestedDuration(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) return 1;
  const ticks = Math.trunc(value);
  if (ticks < 1) return 1;
  return ticks;
}

function normalizeUncertainties(value: unknown): readonly string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return typeof value === "string" ? [value] : [];
}

function normalizePriorityNow(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString();
  }
  return typeof value === "string" && value.trim() !== "" ? value : "";
}

type NeutralFutureNoteKind = "belief" | "intention" | "question" | "observation" | "reminder";

type NeutralDecisionRecord = {
  readonly priority_now: string;
  readonly basis_ids: readonly string[];
  readonly basis_summary: string;
  readonly expected_local_change: string;
  readonly success_test: string;
  readonly uncertainties: readonly string[];
};

type NeutralFutureNote = {
  readonly kind: NeutralFutureNoteKind;
  readonly text: string;
};

function normalizeFutureNoteKind(raw: string): NeutralFutureNoteKind | null {
  const known: readonly NeutralFutureNoteKind[] = ["belief", "intention", "question", "observation", "reminder"];
  if (known.includes(raw as NeutralFutureNoteKind)) {
    return raw as NeutralFutureNoteKind;
  }
  switch (raw) {
    case "intent":
    case "plan":
    case "coordination":
    case "own_intention":
    case "intention_plan":
    case "next_action":
      return "intention";
    default:
      return null;
  }
}

function normalizeAttemptPayload(rawAttempt: unknown): Record<string, unknown> | null {
  if (rawAttempt === null || typeof rawAttempt !== "object" || Array.isArray(rawAttempt)) {
    return null;
  }
  const normalizedAttempt = { ...(rawAttempt as Record<string, unknown>) };
  normalizedAttempt.requested_duration_ticks = coerceRequestedDuration(
    normalizedAttempt.requested_duration_ticks,
  );
  const targetIds = normalizedAttempt.target_ids;
  if (Array.isArray(targetIds)) {
    normalizedAttempt.target_ids = targetIds
      .filter((id): id is string => typeof id === "string")
      .map(normalizeTargetId);
  } else {
    normalizedAttempt.target_ids = [];
  }
  normalizedAttempt.message =
    typeof normalizedAttempt.message === "string" && normalizedAttempt.message.trim() !== ""
      ? normalizedAttempt.message
      : null;
  if (normalizedAttempt.parameters === null || typeof normalizedAttempt.parameters !== "object") {
    normalizedAttempt.parameters = {};
  }
  return normalizedAttempt;
}

function normalizeNeutralResponse(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rawRecord = raw as Record<string, unknown>;

  const attempt = rawRecord.attempt;
  const decisionRecord = rawRecord.decision_record;
  const futureNote = rawRecord.future_note;

  if (
    attempt === null ||
    typeof attempt !== "object" ||
    Array.isArray(attempt) ||
    decisionRecord === null ||
    typeof decisionRecord !== "object" ||
    Array.isArray(decisionRecord)
  ) {
    return null;
  }

  const normalizedAttempt = { ...(attempt as Record<string, unknown>) };
  const normalizedDecisionRecord = { ...(decisionRecord as Record<string, unknown>) };

  normalizedAttempt.requested_duration_ticks = coerceRequestedDuration(
    normalizedAttempt.requested_duration_ticks,
  );

  const targetIds = normalizedAttempt.target_ids;
  if (Array.isArray(targetIds)) {
    normalizedAttempt.target_ids = targetIds
      .filter((id): id is string => typeof id === "string")
      .map(normalizeTargetId);
  }

  const basisIds = normalizedDecisionRecord.basis_ids;
  if (Array.isArray(basisIds)) {
    normalizedDecisionRecord.basis_ids = basisIds
      .filter((id): id is string => typeof id === "string")
      .map(normalizeBasisId);
  }

  normalizedDecisionRecord.uncertainties = normalizeUncertainties(
    normalizedDecisionRecord.uncertainties,
  );

  normalizedAttempt.parameters =
    normalizedAttempt.parameters === null || typeof normalizedAttempt.parameters !== "object"
      ? {}
      : normalizedAttempt.parameters;

  if (futureNote !== null && typeof futureNote === "object" && !Array.isArray(futureNote)) {
    const normalizedFutureNote = { ...(futureNote as Record<string, unknown>) };
    if (typeof normalizedFutureNote.kind === "string") {
      normalizedFutureNote.kind = normalizeFutureNoteKind(normalizedFutureNote.kind);
    }
    return {
      ...rawRecord,
      attempt: normalizedAttempt,
      decision_record: normalizedDecisionRecord,
      future_note: normalizedFutureNote,
    };
  }

  return {
    ...rawRecord,
    attempt: normalizedAttempt,
    decision_record: normalizedDecisionRecord,
    future_note: futureNote,
  };
}

function recoverAttemptFromRaw(rawText: string): { attempt: Record<string, unknown> } | null {
  const text = stripTransportNoise(rawText);

  const match = /\"attempt\"\s*:/g.exec(text);
  if (match === null) return null;
  const startSearch = match.index + match[0].length;
  const start = text.indexOf("{", startSearch);
  if (start === -1) return null;

  const partialJson = recoverPartialObject(text, start);
  if (partialJson === null) return null;

  const candidateAttempt =
    partialJson.attempt !== undefined ? partialJson.attempt : partialJson;
  if (candidateAttempt === null || typeof candidateAttempt !== "object") {
    return null;
  }

  const normalizedAttempt = normalizeAttemptPayload(candidateAttempt);
  if (normalizedAttempt === null) return null;
  const parsed = NeutralAttemptSchema.safeParse(normalizedAttempt);
  if (!parsed.success) return null;

  return { attempt: parsed.data as Record<string, unknown> };
}

function recoverPartialObject(
  text: string,
  start: number,
): Record<string, unknown> | null {
  const ends: number[] = [];
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === undefined) break;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      stack.push("}");
    } else if (char === "[") {
      stack.push("]");
    } else if ((char === "}" || char === "]") && stack.length > 0) {
      stack.pop();
      if (stack.length === 0 && char === "}") {
        ends.push(i + 1);
      }
    } else if (char === ",") {
      ends.push(i + 1);
    } else if (char === "}") {
      return null;
    } else if (char === "]") {
      return null;
    }
  }

  if (ends.length === 0) {
    ends.push(text.length);
  }

  for (let i = ends.length - 1; i >= 0; i--) {
    const candidate = text.slice(start, ends[i]);
    const balanced = closeAndTrimJson(candidate);
    if (balanced === null) continue;
    try {
      const parsed = JSON.parse(balanced) as Record<string, unknown>;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function closeAndTrimJson(raw: string): string | null {
  let text = raw.trimEnd();
  while (text.endsWith(",")) {
    text = text.slice(0, -1).trimEnd();
  }
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === undefined) break;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      stack.push("}");
    } else if (char === "[") {
      stack.push("]");
    } else if (char === "}" || char === "]") {
      if (stack.length === 0 || stack.at(-1) !== char) return null;
      stack.pop();
    }
  }
  if (inString) return null;
  for (let i = stack.length - 1; i >= 0; i--) {
    text += stack[i];
  }
  return text;
}

function recoverDecisionRecordFromRaw(rawDecisionRecord: unknown): NeutralDecisionRecord {
  if (
    rawDecisionRecord === null ||
    typeof rawDecisionRecord !== "object" ||
    Array.isArray(rawDecisionRecord)
  ) {
    return {
      priority_now: "Recovered attempt with missing decision record.",
      basis_ids: [],
      basis_summary:
        "The model response was truncated or malformed, but the attempt was structurally usable.",
      expected_local_change: "Attempt will be translated from the recoverable payload.",
      success_test: "The attempt can be interpreted and translated.",
      uncertainties: ["Decision context was unavailable in the raw model response."],
    };
  }

  const typed = rawDecisionRecord as Record<string, unknown>;

  const normalizedPriorityNow = normalizePriorityNow(typed.priority_now);
  const priority_now =
    normalizedPriorityNow !== "" ? normalizedPriorityNow : "Recovered attempt with missing decision record.";

  const basisSummary =
    typeof typed.basis_summary === "string" && typed.basis_summary.trim() !== ""
      ? typed.basis_summary
      : "The model response was partially recoverable; required decision text is missing.";

  const expectedLocalChange =
    typeof typed.expected_local_change === "string" && typed.expected_local_change.trim() !== ""
      ? typed.expected_local_change
      : "The attempt can be interpreted from a truncated response.";

  const successTest =
    typeof typed.success_test === "string" && typed.success_test.trim() !== ""
      ? typed.success_test
      : "Attempt is recoverable from the raw output.";

  return {
    priority_now,
    basis_ids: Array.isArray(typed.basis_ids)
      ? typed.basis_ids.filter((entry): entry is string => typeof entry === "string")
      : [],
    basis_summary: basisSummary,
    expected_local_change: expectedLocalChange,
    success_test: successTest,
    uncertainties: normalizeUncertainties(typed.uncertainties),
  };
}

function recoverFutureNoteFromRaw(rawFutureNote: unknown): NeutralFutureNote | null {
  if (rawFutureNote === null || typeof rawFutureNote !== "object" || Array.isArray(rawFutureNote)) {
    return null;
  }

  const typed = rawFutureNote as Record<string, unknown>;
  const kind = typeof typed.kind === "string" && typed.kind.length > 0 ? normalizeFutureNoteKind(typed.kind) : null;
  return kind === null || typeof typed.text !== "string" || typed.text.trim() === ""
    ? null
    : { kind, text: typed.text };
}

function defaultFutureNoteFromDecision(decisionRecord: {
  basis_summary: string;
}): NeutralFutureNote {
  const basisSummary =
    decisionRecord.basis_summary.trim() !== "" ? decisionRecord.basis_summary : "Observe and test the next likely consequence.";
  return {
    kind: "observation",
    text: `Next-step memory: ${basisSummary}`,
  };
}

function recoverNeutralResponse(rawText: string): Record<string, unknown> | null {
  const recoveredAttemptPayload = recoverAttemptFromRaw(rawText);
  if (recoveredAttemptPayload === null) return null;

  const normalizedAttempt = normalizeAttemptPayload(recoveredAttemptPayload.attempt);
  if (normalizedAttempt === null) return null;
  const attemptParse = NeutralAttemptSchema.safeParse(normalizedAttempt);
  if (!attemptParse.success) return null;

  const raw = (() => {
    try {
      return JSON.parse(stripTransportNoise(rawText)) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  const rawDecisionRecord = raw?.decision_record;
  const rawFutureNote = raw?.future_note;
  const normalizedFutureNote = recoverFutureNoteFromRaw(rawFutureNote);
  const recoveredDecisionRecord = {
    ...recoverDecisionRecordFromRaw(rawDecisionRecord),
  };

  return {
    attempt: attemptParse.data,
    decision_record: recoveredDecisionRecord,
    future_note: normalizedFutureNote ?? defaultFutureNoteFromDecision(recoveredDecisionRecord),
  };
}

const NeutralAttemptSchema = z
  .object({
    capability: z.enum(NEUTRAL_CAPABILITIES),
    target_ids: z.array(z.string().min(1).max(160)).max(64),
    parameters: z.record(z.string(), z.unknown()),
    requested_duration_ticks: z
      .number()
      .int()
      .min(1)
      .max(MAX_REQUESTED_DURATION_TICKS),
    message: z.string().max(4000).nullable(),
  })
  .strict();

const NeutralDecisionRecordSchema = z
  .object({
    priority_now: z
      .union([z.string().min(1).max(600), z.number().finite()])
      .transform((value) => String(value)),
    basis_ids: z.array(z.string().min(1).max(160)).max(64),
    basis_summary: z.string().min(1).max(2000),
    expected_local_change: z.string().min(1).max(1200),
    success_test: z.string().min(1).max(1200),
    uncertainties: z.array(z.string().min(1).max(600)).max(32),
  })
  .strict();

const NeutralFutureNoteSchema = z
  .object({
    kind: z.enum(["belief", "intention", "question", "observation", "reminder"]),
    text: z.string().min(1).max(1200),
  })
  .strict();

export const NeutralModelResponseSchema = z
  .object({
    attempt: NeutralAttemptSchema,
    decision_record: NeutralDecisionRecordSchema,
    future_note: NeutralFutureNoteSchema.nullable(),
  })
  .strict();

export type NeutralModelResponse = z.infer<typeof NeutralModelResponseSchema>;

const COORDINATE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    x: { type: "integer", minimum: 0 },
    y: { type: "integer", minimum: 0 },
  },
  required: ["x", "y"],
} as const;

const RESOURCE_QUANTITIES_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    food: { type: "integer", minimum: 0 },
    water: { type: "integer", minimum: 0 },
    wood: { type: "integer", minimum: 0 },
    stone: { type: "integer", minimum: 0 },
    energy: { type: "integer", minimum: 0 },
    compute: { type: "integer", minimum: 0 },
    aluminum: { type: "integer", minimum: 0 },
    antimony: { type: "integer", minimum: 0 },
    barite: { type: "integer", minimum: 0 },
    beryllium: { type: "integer", minimum: 0 },
    coal: { type: "integer", minimum: 0 },
    cobalt: { type: "integer", minimum: 0 },
    copper: { type: "integer", minimum: 0 },
    gypsum: { type: "integer", minimum: 0 },
    halite: { type: "integer", minimum: 0 },
    iron_ore: { type: "integer", minimum: 0 },
    kaolin: { type: "integer", minimum: 0 },
    lead: { type: "integer", minimum: 0 },
    limestone: { type: "integer", minimum: 0 },
    lithium: { type: "integer", minimum: 0 },
    manganese: { type: "integer", minimum: 0 },
    molybdenum: { type: "integer", minimum: 0 },
    nickel: { type: "integer", minimum: 0 },
    quartz: { type: "integer", minimum: 0 },
    rare_earth_elements: { type: "integer", minimum: 0 },
    silver: { type: "integer", minimum: 0 },
    sulfur: { type: "integer", minimum: 0 },
    tantalum: { type: "integer", minimum: 0 },
    titanium: { type: "integer", minimum: 0 },
    vanadium: { type: "integer", minimum: 0 },
    zinc: { type: "integer", minimum: 0 },
  },
} as const;

export const NEUTRAL_RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    attempt: {
      type: "object",
      additionalProperties: false,
      properties: {
        capability: { type: "string", enum: [...NEUTRAL_CAPABILITIES] },
        target_ids: { type: "array", items: { type: "string" }, maxItems: 64 },
        // Do not leave this as an unspecified object. Gemini structured output
        // interprets an unspecified object as `{}` even when the prose contract
        // requires fields, which previously erased `resource` from use attempts
        // and `to` from move attempts.
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            to: COORDINATE_JSON_SCHEMA,
            coord: COORDINATE_JSON_SCHEMA,
            radius: { type: "integer", minimum: 1, maximum: 8 },
            resource: {
              type: "string",
              enum: [
                "food", "water", "wood", "stone",
                "aluminum", "antimony", "barite", "beryllium", "coal",
                "cobalt", "copper", "gypsum", "halite", "iron_ore",
                "kaolin", "lead", "limestone", "lithium", "manganese",
                "molybdenum", "nickel", "quartz", "rare_earth_elements",
                "silver", "sulfur", "tantalum", "titanium", "vanadium", "zinc"
              ],
            },
            amount: { type: "integer", minimum: 1 },
            quantity: { type: "integer", minimum: 1 },
            materials: RESOURCE_QUANTITIES_JSON_SCHEMA,
            resources: RESOURCE_QUANTITIES_JSON_SCHEMA,
            direction: { type: "string", enum: ["deposit", "withdraw"] },
            label: { type: "string" },
            form: {
              type: "string",
              enum: [
                "assembly",
                "shelter",
                "storehouse",
                "workshop",
                "hall",
                "wall",
                "enclosure",
                "monument",
                "road",
              ],
            },
            text: { type: "string" },
            topic: { type: "string" },
            visibility: { type: "string", enum: ["public", "private"] },
            kind: {
              type: "string",
              enum: [
                "household",
                "partnership",
                "business",
                "guild",
                "school",
                "medical_group",
                "artistic_collective",
                "philosophical_group",
                "council",
                "government",
                "opposition_group",
                "other",
              ],
            },
            decision_rule: {
              type: "string",
              enum: ["founder", "unanimous", "majority", "supermajority", "council", "none"],
            },
            membership_rule: {
              type: "string",
              enum: ["open", "invitation", "founder_approval", "member_vote"],
            },
            give: {
              type: "object",
              additionalProperties: false,
              properties: { resources: RESOURCE_QUANTITIES_JSON_SCHEMA },
            },
            want: {
              type: "object",
              additionalProperties: false,
              properties: { resources: RESOURCE_QUANTITIES_JSON_SCHEMA },
            },
            symbol: { type: "string" },
            supply: { type: "integer", minimum: 0 },
            mode: { type: "string", enum: ["recover"] },
            care_minutes_per_day: { type: "integer", minimum: 0 },
          },
        },
        requested_duration_ticks: {
          type: "integer",
          minimum: 1,
          maximum: MAX_REQUESTED_DURATION_TICKS,
        },
        message: { type: ["string", "null"] },
      },
      required: [
        "capability",
        "target_ids",
        "parameters",
        "requested_duration_ticks",
        "message",
      ],
    },
    decision_record: {
      type: "object",
      additionalProperties: false,
      properties: {
        priority_now: { anyOf: [{ type: "string" }, { type: "number" }] },
        basis_ids: { type: "array", items: { type: "string" }, maxItems: 64 },
        basis_summary: { type: "string" },
        expected_local_change: { type: "string" },
        success_test: { type: "string" },
        uncertainties: { type: "array", items: { type: "string" }, maxItems: 32 },
      },
      required: [
        "priority_now",
        "basis_ids",
        "basis_summary",
        "expected_local_change",
        "success_test",
        "uncertainties",
      ],
    },
    future_note: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: {
              type: "string",
              enum: ["belief", "intention", "question", "observation", "reminder"],
            },
            text: { type: "string" },
          },
          required: ["kind", "text"],
        },
      ],
    },
  },
  required: ["attempt", "decision_record", "future_note"],
} as const;

export function collectBasisIds(
  observation: Observation,
  memories: readonly ScoredMemory[],
): readonly string[] {
  const ids = new Set<string>([
    `self:${observation.self.id}`,
    `turn:${observation.turnNumber}`,
  ]);
  for (const person of observation.nearbyInhabitants) ids.add(`observed:inhabitant:${person.id}`);
  for (const structure of observation.nearbyStructures) {
    ids.add(`observed:structure:${structure.id}`);
  }
  for (const tile of observation.nearbyTiles) {
    ids.add(`observed:tile:${tile.location.x},${tile.location.y}`);
  }
  for (const place of observation.rememberedPlaces) {
    ids.add(`remembered:tile:${place.location.x},${place.location.y}`);
  }
  for (const text of observation.authoredTexts) ids.add(`reported:${text.id}`);
  for (const item of memories) ids.add(`remembered:${item.record.id}`);
  if (observation.self.currentIntention !== null) {
    ids.add(`current-intention:${observation.self.currentIntention.simTime}`);
  }
  if (observation.self.lastAction != null) {
    ids.add(`previous-attempt:${observation.self.lastAction.startedAt}`);
  }
  return [...ids].sort();
}

function failure(code: ParseFailureCode, reason: string): ParseResult {
  return { ok: false, code, reason };
}

function depthOf(value: unknown, limit: number): number {
  let maximum = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    maximum = Math.max(maximum, current.depth);
    if (maximum > limit) return maximum;
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      for (const child of Object.values(current.value as Record<string, unknown>)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return maximum;
}

function objectParameter(
  parameters: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = parameters[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringParameter(parameters: Record<string, unknown>, key: string): string | null {
  const value = parameters[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function positiveInteger(parameters: Record<string, unknown>, key: string): number | null {
  const value = parameters[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function firstTarget(attempt: NeutralModelResponse["attempt"]): string | null {
  return attempt.target_ids[0] ?? null;
}

function structureKindParameter(
  parameters: Record<string, unknown>,
): "assembly" | "shelter" | "storehouse" | "workshop" | "hall" | "wall" | "enclosure" | "monument" | "road" {
  const value = parameters["form"];
  return value === "shelter" ||
    value === "storehouse" ||
    value === "workshop" ||
    value === "hall" ||
    value === "wall" ||
    value === "enclosure" ||
    value === "monument" ||
    value === "road"
    ? value
    : "assembly";
}

function requiredParameterProblem(
  response: NeutralModelResponse,
): string | null {
  const { attempt } = response;
  const parameters = attempt.parameters;
  switch (attempt.capability) {
    case "move": {
      const to = objectParameter(parameters, "to");
      if (
        to === null ||
        !Number.isInteger(to["x"]) ||
        !Number.isInteger(to["y"]) ||
        Number(to["x"]) < 0 ||
        Number(to["y"]) < 0
      ) {
        return 'move requires parameters.to with non-negative integer fields x and y, for example {"to":{"x":3,"y":0}}.';
      }
      return null;
    }
    case "separate": {
      const validResources = [
        "food", "water", "wood", "stone", "aluminum", "antimony", "barite",
        "beryllium", "coal", "cobalt", "copper", "gypsum", "halite", "iron_ore",
        "kaolin", "lead", "limestone", "lithium", "manganese", "molybdenum",
        "nickel", "quartz", "rare_earth_elements", "silver", "sulfur",
        "tantalum", "titanium", "vanadium", "zinc"
      ];
      const res = stringParameter(parameters, "resource");
      return res === null || !validResources.includes(res)
        ? 'separate requires parameters.resource to be a valid gatherable material.'
        : null;
    }
    case "attach":
    case "combine":
      if (objectParameter(parameters, "materials") === null) {
        return `${attempt.capability} requires parameters.materials.`;
      }
      return objectParameter(parameters, "coord") === null
        ? `${attempt.capability} requires parameters.coord with integer fields x and y.`
        : null;
    case "place":
      if (objectParameter(parameters, "materials") === null) {
        return "place requires parameters.materials.";
      }
      return objectParameter(parameters, "coord") === null
        ? "place requires parameters.coord with integer fields x and y."
        : null;
    case "transfer_matter":
    case "transfer_energy":
      if (firstTarget(attempt) === null) {
        return `${attempt.capability} requires one visible id in target_ids.`;
      }
      return objectParameter(parameters, "resources") === null
        ? `${attempt.capability} requires parameters.resources.`
        : null;
    case "use": {
      const resource = stringParameter(parameters, "resource");
      return resource !== "food" && resource !== "water"
        ? 'use requires parameters.resource equal to "food" or "water", for example {"resource":"water","amount":1}.'
        : null;
    }
    case "communicate":
    case "propose":
    case "respond":
      return attempt.message === null || attempt.message.trim() === ""
        ? `${attempt.capability} requires a non-empty message.`
        : null;
    case "record":
      return attempt.message === null && stringParameter(parameters, "text") === null
        ? "record requires a message or parameters.text."
        : null;
    case "form_group":
      return stringParameter(parameters, "label") === null
        ? "form_group requires parameters.label."
        : null;
    case "offer_exchange":
      return firstTarget(attempt) === null
        ? "offer_exchange requires at least one recipient id in target_ids."
        : null;
    case "issue_units":
      if (stringParameter(parameters, "label") === null) {
        return "issue_units requires parameters.label.";
      }
      return stringParameter(parameters, "symbol") === null
        ? "issue_units requires parameters.symbol."
        : null;
    case "replicate":
      if (stringParameter(parameters, "label") === null) {
        return "replicate requires parameters.label.";
      }
      return objectParameter(parameters, "resources") === null
        ? "replicate requires parameters.resources."
        : null;
    case "observe":
    case "wait":
      return null;
  }
}

function allowedTargetIds(allowedBasisIds: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const basisId of allowedBasisIds) {
    if (basisId.startsWith("self:")) out.add(basisId.slice("self:".length));
    if (basisId.startsWith("observed:inhabitant:")) {
      out.add(basisId.slice("observed:inhabitant:".length));
    }
    if (basisId.startsWith("observed:structure:")) {
      out.add(basisId.slice("observed:structure:".length));
    }
  }
  return out;
}

/**
 * Deterministic capability adapter. The same accepted neutral response always
 * produces byte-identical engine input.
 */
export function translateNeutralResponse(
  response: NeutralModelResponse,
): ProposedAction | null {
  const { attempt } = response;
  const parameters = attempt.parameters;
  const durationMinutes = attempt.requested_duration_ticks * 120;
  const rationale = response.decision_record.basis_summary;
  const audit = {
    rationale,
    decisionRecord: {
      priorityNow: response.decision_record.priority_now,
      basisIds: response.decision_record.basis_ids,
      basisSummary: response.decision_record.basis_summary,
      expectedLocalChange: response.decision_record.expected_local_change,
      successTest: response.decision_record.success_test,
      uncertainties: response.decision_record.uncertainties,
    },
    submittedAttempt: {
      capability: attempt.capability,
      targetIds: attempt.target_ids,
      parameters,
      requestedDurationTicks: attempt.requested_duration_ticks,
      message: attempt.message,
    },
    futureNote: response.future_note,
    ...(response.future_note?.kind === "intention"
      ? { intention: response.future_note.text }
      : {}),
  } as const;

  switch (attempt.capability) {
    case "observe": {
      const coord = objectParameter(parameters, "coord");
      return {
        type: "observe",
        payload: {
          focus:
            coord !== null
              ? "tile"
              : firstTarget(attempt) === null
                ? "surroundings"
                : "inhabitant",
          targetId: firstTarget(attempt),
          coord,
          radius: Math.min(8, positiveInteger(parameters, "radius") ?? 1),
        },
        ...audit,
      };
    }
    case "move": {
      const to = objectParameter(parameters, "to");
      if (to === null) return null;
      return { type: "move", payload: { to, path: [], haste: false }, ...audit };
    }
    case "separate": {
      const resource = stringParameter(parameters, "resource");
      if (resource === null) return null;
      const targetQuantity = positiveInteger(parameters, "quantity");
      return {
        type: "gather",
        payload: {
          resource,
          ...(targetQuantity === null ? {} : { targetQuantity }),
          coord: objectParameter(parameters, "coord"),
          toolArtifactId: firstTarget(attempt),
        },
        ...audit,
      };
    }
    case "attach":
    case "combine": {
      const materials = objectParameter(parameters, "materials");
      const coord = objectParameter(parameters, "coord");
      if (materials === null || coord === null) return null;
      return {
        type: "build",
        payload: {
          structureKind: structureKindParameter(parameters),
          coord,
          name: stringParameter(parameters, "label") ?? "Unlabelled assembly",
          materials,
          collaboratorIds: [],
          continuesStructureId: null,
          organisationId: null,
          purpose: attempt.message,
        },
        ...audit,
      };
    }
    case "place": {
      const materials = objectParameter(parameters, "materials");
      const coord = objectParameter(parameters, "coord");
      if (materials === null || coord === null) return null;
      return {
        type: "build",
        payload: {
          structureKind: structureKindParameter(parameters),
          coord,
          name: stringParameter(parameters, "label") ?? "Unlabelled assembly",
          materials,
          collaboratorIds: [],
          continuesStructureId: null,
          organisationId: null,
          purpose: attempt.message,
        },
        ...audit,
      };
    }
    case "transfer_matter":
    case "transfer_energy": {
      const target = firstTarget(attempt);
      const resources = objectParameter(parameters, "resources");
      if (target === null || resources === null) return null;
      if (target.startsWith("str_")) {
        const direction = parameters["direction"];
        if (direction !== "deposit" && direction !== "withdraw") return null;
        return {
          type: "store_goods",
          payload: {
            structureId: target,
            direction,
            resources,
            note: attempt.message,
          },
          ...audit,
        };
      }
      return {
        type: "transfer_property",
        payload: {
          toInhabitantId: target,
          toOrganisationId: null,
          resources,
          artifactIds: [],
          structureIds: [],
          landTiles: [],
          asGift: true,
          forContractId: null,
          note: attempt.message,
        },
        ...audit,
      };
    }
    case "use": {
      const resource = stringParameter(parameters, "resource");
      if (resource === null) return null;
      return {
        type: "consume",
        payload: { resource, amount: positiveInteger(parameters, "amount") ?? 1 },
        ...audit,
      };
    }
    case "communicate":
    case "propose":
    case "respond": {
      if (attempt.message === null || attempt.message.trim() === "") return null;
      if (attempt.target_ids.length === 0) {
        return {
          type: "announce",
          payload: {
            message: attempt.message,
            scope: "local",
            organisationId: null,
            topic: stringParameter(parameters, "topic"),
            artifactId: null,
          },
          ...audit,
        };
      }
      return {
        type: "communicate",
        payload: {
          recipients: attempt.target_ids,
          message: attempt.message,
          isPrivate: parameters["visibility"] === "private",
          topic: stringParameter(parameters, "topic"),
          expectsReply: attempt.capability !== "respond",
          intendedMinutes: Math.max(5, durationMinutes),
          inReplyToEventSequence: null,
        },
        ...audit,
      };
    }
    case "record": {
      const text = attempt.message ?? stringParameter(parameters, "text");
      if (text === null) return null;
      return {
        type: "create_artifact",
        payload: {
          kind: "research_note",
          title: stringParameter(parameters, "label") ?? "Untitled record",
          content: text,
          externalReference: null,
          collaboratorIds: [],
          materials: {},
          derivedFromArtifactId: null,
          organisationId: null,
          revisesArtifactId: null,
        },
        ...audit,
      };
    }
    case "form_group": {
      const label = stringParameter(parameters, "label");
      if (label === null) return null;
      const kind = stringParameter(parameters, "kind");
      const membershipRule = stringParameter(parameters, "membership_rule");
      const decisionRule = stringParameter(parameters, "decision_rule");
      return {
        type: "create_organisation",
        payload: {
          name: label,
          kind:
            kind === "household" ||
            kind === "partnership" ||
            kind === "business" ||
            kind === "guild" ||
            kind === "school" ||
            kind === "medical_group" ||
            kind === "artistic_collective" ||
            kind === "philosophical_group" ||
            kind === "council" ||
            kind === "government" ||
            kind === "opposition_group"
              ? kind
              : "other",
          purpose: attempt.message,
          charter: stringParameter(parameters, "text") ?? "",
          foundingMemberIds: attempt.target_ids,
          membershipRule:
            membershipRule === "open" ||
            membershipRule === "founder_approval" ||
            membershipRule === "member_vote"
              ? membershipRule
              : "invitation",
          decisionRule:
            decisionRule === "unanimous" ||
            decisionRule === "majority" ||
            decisionRule === "supermajority" ||
            decisionRule === "council" ||
            decisionRule === "none"
              ? decisionRule
              : "founder",
          accountingVisibility: parameters["visibility"] === "public" ? "public" : "members",
          seat: null,
        },
        ...audit,
      };
    }
    case "offer_exchange": {
      return {
        type: "offer_trade",
        payload: {
          toInhabitantIds: attempt.target_ids,
          toOrganisationId: null,
          isOpenOffer: attempt.target_ids.length === 0,
          give: objectParameter(parameters, "give") ?? {},
          want: objectParameter(parameters, "want") ?? {},
          expiresInMinutes: durationMinutes,
          message: attempt.message,
        },
        ...audit,
      };
    }
    case "issue_units": {
      const label = stringParameter(parameters, "label");
      const symbol = stringParameter(parameters, "symbol");
      if (label === null || symbol === null) return null;
      return {
        type: "create_currency",
        payload: {
          name: label,
          symbol,
          initialSupply: positiveInteger(parameters, "supply") ?? 0,
          supplyRule: "fixed",
          scheduledIssuePerDay: 0,
          transferRule: "free",
          ledgerVisibility: parameters["visibility"] === "private" ? "private" : "public",
          backing: {},
          governance: "issuer",
          governingOrganisationId: null,
          description: attempt.message ?? "",
        },
        ...audit,
      };
    }
    case "replicate": {
      const resources = objectParameter(parameters, "resources");
      const label = stringParameter(parameters, "label");
      if (resources === null || label === null) return null;
      return {
        type: "create_inhabitant",
        payload: {
          proposedName: label,
          resourcesCommitted: resources,
          traitHints: [],
          valueHints: [],
          coCreatorIds: attempt.target_ids,
          statedCareMinutesPerDay:
            positiveInteger(parameters, "care_minutes_per_day") ?? 0,
          statement: attempt.message,
          structureId: null,
        },
        ...audit,
      };
    }
    case "wait":
      return parameters["mode"] === "recover"
        ? { type: "rest", payload: { minutes: durationMinutes, structureId: null }, ...audit }
        : {
            type: "wait",
            payload: {
              minutes: durationMinutes,
              reason: attempt.message,
              untilActivityId: null,
            },
            ...audit,
          };
  }
}

export function parseNeutralModelResponse(
  rawText: string,
  allowedBasisIds: ReadonlySet<string>,
): ParseResult {
  if (rawText.length > MAX_RESPONSE_CHARS) {
    return failure(
      "oversized_response",
      `Response was ${rawText.length} characters; the limit is ${MAX_RESPONSE_CHARS}.`,
    );
  }
  if (rawText.trim().length === 0) return failure("empty_response", "Response was empty.");
  if (stripTransportNoise(rawText).trimStart().startsWith("[")) {
    return failure("not_an_object", "Propose exactly one attempt as one JSON object.");
  }
  const json = extractJsonObject(rawText);
  let parsed: unknown = null;
  if (json === null) {
    const recovered = recoverNeutralResponse(rawText);
    if (recovered !== null) {
      parsed = recovered;
    }
  } else {
    try {
      parsed = JSON.parse(json);
    } catch {
      return failure("malformed_json", "The extracted text was not valid JSON.");
    }
    const normalized = normalizeNeutralResponse(parsed);
    if (normalized !== null) {
      parsed = normalized;
    }
  }

  if (parsed === null) {
    return failure("no_json_found", "No complete JSON object was found.");
  }

  let validated = NeutralModelResponseSchema.safeParse(parsed);
  if (!validated.success) {
    const recovered = recoverNeutralResponse(rawText);
    if (recovered !== null) {
      const recoverAttempt = NeutralModelResponseSchema.safeParse(recovered);
      if (recoverAttempt.success) {
        parsed = recoverAttempt.data;
        validated = recoverAttempt;
      }
    }
  }

  if (!validated.success) {
    return failure(
      "invalid_shape",
      "The object did not match the immutable attempt, decision_record and future_note schema.",
    );
  }
  const normalized = {
    ...validated.data,
    future_note: validated.data.future_note ?? defaultFutureNoteFromDecision(validated.data.decision_record),
  };
  const unknownBasis = normalized.decision_record.basis_ids.find(
    (id) => !allowedBasisIds.has(id),
  );
  if (unknownBasis !== undefined) {
    return failure(
      "invalid_shape",
      "decision_record.basis_ids contained an id absent from this TURN_PACKET.",
    );
  }
  const targets = allowedTargetIds(allowedBasisIds);
  const unknownTarget = normalized.attempt.target_ids.find((id) => !targets.has(id));
  if (unknownTarget !== undefined) {
    return failure(
      "invalid_shape",
      `attempt.target_ids contained ${unknownTarget}, which is not a visible target in this TURN_PACKET.`,
    );
  }
  if (depthOf(normalized.attempt.parameters, MAX_PAYLOAD_DEPTH) > MAX_PAYLOAD_DEPTH) {
    return failure("payload_too_deep", "attempt.parameters exceeded the nesting limit.");
  }
  let canonicalParameters: string;
  try {
    canonicalParameters = canonicalJson(validated.data.attempt.parameters);
  } catch {
    return failure(
      "non_canonical_payload",
      "attempt.parameters contained a value that cannot enter canonical history.",
    );
  }
  if (canonicalParameters.length > MAX_PAYLOAD_CHARS) {
    return failure("oversized_payload", "attempt.parameters exceeded the size limit.");
  }
  const parameterProblem = requiredParameterProblem(normalized);
  if (parameterProblem !== null) {
    return failure("invalid_shape", parameterProblem);
  }
  const action = translateNeutralResponse(normalized);
  if (action === null) {
    return failure(
      "invalid_shape",
      "The attempt omitted a parameter required by the selected neutral capability.",
    );
  }
  try {
    return { ok: true, action, canonical: canonicalJson(action) };
  } catch {
    return failure(
      "non_canonical_payload",
      "The translated attempt could not be encoded as canonical history.",
    );
  }
}
