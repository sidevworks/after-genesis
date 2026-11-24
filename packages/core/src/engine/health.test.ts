// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Mortality (§1, §8, §15).
 *
 * The bug these tests exist to keep dead: a 365-day run in which three
 * inhabitants sat at hunger 100 and thirst 100 for a year, carrying food and
 * water, and finished in perfect health. `advanceNeeds` clamped the numbers and
 * nothing read them; `putCondition` was never called by any resolver; nothing
 * anywhere set `status: "dead"`.
 *
 * So the assertions below are deliberately concrete. They pin the *timings* of
 * the progression, not merely its existence — a model that produced conditions
 * but killed nobody, or killed everybody in an hour, would pass a vaguer suite.
 */
import { describe, expect, it } from "vitest";
import { MINUTES_PER_DAY, simTime, type SimTime } from "../time.js";
import { canonicalJson } from "../util/canonical.js";
import { computeStateChecksum } from "./checksum.js";
import {
  AILMENTS,
  RECOVERY_SPEEDUP,
  TERMINAL_SEVERITY,
  advanceHealth,
  minutesToDeath,
  needsWithinBounds,
  recoveryMinutesPerPoint,
  stageForSeverity,
  trendFor,
} from "./health.js";
import { checkInvariants, formatViolations } from "./invariants.js";
import { runAction, settleExpiredActivities } from "./resolvers/index.js";
import { worldTick } from "./resolvers/effects.js";
import { addTestInhabitant, forceInhabitant, founderOf, makeTestWorld } from "./test-support.js";
import { NEED_CEILING, type Condition, type Needs, type WorldState } from "./state.js";

const ailment = (kind: string) => {
  const found = AILMENTS.find((a) => a.kind === kind);
  if (found === undefined) throw new Error(`no ailment ${kind}`);
  return found;
};

const DEHYDRATION = ailment("dehydration");
const STARVATION = ailment("starvation");
const EXHAUSTION = ailment("exhaustion");

/** A one-inhabitant world whose founder has the given needs. */
function worldWithNeeds(needs: Partial<Needs>, seed = "health-seed"): WorldState {
  const base = makeTestWorld({ seed });
  const founder = founderOf(base);
  return forceInhabitant(base, {
    ...founder,
    needs: { hunger: 0, thirst: 0, fatigue: 0, social: 0, ...needs },
  });
}

/** Every unresolved condition of a kind the founder currently carries. */
function conditionsOf(state: WorldState, id: string, kind?: string): Condition[] {
  return Object.keys(state.conditions)
    .sort()
    .map((key) => state.conditions[key] as Condition)
    .filter((c) => c.subject === id && (kind === undefined || c.kind === kind));
}

const openCondition = (state: WorldState, id: string, kind: string): Condition | undefined =>
  conditionsOf(state, id, kind).find((c) => !c.resolved);

/**
 * Run the health tick forward in fixed steps, without any action being taken.
 *
 * This is the case the old engine could not express at all: nobody acts, so no
 * resolver runs, so nothing ever looked at the needs.
 */
function tickForward(
  start: WorldState,
  fromMinutes: number,
  toMinutes: number,
  stepMinutes: number,
): WorldState {
  let state = { ...start, simTime: simTime(fromMinutes) };
  let sequence = state.sequence;
  for (let t = fromMinutes + stepMinutes; t <= toMinutes; t += stepMinutes) {
    sequence += 1;
    const now = simTime(t);
    state = { ...advanceHealth({ ...state, simTime: now }, now, sequence).state, sequence };
  }
  return state;
}

describe("the ailment table (§8)", () => {
  it("keeps need progression ordering: thirst, then hunger, then sleep", () => {
    expect(DEHYDRATION.minutesPerSeverityPoint).toBeLessThan(
      STARVATION.minutesPerSeverityPoint,
    );
    expect(STARVATION.minutesPerSeverityPoint).toBeLessThan(
      EXHAUSTION.minutesPerSeverityPoint,
    );
  });

  it("keeps thirst and hunger as non-terminal trackers while exhaustion can still kill", () => {
    expect(DEHYDRATION.terminal).toBe(false);
    expect(STARVATION.terminal).toBe(false);
    expect(EXHAUSTION.terminal).toBe(true);
    expect((EXHAUSTION.minutesPerSeverityPoint * TERMINAL_SEVERITY) / MINUTES_PER_DAY).toBeGreaterThan(
      28,
    );
  });

  it("leaves the social need alone — isolation is not modelled as lethal", () => {
    expect(AILMENTS.some((a) => a.need === "social")).toBe(false);
  });

  it("recovers faster than it declines, so acting saves you", () => {
    for (const a of AILMENTS) {
      expect(recoveryMinutesPerPoint(a)).toBeLessThan(a.minutesPerSeverityPoint);
      expect(recoveryMinutesPerPoint(a) * RECOVERY_SPEEDUP).toBeLessThanOrEqual(
        a.minutesPerSeverityPoint,
      );
      expect(recoveryMinutesPerPoint(a)).toBeGreaterThanOrEqual(1);
    }
  });

  it("uses a hysteresis band so a wobbling need cannot flap the condition", () => {
    for (const a of AILMENTS) {
      expect(a.reliefThreshold).toBeLessThan(a.onsetThreshold);
      expect(trendFor(a, a.onsetThreshold)).toBe("worsening");
      expect(trendFor(a, a.reliefThreshold)).toBe("easing");
      expect(trendFor(a, a.onsetThreshold - 1)).toBe("holding");
    }
  });

  it("derives stage from severity, monotonically", () => {
    let previous = stageForSeverity(0);
    for (let s = 0; s <= TERMINAL_SEVERITY; s++) {
      expect(stageForSeverity(s)).toBeGreaterThanOrEqual(previous);
      previous = stageForSeverity(s);
    }
    expect(stageForSeverity(TERMINAL_SEVERITY)).toBe(3);
  });
});

describe("needs that bite (§8)", () => {
  it("raises no condition while a need is below the onset threshold", () => {
    const state = tickForward(worldWithNeeds({ thirst: 90 }), 0, 20_000, 500);
    expect(conditionsOf(state, "inh_founder")).toHaveLength(0);
  });

  it("opens a condition as soon as a need saturates", () => {
    const state = tickForward(worldWithNeeds({ thirst: NEED_CEILING }), 0, 10, 10);
    const condition = openCondition(state, "inh_founder", "dehydration");
    expect(condition).toBeDefined();
    expect(condition?.severity).toBe(1);
    expect(condition?.onsetAt).toBe(10);
    expect(condition?.diagnosedBy).toEqual([]);
    expect(condition?.disclosed).toBe(false);
    expect(state.inhabitants["inh_founder"]?.conditions).toContain(condition?.id);
  });

  it("worsens on the declared clock", () => {
    const after = 10 + DEHYDRATION.minutesPerSeverityPoint * 20;
    const state = tickForward(worldWithNeeds({ thirst: NEED_CEILING }), 0, after, 10);
    expect(openCondition(state, "inh_founder", "dehydration")?.severity).toBe(21);
  });

  it("carries the remainder, so tick spacing cannot change the progression", () => {
    // 5-minute ticks earn zero whole severity points each (5 / 43 = 0). Without
    // a carried remainder this inhabitant would be immortal.
    const onset = () => tickForward(worldWithNeeds({ thirst: NEED_CEILING }), 0, 5, 5);
    // Stopping just short of terminal, so the comparison is of the progression
    // itself rather than of two runs that both clamped at 100.
    const fine = tickForward(onset(), 5, 4005, 5);
    const coarse = tickForward(onset(), 5, 4005, 4000);
    const a = openCondition(fine, "inh_founder", "dehydration");
    const b = openCondition(coarse, "inh_founder", "dehydration");
    expect(a?.severity).toBeGreaterThan(90);
    expect(a?.severity).toBeLessThan(TERMINAL_SEVERITY);
    expect(b?.severity).toBe(a?.severity);
    expect(b?.progressedAt).toBe(a?.progressedAt);
    expect(fine.inhabitants["inh_founder"]?.status).toBe("alive");
  });

  it("anchors onset at the tick that noticed it, and never back-dates it", () => {
    // A condition cannot be created and advanced by the same tick: the world
    // does not know how long the need had been saturated before it looked, so
    // the progression starts from the moment it is seen. This is why a world
    // ticked once per week takes 100 ticks to kill, and a world ticked every
    // turn takes about three simulated days.
    const state = tickForward(worldWithNeeds({ thirst: NEED_CEILING }), 0, 10_000, 10_000);
    const condition = openCondition(state, "inh_founder", "dehydration");
    expect(condition?.severity).toBe(1);
    expect(condition?.onsetAt).toBe(10_000);
    expect(state.inhabitants["inh_founder"]?.status).toBe("alive");
  });

  it("raises a separate condition per saturated need", () => {
    const state = tickForward(
      worldWithNeeds({ thirst: 100, hunger: 100, fatigue: 100, social: 100 }),
      0,
      100,
      50,
    );
    const kinds = conditionsOf(state, "inh_founder").map((c) => c.kind).sort();
    expect(kinds).toEqual(["dehydration", "exhaustion", "starvation"]);
  });

  it("eases and then resolves when the need is relieved", () => {
    let state = tickForward(
      worldWithNeeds({ thirst: NEED_CEILING }),
      0,
      DEHYDRATION.minutesPerSeverityPoint * 50,
      100,
    );
    const ill = openCondition(state, "inh_founder", "dehydration");
    expect(ill?.severity).toBeGreaterThan(40);

    // Drink. §8: the condition must be survivable if the inhabitant acts.
    const founder = founderOf(state);
    state = forceInhabitant(state, { ...founder, needs: { ...founder.needs, thirst: 0 } });

    const recovered = tickForward(
      state,
      state.simTime,
      state.simTime + recoveryMinutesPerPoint(DEHYDRATION) * 200,
      100,
    );
    const after = state.conditions[ill?.id ?? ""] as Condition;
    const settled = recovered.conditions[ill?.id ?? ""] as Condition;
    expect(settled.severity).toBe(0);
    expect(settled.resolved).toBe(true);
    expect(after.severity).toBeGreaterThan(settled.severity);
    // §8: history is never deleted. The bout stays on the record.
    expect(recovered.inhabitants["inh_founder"]?.conditions).toContain(settled.id);
    expect(recovered.inhabitants["inh_founder"]?.status).toBe("alive");
  });

  it("stalls in the hysteresis band rather than banking progress", () => {
    const held = tickForward(worldWithNeeds({ thirst: NEED_CEILING }), 0, 100, 100);
    const founder = founderOf(held);
    const parked = forceInhabitant(held, {
      ...founder,
      needs: { ...founder.needs, thirst: DEHYDRATION.onsetThreshold - 1 },
    });
    const later = tickForward(parked, 100, 100_000, 500);
    const condition = openCondition(later, "inh_founder", "dehydration");
    expect(condition?.severity).toBe(1);
    expect(later.inhabitants["inh_founder"]?.status).toBe("alive");
  });
});

describe("death is real and irreversible (§1, §8)", () => {
  const dieOfFatigue = (): WorldState =>
    tickForward(worldWithNeeds({ fatigue: NEED_CEILING }), 0, 40 * MINUTES_PER_DAY, 60);

  it("kills an inhabitant who never rests, at about day thirty", () => {
    const state = dieOfFatigue();
    const dead = state.inhabitants["inh_founder"];
    expect(dead?.status).toBe("dead");
    expect(dead?.deathTime).not.toBeNull();
    const day = (dead?.deathTime ?? 0) / MINUTES_PER_DAY;
    expect(day).toBeGreaterThan(28);
    expect(day).toBeLessThan(31);
  });

  it("records both halves of the death event", () => {
    const dead = dieOfFatigue().inhabitants["inh_founder"];
    expect(dead?.deathTime).not.toBeNull();
    expect(dead?.deathSequence).not.toBeNull();
    expect(Number.isSafeInteger(dead?.deathSequence ?? NaN)).toBe(true);
  });

  it("closes the activity handle and schedules nothing after death", () => {
    const dead = dieOfFatigue().inhabitants["inh_founder"];
    expect(dead?.activity.activityId).toBeNull();
    expect(dead?.activity.state).toBe("idle");
    expect(dead?.nextEligibleTime).toBe(dead?.deathTime);
  });

  it("emits one neutral death event naming the condition, not a verdict", () => {
    let state = { ...worldWithNeeds({ fatigue: NEED_CEILING }), simTime: simTime(0) };
    let deathEvent: { type: string; resolution: unknown } | undefined;
    for (let t = 60; t <= 45 * MINUTES_PER_DAY && deathEvent === undefined; t += 60) {
      const now = simTime(t);
      const tick = advanceHealth({ ...state, simTime: now }, now, state.sequence + t / 60);
      state = tick.state;
      deathEvent = tick.events.find((e) => e.type === "inhabitant.died");
    }
    expect(deathEvent).toBeDefined();
    const detail = deathEvent?.resolution as Record<string, unknown>;
    expect(detail["kind"]).toBe("exhaustion");
    expect(detail["need"]).toBe("fatigue");
    expect(canonicalJson(detail)).not.toMatch(/tragic|sad|grief|murder|crime/i);
  });

  it("does not die from thirst or hunger saturation alone", () => {
    const thirsty = tickForward(worldWithNeeds({ thirst: NEED_CEILING }), 0, 60 * MINUTES_PER_DAY, 60);
    const hungry = tickForward(worldWithNeeds({ hunger: NEED_CEILING }), 0, 60 * MINUTES_PER_DAY, 60);
    expect(thirsty.inhabitants["inh_founder"]?.status).toBe("alive");
    expect(hungry.inhabitants["inh_founder"]?.status).toBe("alive");
    expect(dieOfFatigue().inhabitants["inh_founder"]?.status).toBe("dead");
  });

  it("is survivable: an inhabitant who rests on day two lives", () => {
    let state = tickForward(worldWithNeeds({ fatigue: NEED_CEILING }), 0, 2 * MINUTES_PER_DAY, 60);
    expect(state.inhabitants["inh_founder"]?.status).toBe("alive");
    const founder = founderOf(state);
    state = forceInhabitant(state, { ...founder, needs: { ...founder.needs, fatigue: 0 } });
    const later = tickForward(state, state.simTime, 30 * MINUTES_PER_DAY, 60);
    expect(later.inhabitants["inh_founder"]?.status).toBe("alive");
  });

  it("stops progressing a dead inhabitant's conditions", () => {
    const dead = dieOfFatigue();
    const atDeath = canonicalJson(dead.conditions);
    const later = tickForward(dead, dead.simTime, 60 * MINUTES_PER_DAY, 600);
    expect(canonicalJson(later.conditions)).toBe(atDeath);
    expect(canonicalJson(later.inhabitants)).toBe(canonicalJson(dead.inhabitants));
  });

  it("reports how long a saturated inhabitant has left", () => {
    const state = tickForward(worldWithNeeds({ fatigue: NEED_CEILING }), 0, 10, 10);
    expect(minutesToDeath(state, "inh_founder")).toBe(
      (TERMINAL_SEVERITY - 1) * EXHAUSTION.minutesPerSeverityPoint,
    );
    expect(minutesToDeath(worldWithNeeds({}), "inh_founder")).toBeNull();
    expect(minutesToDeath(dieOfFatigue(), "inh_founder")).toBeNull();
  });
});

describe("§8 death must never delete history", () => {
  /** A founder with belongings, a neighbour, memories and a relationship. */
  function populatedWorld(): WorldState {
    let state = makeTestWorld({ seed: "history-seed" });
    const founder = founderOf(state);
    state = addTestInhabitant(state, {
      id: "inh_second",
      displayName: "Second",
      location: founder.location,
      inventory: { energy: 700, food: 6, water: 6 },
    });
    // A real interaction, so there are memories to preserve.
    state = runAction({
      state,
      actorId: "inh_founder",
      action: { type: "announce", payload: { text: "I am here." } },
      simTime: simTime(1),
      sequence: state.sequence + 1,
    }).state;
    const withNeeds = state.inhabitants["inh_founder"];
    if (withNeeds === undefined) throw new Error("no founder");
    return forceInhabitant(state, {
      ...withNeeds,
      needs: { ...withNeeds.needs, fatigue: NEED_CEILING },
      beliefs: { inh_second: "keeps their word" },
      relationships: {
        inh_second: {
          other: "inh_second",
          familiarity: 40,
          trust: 25,
          lastInteraction: simTime(1),
        },
      },
    });
  }

  it("preserves memories, relationships and lineage while moving property into lootable remains", () => {
    const before = populatedWorld();
    const living = before.inhabitants["inh_founder"];
    if (living === undefined) throw new Error("no founder");
    expect(Object.keys(before.memories).length).toBeGreaterThan(0);
    expect(Object.keys(living.relationships).length).toBeGreaterThan(0);

    const after = tickForward(before, before.simTime, 40 * MINUTES_PER_DAY, 60);
    const corpse = after.inhabitants["inh_founder"];
    expect(corpse?.status).toBe("dead");

    const remains = after.remains[`rem_${living.id}`];
    expect(corpse?.inventory).toEqual({});
    expect(corpse?.concealed).toEqual({});
    expect(corpse?.exposed).toEqual({});
    expect(remains?.inventory).toMatchObject({ food: living.inventory.food, water: living.inventory.water });
    expect(canonicalJson(corpse?.relationships)).toBe(canonicalJson(living.relationships));
    expect(canonicalJson(corpse?.beliefs)).toBe(canonicalJson(living.beliefs));
    expect(canonicalJson(corpse?.skills)).toBe(canonicalJson(living.skills));
    expect(canonicalJson(corpse?.parents)).toBe(canonicalJson(living.parents));
    expect(canonicalJson(corpse?.memberships)).toBe(canonicalJson(living.memberships));
    expect(canonicalJson(corpse?.contracts)).toBe(canonicalJson(living.contracts));
    expect(corpse?.reputation).toBe(living.reputation);
    expect(corpse?.creationSequence).toBe(living.creationSequence);
    expect(corpse?.birthTime).toBe(living.birthTime);
    expect(canonicalJson(corpse?.location)).toBe(canonicalJson(living.location));

    // Memories are untouched, both the dead one's own and everyone else's.
    expect(canonicalJson(after.memories)).toBe(canonicalJson(before.memories));
    // The announcement is still in the public record.
    expect(canonicalJson(after.publicRecords)).toBe(canonicalJson(before.publicRecords));
  });

  it("does not redistribute the dead's property (§8 leaves that to survivors)", () => {
    const before = populatedWorld();
    const after = tickForward(before, before.simTime, 40 * MINUTES_PER_DAY, 60);
    expect(after.inhabitants["inh_founder"]?.status).toBe("dead");
    expect(canonicalJson(after.inhabitants["inh_second"]?.inventory)).toBe(
      canonicalJson(before.inhabitants["inh_second"]?.inventory),
    );
    // §15: death creates and destroys nothing. The corpse keeps its food.
    expect(canonicalJson(after.ledger)).toBe(canonicalJson(before.ledger));
    expect(formatViolations(
      checkInvariants(after).filter((v) => v.invariant === "conserved_resource_totals"),
    )).toBe("");
  });

  it("leaves the world satisfying every invariant", () => {
    const after = tickForward(populatedWorld(), 1, 40 * MINUTES_PER_DAY, 60);
    expect(formatViolations(checkInvariants(after))).toBe("");
  });

  it("holds every invariant at every step of the dying, not only at the end", () => {
    let state = { ...populatedWorld(), simTime: simTime(1) };
    for (let t = 61; t <= 40 * MINUTES_PER_DAY; t += 60) {
      const now = simTime(t);
      state = {
        ...advanceHealth({ ...state, simTime: now }, now, state.sequence + 1).state,
        sequence: state.sequence + 1,
      };
      expect(formatViolations(checkInvariants(state)), `at minute ${t}`).toBe("");
    }
    expect(state.inhabitants["inh_founder"]?.status).toBe("dead");
  });
});

describe("§15 inhabitants cannot act after death", () => {
  it("rejects the dead actor's turns with DEAD, from the killing turn onwards", () => {
    // The tick runs inside `runAction` itself, so the very turn on which the
    // progression runs out is also the turn the death guard refuses.
    let state = worldWithNeeds({ fatigue: NEED_CEILING });
    let now: SimTime = simTime(0);
    let killingOutcome: unknown;
    for (let turn = 0; turn < 900; turn++) {
      now = simTime(now + 60);
      const result = runAction({
        state,
        actorId: "inh_founder",
        action: { type: "wait", payload: { minutes: 5 } },
        simTime: now,
        sequence: state.sequence + 1,
      });
      state = result.state;
      if (state.inhabitants["inh_founder"]?.status === "dead") {
        killingOutcome = result.outcome;
        break;
      }
    }
    expect(state.inhabitants["inh_founder"]?.status).toBe("dead");
    expect(killingOutcome).toMatchObject({ status: "rejected", code: "DEAD" });

    const later = runAction({
      state,
      actorId: "inh_founder",
      action: { type: "gather", payload: {} },
      simTime: simTime(now + 10_000),
      sequence: state.sequence + 1,
    });
    expect(later.outcome).toMatchObject({ code: "DEAD" });
    const corpse = later.state.inhabitants["inh_founder"];
    expect(corpse?.lastActionTime ?? 0).toBeLessThanOrEqual(corpse?.deathTime ?? 0);
    expect(corpse?.nextEligibleTime ?? 0).toBeLessThanOrEqual(corpse?.deathTime ?? 0);
  });

  it("kills through the ordinary turn path, with no special caller support", () => {
    // `settleExpiredActivities` keeps its old name and signature, so the
    // existing pipeline gains mortality without being edited.
    let state = { ...worldWithNeeds({ fatigue: NEED_CEILING }), simTime: simTime(0) };
    for (let t = 60; t <= 40 * MINUTES_PER_DAY; t += 60) {
      state = settleExpiredActivities({ ...state, simTime: simTime(t) }, simTime(t));
    }
    expect(state.inhabitants["inh_founder"]?.status).toBe("dead");
  });

  it("returns the death event when the caller asks for it", () => {
    // Run to the brink through the discarding path, then take the last step
    // through `worldTick`, which hands the caller the events.
    let state = { ...worldWithNeeds({ fatigue: NEED_CEILING }), simTime: simTime(0) };
    let t = 0;
    while (state.inhabitants["inh_founder"]?.status === "alive" && t < 40 * MINUTES_PER_DAY) {
      t += 60;
      const previous = state;
      state = settleExpiredActivities({ ...state, simTime: simTime(t) }, simTime(t));
      if (state.inhabitants["inh_founder"]?.status === "dead") {
        const tick = worldTick({ ...previous, simTime: simTime(t) }, simTime(t), 99);
        expect(tick.events.map((e) => e.type)).toContain("inhabitant.died");
        expect(tick.state.inhabitants["inh_founder"]?.deathSequence).toBe(99);
        return;
      }
    }
    throw new Error("the inhabitant never died");
  });
});

describe("§15 replayed history produces an identical state checksum", () => {
  /** Drive a world to extinction twice through the public turn entry point. */
  function starveRun(seed: string): { checksums: string[]; final: WorldState } {
    let state = worldWithNeeds({ fatigue: NEED_CEILING }, seed);
    const checksums = [computeStateChecksum(state)];
    let now: SimTime = simTime(0);
    for (let turn = 0; turn < 900; turn++) {
      now = simTime(now + 60);
      state = runAction({
        state,
        actorId: "inh_founder",
        action: { type: "wait", payload: { minutes: 5 } },
        simTime: now,
        sequence: state.sequence + 1,
      }).state;
      checksums.push(computeStateChecksum(state));
    }
    return { checksums, final: state };
  }

  it("two runs of the same dying world agree at every step", () => {
    const a = starveRun("replay-seed");
    const b = starveRun("replay-seed");
    expect(b.checksums).toEqual(a.checksums);
    expect(canonicalJson(b.final)).toBe(canonicalJson(a.final));
    expect(a.final.inhabitants["inh_founder"]?.status).toBe("dead");
  });

  it("uses no randomness, so the same needs always die at the same instant", () => {
    const first = starveRun("replay-seed").final.inhabitants["inh_founder"]?.deathTime;
    const second = starveRun("a-completely-different-seed").final.inhabitants["inh_founder"]
      ?.deathTime;
    expect(first).toBe(second);
  });
});

describe("§8 the year-one failure, end to end", () => {
  /**
   * The exact scenario that produced the bug report: inhabitants who carry food
   * and water, never consume any of it, and whose needs sit at the ceiling.
   * Before this module they survived 365 days untouched.
   */
  it("kills three inhabitants who hold supplies but never use them", () => {
    let state = makeTestWorld({ seed: "year-one" });
    const founder = founderOf(state);
    state = addTestInhabitant(state, {
      id: "inh_b",
      displayName: "B",
      location: founder.location,
      inventory: { energy: 500, food: 40, water: 40 },
    });
    state = addTestInhabitant(state, {
      id: "inh_c",
      displayName: "C",
      location: founder.location,
      inventory: { energy: 500, food: 40, water: 40 },
    });
    for (const id of ["inh_founder", "inh_b", "inh_c"]) {
      const person = state.inhabitants[id];
      if (person === undefined) throw new Error(`missing ${id}`);
      state = forceInhabitant(state, {
        ...person,
        needs: { hunger: NEED_CEILING, thirst: NEED_CEILING, fatigue: NEED_CEILING, social: 0 },
      });
    }

    const timeline: Record<string, number> = {};
    let now: SimTime = simTime(0);
    for (let turn = 0; turn < 365 * 4 && Object.keys(timeline).length < 3; turn++) {
      now = simTime(now + 360);
      const actor = ["inh_founder", "inh_b", "inh_c"][turn % 3] as string;
      state = runAction({
        state,
        actorId: actor,
        action: { type: "wait", payload: { minutes: 5 } },
        simTime: now,
        sequence: state.sequence + 1,
      }).state;
      for (const id of ["inh_founder", "inh_b", "inh_c"]) {
        const person = state.inhabitants[id];
        if (person?.status === "dead" && timeline[id] === undefined) {
          timeline[id] = person.deathTime ?? 0;
        }
      }
    }

    expect(Object.keys(timeline).sort()).toEqual(["inh_b", "inh_c", "inh_founder"]);
    for (const id of Object.keys(timeline)) {
      const days = (timeline[id] ?? 0) / MINUTES_PER_DAY;
      expect(days, `${id} died on day ${days}`).toBeGreaterThan(28);
      expect(days, `${id} died on day ${days}`).toBeLessThan(31);
      // Their unused provisions remain recoverable on the tile where they died.
      expect(state.remains[`rem_${id}`]?.inventory.food ?? 0).toBeGreaterThan(0);
      expect(state.remains[`rem_${id}`]?.inventory.water ?? 0).toBeGreaterThan(0);
    }
    expect(formatViolations(checkInvariants(state))).toBe("");
  });
});

describe("maturity advances with world time", () => {
  it("raises newborns to adult stage and then caps them there", () => {
    const seed = makeTestWorld();
    const base = {
      ...addTestInhabitant(seed, {
        id: "inh_newborn",
        location: founderOf(seed).location,
        parents: ["inh_founder"],
        birthTime: simTime(0),
        creationSequence: 1,
        maturity: 0,
      }),
      sequence: 1,
      simTime: simTime(0),
    };

    const oneDay = worldTick(base, simTime(MINUTES_PER_DAY), 2).state;
    const twoDays = worldTick(oneDay, simTime(2 * MINUTES_PER_DAY), 3).state;
    const adult = worldTick(twoDays, simTime(3 * MINUTES_PER_DAY), 4).state;
    const later = worldTick(adult, simTime(10 * MINUTES_PER_DAY), 5).state;

    expect(oneDay.inhabitants["inh_newborn"]?.maturity).toBe(1);
    expect(twoDays.inhabitants["inh_newborn"]?.maturity).toBe(2);
    expect(adult.inhabitants["inh_newborn"]?.maturity).toBe(3);
    expect(later.inhabitants["inh_newborn"]?.maturity).toBe(3);
    expect(formatViolations(checkInvariants(later))).toBe("");
  });
});

describe("needs stay inside their declared bounds", () => {
  it("accepts a bounded need set and rejects anything outside it", () => {
    expect(needsWithinBounds({ hunger: 0, thirst: NEED_CEILING, fatigue: 50, social: 1 })).toBe(true);
    expect(needsWithinBounds({ hunger: -1, thirst: 0, fatigue: 0, social: 0 })).toBe(false);
    expect(
      needsWithinBounds({ hunger: NEED_CEILING + 1, thirst: 0, fatigue: 0, social: 0 }),
    ).toBe(false);
    expect(needsWithinBounds({ hunger: 1.5, thirst: 0, fatigue: 0, social: 0 })).toBe(false);
  });
});
