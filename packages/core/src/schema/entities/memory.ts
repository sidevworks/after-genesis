/**
 * Memory (§19).
 *
 * Three levels, as §19 requires: recent working memory, episodic memory, and
 * long-term reflections. The distinction that matters most is the last one:
 * **reflections are beliefs, not canonical facts**. An inhabitant's conclusion
 * that "Agent 4 cannot be trusted" is a memory record with an author and a
 * confidence, and it may be flatly wrong. The event log records what happened;
 * memory records what someone made of it.
 *
 * §19's other hard rule shapes every schema here: "Never silently rewrite
 * historical memories. Corrections or changed beliefs must create new memory
 * records." So there is no `edit` path and no mutable `content` field. A changed
 * belief is a new record whose `supersedesMemoryId` points at the old one, and
 * the old one keeps its original text forever. The world can therefore show that
 * an inhabitant once believed something it no longer believes — which is most of
 * what makes a mind legible over time.
 *
 * Memories are private (§6): "Private cognition and private memories must remain
 * inaccessible to other inhabitants unless disclosed through a valid action."
 * `ownerId` is not a convenience field; it is the access boundary.
 */
import { z } from "zod";
import { CoordSchema } from "../primitives.js";
import {
  ENTITY_LINE_MAX,
  ENTITY_NOTE_MAX,
  ENTITY_TEXT_MAX,
  EntityIdSchema,
  PercentSchema,
  SequenceSchema,
  SignedPercentSchema,
  SimTimeSchema,
  entityText,
} from "./common.js";

/**
 * How a memory came to be held (§11E).
 *
 * Provenance is what keeps §15's "Private information cannot appear in another
 * inhabitant's context without a valid disclosure event" auditable: every
 * memory can be traced to the observation, conversation, publication or
 * investigation that produced it. A memory with `told` provenance and a source
 * inhabitant is second-hand and may be a lie.
 */
export const MemoryProvenanceSchema = z.enum([
  "participated",
  "observed",
  "told",
  "read",
  "investigated",
  "inferred",
]);
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

/**
 * A specific experience (§19 "Episodic memory").
 *
 * The scoring fields exist to serve §19's retrieval criteria — recency,
 * relevance, relationship, location, current needs, current goals, emotional or
 * motivational significance. They are integers, and they are assigned when the
 * memory is formed rather than recomputed, so that a replay produces the same
 * retrieval order.
 *
 * `emotionalValence` is *not* scripted feeling. §11C: "Do not script guilt,
 * affection, resentment or grief." It is a stored weight derived from what
 * happened to the inhabitant's goals and resources, which then affects what it
 * remembers — the difference being that the world never tells an inhabitant how
 * to feel, it only makes losses memorable.
 */
export const EpisodicMemorySchema = z.object({
  kind: z.literal("episodic"),
  id: EntityIdSchema,
  worldId: EntityIdSchema,
  /** The only inhabitant that may retrieve this record (§6). */
  ownerId: EntityIdSchema,
  createdAt: SimTimeSchema,
  /** When the remembered thing happened, which may precede `createdAt`. */
  occurredAt: SimTimeSchema,
  /** The canonical event this derives from, if any (§16). */
  eventSequence: SequenceSchema.nullable().default(null),
  summary: entityText(ENTITY_NOTE_MAX),
  participantIds: z.array(EntityIdSchema).max(16).default([]),
  coord: CoordSchema.nullable().default(null),
  provenance: MemoryProvenanceSchema,
  /** Who told the owner, for second-hand memories. Null when first-hand. */
  sourceInhabitantId: EntityIdSchema.nullable().default(null),
  /** How strongly this competes for retrieval. */
  salience: PercentSchema.default(50),
  goalRelevance: PercentSchema.default(0),
  emotionalValence: SignedPercentSchema.default(0),
  tags: z.array(z.string().max(ENTITY_LINE_MAX)).max(8).default([]),
  /** A later record that revises this one. The original text never changes (§19). */
  supersededByMemoryId: EntityIdSchema.nullable().default(null),
});
export type EpisodicMemory = z.infer<typeof EpisodicMemorySchema>;

/**
 * A periodic compressed interpretation (§19 "Long-term reflections").
 *
 * `isBelief` is a literal `true` and cannot be set otherwise. It is there so
 * that any code reading a memory record must confront the question of whether
 * it is handling a fact or an opinion, and so that a reflection can never be
 * mistaken for a canonical event when it is serialised into a prompt.
 */
export const ReflectionMemorySchema = z.object({
  kind: z.literal("reflection"),
  id: EntityIdSchema,
  worldId: EntityIdSchema,
  ownerId: EntityIdSchema,
  createdAt: SimTimeSchema,
  /** The window of experience this reflection compresses. */
  coversFrom: SimTimeSchema,
  coversTo: SimTimeSchema,
  statement: entityText(ENTITY_TEXT_MAX),
  /** The episodic records it was formed from, so it can be traced back. */
  derivedFromMemoryIds: z.array(EntityIdSchema).max(64).default([]),
  /** The owner's own confidence in the belief. Not a measure of its truth. */
  confidence: PercentSchema.default(50),
  /** Structurally guarantees a reflection can never be read as a canonical fact. */
  isBelief: z.literal(true),
  subjectIds: z.array(EntityIdSchema).max(16).default([]),
  tags: z.array(z.string().max(ENTITY_LINE_MAX)).max(8).default([]),
  supersededByMemoryId: EntityIdSchema.nullable().default(null),
});
export type ReflectionMemory = z.infer<typeof ReflectionMemorySchema>;

/** Either level of stored memory. */
export const MemorySchema = z.discriminatedUnion("kind", [
  EpisodicMemorySchema,
  ReflectionMemorySchema,
]);
export type Memory = z.infer<typeof MemorySchema>;

/**
 * How many items working memory holds.
 *
 * Small on purpose. §19: "Do not resend an inhabitant's complete life history on
 * every turn. Keep inference costs bounded." Working memory is the immediately
 * preceding context, not a summary of a life.
 */
export const WORKING_MEMORY_LIMIT = 16;

/**
 * Recent working memory (§19).
 *
 * Rebuilt each turn from the tail of the inhabitant's episodic record and the
 * events it just witnessed. Unlike the other two levels it is not durable — it
 * is a view, and it may be recomputed identically on replay.
 */
export const WorkingMemorySchema = z.object({
  ownerId: EntityIdSchema,
  updatedAt: SimTimeSchema,
  items: z
    .array(
      z.object({
        eventSequence: SequenceSchema.nullable(),
        at: SimTimeSchema,
        summary: entityText(ENTITY_LINE_MAX),
      }),
    )
    .max(WORKING_MEMORY_LIMIT)
    .default([]),
});
export type WorkingMemory = z.infer<typeof WorkingMemorySchema>;

/**
 * What an inhabitant thinks about another inhabitant (§6 "Beliefs about other
 * inhabitants").
 *
 * Kept alongside memory rather than on the relationship record, because a belief
 * is held by one party and need not be reciprocated, accurate or known to its
 * subject.
 */
export const BeliefAboutOtherSchema = z.object({
  subjectId: EntityIdSchema,
  summary: entityText(ENTITY_NOTE_MAX),
  confidence: PercentSchema.default(50),
  updatedAt: SimTimeSchema,
  /** Memories supporting the belief, so it can be revisited when they are revised. */
  basedOnMemoryIds: z.array(EntityIdSchema).max(32).default([]),
});
export type BeliefAboutOther = z.infer<typeof BeliefAboutOtherSchema>;
