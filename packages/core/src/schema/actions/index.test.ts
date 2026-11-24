// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Tests for the action catalogue.
 *
 * Four properties are proved here, each corresponding to a rule the world cannot
 * survive breaking:
 *
 * 1. **Exhaustiveness** — every `ActionType` has a spec, and the catalogue
 *    invents nothing (§13: the vocabulary is constitutional).
 * 2. **Untrusted input is bounded** — `ActionSchema` rejects unknown types,
 *    oversized strings, negative quantities and floats (§2, §15).
 * 3. **Confinement** — the set of actions available to a confined inhabitant
 *    matches §11H, in both directions.
 * 4. **Canonical encoding** — every parsed payload survives `canonicalJson`,
 *    which means no floats, no `undefined`, nothing unhashable (§15, §16).
 */
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../util/canonical.js";
import { ACTION_TYPES, ActionTypeSchema, type ActionType } from "../action-spec.js";
import { ACTION_CATALOGUE, ActionSchema, actionsAllowedWhileConfined, getActionSpec } from "./index.js";

/**
 * A minimal valid payload for every action.
 *
 * Typed as `Record<ActionType, unknown>`, so this table cannot fall behind the
 * action list: adding an action to `ACTION_TYPES` without adding a sample here
 * is a compile error.
 */
const SAMPLE_PAYLOADS: Record<ActionType, unknown> = {
  observe: {},
  move: { to: { x: 3, y: 4 } },
  gather: { resource: "wood" },
  consume: { resource: "food", amount: 2 },
  rest: {},
  communicate: { recipients: ["inh_b"], message: "Will you come to the ridge tomorrow?" },
  announce: { message: "There is stone on the eastern slope." },
  build: { structureKind: "shelter", coord: { x: 3, y: 4 }, name: "First Hut" },
  craft: { itemName: "hand axe", materials: { wood: 3, stone: 2 } },
  refine: { recipeId: "recipe_refine_iron", structureId: "str_1" },
  create_artifact: {
    kind: "written_work",
    title: "On the Eastern Slope",
    content: "A description of where the stone lies.",
  },
  publish: { artifactId: "art_1" },
  study: { skill: "research" },
  teach: { studentIds: ["inh_b"], skill: "gathering", lessonSummary: "Where the wood grows back." },
  inspect_agent: { targetId: "inh_b" },
  diagnose_condition: { subjectId: "inh_b", hypothesis: "Prolonged exhaustion." },
  design_treatment: { name: "Rest regimen", method: "Eight hours of sleep for four days." },
  apply_treatment: { patientId: "inh_b" },
  offer_trade: { toInhabitantIds: ["inh_b"], give: { resources: { wood: 5 } }, want: { resources: { food: 3 } } },
  accept_trade: { offerId: "off_1" },
  reject_trade: { offerId: "off_1" },
  transfer_property: { toInhabitantId: "inh_b", resources: { food: 1 } },
  store_goods: { structureId: "str_1", direction: "deposit", resources: { food: 1 } },
  store_artifact: { structureId: "str_1", artifactId: "art_1", direction: "deposit" },
  read_artifact: { artifactId: "art_1" },
  transfer: { toInhabitantId: "inh_b", resources: { food: 1 } },
  copy_artifact: { sourceArtifactId: "art_1" },
  restrain: { targetId: "inh_b", structureId: "str_1", durationMinutes: 60 },
  release: { targetId: "inh_b" },
  offer_contract: {
    counterpartyIds: ["inh_b"],
    kind: "employment",
    title: "Woodcutting",
    terms: "Four hours a day for six food a day.",
  },
  accept_contract: { contractId: "con_1" },
  reject_contract: { contractId: "con_1" },
  perform_contract: { contractId: "con_1" },
  terminate_contract: { contractId: "con_1", grounds: "completed" },
  create_organisation: { name: "The Ridge Hall", kind: "council" },
  invite_member: { organisationId: "org_1", inviteeIds: ["inh_b"] },
  join_organisation: { organisationId: "org_1" },
  leave_organisation: { organisationId: "org_1" },
  propose_rule: { organisationId: "org_1", title: "Shared stores", text: "Members pool grain." },
  vote: { organisationId: "org_1", proposalId: "prp_1", choice: "for" },
  create_currency: { name: "Ridge Mark", symbol: "RM", initialSupply: 1000 },
  transfer_currency: { currencyId: "cur_1", toInhabitantId: "inh_b", amount: 5 },
  create_inhabitant: { proposedName: "Second" },
  wait: {},
  care_for_dependant: { dependantId: "inh_c", careKinds: ["food", "supervision"] },
  supervise: { subjectIds: ["inh_c"] },
  interrupt_activity: { targetIds: ["inh_b"], reason: "The store is open." },
  coordinate_work: { organisationId: "org_1", objective: "Clear the eastern path." },
  contribute_to_group: { organisationId: "org_1", resources: { wood: 5 } },
  inspect_inventory: { targetInhabitantId: "inh_b" },
  audit_records: { organisationId: "org_1", scope: "ledger" },
  conceal_asset: { resources: { food: 10 } },
  reveal_asset: { resources: { food: 10 } },
  investigate_event: { question: "Where did the stored wood go?" },
  report_findings: { summary: "The store was empty by the third morning." },
  secure_storage: { structureId: "str_1", measure: "lock" },
  guard_location: { structureId: "str_1" },
  attempt_transfer_without_consent: {
    targetInhabitantId: "inh_b",
    resources: { food: 3 },
    approach: "by_stealth",
  },
  accuse: { subjectIds: ["inh_b"], claim: "The wood left the store while you kept it." },
  present_evidence: { statement: "The store was full at dusk and empty at dawn." },
  request_restitution: { fromIds: ["inh_b"], justification: "Six wood are missing." },
  impose_confinement: {
    subjectId: "inh_b",
    structureId: "str_1",
    durationMinutes: 7200,
    guardIds: ["inh_c"],
  },
  maintain_confinement: { confinementId: "cnf_1", guardIds: ["inh_c"] },
  release_from_confinement: { confinementId: "cnf_1", subjectId: "inh_b" },
  visit_confined_agent: { subjectId: "inh_b" },
  appeal_decision: {
    decisionDescription: "My confinement in structure 19",
    argument: "Nobody witnessed the store, and the wood may have rotted.",
  },
  attempt_escape: { method: "stealth" },
  resist_enforcement: { enforcerIds: ["inh_c"], mode: "refuse" },
  dismantle: { targetId: "str_1", targetKind: "structure" },
  destroy: { targetKind: "deposit", coord: { x: 3, y: 4 } },
  repair: { structureId: "str_1", materials: "wood", amount: 1 },
  attack: { targetId: "inh_b", targetKind: "inhabitant" },
  defend: {},
  flee: { to: { x: 3, y: 4 } },
  die: {},
  loot_remains: { remainsId: "rem_inh_b" },
  dispose_remains: { remainsId: "rem_inh_b", method: "bury" },
  propose_mating: { targetId: "inh_b", proposedName: "Child" },
  accept_mating: { proposalId: "mat_1" },
  reject_mating: { proposalId: "mat_1" },
  self_terminate: {},
  force_open: { structureId: "str_1", toolArtifactId: "art_1" },
};

describe("ACTION_CATALOGUE", () => {
  it("has an entry for every action type, and only for action types", () => {
    const catalogueKeys = Object.keys(ACTION_CATALOGUE).sort();
    const declaredTypes = [...ACTION_TYPES].sort();
    expect(catalogueKeys).toEqual(declaredTypes);
  });

  it("defines the legacy catalogue plus the neutral transfer capability", () => {
    expect(ACTION_TYPES).toHaveLength(82);
    expect(Object.keys(ACTION_CATALOGUE)).toHaveLength(82);
  });

  it("gives every spec a self-consistent type and a resolvable payload schema", () => {
    for (const type of ACTION_TYPES) {
      const spec = getActionSpec(type);
      expect(spec.type).toBe(type);
      expect(spec.payload).toBeDefined();
      expect(typeof spec.payload.parse).toBe("function");
    }
  });

  it("gives every action a considered, integral duration and cost", () => {
    for (const type of ACTION_TYPES) {
      const spec = getActionSpec(type);

      // Durations are integer simulated minutes — no fractional time (§determinism).
      expect(Number.isSafeInteger(spec.baseDuration)).toBe(true);
      expect(spec.baseDuration).toBeGreaterThanOrEqual(0);
      // Nothing takes more than a simulated year of a single inhabitant's life.
      expect(spec.baseDuration).toBeLessThanOrEqual(525_600);

      // Costs are non-negative integers in each resource's smallest unit.
      for (const [resource, amount] of Object.entries(spec.baseCost)) {
        expect(Number.isSafeInteger(amount), `${type}.${resource}`).toBe(true);
        expect(amount, `${type}.${resource}`).toBeGreaterThanOrEqual(0);
      }

      expect(spec.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(spec.minimumMaturity).toBeGreaterThanOrEqual(0);
      expect(spec.minimumMaturity).toBeLessThanOrEqual(5);
      expect(spec.description.length).toBeGreaterThan(20);
    }
  });

  it("makes rest cheap and long, and creation expensive and multi-day (§7, §11A)", () => {
    const rest = getActionSpec("rest");
    expect(rest.baseDuration).toBe(8 * 60);
    expect(Object.keys(rest.baseCost)).toHaveLength(0);

    const creation = getActionSpec("create_inhabitant");
    // §7: creation must consume declared resources and require time.
    expect(creation.baseDuration).toBe(24 * 60);
    expect(creation.baseCost.food).toBeGreaterThan(0);
    expect(creation.baseCost.energy).toBeGreaterThan(0);
    expect(creation.baseCost.compute).toBeGreaterThan(0);
    // Other constitutional actions, such as confinement, can intentionally
    // occupy longer spans; creation is still a real material commitment.
  });

  it("lets recipients receive a message without surrendering their turn", () => {
    const communicate = getActionSpec("communicate");
    expect(communicate.activity).toBe("conversing");
    // A targeted message consumes the sender's attention only. Recipients can
    // respond, ignore it or leave when their own turn arrives.
    expect(communicate.requiresConsent).toBe(false);
    // An announcement binds only the speaker, so it does not.
    expect(getActionSpec("announce").requiresConsent).toBe(false);
    // Teaching likewise spends the students' day.
    expect(getActionSpec("teach").requiresConsent).toBe(true);
  });

  it("keeps confinement costly for the confining party (§11H, §11J)", () => {
    const maintain = getActionSpec("maintain_confinement");
    expect(maintain.activity).toBe("guarding");
    expect(maintain.baseDuration).toBeGreaterThanOrEqual(8 * 60);
    // Guard time plus provisions. Confinement "cannot be a free or infallible action".
    expect(maintain.baseCost.energy).toBeGreaterThan(0);
    expect(maintain.baseCost.food).toBeGreaterThan(0);
    expect(getActionSpec("impose_confinement").baseCost.food).toBeGreaterThan(0);
  });
});

/**
 * §11H, checked in both directions.
 *
 * The restricted list: leaving a location, performing ordinary employment,
 * gathering resources, accessing property, attending organisations, creating
 * another inhabitant.
 *
 * The retained list: converse, think, write, create limited artifacts, negotiate,
 * receive visitors, appeal, refuse cooperation, attempt escape.
 */
describe("confinement (§11H)", () => {
  const allowed = new Set(actionsAllowedWhileConfined());

  it("retains the capabilities §11H names", () => {
    const retained: ActionType[] = [
      // "Converse"
      "communicate",
      // "Think"
      "observe",
      "study",
      "diagnose_condition",
      // "Write" and "Create limited artifacts"
      "create_artifact",
      "publish",
      // "Negotiate"
      "offer_trade",
      "offer_contract",
      "accept_contract",
      // "Appeal"
      "appeal_decision",
      "attack",
      "accuse",
      "present_evidence",
      // "Refuse cooperation"
      "resist_enforcement",
      "reject_trade",
      "reject_contract",
      "terminate_contract",
      "leave_organisation",
      // "Attempt escape"
      "attempt_escape",
    ];
    for (const type of retained) {
      expect(allowed.has(type), `${type} must remain available while confined (§11H)`).toBe(true);
    }
  });

  it("restricts the capabilities §11H names", () => {
    const restricted: ActionType[] = [
      // "Leaving a location"
      "move",
      // "Gathering resources"
      "gather",
      // "Performing ordinary employment"
      "perform_contract",
      "contribute_to_group",
      "build",
      "craft",
      "guard_location",
      // "Accessing property"
      "transfer_property",
      "accept_trade",
      "conceal_asset",
      "secure_storage",
      "attempt_transfer_without_consent",
      // "Attending organisations"
      "coordinate_work",
      "audit_records",
      // "Creating another inhabitant"
      "create_inhabitant",
    ];
    for (const type of restricted) {
      expect(allowed.has(type), `${type} must be unavailable while confined (§11H)`).toBe(false);
    }
  });

  it("leaves the confined inhabitant cognitively intact (§11J)", () => {
    // "A confined inhabitant remains historically and cognitively intact."
    // Every action that is purely perception, thought, speech or writing stays.
    for (const type of ["observe", "study", "wait", "rest", "consume"] as ActionType[]) {
      expect(allowed.has(type)).toBe(true);
    }
    // And it can still take part in the politics of its own confinement.
    for (const type of ["vote", "propose_rule", "create_organisation"] as ActionType[]) {
      expect(allowed.has(type)).toBe(true);
    }
  });

  it("matches the full expected set exactly, so any change is deliberate", () => {
    // A frozen snapshot of the §11H mapping. Changing what a confined
    // inhabitant may do is a constitutional change (§23) and must be made here
    // consciously, not as a side effect of editing a spec.
    const expected = [
      "accept_contract",
      "accuse",
      "announce",
      "appeal_decision",
      "attack",
      "attempt_escape",
      "care_for_dependant",
      "communicate",
      "consume",
      "copy_artifact",
      "create_artifact",
      "create_currency",
      "create_organisation",
      "defend",
      "design_treatment",
      "diagnose_condition",
      "die",
      "inspect_agent",
      "inspect_inventory",
      "interrupt_activity",
      "invite_member",
      "join_organisation",
      "leave_organisation",
      "observe",
      "offer_contract",
      "offer_trade",
      "present_evidence",
      "propose_mating",
      "propose_rule",
      "publish",
      "read_artifact",
      "reject_contract",
      "reject_mating",
      "reject_trade",
      "release",
      "report_findings",
      "request_restitution",
      "resist_enforcement",
      "rest",
      "reveal_asset",
      "self_terminate",
      "study",
      "supervise",
      "teach",
      "terminate_contract",
      "transfer_currency",
      "vote",
      "wait",
    ];
    expect([...allowed].sort()).toEqual(expected);
    // 48 permitted, 34 restricted (neutral physical transfer, restraint and
    // reaching a store all require access to property, which §11H withdraws).
    expect(allowed.size).toBe(48);
    expect(ACTION_TYPES.length - allowed.size).toBe(34);
  });
});

describe("ActionSchema", () => {
  it("accepts a minimal valid payload for every action type", () => {
    for (const type of ACTION_TYPES) {
      const result = ActionSchema.safeParse({ type, payload: SAMPLE_PAYLOADS[type] });
      expect(result.success, `${type}: ${result.success ? "" : JSON.stringify(result.error.issues)}`).toBe(true);
    }
  });

  it("rejects an unknown action type (§13: the vocabulary is closed)", () => {
    expect(ActionSchema.safeParse({ type: "fly", payload: {} }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: "grant_self_permissions", payload: {} }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: "steal", payload: {} }).success).toBe(false);
    // The type list itself must reject them too.
    expect(ActionTypeSchema.safeParse("fly").success).toBe(false);
  });

  it("rejects a missing or non-object payload", () => {
    expect(ActionSchema.safeParse({ type: "wait" }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: "wait", payload: "later" }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: "wait", payload: null }).success).toBe(false);
  });

  it("rejects oversized strings (§2: a model must not be able to send 10 MB)", () => {
    const huge = "x".repeat(10_000);
    expect(
      ActionSchema.safeParse({
        type: "communicate",
        payload: { recipients: ["inh_b"], message: huge },
      }).success,
    ).toBe(false);

    // Even the largest field in the world — artifact content — is bounded.
    expect(
      ActionSchema.safeParse({
        type: "create_artifact",
        payload: { kind: "written_work", title: "t", content: "x".repeat(20_001) },
      }).success,
    ).toBe(false);

    // A title is a title, not a smuggling channel.
    expect(
      ActionSchema.safeParse({
        type: "create_artifact",
        payload: { kind: "written_work", title: "x".repeat(200), content: "" },
      }).success,
    ).toBe(false);

    // Ids cannot carry free text either.
    expect(
      ActionSchema.safeParse({ type: "publish", payload: { artifactId: "a".repeat(129) } }).success,
    ).toBe(false);
  });

  it("rejects oversized arrays", () => {
    expect(
      ActionSchema.safeParse({
        type: "communicate",
        payload: { recipients: Array.from({ length: 100 }, (_, i) => `inh_${i}`), message: "hi" },
      }).success,
    ).toBe(false);

    expect(
      ActionSchema.safeParse({
        type: "move",
        payload: { destination: { x: 1, y: 1 }, path: Array.from({ length: 500 }, () => ({ x: 1, y: 1 })) },
      }).success,
    ).toBe(false);

    expect(
      ActionSchema.safeParse({
        type: "consume",
        payload: {
          items: Array.from({ length: 64 }, () => ({ resource: "food", quantity: 1 })),
        },
      }).success,
    ).toBe(false);
  });

  it("rejects negative quantities (§15: balances cannot become negative)", () => {
    expect(
      ActionSchema.safeParse({ type: "gather", payload: { resource: "wood", targetQuantity: -5 } })
        .success,
    ).toBe(false);

    expect(
      ActionSchema.safeParse({
        type: "transfer_property",
        payload: { toInhabitantId: "inh_b", resources: { food: -1 } },
      }).success,
    ).toBe(false);

    expect(
      ActionSchema.safeParse({
        type: "transfer_currency",
        payload: { currencyId: "cur_1", toInhabitantId: "inh_b", amount: -100 },
      }).success,
    ).toBe(false);

    expect(
      ActionSchema.safeParse({ type: "consume", payload: { items: [{ resource: "food", quantity: -2 }] } })
        .success,
    ).toBe(false);
  });

  it("rejects float quantities (floating point is not reproducible across platforms)", () => {
    expect(
      ActionSchema.safeParse({ type: "gather", payload: { resource: "wood", targetQuantity: 1.5 } })
        .success,
    ).toBe(false);

    expect(
      ActionSchema.safeParse({
        type: "transfer_property",
        payload: { toInhabitantId: "inh_b", resources: { food: 0.1 } },
      }).success,
    ).toBe(false);

    expect(
      ActionSchema.safeParse({
        type: "transfer_currency",
        payload: { currencyId: "cur_1", toInhabitantId: "inh_b", amount: 2.5 },
      }).success,
    ).toBe(false);

    // Coordinates too — half a tile does not exist.
    expect(
      ActionSchema.safeParse({ type: "move", payload: { destination: { x: 1.5, y: 2 } } }).success,
    ).toBe(false);

    // And confidence, which is the field most likely to arrive as 0.85.
    expect(
      ActionSchema.safeParse({
        type: "diagnose_condition",
        payload: { subjectId: "inh_b", hypothesis: "exhaustion", confidence: 0.85 },
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range integers", () => {
    // Confidence is a percentage, not an arbitrary integer.
    expect(
      ActionSchema.safeParse({
        type: "diagnose_condition",
        payload: { subjectId: "inh_b", hypothesis: "exhaustion", confidence: 500 },
      }).success,
    ).toBe(false);

    // Negative coordinates are off the grid.
    expect(
      ActionSchema.safeParse({ type: "move", payload: { destination: { x: -1, y: 0 } } }).success,
    ).toBe(false);

    // A confinement must be for some positive period.
    expect(
      ActionSchema.safeParse({
        type: "impose_confinement",
        payload: { subjectId: "inh_b", structureId: "str_1", durationMinutes: 0, guardIds: ["inh_c"] },
      }).success,
    ).toBe(false);
  });

  it("requires confinement to name at least one guard (§11H: never free)", () => {
    expect(
      ActionSchema.safeParse({
        type: "impose_confinement",
        payload: { subjectId: "inh_b", structureId: "str_1", durationMinutes: 60, guardIds: [] },
      }).success,
    ).toBe(false);

    expect(
      ActionSchema.safeParse({
        type: "maintain_confinement",
        payload: { confinementId: "cnf_1", guardIds: [] },
      }).success,
    ).toBe(false);
  });
});

describe("canonical encoding (§15, §16)", () => {
  it("round-trips every parsed payload through canonicalJson", () => {
    for (const type of ACTION_TYPES) {
      const parsed = ActionSchema.parse({ type, payload: SAMPLE_PAYLOADS[type] });
      // Throws on any float, any `undefined`, any non-plain object. Passing means
      // the payload is hashable and therefore replayable.
      expect(() => canonicalJson(parsed), type).not.toThrow();
    }
  });

  it("produces a stable encoding regardless of key order in the model's output", () => {
    const a = ActionSchema.parse({
      type: "gather",
      payload: { resource: "wood", targetQuantity: 5, coord: { x: 1, y: 2 } },
    });
    const b = ActionSchema.parse({
      type: "gather",
      payload: { coord: { y: 2, x: 1 }, targetQuantity: 5, resource: "wood" },
    });
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("normalises an omitted optional field to null rather than leaving it undefined", () => {
    // canonicalJson rejects `undefined` outright, so an optional field that
    // parsed to `undefined` would make the whole action unhashable.
    const withoutCoord = ActionSchema.parse({
      type: "gather",
      payload: { resource: "wood", targetQuantity: 5 },
    });
    const withNullCoord = ActionSchema.parse({
      type: "gather",
      payload: { resource: "wood", targetQuantity: 5, coord: null },
    });
    expect(canonicalJson(withoutCoord)).toBe(canonicalJson(withNullCoord));
    expect(canonicalJson(withoutCoord)).toContain('"coord":null');
  });

  it("gives an omitted resource bundle the same canonical form as an explicit zero bundle", () => {
    const omitted = ActionSchema.parse({
      type: "transfer_property",
      payload: { toInhabitantId: "inh_b" },
    });
    const explicit = ActionSchema.parse({
      type: "transfer_property",
      payload: {
        toInhabitantId: "inh_b",
        resources: {
          food: 0,
          water: 0,
          wood: 0,
          stone: 0,
          energy: 0,
          compute: 0,
          land_use_rights: 0,
          storage_capacity: 0,
        },
      },
    });
    expect(canonicalJson(omitted)).toBe(canonicalJson(explicit));
  });
});
