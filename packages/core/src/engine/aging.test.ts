import { describe, expect, it } from "vitest";
import { MINUTES_PER_DAY, simTime } from "../time.js";
import { ageDaysAt, advanceAging, elderEnergyCost, elderGatherYield, isElderAt } from "./aging.js";
import { makeTestWorld } from "./test-support.js";

describe("aging and mandatory mortality", () => {
  it("derives age from canonical birth time and enters elder state at 85 percent", () => {
    const state = makeTestWorld();
    const founder = {
      ...state.inhabitants.inh_founder!,
      maxLifespanDays: 40,
      lifecycle: { birthTick: simTime(0), maxLifespanTicks: 40 * MINUTES_PER_DAY, isElder: false },
    };
    const elderAt = simTime(34 * MINUTES_PER_DAY);
    expect(ageDaysAt(founder, elderAt)).toBe(34);
    expect(isElderAt(founder, elderAt)).toBe(true);
    expect(elderEnergyCost(founder, elderAt, 20)).toBe(25);
    expect(elderGatherYield(founder, elderAt, 8)).toBe(6);
  });

  it("forces death at the lifespan limit and relocates conserved holdings into remains", () => {
    const base = makeTestWorld({ founderInventory: { food: 7, wood: 3, energy: 800 } });
    const founder = {
      ...base.inhabitants.inh_founder!,
      maxLifespanDays: 40,
      lifecycle: { birthTick: simTime(0), maxLifespanTicks: 40 * MINUTES_PER_DAY, isElder: false },
    };
    const state = { ...base, inhabitants: { ...base.inhabitants, [founder.id]: founder } };
    const outcome = advanceAging(state, simTime(40 * MINUTES_PER_DAY), 1);
    const dead = outcome.state.inhabitants[founder.id]!;
    const remains = outcome.state.remains[`rem_${founder.id}`]!;
    expect(dead.status).toBe("dead");
    expect(dead.inventory).toEqual({});
    expect(remains.inventory).toMatchObject({ food: 7, wood: 3 });
    expect(outcome.events).toContainEqual(expect.objectContaining({ type: "inhabitant.died", actor: founder.id }));
  });
});
