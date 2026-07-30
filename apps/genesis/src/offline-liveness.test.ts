import {
  buildGenesis,
  runAction,
  simTime,
  type DerivedEvent,
} from "@after-genesis/core";
import { describe, expect, it } from "vitest";
import { demoConfig, mechanicalCognition } from "./cli.js";

const MAX_TURNS = 100 * 12;

describe("offline one-founder liveness", () => {
  it("keeps the interactive rehearsal on its original three-person Genesis roster", () => {
    const state = buildGenesis(demoConfig()).state;
    expect(Object.keys(state.inhabitants).sort()).toEqual([
      "inh_ember",
      "inh_founder",
      "inh_lumen",
    ]);
    expect(state.sequence).toBe(0);
  });

  it("reaches a resolved descendant creation within 100 simulated days", async () => {
    let state = buildGenesis(demoConfig(undefined, false)).state;
    const cognition = mechanicalCognition();
    let creation: DerivedEvent | null = null;
    const actionCounts: Record<string, number> = {};

    for (let sequence = 1; sequence <= MAX_TURNS && creation === null; sequence++) {
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
        creation =
          result.events.find((event) => event.type === "action.create_inhabitant") ?? null;
      }
    }

    expect(
      creation,
      `offline cognition never resolved create_inhabitant: ${JSON.stringify({
        actionCounts,
        founder: state.inhabitants["inh_founder"],
        structures: state.structures,
      })}`,
    ).not.toBeNull();
    expect(
      Object.values(state.inhabitants).filter((inhabitant) => inhabitant.status === "alive")
        .length,
    ).toBeGreaterThan(1);
  });
});
