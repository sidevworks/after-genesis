import {
  buildGenesis,
  runAction,
  simTime,
  type DerivedEvent,
} from "@after-genesis/core";
import { describe, expect, it } from "vitest";
import { demoConfig, mechanicalCognition } from "./cli.js";

const MAX_TURNS = 100 * 12;

describe("offline cohort liveness", () => {
  it("begins the interactive rehearsal with a neutral Genesis cohort", () => {
    const state = buildGenesis(demoConfig()).state;
    expect(Object.keys(state.inhabitants).sort()).toEqual([
      "inh_ember",
      "inh_founder",
      "inh_lumen",
    ]);
    expect(
      Object.values(state.inhabitants).flatMap((inhabitant) => [
        ...inhabitant.values,
        ...inhabitant.privateGoals,
      ]),
    ).toEqual([]);
    expect(state.sequence).toBe(0);
  });

  it("produces physical state changes within 100 simulated days", async () => {
    let state = buildGenesis(demoConfig()).state;
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
});
