// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Memory retrieval and reflection (§19).
 *
 * Three tiers, and the type system enforces the distinction between them:
 *
 *  - **Working memory** — the last few things that happened, kept because
 *    context without immediate continuity produces incoherent behaviour.
 *  - **Episodic memory** — specific experiences, each anchored to a canonical
 *    event sequence. These are *records of facts the inhabitant observed*.
 *  - **Reflections** — periodic compressed interpretations the inhabitant formed
 *    about itself, others and the world. §19 is unambiguous: "Reflections are
 *    beliefs, not canonical facts."
 *
 * That last distinction is the one most likely to be eroded by a convenient
 * refactor, so it is made structural rather than documentary. A reflection has
 * no `eventSequence` field and carries `epistemicStatus: "belief"`; an episodic
 * memory requires `eventSequence` and carries `epistemicStatus: "observed"`.
 * There is no assignability in either direction, so a reflection can never be
 * passed where an observation is expected, and no amount of downstream code can
 * quietly promote a belief into a fact.
 *
 * Two further rules from §19:
 *
 *  - "Do not resend an inhabitant's complete life history on every turn."
 *    Retrieval is capped by record count *and* estimated tokens, scaled by
 *    cognition level and maturity.
 *  - "Never silently rewrite historical memories." Nothing in this module
 *    mutates a record. Revising a belief produces a NEW record that points at
 *    the one it supersedes.
 *
 * All scoring is integer arithmetic. Floats are banned world-wide for
 * determinism, and a retrieval score that differed in the last bit across
 * platforms would change which memories entered the prompt, which would change
 * the request hash, which would break replay (§15).
 */
import type { CognitionLevel } from "@after-genesis/core/schema/action-spec";
import type { Maturity, Need, Point, PrivateGoal } from "./types.js";

/** Fields common to every memory record, whatever its tier. */
interface MemoryBase {
  readonly id: string;
  /** Simulated minutes since Genesis at which the memory was formed. */
  readonly simTime: number;
  /**
   * AUTHORED-ADJACENT. Rendered through the untrusted-text sanitiser in all
   * cases: even an engine-written summary can quote what an inhabitant said.
   */
  readonly content: string;
  /** Lowercased tags used for relevance scoring. Sorted by the caller or by us. */
  readonly tags: readonly string[];
  /** Inhabitant ids involved. Used for the relationship term. */
  readonly participants: readonly string[];
  /** Where it happened, or null if it has no location. */
  readonly location: Point | null;
  /** Integer 0–100. How much this mattered to the inhabitant when formed. */
  readonly significance: number;
}

/**
 * The most recent handful of events, kept regardless of score.
 *
 * Working memory exists so an inhabitant does not restart its train of thought
 * every turn. It is small by design and always gets a reserved share of the
 * budget, because dropping it produces an inhabitant that repeats itself.
 */
export interface WorkingMemory extends MemoryBase {
  readonly tier: "working";
  readonly epistemicStatus: "observed";
  /** The canonical event this came from. */
  readonly eventSequence: number;
}

/** A specific remembered experience, anchored to a canonical event (§19). */
export interface EpisodicMemory extends MemoryBase {
  readonly tier: "episodic";
  readonly epistemicStatus: "observed";
  /** The canonical event this came from. Non-optional: an experience has a provenance. */
  readonly eventSequence: number;
  /** How the inhabitant came to know this (§11E). */
  readonly provenance: "observed" | "told" | "investigated" | "published" | "participated";
}

/**
 * A belief the inhabitant formed. NOT a canonical fact.
 *
 * Structurally distinct from the tiers above: no `eventSequence`, and
 * `epistemicStatus` is `"belief"`. A reflection may be wrong, may contradict
 * events, and may have been formed from another inhabitant's lies. The engine
 * must never read one.
 */
export interface Reflection extends MemoryBase {
  readonly tier: "reflection";
  readonly epistemicStatus: "belief";
  /** Integer 0–100. The inhabitant's own confidence; carries no evidential weight. */
  readonly confidence: number;
  /**
   * Episodic memory ids this belief was drawn from. Provenance for the audit
   * trail, not a claim that the belief follows from them.
   */
  readonly derivedFrom: readonly string[];
  /**
   * The id of the reflection this one replaces, if any.
   *
   * §19: a changed belief creates a NEW record. The old record stays. This is
   * what lets the audit show that an inhabitant changed its mind, and when.
   */
  readonly supersedes: string | null;
}

export type MemoryRecord = WorkingMemory | EpisodicMemory | Reflection;

/**
 * Compile-time proof that a reflection cannot be used as an observation.
 *
 * If someone later "simplifies" the union by giving `Reflection` an
 * `eventSequence` or widening `epistemicStatus`, this stops compiling. That is
 * the point: §19's belief/fact boundary should fail loudly, not silently.
 */
type _AssertBeliefIsNotFact = Reflection extends { epistemicStatus: "observed" } ? never : true;
type _AssertFactIsNotBelief = EpisodicMemory extends { epistemicStatus: "belief" } ? never : true;
const _beliefBoundaryHolds: [_AssertBeliefIsNotFact, _AssertFactIsNotBelief] = [true, true];
void _beliefBoundaryHolds;

/** True for records the engine may treat as evidence. Reflections never qualify. */
export function isObservedMemory(record: MemoryRecord): record is WorkingMemory | EpisodicMemory {
  return record.epistemicStatus === "observed";
}

/** True for records that are the inhabitant's interpretation rather than experience. */
export function isBelief(record: MemoryRecord): record is Reflection {
  return record.epistemicStatus === "belief";
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Integer weights for the seven retrieval signals §19 names.
 *
 * Weights sum to 100 in every profile, so a raw score is directly comparable
 * across cognition levels without division.
 */
export interface ScoreWeights {
  readonly recency: number;
  readonly relevance: number;
  readonly relationship: number;
  readonly location: number;
  readonly needs: number;
  readonly goals: number;
  readonly significance: number;
}

/**
 * Per-level weight profiles.
 *
 * The differences are the interesting part. A `conversation` turn weights
 * relationship and recency, because who you are talking to and what was just
 * said dominate. A `planning` turn weights goals and significance, because the
 * question is what matters over a horizon rather than what is in front of you.
 * A `reflection` turn weights significance and relationship and almost ignores
 * location, because forming a belief about your life is not a spatial activity.
 */
const WEIGHT_PROFILES: Readonly<Record<CognitionLevel, ScoreWeights>> = {
  reaction: {
    recency: 45,
    relevance: 15,
    relationship: 10,
    location: 20,
    needs: 5,
    goals: 0,
    significance: 5,
  },
  routine: {
    recency: 25,
    relevance: 20,
    relationship: 10,
    location: 15,
    needs: 15,
    goals: 10,
    significance: 5,
  },
  conversation: {
    recency: 25,
    relevance: 20,
    relationship: 30,
    location: 5,
    needs: 5,
    goals: 5,
    significance: 10,
  },
  planning: {
    recency: 10,
    relevance: 20,
    relationship: 10,
    location: 5,
    needs: 15,
    goals: 25,
    significance: 15,
  },
  reflection: {
    recency: 5,
    relevance: 15,
    relationship: 20,
    location: 0,
    needs: 5,
    goals: 20,
    significance: 35,
  },
  study: {
    recency: 10,
    relevance: 35,
    relationship: 5,
    location: 5,
    needs: 5,
    goals: 20,
    significance: 20,
  },
};

export function weightsFor(level: CognitionLevel): ScoreWeights {
  return WEIGHT_PROFILES[level];
}

/** Everything the scorer compares a memory against. All integers. */
export interface RetrievalContext {
  readonly nowSimTime: number;
  readonly location: Point;
  /** Ids the inhabitant is currently dealing with; boosts memories involving them. */
  readonly focusInhabitantIds: readonly string[];
  readonly needs: readonly Need[];
  readonly goals: readonly PrivateGoal[];
  /** Lowercased tokens describing the current situation, from the engine. */
  readonly situationTags: readonly string[];
  readonly cognitionLevel: CognitionLevel;
  readonly maturity: Maturity;
}

/** Clamp to 0–100 with integer semantics. */
function clamp100(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return Math.trunc(value);
}

/**
 * Recency, as an integer ramp rather than an exponential decay.
 *
 * An exponential would need `Math.exp`, whose last bits are not guaranteed
 * identical across platforms — and a one-unit difference here can reorder two
 * memories and change the prompt bytes. A linear ramp over a horizon window is
 * exact in integer arithmetic and expresses the same idea: things stop being
 * "recent" at a definite point.
 *
 * The horizon scales with maturity (§11B "shorter planning horizons" for the
 * young): a child's sense of "recently" is a day; an adult's is a season.
 */
export function recencyScore(ageMinutes: number, horizonMinutes: number): number {
  if (horizonMinutes <= 0) return 0;
  if (ageMinutes <= 0) return 100;
  if (ageMinutes >= horizonMinutes) return 0;
  // Integer division throughout: numerator and denominator are both integers,
  // and Math.trunc makes the truncation explicit rather than incidental.
  return clamp100(100 - Math.trunc((ageMinutes * 100) / horizonMinutes));
}

/** Overlap between two tag sets, scaled so four shared tags saturate. */
function tagOverlapScore(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const set = new Set(b);
  let overlap = 0;
  for (const tag of a) if (set.has(tag)) overlap += 1;
  return clamp100(overlap * 25);
}

/**
 * Location proximity. Same tile is 100; the score falls to 0 at 8 tiles, which
 * is roughly the observation radius.
 */
function locationScore(memoryLocation: Point | null, here: Point): number {
  if (memoryLocation === null) return 0;
  const distance = Math.max(
    Math.abs(memoryLocation.x - here.x),
    Math.abs(memoryLocation.y - here.y),
  );
  if (distance >= 8) return 0;
  return clamp100(100 - distance * 13);
}

/**
 * Relationship: does this memory involve someone currently in play?
 *
 * Binary rather than graded, because the alternative — weighting by sentiment —
 * would make an inhabitant's memory systematically biased towards people it
 * likes, which is a personality trait the world should let emerge from choices
 * rather than one baked into retrieval.
 */
function relationshipScore(participants: readonly string[], focus: readonly string[]): number {
  if (focus.length === 0 || participants.length === 0) return 0;
  const set = new Set(focus);
  for (const id of participants) if (set.has(id)) return 100;
  return 0;
}

/** Needs term: pressing needs pull up memories tagged with them. */
function needsScore(tags: readonly string[], needs: readonly Need[]): number {
  if (needs.length === 0) return 0;
  const tagSet = new Set(tags);
  let best = 0;
  for (const need of needs) {
    if (tagSet.has(need.kind.toLowerCase())) {
      // A need at level 100 fully credits the term; a satisfied need credits nothing.
      best = Math.max(best, clamp100(need.level));
    }
  }
  return best;
}

/** Goals term: scaled by the goal's own priority so trivial goals do not dominate. */
function goalsScore(tags: readonly string[], goals: readonly PrivateGoal[]): number {
  if (goals.length === 0) return 0;
  const tagSet = new Set(tags);
  let best = 0;
  for (const goal of goals) {
    let matched = false;
    for (const tag of goal.tags) {
      if (tagSet.has(tag)) {
        matched = true;
        break;
      }
    }
    if (matched) best = Math.max(best, clamp100(goal.priority));
  }
  return best;
}

/** The individual signal values, retained for audit and for explaining retrieval. */
export interface ScoreBreakdown {
  readonly recency: number;
  readonly relevance: number;
  readonly relationship: number;
  readonly location: number;
  readonly needs: number;
  readonly goals: number;
  readonly significance: number;
  /** Weighted sum, divided by 100. Integer. */
  readonly total: number;
}

/**
 * Score one memory. Pure, integer-only, and independent of iteration order.
 *
 * `horizonMinutes` is passed in rather than derived here so that the same
 * function can score a child's memory and an adult's memory on the same scale.
 */
export function scoreMemory(
  record: MemoryRecord,
  context: RetrievalContext,
  horizonMinutes: number,
): ScoreBreakdown {
  const weights = weightsFor(context.cognitionLevel);
  const signals = {
    recency: recencyScore(context.nowSimTime - record.simTime, horizonMinutes),
    relevance: tagOverlapScore(record.tags, context.situationTags),
    relationship: relationshipScore(record.participants, context.focusInhabitantIds),
    location: locationScore(record.location, context.location),
    needs: needsScore(record.tags, context.needs),
    goals: goalsScore(record.tags, context.goals),
    significance: clamp100(record.significance),
  };

  // Weighted sum over integers, then a single truncating division. Accumulating
  // in one pass and dividing once avoids repeated rounding, which would make the
  // result depend on the order the terms happen to be listed in.
  const weighted =
    signals.recency * weights.recency +
    signals.relevance * weights.relevance +
    signals.relationship * weights.relationship +
    signals.location * weights.location +
    signals.needs * weights.needs +
    signals.goals * weights.goals +
    signals.significance * weights.significance;

  return { ...signals, total: Math.trunc(weighted / 100) };
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * How much memory a turn may retrieve.
 *
 * Both caps bind. A count cap alone lets ten enormous memories blow the context;
 * a token cap alone lets a hundred one-word memories crowd out the prompt's
 * structure. §19 asks for bounded inference cost, and bounded means both.
 */
export interface RetrievalBudget {
  readonly maxRecords: number;
  readonly maxEstimatedTokens: number;
  /** Records always kept from working memory regardless of score. */
  readonly reservedWorkingRecords: number;
  /** How far back "recent" reaches, in simulated minutes. */
  readonly horizonMinutes: number;
}

/** Base budgets per cognition level, before the maturity scaling below. */
const BASE_BUDGETS: Readonly<Record<CognitionLevel, RetrievalBudget>> = {
  reaction: {
    maxRecords: 4,
    maxEstimatedTokens: 300,
    reservedWorkingRecords: 3,
    horizonMinutes: 240,
  },
  routine: {
    maxRecords: 10,
    maxEstimatedTokens: 900,
    reservedWorkingRecords: 3,
    horizonMinutes: 1440,
  },
  conversation: {
    maxRecords: 14,
    maxEstimatedTokens: 1400,
    reservedWorkingRecords: 4,
    horizonMinutes: 4320,
  },
  planning: {
    maxRecords: 24,
    maxEstimatedTokens: 3000,
    reservedWorkingRecords: 3,
    horizonMinutes: 43200,
  },
  reflection: {
    maxRecords: 32,
    maxEstimatedTokens: 4000,
    reservedWorkingRecords: 2,
    horizonMinutes: 259200,
  },
  study: {
    maxRecords: 20,
    maxEstimatedTokens: 2600,
    reservedWorkingRecords: 2,
    horizonMinutes: 129600,
  },
};

/**
 * Maturity scaling, as integer percentages (§11B: "Young inhabitants must have
 * smaller effective context budgets, fewer retrieved memories, shorter planning
 * horizons").
 *
 * Index is the developmental stage; stage 0 is newly created. Beyond the end of
 * the table the scale is 100 — an adult gets the full budget and no more.
 * Deliberately not a formula: a table is auditable, and these numbers are
 * constitutional in effect because they shape every prompt the world ever
 * builds.
 */
const MATURITY_SCALE_PERCENT: readonly number[] = [20, 35, 50, 70, 85, 100];

export function maturityScalePercent(maturity: Maturity): number {
  const index = Math.trunc(maturity);
  if (index < 0) return MATURITY_SCALE_PERCENT[0] ?? 20;
  if (index >= MATURITY_SCALE_PERCENT.length) return 100;
  return MATURITY_SCALE_PERCENT[index] ?? 100;
}

/**
 * Scale an integer by a percentage, never below `floor`.
 * `Math.trunc` keeps this exact; there is no rounding mode to disagree about.
 */
function scaleInt(value: number, percent: number, floor: number): number {
  return Math.max(floor, Math.trunc((value * percent) / 100));
}

export function retrievalBudget(level: CognitionLevel, maturity: Maturity): RetrievalBudget {
  const base = BASE_BUDGETS[level];
  const percent = maturityScalePercent(maturity);
  return {
    maxRecords: scaleInt(base.maxRecords, percent, 1),
    maxEstimatedTokens: scaleInt(base.maxEstimatedTokens, percent, 60),
    // Even a newborn keeps at least one working memory: without it there is no
    // continuity between turns at all, which produces an inhabitant that cannot
    // finish a sentence rather than one that is young.
    reservedWorkingRecords: scaleInt(base.reservedWorkingRecords, percent, 1),
    horizonMinutes: scaleInt(base.horizonMinutes, percent, 60),
  };
}

/**
 * Estimated token count for a string.
 *
 * Four characters per token is the standard rough English heuristic. It is an
 * *estimate* used only for budgeting — the authoritative count comes back from
 * the provider and is what the spend ledger charges against. Integer ceiling
 * division, so it never under-counts.
 */
export function estimateTokens(text: string): number {
  return Math.trunc((text.length + 3) / 4);
}

/** Tokens a record will cost once rendered, including its one-line header. */
function recordTokenCost(record: MemoryRecord): number {
  // ~14 tokens covers the rendered prefix: tier, time, epistemic status, tags.
  return estimateTokens(record.content) + 14;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface ScoredMemory {
  readonly record: MemoryRecord;
  readonly score: ScoreBreakdown;
  /** Why it was kept. `reserved` means working memory admitted regardless of score. */
  readonly admission: "reserved" | "scored";
}

export interface RetrievalResult {
  readonly selected: readonly ScoredMemory[];
  readonly budget: RetrievalBudget;
  readonly estimatedTokens: number;
  /** How many candidates were considered. Useful for spotting runaway memory growth (§24). */
  readonly consideredCount: number;
  /** Candidates dropped because a cap bound. */
  readonly droppedCount: number;
}

/**
 * A content key used to collapse memories that say the same thing.
 *
 * Lowercased, with digits and runs of whitespace flattened, so that "You saw:
 * fertile at (8, 2); forest at (10, 4)" and the same sentence recorded two hours
 * later with different coordinates do NOT collapse — the numbers are removed
 * from comparison only after the words differ, which they do not here. Two
 * memories collapse when they are the same sentence about the same kind of
 * event, which is exactly the case this exists for.
 *
 * Pure string work on already-canonical content: no locale, no normalisation
 * tables, so two machines derive the same key.
 */
function contentKey(record: MemoryRecord): string {
  return record.content
    .toLowerCase()
    .replace(/-?\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Collapse repeated memories, keeping the most recent of each group.
 *
 * §19 asks for bounded retrieval, and a budget spent on the same sentence
 * sixteen times is not bounded in any useful sense. On day 100 of the first
 * long run, every one of the founder's sixteen retrieved memories read "You
 * performed observe with payload {}. Outcome: resolved. You saw: fertile at
 * (8, 2); forest at (10, 4); plains at (6, 0)." The strongest signal in its
 * context window was a transcript of its own idleness, and it went on observing.
 *
 * This is not a judgement about which memories matter — that would be the
 * platform choosing what an inhabitant values (§26). It is the narrower claim
 * that hearing the same sentence a second time carries no information the first
 * did not. The repetition itself is not erased: the record still exists, the
 * canonical events behind every repeat are untouched, and a later turn with a
 * different situation may retrieve a different member of the group.
 */
function collapseRepeats(scored: readonly ScoredMemory[]): ScoredMemory[] {
  const best = new Map<string, ScoredMemory>();
  for (const candidate of scored) {
    const key = `${candidate.record.tier} ${contentKey(candidate.record)}`;
    const incumbent = best.get(key);
    if (incumbent === undefined || compareScored(candidate, incumbent) < 0) {
      best.set(key, candidate);
    }
  }
  // Sorted rather than returned in Map insertion order: insertion order follows
  // the caller's candidate order, and the prompt must not depend on that.
  return [...best.values()].sort(compareScored);
}

/**
 * Deterministic ordering for candidates with equal score.
 *
 * Score first (descending), then simTime (descending, so the newer of two
 * equally relevant memories wins), then id (ascending) as the final tiebreak.
 * The id tiebreak is what makes the result independent of the order the caller
 * happened to load records in — without it, a store returning rows in a
 * different order would produce a different prompt and a different hash.
 */
function compareScored(a: ScoredMemory, b: ScoredMemory): number {
  if (a.score.total !== b.score.total) return b.score.total - a.score.total;
  if (a.record.simTime !== b.record.simTime) return b.record.simTime - a.record.simTime;
  return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
}

/**
 * Select the memories for one turn.
 *
 * Pure: no clock, no I/O, no mutation of any input. Calling it twice with the
 * same arguments returns the same records in the same order, which is a
 * precondition for the prompt being byte-stable.
 */
export function retrieveMemories(
  candidates: readonly MemoryRecord[],
  context: RetrievalContext,
  budgetOverride?: RetrievalBudget,
): RetrievalResult {
  const budget = budgetOverride ?? retrievalBudget(context.cognitionLevel, context.maturity);

  const scored: ScoredMemory[] = candidates.map((record) => ({
    record,
    score: scoreMemory(record, context, budget.horizonMinutes),
    admission: "scored" as const,
  }));

  // Reserve the newest working memories first. They are admitted on recency
  // alone: continuity is not something an inhabitant should have to win on
  // relevance every turn.
  const working = scored
    .filter((s) => s.record.tier === "working")
    .sort((a, b) => {
      if (a.record.simTime !== b.record.simTime) return b.record.simTime - a.record.simTime;
      return a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0;
    })
    .slice(0, budget.reservedWorkingRecords)
    .map((s): ScoredMemory => ({ ...s, admission: "reserved" }));

  const reservedIds = new Set(working.map((s) => s.record.id));
  // Repeats are collapsed only among the scored candidates. Reserved working
  // memory is admitted on recency alone and stays whole: if the last three
  // things that happened really were the same thing three times, that is the
  // situation the inhabitant is in and hiding it would be a lie.
  const rest = collapseRepeats(scored.filter((s) => !reservedIds.has(s.record.id)));

  const selected: ScoredMemory[] = [];
  let tokens = 0;

  for (const candidate of [...working, ...rest]) {
    if (selected.length >= budget.maxRecords) break;
    const cost = recordTokenCost(candidate.record);
    // A reserved record is admitted even if it overshoots the token cap, but
    // nothing after it is: the cap still binds, it just cannot cost an
    // inhabitant its continuity.
    if (candidate.admission === "scored" && tokens + cost > budget.maxEstimatedTokens) continue;
    selected.push(candidate);
    tokens += cost;
  }

  // Reserved records were prepended for admission; present the final list in
  // one canonical order so the prompt is stable regardless of admission path.
  const ordered = [...selected].sort(compareScored);

  return {
    selected: ordered,
    budget,
    estimatedTokens: tokens,
    consideredCount: candidates.length,
    droppedCount: candidates.length - ordered.length,
  };
}

// ---------------------------------------------------------------------------
// Reflection formation
// ---------------------------------------------------------------------------

export interface ReflectionDraft {
  readonly id: string;
  readonly simTime: number;
  readonly content: string;
  readonly tags: readonly string[];
  readonly participants: readonly string[];
  readonly location: Point | null;
  readonly significance: number;
  readonly confidence: number;
  readonly derivedFrom: readonly string[];
}

/**
 * Create a new reflection.
 *
 * There is no `updateReflection`. §19 forbids silently rewriting memory, so the
 * only way to change a belief is `reviseReflection`, which produces a second
 * record pointing back at the first. The pair is the audit trail: the world can
 * show exactly what an inhabitant used to believe and when it stopped.
 */
export function createReflection(draft: ReflectionDraft): Reflection {
  const record: Reflection = {
    tier: "reflection",
    epistemicStatus: "belief",
    id: draft.id,
    simTime: draft.simTime,
    content: draft.content,
    tags: Object.freeze([...draft.tags].sort()),
    participants: Object.freeze([...draft.participants].sort()),
    location: draft.location,
    significance: Math.trunc(draft.significance),
    confidence: Math.trunc(draft.confidence),
    derivedFrom: Object.freeze([...draft.derivedFrom].sort()),
    supersedes: null,
  };
  return Object.freeze(record);
}

/**
 * Revise a belief by creating a new record that supersedes the old one.
 *
 * `previous` is read and never touched. The returned record is frozen, as is the
 * original if it came from this module — a caller that tries to "just update
 * the confidence" gets a runtime error in strict mode rather than a quietly
 * falsified history.
 */
export function reviseReflection(previous: Reflection, draft: ReflectionDraft): Reflection {
  const next: Reflection = { ...createReflection(draft), supersedes: previous.id };
  return Object.freeze(next);
}

/**
 * The chain of superseded ids, newest first, for one reflection.
 * Used by the audit export to render how a belief changed over time.
 */
export function beliefHistory(
  reflection: Reflection,
  all: readonly Reflection[],
): readonly Reflection[] {
  const byId = new Map(all.map((r) => [r.id, r]));
  const chain: Reflection[] = [reflection];
  const seen = new Set<string>([reflection.id]);
  let cursor: string | null = reflection.supersedes;
  while (cursor !== null && !seen.has(cursor)) {
    const previous: Reflection | undefined = byId.get(cursor);
    if (previous === undefined) break;
    chain.push(previous);
    seen.add(previous.id);
    cursor = previous.supersedes;
  }
  return chain;
}
