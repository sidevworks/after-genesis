// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Memory tests (§19, §11B).
 *
 * Three properties are checked here, in rough order of how badly the world
 * breaks if they fail:
 *
 *  1. Retrieval is deterministic and integer-only. A score that varied would
 *     change which memories entered the prompt, which would change the request
 *     hash, which would break replay.
 *  2. The budget genuinely binds, and binds harder for the young (§11B).
 *  3. Reflections are beliefs. Nothing mutates a stored memory, and revising a
 *     belief creates a new record (§19).
 */
import { describe, expect, it } from "vitest";
import {
  beliefHistory,
  createReflection,
  estimateTokens,
  isBelief,
  isObservedMemory,
  maturityScalePercent,
  recencyScore,
  retrievalBudget,
  retrieveMemories,
  reviseReflection,
  scoreMemory,
  weightsFor,
  type MemoryRecord,
  type Reflection,
} from "./memory.js";
import { lcg, makeMemories, makeRetrievalContext, shuffle } from "./testing.js";

describe("scoring is integer-only", () => {
  it("produces integers for every signal and the total", () => {
    const context = makeRetrievalContext();
    for (const record of makeMemories()) {
      const score = scoreMemory(record, context, 4_320);
      for (const [key, value] of Object.entries(score)) {
        expect(Number.isSafeInteger(value), `${key} = ${value}`).toBe(true);
      }
    }
  });

  it("keeps every signal within 0..100", () => {
    const context = makeRetrievalContext();
    for (const record of makeMemories()) {
      const { total, ...signals } = scoreMemory(record, context, 4_320);
      expect(total).toBeGreaterThanOrEqual(0);
      for (const value of Object.values(signals)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });

  it("uses weight profiles that sum to 100", () => {
    for (const level of ["reaction", "routine", "conversation", "planning", "reflection", "study"] as const) {
      const weights = weightsFor(level);
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      expect(sum, level).toBe(100);
    }
  });

  it("is a pure function of its inputs", () => {
    const context = makeRetrievalContext();
    const record = makeMemories()[0] as MemoryRecord;
    expect(scoreMemory(record, context, 1_000)).toEqual(scoreMemory(record, context, 1_000));
  });
});

describe("recencyScore", () => {
  it("is 100 at zero age and 0 beyond the horizon", () => {
    expect(recencyScore(0, 1_000)).toBe(100);
    expect(recencyScore(1_000, 1_000)).toBe(0);
    expect(recencyScore(5_000, 1_000)).toBe(0);
  });

  it("decays monotonically without floating point", () => {
    let previous = 101;
    for (let age = 0; age <= 1_000; age += 37) {
      const score = recencyScore(age, 1_000);
      expect(Number.isSafeInteger(score)).toBe(true);
      expect(score).toBeLessThanOrEqual(previous);
      previous = score;
    }
  });

  it("treats a zero horizon as no recency signal rather than dividing by zero", () => {
    expect(recencyScore(10, 0)).toBe(0);
  });
});

describe("retrieval determinism", () => {
  it("is insensitive to candidate ordering", () => {
    const context = makeRetrievalContext();
    const baseline = retrieveMemories(makeMemories(), context);
    const next = lcg(7);
    for (let run = 0; run < 50; run++) {
      const shuffled = retrieveMemories(shuffle(makeMemories(), next), context);
      expect(shuffled.selected.map((s) => s.record.id)).toEqual(
        baseline.selected.map((s) => s.record.id),
      );
    }
  });

  it("does not mutate the candidate array", () => {
    const candidates = makeMemories();
    const before = candidates.map((c) => c.id);
    retrieveMemories(candidates, makeRetrievalContext());
    expect(candidates.map((c) => c.id)).toEqual(before);
  });
});

describe("retrieval budget (§19: keep inference costs bounded)", () => {
  it("caps by record count", () => {
    const many: MemoryRecord[] = Array.from({ length: 500 }, (_, i) => ({
      tier: "episodic",
      epistemicStatus: "observed",
      id: `mem_${String(i).padStart(4, "0")}`,
      simTime: 14_000 - i,
      content: "Something happened.",
      tags: ["food"],
      participants: ["inh_bravo"],
      location: { x: 6, y: 9 },
      significance: 50,
      provenance: "observed",
      eventSequence: i,
    }));
    const result = retrieveMemories(many, makeRetrievalContext());
    expect(result.selected.length).toBeLessThanOrEqual(result.budget.maxRecords);
    expect(result.droppedCount).toBeGreaterThan(400);
  });

  it("caps by estimated tokens even when the record count would allow more", () => {
    const fat: MemoryRecord[] = Array.from({ length: 20 }, (_, i) => ({
      tier: "episodic",
      epistemicStatus: "observed",
      id: `mem_${i}`,
      simTime: 14_000,
      content: "x".repeat(4_000),
      tags: ["food"],
      participants: [],
      location: null,
      significance: 90,
      provenance: "observed",
      eventSequence: i,
    }));
    const result = retrieveMemories(fat, makeRetrievalContext());
    expect(result.selected.length).toBeLessThan(result.budget.maxRecords);
    expect(result.estimatedTokens).toBeLessThanOrEqual(
      result.budget.maxEstimatedTokens + 4_000,
    );
  });

  it("always keeps some working memory, so an inhabitant has continuity", () => {
    const result = retrieveMemories(makeMemories(), makeRetrievalContext());
    const reserved = result.selected.filter((s) => s.admission === "reserved");
    expect(reserved.length).toBeGreaterThan(0);
  });
});

describe("maturity scaling (§11B)", () => {
  it("gives the young smaller budgets and shorter horizons", () => {
    const child = retrievalBudget("planning", 0);
    const adult = retrievalBudget("planning", 5);
    expect(child.maxRecords).toBeLessThan(adult.maxRecords);
    expect(child.maxEstimatedTokens).toBeLessThan(adult.maxEstimatedTokens);
    expect(child.horizonMinutes).toBeLessThan(adult.horizonMinutes);
  });

  it("expands monotonically with development", () => {
    let previous = 0;
    for (let maturity = 0; maturity <= 6; maturity++) {
      const percent = maturityScalePercent(maturity);
      expect(percent).toBeGreaterThanOrEqual(previous);
      previous = percent;
    }
    expect(maturityScalePercent(99)).toBe(100);
  });

  it("never scales an adult above the base budget", () => {
    expect(retrievalBudget("routine", 100).maxRecords).toBe(
      retrievalBudget("routine", 5).maxRecords,
    );
  });

  it("keeps at least one memory and one working record even for a newborn", () => {
    const newborn = retrievalBudget("reaction", 0);
    expect(newborn.maxRecords).toBeGreaterThanOrEqual(1);
    expect(newborn.reservedWorkingRecords).toBeGreaterThanOrEqual(1);
  });

  it("produces only integer budgets", () => {
    for (let maturity = 0; maturity <= 6; maturity++) {
      const budget = retrievalBudget("conversation", maturity);
      for (const value of Object.values(budget)) {
        expect(Number.isSafeInteger(value)).toBe(true);
      }
    }
  });

  it("gives a deeper cognition level a larger budget", () => {
    expect(retrievalBudget("reflection", 5).maxRecords).toBeGreaterThan(
      retrievalBudget("reaction", 5).maxRecords,
    );
  });
});

describe("reflections are beliefs, not facts (§19)", () => {
  const draft = {
    id: "mem_r2",
    simTime: 20_000,
    content: "Bracken is fair after all.",
    tags: ["bracken", "trust"],
    participants: ["inh_bravo"],
    location: null,
    significance: 60,
    confidence: 40,
    derivedFrom: ["mem_e1"],
  };

  it("types a reflection as a belief and an episodic memory as observed", () => {
    const reflection = createReflection(draft);
    expect(isBelief(reflection)).toBe(true);
    expect(isObservedMemory(reflection)).toBe(false);

    const episodic = makeMemories().find((m) => m.tier === "episodic");
    expect(episodic).toBeDefined();
    if (episodic) {
      expect(isObservedMemory(episodic)).toBe(true);
      expect(isBelief(episodic)).toBe(false);
    }
  });

  it("gives a reflection no event sequence to be mistaken for", () => {
    const reflection = createReflection(draft) as unknown as Record<string, unknown>;
    expect(reflection["eventSequence"]).toBeUndefined();
  });

  it("freezes the record, so a caller cannot quietly edit history", () => {
    const reflection = createReflection(draft);
    expect(Object.isFrozen(reflection)).toBe(true);
    expect(() => {
      (reflection as unknown as { confidence: number }).confidence = 100;
    }).toThrow(TypeError);
  });

  it("creates a NEW record when a belief changes, leaving the old one intact", () => {
    const original = createReflection({ ...draft, id: "mem_r1", content: "Bracken cannot be trusted." });
    const revised = reviseReflection(original, draft);

    expect(revised.id).not.toBe(original.id);
    expect(revised.supersedes).toBe(original.id);
    // The original is untouched: the audit can still show what was believed.
    expect(original.content).toBe("Bracken cannot be trusted.");
    expect(original.supersedes).toBeNull();
  });

  it("reconstructs the chain of changed beliefs, newest first", () => {
    const first = createReflection({ ...draft, id: "r1", content: "a" });
    const second = reviseReflection(first, { ...draft, id: "r2", content: "b" });
    const third = reviseReflection(second, { ...draft, id: "r3", content: "c" });
    const chain = beliefHistory(third, [first, second, third]);
    expect(chain.map((r) => r.id)).toEqual(["r3", "r2", "r1"]);
  });

  it("terminates on a cyclic supersedes chain rather than hanging", () => {
    const a: Reflection = { ...createReflection({ ...draft, id: "a" }), supersedes: "b" };
    const b: Reflection = { ...createReflection({ ...draft, id: "b" }), supersedes: "a" };
    expect(beliefHistory(a, [a, b]).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("sorts its collections, so two equal reflections encode identically", () => {
    const one = createReflection({ ...draft, tags: ["b", "a"], derivedFrom: ["y", "x"] });
    const two = createReflection({ ...draft, tags: ["a", "b"], derivedFrom: ["x", "y"] });
    expect(one).toEqual(two);
  });
});

describe("estimateTokens", () => {
  it("never under-counts", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("returns an integer for a large string", () => {
    expect(Number.isSafeInteger(estimateTokens("x".repeat(1_000_003)))).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* Repetition does not consume the budget                                     */
/* ------------------------------------------------------------------------- */

/**
 * Reconstructed from the first hundred-day run.
 *
 * The founder's day-100 planning turn retrieved sixteen memories, and all
 * sixteen were the same sentence: it had observed, and seen the same three kinds
 * of terrain. Everything else it had ever done — gathering, moving, the four
 * research notes it wrote — lost every retrieval slot to copies of one event.
 */
function observeMemory(id: string, simTime: number): MemoryRecord {
  return {
    tier: "episodic",
    epistemicStatus: "observed",
    id,
    simTime,
    content:
      "You performed observe with payload {}. Outcome: resolved. " +
      "You saw: fertile at (8, 2); forest at (10, 4); plains at (6, 0).",
    tags: ["fertile", "forest", "observe", "plains"],
    participants: [],
    location: { x: 10, y: 4 },
    significance: 50,
    eventSequence: simTime,
    provenance: "observed",
  };
}

function distinctMemory(id: string, simTime: number, content: string): MemoryRecord {
  return {
    tier: "episodic",
    epistemicStatus: "observed",
    id,
    simTime,
    content,
    tags: ["forest"],
    participants: [],
    location: { x: 10, y: 4 },
    significance: 50,
    eventSequence: simTime,
    provenance: "observed",
  };
}

describe("repeated memories do not crowd out the rest", () => {
  const context = {
    nowSimTime: 142_920,
    location: { x: 10, y: 4 },
    focusInhabitantIds: [],
    needs: [],
    goals: [],
    situationTags: ["forest", "idle", "wood"],
    cognitionLevel: "planning" as const,
    maturity: 5 as const,
  };

  // Forty identical observes, and they are the *newest* memories — which is the
  // shape of the real failure: the founder's recent past was a run of observes,
  // so recency handed them every slot and the things it had actually done were
  // all older than the repetition that displaced them.
  const candidates: MemoryRecord[] = [
    ...Array.from({ length: 40 }, (_, i) => observeMemory(`obs_${i}`, 130_000 + i * 120)),
    distinctMemory("act_1", 120_000, "You performed gather. Outcome: resolved. You gathered 8 wood."),
    distinctMemory("act_2", 121_000, "You performed build. Outcome: rejected: not enough wood."),
    distinctMemory("act_3", 122_000, "You performed create_artifact. Outcome: resolved."),
  ];

  it("keeps one of the repeated memories, not forty", () => {
    const result = retrieveMemories(candidates, context);
    const observes = result.selected.filter((s) => s.record.content.includes("observe"));
    expect(observes).toHaveLength(1);
  });

  it("keeps the most recent of the collapsed group", () => {
    const result = retrieveMemories(candidates, context);
    const observe = result.selected.find((s) => s.record.content.includes("observe"));
    expect(observe?.record.id).toBe("obs_39");
  });

  it("admits the distinct memories the repeats used to displace", () => {
    const result = retrieveMemories(candidates, context);
    const ids = result.selected.map((s) => s.record.id);
    expect(ids).toContain("act_1");
    expect(ids).toContain("act_2");
    expect(ids).toContain("act_3");
  });

  it("stays deterministic regardless of candidate order", () => {
    const forward = retrieveMemories(candidates, context);
    const backward = retrieveMemories([...candidates].reverse(), context);
    expect(backward.selected.map((s) => s.record.id)).toEqual(
      forward.selected.map((s) => s.record.id),
    );
  });

  it("does not collapse memories that merely share a shape", () => {
    // Same sentence pattern, genuinely different events. These must all survive.
    const distinct = [
      distinctMemory("a", 130_000, "You performed gather. Outcome: resolved. You gathered wood."),
      distinctMemory("b", 130_100, "You performed gather. Outcome: resolved. You gathered food."),
      distinctMemory("c", 130_200, "You performed gather. Outcome: resolved. You gathered stone."),
    ];
    const result = retrieveMemories(distinct, context);
    expect(result.selected).toHaveLength(3);
  });
});
