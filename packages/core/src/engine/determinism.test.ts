// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * The property that the whole platform rests on (§15, §16, §28).
 *
 * §15: "Replayed history produces an identical state checksum."
 * §28: "Reconstructed and production checksums match."
 *
 * The test below drives a long, varied, deliberately hostile sequence of
 * actions through the engine twice and asserts the two runs agree at every
 * step, not merely at the end. Agreeing only at the end would hide a pair of
 * divergences that happened to cancel out.
 *
 * The action script is itself generated from a seeded `Rng`, so it is a fixed
 * sequence — "random" in shape, identical on every run and on every machine.
 * That is exactly the situation replay faces: the *same* recorded decisions
 * fed to the engine a second time must produce the same world.
 */
import { describe, expect, it } from "vitest";
import { ACTION_TYPES, type ActionType } from "../schema/action-spec.js";
import { RESOURCE_KINDS } from "../schema/primitives.js";
import { simTime, type SimTime } from "../time.js";
import { canonicalJson } from "../util/canonical.js";
import { Rng } from "../util/rng.js";
import { computeStateChecksum } from "./checksum.js";
import { checkInvariants, formatViolations } from "./invariants.js";
import { runAction } from "./resolvers/index.js";
import { addTestInhabitant, makeTestWorld, founderOf } from "./test-support.js";
import type { WorldState } from "./state.js";

interface ScriptedTurn {
  readonly actorId: string;
  readonly type: ActionType;
  readonly payload: unknown;
  readonly advanceMinutes: number;
}

/**
 * Build a fixed script of turns from a seed.
 *
 * The mix is deliberate: mostly slice actions so the world actually evolves,
 * plus unimplemented actions and malformed payloads so that the rejection paths
 * are exercised too. A determinism test that only ever took the happy path
 * would not prove much.
 */
function buildScript(seed: string, count: number, actors: readonly string[]): ScriptedTurn[] {
  const rng = Rng.derive(seed, "test", "script");
  const weighted: readonly (readonly [ActionType, number])[] = [
    ["observe", 14],
    ["move", 22],
    ["gather", 22],
    ["consume", 12],
    ["rest", 12],
    ["wait", 12],
    // Rejection paths.
    ["build", 2],
    ["create_inhabitant", 2],
    ["transfer_currency", 1],
    ["impose_confinement", 1],
  ];

  const turns: ScriptedTurn[] = [];
  for (let i = 0; i < count; i++) {
    const type = rng.pickWeighted(weighted);
    const actorId = rng.pick(actors);
    let payload: unknown = {};
    switch (type) {
      case "move":
        payload = { to: { x: rng.nextBelow(32), y: rng.nextBelow(32) } };
        break;
      case "gather":
        payload = rng.chance(1, 2) ? {} : { resource: rng.pick(RESOURCE_KINDS) };
        break;
      case "consume":
        payload = { resource: rng.chance(1, 2) ? "food" : "water", amount: rng.nextInt(1, 4) };
        break;
      case "rest":
        payload = { minutes: rng.nextInt(1, 480) };
        break;
      case "wait":
        payload = { minutes: rng.nextInt(1, 240) };
        break;
      default:
        // Malformed on purpose, a third of the time.
        payload = rng.chance(1, 3) ? null : {};
        break;
    }
    turns.push({ actorId, type, payload, advanceMinutes: rng.nextInt(0, 90) });
  }
  return turns;
}

interface RunTrace {
  readonly finalState: WorldState;
  readonly checksums: readonly string[];
  readonly outcomes: readonly string[];
  readonly events: readonly string[];
}

/** Replay a script against a fresh world, recording a checksum after every turn. */
function runScript(script: readonly ScriptedTurn[], seed: string): RunTrace {
  let state = seedWorld(seed);
  const checksums: string[] = [computeStateChecksum(state)];
  const outcomes: string[] = [];
  const events: string[] = [];
  let now: SimTime = state.simTime;

  for (const turn of script) {
    now = simTime(now + turn.advanceMinutes);
    const result = runAction({
      state,
      actorId: turn.actorId,
      action: { type: turn.type, payload: turn.payload },
      simTime: now,
      sequence: state.sequence + 1,
    });
    state = result.state;
    outcomes.push(canonicalJson(result.outcome));
    events.push(canonicalJson(result.events.map((e) => ({ ...e, resolution: e.resolution ?? null }))));
    checksums.push(computeStateChecksum(state));
  }
  return { finalState: state, checksums, outcomes, events };
}

/** A two-inhabitant world. Both start beside each other so they interact. */
function seedWorld(seed: string): WorldState {
  const base = makeTestWorld({ seed });
  const founder = founderOf(base);
  return addTestInhabitant(base, {
    id: "inh_second",
    displayName: "Second",
    location: founder.location,
    inventory: { energy: 700, food: 6, water: 6 },
  });
}

const ACTORS = ["inh_founder", "inh_second"] as const;

describe("§15 replayed history produces an identical state checksum", () => {
  const script = buildScript("determinism-seed", 500, ACTORS);

  it("builds a 500-turn script", () => {
    expect(script).toHaveLength(500);
  });

  it("two independent runs agree on the final checksum", () => {
    const a = runScript(script, "determinism-seed");
    const b = runScript(script, "determinism-seed");
    expect(b.checksums.at(-1)).toBe(a.checksums.at(-1));
  });

  it("two independent runs agree at every single step", () => {
    const a = runScript(script, "determinism-seed");
    const b = runScript(script, "determinism-seed");
    expect(b.checksums).toEqual(a.checksums);
    for (let i = 0; i < a.checksums.length; i++) {
      expect(b.checksums[i], `divergence at turn ${i}`).toBe(a.checksums[i]);
    }
  });

  it("two independent runs produce identical outcomes and events", () => {
    const a = runScript(script, "determinism-seed");
    const b = runScript(script, "determinism-seed");
    expect(b.outcomes).toEqual(a.outcomes);
    expect(b.events).toEqual(a.events);
  });

  it("the final states are byte-identical under canonical encoding", () => {
    const a = runScript(script, "determinism-seed");
    const b = runScript(script, "determinism-seed");
    expect(canonicalJson(b.finalState)).toBe(canonicalJson(a.finalState));
  });

  it("the world actually changed — otherwise determinism is trivial", () => {
    const a = runScript(script, "determinism-seed");
    expect(a.checksums.at(-1)).not.toBe(a.checksums[0]);
    // A meaningful number of distinct states were visited.
    expect(new Set(a.checksums).size).toBeGreaterThan(50);
    expect(a.finalState.sequence).toBe(500);
    expect(a.finalState.simTime).toBeGreaterThan(0);
  });

  it("a healthy mix of actions resolved and were rejected", () => {
    const a = runScript(script, "determinism-seed");
    const resolved = a.outcomes.filter((o) => o.includes('"status":"resolved"')).length;
    const rejected = a.outcomes.filter((o) => o.includes('"status":"rejected"')).length;
    expect(resolved).toBeGreaterThan(50);
    expect(rejected).toBeGreaterThan(50);
    expect(resolved + rejected).toBe(500);
  });

  it("every invariant still holds after 500 turns", () => {
    const a = runScript(script, "determinism-seed");
    expect(formatViolations(checkInvariants(a.finalState))).toBe("");
  });

  it("invariants hold at EVERY turn, not just at the end", () => {
    let state = seedWorld("determinism-seed");
    let now: SimTime = state.simTime;
    for (let i = 0; i < script.length; i++) {
      const turn = script[i] as ScriptedTurn;
      now = simTime(now + turn.advanceMinutes);
      state = runAction({
        state,
        actorId: turn.actorId,
        action: { type: turn.type, payload: turn.payload },
        simTime: now,
        sequence: state.sequence + 1,
      }).state;
      const violations = checkInvariants(state);
      expect(formatViolations(violations), `after turn ${i} (${turn.type})`).toBe("");
    }
  });

  it("a different world seed produces a different history", () => {
    const a = runScript(script, "determinism-seed");
    const b = runScript(script, "different-seed");
    expect(b.checksums.at(-1)).not.toBe(a.checksums.at(-1));
  });

  it("resolution never depends on wall-clock time", () => {
    // Two runs separated by real time must still agree. If any resolver read
    // Date.now(), this is where it would show.
    const a = runScript(script.slice(0, 120), "determinism-seed");
    const start = Date.now();
    while (Date.now() - start < 15) {
      /* burn a little real time */
    }
    const b = runScript(script.slice(0, 120), "determinism-seed");
    expect(b.checksums).toEqual(a.checksums);
  });
});

describe("determinism across action shapes", () => {
  it("holds for a script drawn from every action type", () => {
    const rng = Rng.derive("all-actions", "script");
    const script: ScriptedTurn[] = ACTION_TYPES.flatMap((type) => [
      { actorId: "inh_founder", type, payload: {}, advanceMinutes: rng.nextInt(0, 200) },
      { actorId: "inh_second", type, payload: null, advanceMinutes: rng.nextInt(0, 200) },
    ]);
    const a = runScript(script, "all-actions");
    const b = runScript(script, "all-actions");
    expect(a.checksums).toEqual(b.checksums);
    expect(formatViolations(checkInvariants(a.finalState))).toBe("");
  });

  it("holds across several independent world seeds", () => {
    for (const seed of ["multi-1", "multi-2", "multi-3"]) {
      const script = buildScript(seed, 120, ACTORS);
      expect(runScript(script, seed).checksums).toEqual(runScript(script, seed).checksums);
    }
  });
});

describe("conservation over a long run (§5, §15)", () => {
  it("the conserved-resource equation balances after 500 turns", () => {
    const script = buildScript("conservation-seed", 500, ACTORS);
    const { finalState } = runScript(script, "conservation-seed");
    // `conservedResourceTotals` is the check; asserting an empty violation list
    // for it specifically makes the failure message point at the right rule.
    const violations = checkInvariants(finalState).filter(
      (v) => v.invariant === "conserved_resource_totals",
    );
    expect(formatViolations(violations)).toBe("");
  });

  it("food is genuinely destroyed by eating, not merely moved", () => {
    const script = buildScript("sink-seed", 300, ACTORS);
    const { finalState } = runScript(script, "sink-seed");
    expect(finalState.ledger.destroyed.food ?? 0).toBeGreaterThan(0);
  });
});
