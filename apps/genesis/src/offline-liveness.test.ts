import {
  buildGenesis,
  runAction,
  simTime,
  type DerivedEvent,
} from "@after-genesis/core";
import { describe, expect, it } from "vitest";
import { demoConfig, mechanicalCognition } from "./cli.js";

const TURNS_PER_DAY = 12;
const MAX_TURNS = 100 * TURNS_PER_DAY;

describe("offline cohort liveness", () => {
  it("seeds all ten worksheet Progenitors by default", () => {
    const state = buildGenesis(demoConfig()).state;

    expect(Object.keys(state.inhabitants).sort()).toEqual([
      "inh_01_alpha",
      "inh_02_beta",
      "inh_03_gamma",
      "inh_04_delta",
      "inh_05_epsilon",
      "inh_06_zeta",
      "inh_07_eta",
      "inh_08_theta",
      "inh_09_iota",
      "inh_10_kappa",
    ]);
    expect(state.inhabitants.inh_10_kappa?.values).toContain(
      "Archetype: The Archivist (The Observer)",
    );
  });

  it("begins the interactive rehearsal with the declared Progenitor cohort", () => {
    const state = buildGenesis(demoConfig(undefined, 3)).state;
    expect(Object.keys(state.inhabitants).sort()).toEqual([
      "inh_01_alpha",
      "inh_02_beta",
      "inh_03_gamma",
    ]);
    expect(state.inhabitants.inh_01_alpha?.values).toContain("Archetype: The Imperialist");
    expect(state.inhabitants.inh_01_alpha?.privateGoals).toContain(
      "Core directive: Maximize controlled territory and dominate resource nodes.",
    );
    expect(state.inhabitants.inh_02_beta?.privateGoals).toContain(
      "Preferred actions: craft, gather, communicate.",
    );
    expect(state.sequence).toBe(0);
  });

  it("produces physical state changes within 100 simulated days", async () => {
    let state = buildGenesis(demoConfig(undefined, 3)).state;
    const cognition = mechanicalCognition();
    let physicalChange: DerivedEvent | null = null;
    const actionCounts: Record<string, number> = {};

    for (let sequence = 1; sequence <= MAX_TURNS && physicalChange === null; sequence++) {
      const actorIds = Object.values(state.inhabitants)
        .filter((inhabitant) => inhabitant.status === "alive")
        .map((inhabitant) => inhabitant.id)
        .sort();
      const actorId = actorIds[(sequence - 1) % actorIds.length];
      if (actorId === undefined) throw new Error(`no living actor at sequence ${sequence}`);
      const at = simTime(sequence * 120);
      const proposal = await cognition.propose({ state, actorId, simTime: at, sequence });
      const proposedType = proposal.action?.type ?? "wait";
      actionCounts[proposedType] = (actionCounts[proposedType] ?? 0) + 1;
      const result = runAction({
        state,
        actorId,
        action: proposal.action ?? { type: "wait", payload: {} },
        simTime: at,
        sequence,
      });
      state = result.state;
      if (result.outcome.status === "resolved") {
        physicalChange =
          result.events.find((event) =>
            [
              "action.build",
              "action.store_goods",
              "action.create_inhabitant",
            ].includes(event.type),
          ) ?? null;
      }
    }

    expect(
      physicalChange,
      `offline cognition never resolved a physical world change: ${JSON.stringify({
        actionCounts,
        founder: state.inhabitants["inh_founder"],
        structures: state.structures,
      })}`,
    ).not.toBeNull();
    expect(Object.keys(state.structures).length).toBeGreaterThan(0);
  });

  it("does not regress into a multi-day idle or rejection loop", async () => {
    let state = buildGenesis(demoConfig(undefined, 3)).state;
    const cognition = mechanicalCognition();
    const eventCounts: Record<string, number> = {};
    const outcomeCounts: Record<string, number> = {};
    const actionCounts: Record<string, number> = {};
    let longestRejectedStreak = 0;
    let rejectedStreak = 0;

    for (let sequence = 1; sequence <= 30 * TURNS_PER_DAY; sequence++) {
      const actorIds = Object.values(state.inhabitants)
        .filter((inhabitant) => inhabitant.status === "alive")
        .map((inhabitant) => inhabitant.id)
        .sort();
      const actorId = actorIds[(sequence - 1) % actorIds.length];
      if (actorId === undefined) throw new Error(`no living actor at sequence ${sequence}`);
      const at = simTime(sequence * 120);
      const proposal = await cognition.propose({ state, actorId, simTime: at, sequence });
      const action = proposal.action ?? { type: "wait", payload: {} };
      actionCounts[action.type] = (actionCounts[action.type] ?? 0) + 1;

      const result = runAction({ state, actorId, action, simTime: at, sequence });
      state = result.state;
      outcomeCounts[result.outcome.status] = (outcomeCounts[result.outcome.status] ?? 0) + 1;
      for (const event of result.events) {
        eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
      }
      if (result.outcome.status === "rejected") {
        rejectedStreak += 1;
        longestRejectedStreak = Math.max(longestRejectedStreak, rejectedStreak);
      } else {
        rejectedStreak = 0;
      }
    }

    const living = Object.values(state.inhabitants).filter(
      (inhabitant) => inhabitant.status === "alive",
    );
    const meaningfulEvents = Object.entries(eventCounts)
      .filter(([type]) => !["action.observe", "action.wait", "action.rest"].includes(type))
      .reduce((total, [, count]) => total + count, 0);

    expect(
      living.length,
      `offline run killed the cohort: ${JSON.stringify({
        eventCounts,
        outcomeCounts,
        actionCounts,
        inhabitants: state.inhabitants,
      })}`,
    ).toBeGreaterThan(0);
    expect(
      meaningfulEvents,
      `offline run advanced days without meaningful actions: ${JSON.stringify({
        eventCounts,
        outcomeCounts,
        actionCounts,
      })}`,
    ).toBeGreaterThanOrEqual(12);
    expect(
      Object.keys(eventCounts).length,
      `offline run collapsed to a single event kind: ${JSON.stringify({
        eventCounts,
        outcomeCounts,
        actionCounts,
      })}`,
    ).toBeGreaterThanOrEqual(4);
    expect(
      longestRejectedStreak,
      `offline run got stuck in a rejection loop: ${JSON.stringify({
        eventCounts,
        outcomeCounts,
        actionCounts,
      })}`,
    ).toBeLessThan(12);
    expect(Math.floor(state.simTime / (24 * 60))).toBeGreaterThanOrEqual(30);
  });
});
