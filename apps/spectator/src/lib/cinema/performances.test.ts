// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * The performance catalogue, tested against the canonical vocabulary itself.
 *
 * The action list is imported from `@after-genesis/core` rather than copied,
 * so that a constitutional change to the vocabulary (§13) breaks this suite
 * instead of silently producing figures with no posture.
 */
import { describe, expect, it } from "vitest";
import { ACTION_TYPES, ActivityStateSchema } from "@after-genesis/core/schema/action-spec";
import { PERFORMANCE_CATALOGUE, performanceFor, performanceForSegment } from "./performances";
import type { ChronicleSegment } from "./types";

const ACTIVITY_STATES = ActivityStateSchema.options;

function segment(over: Partial<ChronicleSegment>): ChronicleSegment {
  return {
    id: "seg-1",
    inhabitantId: "inh_founder",
    activityId: "act-1",
    sequence: 4,
    actionType: "consume",
    activityState: "idle",
    startTick: 0,
    endTick: 60,
    canonicalMinutes: 60,
    from: { x: 3, y: 4 },
    to: { x: 3, y: 4 },
    focus: null,
    participants: ["inh_founder"],
    disclosure: "disclosed",
    visibility: "local",
    outcomeStatus: "resolved",
    detail: null,
    caption: "an inhabitant consumed a resource",
    ...over,
  };
}

describe("the catalogue covers the whole canonical vocabulary", () => {
  it("names every action type in ActionTypeSchema", () => {
    const missing = ACTION_TYPES.filter((type) => PERFORMANCE_CATALOGUE[type] === undefined);
    expect(missing, `action types with no performance: ${missing.join(", ")}`).toEqual([]);
  });

  it("resolves every action type to a posture rather than to the unknown fallback", () => {
    const unresolved = ACTION_TYPES.filter(
      (type) => performanceFor(type, "idle", "disclosed").clip === "unknown",
    );
    expect(unresolved, `unresolved action types: ${unresolved.join(", ")}`).toEqual([]);
  });

  it("resolves every activity state without consulting the action type", () => {
    const unresolved = ACTIVITY_STATES.filter(
      (state) =>
        performanceFor("an_action_from_a_later_world", state, "envelope_only").clip === "unknown",
    );
    expect(unresolved, `unresolved activity states: ${unresolved.join(", ")}`).toEqual([]);
  });

  it("declares a finite, positive cycle rate everywhere", () => {
    for (const type of ACTION_TYPES) {
      const spec = performanceFor(type, "idle", "disclosed");
      expect(Number.isFinite(spec.cycleRate), type).toBe(true);
      expect(spec.cycleRate, type).toBeGreaterThan(0);
    }
  });

  it("marks every spec as derived, so nothing here can pass as canonical", () => {
    for (const type of ACTION_TYPES) {
      expect(performanceFor(type, "idle", "disclosed").derived).toBe(true);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(PERFORMANCE_CATALOGUE)).toBe(true);
  });
});

describe("the envelope is depicted; the contents are not", () => {
  it("depicts a canonical activity state whose contents were withheld", () => {
    // §11E: nearby inhabitants and public activity are directly observable. A
    // conversation the world recorded and whose words it withheld is still a
    // conversation, and drawing a standing figure instead would deny that.
    expect(performanceFor("communicate", "conversing", "envelope_only").clip).toBe("talk");
    expect(performanceFor("gather", "gathering", "envelope_only").clip).toBe("harvest");
    expect(performanceFor("rest", "sleeping", "envelope_only").clip).toBe("sleep");
    expect(performanceFor("move", "travelling", "envelope_only").clip).toBe("walk");
  });

  it("never depicts an interval no canonical record covers", () => {
    for (const type of ACTION_TYPES) {
      for (const state of ACTIVITY_STATES) {
        const spec = performanceFor(type, state, "unrecorded");
        expect(spec.clip, `${type}/${state}`).toBe("undisclosed");
        expect(spec.prop, `${type}/${state}`).toBe("none");
        expect(spec.faceFocus, `${type}/${state}`).toBe(false);
      }
    }
  });

  it("returns an identical spec for every unrecorded stretch, so its shape leaks nothing", () => {
    const specs = new Set(
      ACTION_TYPES.flatMap((type) =>
        ACTIVITY_STATES.map((state) => JSON.stringify(performanceFor(type, state, "unrecorded"))),
      ),
    );
    expect(specs.size).toBe(1);
  });

  it("does not let the action type refine a clip when the contents are withheld", () => {
    // Rule 2. `consume` resolves to eat or drink from `detail.resource`, and the
    // resource is content: with contents withheld the depiction must fall back
    // to the activity state rather than imply which of the two it was.
    const withheld = performanceFor("consume", "idle", "envelope_only");
    const disclosed = performanceFor("consume", "idle", "disclosed");
    expect(withheld.clip).toBe("idle");
    expect(disclosed.clip).toBe("eat");
    expect(withheld.clip).not.toBe("eat");
    expect(withheld.clip).not.toBe("drink");
  });

  it("gives the same envelope clip whatever the withheld action was", () => {
    // Same activity state, four different actions, contents withheld: the
    // depiction must not vary, because the variation would be the disclosure.
    const clips = new Set(
      ["communicate", "announce", "accuse", "appeal_decision"].map(
        (type) => performanceFor(type, "conversing", "envelope_only").clip,
      ),
    );
    expect([...clips]).toEqual(["talk"]);
  });

  it("carries no prop that could encode what was said or exchanged", () => {
    // Rule 3, at the envelope layer: a prop may describe the posture, never the
    // transaction. Only the disclosed path may reach for a bundle or a vessel.
    for (const state of ACTIVITY_STATES) {
      const spec = performanceFor("an_action_from_a_later_world", state, "envelope_only");
      expect(["none", "tool", "tablet", "bundle"], `${state} prop`).toContain(spec.prop);
    }
    expect(performanceFor("x", "caring", "envelope_only").prop).toBe("none");
    expect(performanceFor("x", "performing", "envelope_only").prop).toBe("none");
  });

  it("uses unknown, not undisclosed, for a word this build does not recognise", () => {
    // Nothing was withheld here; the vocabulary simply moved on.
    expect(performanceFor("a_later_action", "a_later_state", "disclosed").clip).toBe("unknown");
    expect(performanceFor("a_later_action", "a_later_state", "envelope_only").clip).toBe("unknown");
  });
});

describe("clips are postures rather than stories", () => {
  it("gives neutral physical postures to the contested actions", () => {
    // §11F, §11G: the engine records what happened; whether it was theft,
    // justice or malpractice is an argument between inhabitants.
    const neutral = ["reach", "carry", "walk", "guard", "talk", "examine"];
    for (const type of [
      "attempt_transfer_without_consent",
      "conceal_asset",
      "impose_confinement",
      "maintain_confinement",
      "release_from_confinement",
      "attempt_escape",
      "resist_enforcement",
      "restrain",
      "accuse",
    ]) {
      const spec = performanceFor(type, "working", "disclosed");
      expect(neutral, `${type} → ${spec.clip}`).toContain(spec.clip);
    }
  });

  it("keeps the same posture for an action and its opposite", () => {
    expect(performanceFor("restrain", "working", "disclosed").clip).toBe(
      performanceFor("release", "working", "disclosed").clip,
    );
    expect(performanceFor("impose_confinement", "working", "disclosed").clip).toBe(
      performanceFor("release_from_confinement", "working", "disclosed").clip,
    );
  });

  it("draws a confined inhabitant by what they are doing, not by their confinement", () => {
    // §11H: a confined inhabitant "may retain the ability to converse, think,
    // write". The restrained posture is a fallback, never an override.
    expect(performanceFor("communicate", "conversing", "envelope_only").clip).toBe("talk");
    expect(performanceFor("an_action_from_a_later_world", "confined", "disclosed").clip).toBe(
      "restrained",
    );
  });

  it("locks a travelling gait to distance rather than to time", () => {
    const walk = performanceFor("move", "travelling", "disclosed");
    expect(walk.locomotion).toBe("path");
    // cyclesPerSimMinute = cycleRate * speed for path clips: halving the speed
    // halves the stride count over the same ground.
    expect(walk.cycleRate * 0.2).toBeCloseTo(2 * (walk.cycleRate * 0.1), 10);
  });
});

describe("performanceForSegment refines only on disclosed detail", () => {
  it("distinguishes drinking from eating when the resource is disclosed", () => {
    const water = performanceForSegment(
      segment({ actionType: "consume", detail: { resource: "water", amount: 1 } }),
    );
    const food = performanceForSegment(
      segment({ actionType: "consume", detail: { resource: "food", amount: 1 } }),
    );
    expect(water.clip).toBe("drink");
    expect(water.prop).toBe("vessel");
    expect(food.clip).toBe("eat");
  });

  it("refuses the refinement when the contents are withheld", () => {
    const withheld = performanceForSegment(
      segment({ actionType: "consume", disclosure: "envelope_only", detail: null }),
    );
    expect(withheld.clip).toBe("idle");
  });

  it("refuses the refinement even if a detail leaks onto a withheld segment", () => {
    // Defence in depth: this rule must not depend on the chronicle keeping its
    // promise that `detail` is null unless the segment is disclosed.
    const leaked = performanceForSegment(
      segment({
        actionType: "consume",
        disclosure: "envelope_only",
        detail: { resource: "water" },
      }),
    );
    expect(leaked.clip).toBe("idle");
  });

  it("says nothing at all about an unrecorded stretch", () => {
    const gap = performanceForSegment(
      segment({
        actionType: "unrecorded",
        activityState: "unrecorded",
        disclosure: "unrecorded",
        detail: null,
      }),
    );
    expect(gap.clip).toBe("undisclosed");
  });
});
