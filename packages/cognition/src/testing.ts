/**
 * Deterministic fixtures for cognition tests.
 *
 * Shipped as part of the package rather than hidden in a test folder because the
 * runtime and audit packages need the same fixtures to drive §24's mechanical
 * simulation, and duplicating them would let the two drift.
 *
 * Everything here is a pure function of its arguments. There is no clock and no
 * `Math.random`: the shuffle below is a seeded LCG so that a test which fails on
 * one machine fails identically on every other.
 */
import type { MemoryRecord, Reflection, RetrievalContext } from "./memory.js";
import type { PriceTable } from "./budget.js";
import type { Observation } from "./types.js";

/**
 * A seeded linear congruential generator.
 *
 * Used ONLY by tests, to shuffle inputs and prove the prompt builder is
 * insensitive to input ordering. Nothing in the production path may use this —
 * the world's randomness lives in core's seeded RNG and is derived from the
 * event chain.
 */
export function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

/** Fisher–Yates with a seeded generator. Returns a new array. */
export function shuffle<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/**
 * Rebuild every object in a structure with its keys in a shuffled insertion
 * order, and shuffle every array.
 *
 * This is the actual test of determinism. JavaScript preserves insertion order
 * for string keys, so an implementation that iterated `Object.keys` without
 * sorting, or that serialised with `JSON.stringify`, would produce different
 * bytes for the same logical observation. Arrays are shuffled too, because a
 * store returning rows in a different order is the realistic version of this
 * failure.
 */
export function shuffleDeep<T>(value: T, next: () => number): T {
  if (Array.isArray(value)) {
    return shuffle(
      value.map((item) => shuffleDeep(item, next)),
      next,
    ) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = shuffle(Object.keys(record), next);
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = shuffleDeep(record[key], next);
    return out as unknown as T;
  }
  return value;
}

/**
 * Test prices.
 *
 * DELIBERATELY NOT REAL. These are round numbers chosen to make arithmetic
 * checkable by hand. Production must supply a `PriceTable` verified against the
 * provider's live pricing page — see the header of budget.ts.
 */
export const TEST_PRICES: readonly PriceTable[] = [
  {
    modelId: "test-model",
    inputMicrosPerMillionTokens: 100_000,
    outputMicrosPerMillionTokens: 400_000,
    verifiedOn: "1970-01-01",
  },
];

/** A complete, legal observation. Override any field to build a variant. */
export function makeObservation(overrides: Partial<Observation> = {}): Observation {
  const base: Observation = {
    worldId: "world_test",
    sequence: 41,
    simTime: 14_400,
    turnNumber: 12,
    cognitionLevel: "routine",
    self: {
      id: "inh_alpha",
      displayName: "Alder",
      generation: 1,
      maturity: 4,
      birthTime: 0,
      location: { x: 6, y: 9 },
      terrain: "plains",
      activity: "idle",
      energy: 72,
      computeAllowance: 40,
      integrity: 91,
      confined: false,
      traits: [
        { name: "curiosity", value: 71 },
        { name: "caution", value: 44 },
        { name: "warmth", value: 58 },
      ],
      values: [
        { id: "val_1", statement: "Keep promises even when they cost me.", weight: 80 },
        { id: "val_2", statement: "Nobody should go hungry within sight of my store.", weight: 65 },
      ],
      privateGoals: [
        {
          id: "goal_1",
          statement: "Build a granary before the next dry season.",
          priority: 90,
          tags: ["granary", "build", "food"],
        },
        {
          id: "goal_2",
          statement: "Learn what Bracken is hiding.",
          priority: 55,
          tags: ["bracken", "secret"],
        },
      ],
      needs: [
        { kind: "food", level: 62 },
        { kind: "rest", level: 30 },
        { kind: "safety", level: 12 },
      ],
      conditions: [
        { id: "cnd_1", name: "sprained ankle", severity: 22, known: true },
        { id: "cnd_2", name: "early blight", severity: 40, known: false },
      ],
      skills: [
        { name: "carpentry", level: 3 },
        { name: "foraging", level: 5 },
      ],
      inventory: { food: 12, wood: 40, stone: 3 },
    },
    nearbyInhabitants: [
      {
        id: "inh_bravo",
        displayName: "Bracken",
        distance: 1,
        location: { x: 7, y: 9 },
        visibleActivity: "gathering",
        relationshipSentiment: -20,
        interactionCount: 14,
      },
      {
        id: "inh_charlie",
        displayName: "Cress",
        distance: 3,
        location: { x: 6, y: 12 },
        visibleActivity: "building",
        relationshipSentiment: null,
        interactionCount: 0,
      },
    ],
    nearbyStructures: [
      { id: "str_1", kind: "shelter", location: { x: 5, y: 9 }, ownerId: "inh_alpha" },
      { id: "str_2", kind: "well", location: { x: 8, y: 10 }, ownerId: null },
    ],
    nearbyTiles: [
      { location: { x: 6, y: 9 }, terrain: "plains", visibleResources: {} },
      { location: { x: 7, y: 9 }, terrain: "forest", visibleResources: { wood: 30 } },
      { location: { x: 6, y: 10 }, terrain: "fertile", visibleResources: { food: 8 } },
    ],
    authoredTexts: [
      {
        id: "msg_1",
        kind: "message",
        authorId: "inh_bravo",
        authorName: "Bracken",
        simTime: 14_390,
        body: "You still owe me four wood from the storm.",
      },
    ],
    worldNotices: ["The dry season begins in 9 days."],
    availableActions: [
      { type: "wait", description: "Do nothing this turn." },
      { type: "gather", description: "Collect a resource from your tile.", payloadHint: '{ "resource": <kind> }' },
      { type: "move", description: "Step to an adjacent tile.", payloadHint: '{ "to": { "x": <int>, "y": <int> } }' },
      {
        type: "communicate",
        description: "Say something to someone nearby.",
        payloadHint: '{ "to": <inhabitant id>, "text": <string> }',
      },
    ],
  };

  return { ...base, ...overrides };
}

/** A retrieval context consistent with `makeObservation`. */
export function makeRetrievalContext(
  overrides: Partial<RetrievalContext> = {},
): RetrievalContext {
  const observation = makeObservation();
  const base: RetrievalContext = {
    nowSimTime: observation.simTime,
    location: observation.self.location,
    focusInhabitantIds: ["inh_bravo"],
    needs: observation.self.needs,
    goals: observation.self.privateGoals,
    situationTags: ["food", "granary", "storm"],
    cognitionLevel: observation.cognitionLevel,
    maturity: observation.self.maturity,
  };
  return { ...base, ...overrides };
}

/** A mixed set of memory candidates spanning all three tiers (§19). */
export function makeMemories(): readonly MemoryRecord[] {
  const reflection: Reflection = {
    tier: "reflection",
    epistemicStatus: "belief",
    id: "mem_r1",
    simTime: 10_000,
    content: "Bracken counts every favour. I should get things in writing.",
    tags: ["bracken", "trust"],
    participants: ["inh_bravo"],
    location: null,
    significance: 70,
    confidence: 60,
    derivedFrom: ["mem_e1"],
    supersedes: null,
  };

  return [
    {
      tier: "working",
      epistemicStatus: "observed",
      id: "mem_w1",
      simTime: 14_395,
      content: "Bracken walked over and stopped a pace away.",
      tags: ["bracken"],
      participants: ["inh_bravo"],
      location: { x: 6, y: 9 },
      significance: 20,
      eventSequence: 40,
    },
    {
      tier: "working",
      epistemicStatus: "observed",
      id: "mem_w2",
      simTime: 14_380,
      content: "I set down the wood I had been carrying.",
      tags: ["wood"],
      participants: [],
      location: { x: 6, y: 9 },
      significance: 10,
      eventSequence: 38,
    },
    {
      tier: "episodic",
      epistemicStatus: "observed",
      id: "mem_e1",
      simTime: 12_000,
      content: "The storm took the roof off the store and Bracken helped me carry wood.",
      tags: ["storm", "wood", "bracken"],
      participants: ["inh_bravo"],
      location: { x: 6, y: 9 },
      significance: 80,
      provenance: "participated",
      eventSequence: 31,
    },
    {
      tier: "episodic",
      epistemicStatus: "observed",
      id: "mem_e2",
      simTime: 6_000,
      content: "Cress said the fertile ground south of the well yields twice over.",
      tags: ["food", "cress", "fertile"],
      participants: ["inh_charlie"],
      location: { x: 6, y: 12 },
      significance: 45,
      provenance: "told",
      eventSequence: 17,
    },
    reflection,
  ];
}
