/**
 * The inhabitant (§6).
 *
 * Every field §6 requires appears below, in §6's order, each marked with the
 * requirement it satisfies. Nothing has been folded away for convenience: the
 * list in §6 is the specification of what a person in this world *is*, and a
 * missing field is a missing faculty.
 *
 * Two properties of this schema are load-bearing and easy to lose:
 *
 * **It is not omniscient.** §6: "An inhabitant must not possess omniscient
 * access to world state. Its context may contain only information it
 * legitimately observed, was told, discovered or can currently perceive." So
 * `knownLocations`, `knownPublicInformation` and `beliefsAboutOthers` are the
 * inhabitant's *own* accumulated picture — bounded, stale, possibly wrong — and
 * the observation builder may draw on nothing else about the wider world.
 *
 * **It has exactly one activity.** §11A allows one primary activity at any
 * simulated moment, and §11J requires that "An inhabitant cannot occupy two
 * primary activities simultaneously". That invariant is structural here: there
 * is one `activity` object, not a list, so a second concurrent activity is not
 * something the engine has to reject — it is something that cannot be
 * represented.
 *
 * There is deliberately no `career`, `profession`, `role` or `title` field
 * (§9). There is no `legitimacy`, `rank` or `authority` field (§11G). There is
 * no `feeling` or `mood` field (§11C: "Do not script guilt, affection,
 * resentment or grief"). What an inhabitant is, is what it has done.
 */
import { z } from "zod";
import { ActivityStateSchema, CognitionLevelSchema } from "../action-spec.js";
import { CoordSchema, TerrainSchema } from "../primitives.js";
import {
  ENTITY_LABEL_MAX,
  ENTITY_LINE_MAX,
  ENTITY_NAME_MAX,
  ENTITY_NOTE_MAX,
  EntityIdSchema,
  HeldBundleSchema,
  CurrencyHoldingSchema,
  PercentSchema,
  SequenceSchema,
  SignedPercentSchema,
  SimTimeSchema,
  entityName,
  entityText,
} from "./common.js";
import { ConditionInstanceSchema } from "./condition.js";
import { BeliefAboutOtherSchema } from "./memory.js";
import { SkillSetSchema } from "./skills.js";

// ---------------------------------------------------------------------------
// Component schemas
// ---------------------------------------------------------------------------

/**
 * The one activity an inhabitant is engaged in (§11A).
 *
 * `activityId` identifies the multi-participant activity a conversation, lesson
 * or shared build belongs to, so that every participant's record points at the
 * same thing and the scheduler can see that all of their time is committed to it
 * (§11J).
 */
export const CurrentActivitySchema = z.object({
  state: ActivityStateSchema,
  /** Null when idle. Shared by every participant in a joint activity. */
  activityId: EntityIdSchema.nullable().default(null),
  /** The action type that started it, for the spectator view and the audit log. */
  actionType: z.string().max(ENTITY_LABEL_MAX).nullable().default(null),
  startedAt: SimTimeSchema,
  /** When it completes. Equal to `startedAt` for instantaneous states. */
  endsAt: SimTimeSchema,
  /** Other inhabitants whose time this same activity is consuming (§11J). */
  participantIds: z.array(EntityIdSchema).max(16).default([]),
  coord: CoordSchema.nullable().default(null),
  /** Whether and how this activity may be broken into (§11A). */
  interruptible: z.boolean().default(true),
  /** Work completed so far, for activities whose progress survives interruption. */
  progress: PercentSchema.default(0),
  startedByEventSequence: SequenceSchema.nullable().default(null),
});
export type CurrentActivity = z.infer<typeof CurrentActivitySchema>;

/**
 * Energy: the capacity to act (§5, §6).
 *
 * Not conserved — restored by rest and food, destroyed by work. `max` falls with
 * conditions and rises with development, which is how §11B's "daily capacity"
 * becomes a number rather than a policy.
 */
export const EnergyStateSchema = z.object({
  current: z.number().int().nonnegative().max(100_000),
  max: z.number().int().nonnegative().max(100_000),
  /** Energy restored per hour of rest, before conditions. */
  recoveryPerHour: z.number().int().nonnegative().max(10_000).default(0),
});
export type EnergyState = z.infer<typeof EnergyStateSchema>;

/**
 * Compute allowance: the capacity to think (§11B, §6).
 *
 * §11B: "Cognition also consumes time and simulated compute. […] Longer context
 * retrieval and deeper reasoning must consume more compute and potentially more
 * simulated time." Spending here is what makes deliberate planning a decision
 * with a cost rather than a free upgrade, and `spentTotal` is what §15's spend
 * limits are checked against.
 */
export const ComputeAllowanceSchema = z.object({
  perDay: z.number().int().nonnegative().max(1_000_000),
  remainingToday: z.number().int().nonnegative().max(1_000_000),
  dayStartedAt: SimTimeSchema,
  spentTotal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  /**
   * The deepest cognition level this inhabitant may currently request. Young and
   * impaired inhabitants are capped low — §11B: "Young inhabitants must have
   * smaller effective context budgets, fewer retrieved memories, shorter
   * planning horizons and restricted action capabilities."
   */
  maxCognitionLevel: CognitionLevelSchema.default("routine"),
});
export type ComputeAllowance = z.infer<typeof ComputeAllowanceSchema>;

/**
 * Developmental stage (§11B).
 *
 * `stage` gates which actions are available (see `MATURITY` in
 * `../actions/common.js`). It advances with age, health, care received and
 * education — and may never advance at all for an inhabitant created with a
 * developmental imperfection (§7). It is not a lifecycle clock.
 */
export const MaturitySchema = z.object({
  stage: z.number().int().min(0).max(5),
  /** Accumulated development, from which the stage is derived. */
  developmentPoints: z.number().int().nonnegative().max(1_000_000).default(0),
  /** Simulated minutes lived. Age alone does not grant maturity. */
  ageMinutes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  /** Planning horizon in simulated minutes, used to bound cognition (§11B). */
  planningHorizonMinutes: z.number().int().nonnegative().max(5_256_000).default(1440),
  /** How many memories may be retrieved per turn (§19). Small when young. */
  memoryRetrievalLimit: z.number().int().min(0).max(256).default(8),
});
export type Maturity = z.infer<typeof MaturitySchema>;

/**
 * A relationship as one party holds it (§6).
 *
 * Asymmetric on purpose: A's record of B and B's record of A are separate rows
 * and may disagree entirely. There is no field for "how close they are" as a
 * shared fact, because there is no such fact.
 *
 * `kind` is a label the holder applies, not a status the world confers —
 * `parent` here means "I regard them as my parent". Lineage as a *fact* lives in
 * `parentIds`, which the engine writes and nobody can revise.
 */
export const RelationshipSchema = z.object({
  otherId: EntityIdSchema,
  /** How much shared history there is. Rises with every interaction. */
  familiarity: PercentSchema.default(0),
  /** −100…100. Derived from kept and broken expectations, not from sentiment. */
  trust: SignedPercentSchema.default(0),
  /** −100…100. Derived from cooperation, conflict and time spent. */
  affinity: SignedPercentSchema.default(0),
  /** Outstanding felt obligation. Rises with unreciprocated gifts and care. */
  obligation: SignedPercentSchema.default(0),
  kind: z
    .enum([
      "unacquainted",
      "acquaintance",
      "creator",
      "descendant",
      "sibling",
      "household",
      "colleague",
      "employer",
      "employee",
      "teacher",
      "student",
      "patient",
      "practitioner",
      "counterparty",
      "adversary",
      "other",
    ])
    .default("acquaintance"),
  firstMetAt: SimTimeSchema.nullable().default(null),
  lastInteractionAt: SimTimeSchema.nullable().default(null),
  interactionCount: z.number().int().nonnegative().max(1_000_000).default(0),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

/**
 * Reputation (§6).
 *
 * A *standing among others*, accumulated from observed behaviour, and therefore
 * partial: an inhabitant that has never been seen has no reputation, good or
 * bad. `byOrganisation` lets a hero to one group be a menace to another, which
 * is the honest representation given §11G's insistence that legitimacy is a
 * matter of opinion.
 */
export const ReputationSchema = z.object({
  /** −100…100, across all inhabitants who have observed anything. */
  overall: SignedPercentSchema.default(0),
  /** How many inhabitants have a basis for an opinion at all. */
  knownByCount: z.number().int().nonnegative().max(1_000_000).default(0),
  byOrganisation: z.record(EntityIdSchema, SignedPercentSchema).default({}),
  /**
   * Standing in particular kinds of activity, e.g. how reliably it treats or
   * trades. Keys are skill names or free labels applied by observers — these are
   * emergent descriptions, never assigned professions (§9).
   */
  byDomain: z.record(z.string().max(ENTITY_LABEL_MAX), SignedPercentSchema).default({}),
});
export type Reputation = z.infer<typeof ReputationSchema>;

/** A goal the inhabitant holds privately (§6 "Private goals"). */
export const PrivateGoalSchema = z.object({
  id: EntityIdSchema,
  description: entityText(ENTITY_NOTE_MAX),
  priority: PercentSchema.default(50),
  createdAt: SimTimeSchema,
  status: z.enum(["active", "achieved", "abandoned", "frustrated", "deferred"]).default("active"),
  resolvedAt: SimTimeSchema.nullable().default(null),
  /** Goals are private cognition (§6) and enter no one else's context. */
  relatedInhabitantIds: z.array(EntityIdSchema).max(16).default([]),
});
export type PrivateGoal = z.infer<typeof PrivateGoalSchema>;

/**
 * Current needs (§6).
 *
 * Pressures derived from the inhabitant's actual state, 0 = satisfied,
 * 100 = urgent. They are inputs to cognition, not commands: an inhabitant with
 * hunger at 90 may still choose to finish its work and starve. Nothing here
 * forces a behaviour.
 */
export const NeedsSchema = z.object({
  hunger: PercentSchema.default(0),
  thirst: PercentSchema.default(0),
  fatigue: PercentSchema.default(0),
  shelter: PercentSchema.default(0),
  safety: PercentSchema.default(0),
  company: PercentSchema.default(0),
  purpose: PercentSchema.default(0),
});
export type Needs = z.infer<typeof NeedsSchema>;

/** Property held beyond the carried inventory (§6). */
export const PropertySchema = z.object({
  artifactIds: z.array(EntityIdSchema).max(512).default([]),
  structureIds: z.array(EntityIdSchema).max(128).default([]),
  /** Tiles this inhabitant holds land-use rights over (§5). */
  landTiles: z.array(CoordSchema).max(512).default([]),
  /** Resources kept in structures rather than carried. */
  storedResources: HeldBundleSchema,
  currencyHoldings: z.array(CurrencyHoldingSchema).max(32).default([]),
  /** Holdings that are not currently observable by others (§11E). */
  concealedResources: HeldBundleSchema,
  concealedArtifactIds: z.array(EntityIdSchema).max(128).default([]),
});
export type Property = z.infer<typeof PropertySchema>;

/** Health and integrity (§6, §8). */
export const HealthStateSchema = z.object({
  /** Overall bodily integrity, 0–100. Death occurs at 0 or by a terminal stage. */
  integrity: PercentSchema.default(100),
  conditions: z.array(ConditionInstanceSchema).max(32).default([]),
  /** Symptoms another inhabitant could perceive by looking (§8). */
  visibleSymptoms: z.array(z.string().max(ENTITY_LINE_MAX)).max(16).default([]),
  lastAssessedAt: SimTimeSchema.nullable().default(null),
  lastAssessedById: EntityIdSchema.nullable().default(null),
});
export type HealthState = z.infer<typeof HealthStateSchema>;

/**
 * Voice identity (§6, §21).
 *
 * A persistent voice configuration used by the media layer. Read-only with
 * respect to the world: §21 requires audio generation to be asynchronous and
 * requires that "A failed audio job must never block or change the simulation."
 */
export const VoiceIdentitySchema = z.object({
  /** Provider voice identifier, e.g. an ElevenLabs voice id. */
  voiceId: z.string().max(ENTITY_NAME_MAX),
  /** Integer per mille adjustments. No floats reach the canonical record. */
  stabilityPermille: z.number().int().min(0).max(1000).default(500),
  similarityPermille: z.number().int().min(0).max(1000).default(750),
  assignedAt: SimTimeSchema,
});
export type VoiceIdentity = z.infer<typeof VoiceIdentitySchema>;

/**
 * Model configuration (§6, §3).
 *
 * §3 requires the model provider to sit behind a provider-neutral interface and
 * requires the model and version used to be recorded for every inference. The
 * per-inhabitant record is here; the per-event record is on the event's
 * provenance (§16).
 *
 * `temperatureMilli` is an integer thousandth. A float here would make the
 * request hash — and therefore replay — platform-dependent.
 *
 * §11B: "Use the same underlying model where practical while controlling the
 * context and capabilities supplied to it." Difference between inhabitants comes
 * from the budgets below, not from giving some of them a better brain.
 */
export const ModelConfigSchema = z.object({
  /** Exact model identifier, e.g. "gemini-2.5-flash-lite". */
  modelId: z.string().max(ENTITY_NAME_MAX),
  /** Model used for rare high-importance cognition (§3). */
  deepModelId: z.string().max(ENTITY_NAME_MAX).nullable().default(null),
  temperatureMilli: z.number().int().min(0).max(2000).default(700),
  maxOutputTokens: z.number().int().min(1).max(32_768).default(2048),
  /** Ceiling on the observation and memory context assembled per turn (§11B). */
  contextBudgetTokens: z.number().int().min(1).max(1_000_000).default(16_000),
  defaultCognitionLevel: CognitionLevelSchema.default("routine"),
  /** Schema version of the prompt template. Changing it is constitutional (§23). */
  promptVersion: z.number().int().positive().default(1),
});
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * A tile this inhabitant has learned about (§6 "Known locations").
 *
 * Its own record, and it can be out of date. What it believed it saw at day 3 is
 * what it still believes at day 300 unless it goes back and looks — that gap is
 * where scouting, rumour and stale maps come from (§11E).
 */
export const KnownLocationSchema = z.object({
  coord: CoordSchema,
  terrain: TerrainSchema,
  learnedAt: SimTimeSchema,
  /** How it came to know: seen for itself, or told by someone (§11E). */
  provenance: z.enum(["observed", "told", "read"]).default("observed"),
  sourceInhabitantId: EntityIdSchema.nullable().default(null),
  note: entityText(ENTITY_LINE_MAX).default(""),
});
export type KnownLocation = z.infer<typeof KnownLocationSchema>;

/**
 * A publicly recorded fact this inhabitant has actually encountered (§6 "Known
 * public information", §11E "Publicly recorded").
 *
 * Public does not mean known. A published contract exists whether or not anyone
 * read it; this list is what *this* inhabitant read. Populating it from the
 * world's public records without an observation event would breach §15's
 * requirement that information reach a context only through a valid path.
 */
export const KnownPublicFactSchema = z.object({
  topic: z.string().max(ENTITY_LABEL_MAX),
  summary: entityText(ENTITY_NOTE_MAX),
  learnedAt: SimTimeSchema,
  sourceEventSequence: SequenceSchema.nullable().default(null),
  subjectId: EntityIdSchema.nullable().default(null),
});
export type KnownPublicFact = z.infer<typeof KnownPublicFactSchema>;

/** Membership in an organisation, as the member records it (§6). */
export const GroupMembershipSchema = z.object({
  organisationId: EntityIdSchema,
  role: z.string().max(ENTITY_LABEL_MAX).default(""),
  joinedAt: SimTimeSchema,
  /** Whether the membership is disclosed. Undisclosed membership is private (§11E). */
  disclosed: z.boolean().default(true),
});
export type GroupMembership = z.infer<typeof GroupMembershipSchema>;

/** An obligation this inhabitant carries under a contract (§6). */
export const ObligationRefSchema = z.object({
  contractId: EntityIdSchema,
  obligationIndex: z.number().int().min(0).max(255),
  dueAt: SimTimeSchema.nullable().default(null),
  status: z
    .enum(["pending", "performed", "partially_performed", "overdue", "breached", "released"])
    .default("pending"),
});
export type ObligationRef = z.infer<typeof ObligationRefSchema>;

/**
 * The record of a death (§8).
 *
 * Present only when the inhabitant has died, and never a reason to delete
 * anything. §8: "Death must never delete history. Mark the inhabitant inactive
 * and preserve: Memories, Relationships, Property, Contracts, Artifacts,
 * Messages, Reputation, Lineage, Complete event history." Every one of those
 * fields stays populated on a dead inhabitant's record, exactly as it was.
 *
 * Death is irreversible in the initial ruleset (§8). What happens to the estate
 * is not decided here: inheritance, debts, memorials and abandoned property are
 * for the survivors to settle.
 */
export const DeathEventSchema = z.object({
  diedAt: SimTimeSchema,
  eventSequence: SequenceSchema,
  cause: z.enum([
    "condition",
    "starvation",
    "dehydration",
    "exhaustion",
    "injury",
    "ageing",
    "unknown",
  ]),
  conditionId: EntityIdSchema.nullable().default(null),
  /** Recorded neutrally. The engine states a physical cause, not a culpability (§11G). */
  relatedInhabitantIds: z.array(EntityIdSchema).max(16).default([]),
  coord: CoordSchema.nullable().default(null),
});
export type DeathEvent = z.infer<typeof DeathEventSchema>;

// ---------------------------------------------------------------------------
// The inhabitant
// ---------------------------------------------------------------------------

export const InhabitantSchema = z.object({
  // §6: Stable unique identifier
  id: EntityIdSchema,
  worldId: EntityIdSchema,

  // §6: Display name
  displayName: entityName(),

  // §6: Generation number. 0 is the founder, created only at Genesis (§7, §22).
  generation: z.number().int().nonnegative().max(10_000),

  // §6: Parent or creator identifiers. Canonical lineage, never revisable.
  parentIds: z.array(EntityIdSchema).max(4).default([]),

  // §6: Creation event. The immutable birth event required by §7.
  creationEventSequence: SequenceSchema,

  // §6: Birth time
  birthTime: SimTimeSchema,

  // §6: Current location
  location: CoordSchema,

  /**
   * §6: Status.
   *
   * `dead` is terminal and irreversible (§8). A dead inhabitant keeps every
   * other field on this record; it simply never acts again (§15: "Inhabitants
   * cannot act after death").
   */
  status: z.enum(["active", "incapacitated", "dead"]).default("active"),

  /**
   * §11A: the single primary activity. One object, never a list — §11J's
   * "cannot occupy two primary activities simultaneously" is enforced by the
   * shape of the data, not by a check that could be forgotten.
   */
  activity: CurrentActivitySchema,

  /**
   * §11H: the confinement currently constraining this inhabitant, if any.
   * A pointer to a `Confinement` record — confinement is a relationship between
   * parties and a place, not an edit to the confined inhabitant.
   */
  confinementId: EntityIdSchema.nullable().default(null),

  /**
   * §6: Personality traits.
   *
   * Bounded −100…100 per named trait, generated at creation within bounds (§7)
   * and largely stable thereafter. Traits shape which options an inhabitant
   * tends to consider; they never determine an outcome.
   */
  personalityTraits: z.record(z.string().max(ENTITY_LABEL_MAX), SignedPercentSchema).default({}),

  // §6: Values. Short statements the inhabitant holds; they may be abandoned.
  values: z.array(z.string().max(ENTITY_NAME_MAX)).max(16).default([]),

  // §6: Private goals. Private cognition; inaccessible to others (§6, §11E).
  privateGoals: z.array(PrivateGoalSchema).max(32).default([]),

  // §6: Current needs
  needs: NeedsSchema,

  // §6: Inventory — what is carried, and therefore potentially observable (§11E).
  inventory: HeldBundleSchema,

  // §6: Property
  property: PropertySchema,

  // §6: Energy
  energy: EnergyStateSchema,

  // §6: Compute allowance (§11B)
  computeAllowance: ComputeAllowanceSchema,

  /** §11B: developmental stage, which gates action availability. */
  maturity: MaturitySchema,

  // §6: Learned skills (§9). Practice and level; no career, ever.
  skills: SkillSetSchema.default({}),

  // §6: Relationships. One-sided records that need not be reciprocated.
  relationships: z.record(EntityIdSchema, RelationshipSchema).default({}),

  // §6: Reputation
  reputation: ReputationSchema,

  // §6: Group memberships
  groupMemberships: z.array(GroupMembershipSchema).max(64).default([]),

  // §6: Contracts and obligations
  contractIds: z.array(EntityIdSchema).max(256).default([]),
  obligations: z.array(ObligationRefSchema).max(256).default([]),

  /**
   * §6: Episodic memories, and §6: Long-term memory summaries.
   *
   * Held as bounded id lists, with the records themselves in the memory store
   * (§19). Keeping them out of the inhabitant document is what stops a turn from
   * loading a whole life — §19: "Do not resend an inhabitant's complete life
   * history on every turn. Keep inference costs bounded."
   */
  episodicMemoryIds: z.array(EntityIdSchema).max(4096).default([]),
  reflectionMemoryIds: z.array(EntityIdSchema).max(512).default([]),
  lastReflectionAt: SimTimeSchema.nullable().default(null),

  // §6: Beliefs about other inhabitants. Beliefs, not facts (§19).
  beliefsAboutOthers: z.record(EntityIdSchema, BeliefAboutOtherSchema).default({}),

  // §6: Known locations
  knownLocations: z.array(KnownLocationSchema).max(1024).default([]),

  // §6: Known public information
  knownPublicInformation: z.array(KnownPublicFactSchema).max(512).default([]),

  // §6: Health and integrity state (§8)
  health: HealthStateSchema,

  // §6: Voice identity (§21)
  voice: VoiceIdentitySchema.nullable().default(null),

  // §6: Model configuration (§3, §11B)
  modelConfig: ModelConfigSchema,

  // §6: Last action time
  lastActionAt: SimTimeSchema.nullable().default(null),
  lastActionType: z.string().max(ENTITY_LABEL_MAX).nullable().default(null),

  /**
   * §6: Next eligible action time.
   *
   * The scheduler's only input for this inhabitant (§4C). It moves forward as
   * activities complete; it never moves backwards, which is half of §15's "World
   * time cannot move backwards" at the individual level.
   */
  nextEligibleAt: SimTimeSchema,

  /** Turns taken. Used for idempotency and for the audit export (§14). */
  turnCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),

  // §6: Death event, when applicable
  deathEvent: DeathEventSchema.nullable().default(null),
});
export type Inhabitant = z.infer<typeof InhabitantSchema>;
