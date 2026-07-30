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
    priority_now: z.string().min(1).max(600),
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
              enum: ["food", "water", "wood", "stone"],
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
        priority_now: { type: "string" },
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
    case "separate":
      return stringParameter(parameters, "resource") === null
        ? 'separate requires parameters.resource equal to "food", "water", "wood", or "stone".'
        : null;
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
  if (json === null) return failure("no_json_found", "No complete JSON object was found.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return failure("malformed_json", "The extracted text was not valid JSON.");
  }
  const validated = NeutralModelResponseSchema.safeParse(parsed);
  if (!validated.success) {
    return failure(
      "invalid_shape",
      "The object did not match the immutable attempt, decision_record and future_note schema.",
    );
  }
  const unknownBasis = validated.data.decision_record.basis_ids.find(
    (id) => !allowedBasisIds.has(id),
  );
  if (unknownBasis !== undefined) {
    return failure(
      "invalid_shape",
      "decision_record.basis_ids contained an id absent from this TURN_PACKET.",
    );
  }
  const targets = allowedTargetIds(allowedBasisIds);
  const unknownTarget = validated.data.attempt.target_ids.find((id) => !targets.has(id));
  if (unknownTarget !== undefined) {
    return failure(
      "invalid_shape",
      `attempt.target_ids contained ${unknownTarget}, which is not a visible target in this TURN_PACKET.`,
    );
  }
  if (depthOf(validated.data.attempt.parameters, MAX_PAYLOAD_DEPTH) > MAX_PAYLOAD_DEPTH) {
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
  const parameterProblem = requiredParameterProblem(validated.data);
  if (parameterProblem !== null) {
    return failure("invalid_shape", parameterProblem);
  }
  const action = translateNeutralResponse(validated.data);
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
