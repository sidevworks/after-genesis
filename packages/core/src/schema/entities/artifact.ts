/**
 * Creative works and inventions (§12).
 *
 * §12 lists exactly what an artifact requires: creator or creators, creation
 * event, title, content or storage reference, ownership, publication status,
 * provenance, revision history, associated costs, and sale or transfer history.
 * Every one of those is a field below.
 *
 * Two boundaries are worth stating explicitly:
 *
 * - An artifact's *content* is inert. A design describing a machine does not
 *   produce a machine; a text describing a law does not create one (§11G). What
 *   an artifact can do is be studied, copied, sold, believed and argued about.
 * - Generated media (ElevenLabs audio, §21) is not an artifact and never
 *   appears here. §12: "Generated media must be clearly distinguishable from
 *   canonical world actions. Media generation cannot modify the civilisation."
 */
import { z } from "zod";
import {
  ENTITY_CONTENT_MAX,
  ENTITY_NAME_MAX,
  ENTITY_NOTE_MAX,
  EntityIdSchema,
  HeldBundleSchema,
  CurrencyHoldingSchema,
  DisclosurePolicySchema,
  OwnershipShareSchema,
  SequenceSchema,
  SimTimeSchema,
  entityName,
  entityText,
} from "./common.js";

/**
 * One revision of an artifact (§12 "Revision history").
 *
 * Revisions append; they never overwrite. The content of revision 0 is still
 * readable after revision 7 exists, which is the same discipline as §19's rule
 * about memories and §16's rule about events: the world corrects itself by
 * adding, never by editing.
 */
export const ArtifactRevisionSchema = z.object({
  revision: z.number().int().nonnegative().max(1024),
  at: SimTimeSchema,
  editorId: EntityIdSchema,
  eventSequence: SequenceSchema,
  /** Digest of the revision's content, so an export can be verified (§16). */
  contentHash: z.string().max(128),
  note: entityText(ENTITY_NOTE_MAX).default(""),
});
export type ArtifactRevision = z.infer<typeof ArtifactRevisionSchema>;

/** A change of hands (§12 "Sale or transfer history"). */
export const ArtifactTransferSchema = z.object({
  at: SimTimeSchema,
  eventSequence: SequenceSchema,
  fromHolderId: EntityIdSchema.nullable(),
  toHolderId: EntityIdSchema,
  /** What was paid, if anything. A gift has an empty price. */
  priceResources: HeldBundleSchema,
  priceCurrency: z.array(CurrencyHoldingSchema).max(8).default([]),
});
export type ArtifactTransfer = z.infer<typeof ArtifactTransferSchema>;

export const ArtifactSchema = z.object({
  id: EntityIdSchema,
  worldId: EntityIdSchema,
  kind: z.enum([
    "written_work",
    "image",
    "design",
    "song",
    "script",
    "play",
    "performance_record",
    "research_note",
    "advertisement",
    "news_report",
    "invention",
    "tool",
    "container",
    "lock",
    "instrument",
    "furnishing",
    "medicine",
    "other",
  ]),
  title: entityName(),
  /** §12: creator or creators. Order is the order they were recorded in. */
  creatorIds: z.array(EntityIdSchema).min(1).max(8),
  createdAt: SimTimeSchema,
  /** §12: creation event. */
  createdByEventSequence: SequenceSchema,

  /**
   * §12: content *or* storage reference. Inline for text; a Cloud Storage path
   * for audio and images (§3). Exactly one is expected to be non-empty, but both
   * are bounded because both end up in the canonical export.
   */
  content: entityText(ENTITY_CONTENT_MAX).default(""),
  externalReference: entityText(ENTITY_NAME_MAX).default(""),
  contentHash: z.string().max(128).default(""),

  ownership: z.array(OwnershipShareSchema).max(16).default([]),

  /** §12: publication status. Private works are unobservable to others (§11E). */
  publicationStatus: z.enum(["private", "shared", "published", "withdrawn"]).default("private"),
  publishedAt: SimTimeSchema.nullable().default(null),
  publicationAudience: DisclosurePolicySchema.default("private"),

  /** §12: provenance. */
  derivedFromArtifactIds: z.array(EntityIdSchema).max(16).default([]),
  producedByStructureId: EntityIdSchema.nullable().default(null),
  organisationId: EntityIdSchema.nullable().default(null),

  /** §12: revision history. */
  revisions: z.array(ArtifactRevisionSchema).max(1024).default([]),

  /** §12: associated costs — what its creation actually consumed. */
  costs: HeldBundleSchema,

  /** §12: sale or transfer history. */
  transfers: z.array(ArtifactTransferSchema).max(256).default([]),

  /**
   * Mechanical affordance, decided by the engine at creation from materials and
   * skill — not from the artifact's description. A `tool` with quality 0 helps
   * nobody regardless of what its text claims (§2).
   */
  quality: z.number().int().min(0).max(100).default(0),
  /** Wear. A tool at 0 integrity no longer functions but still exists as a record. */
  integrity: z.number().int().min(0).max(100).default(100),

  /**
   * Preserved after its creators die (§8: "Death must never delete history").
   * Surviving inhabitants decide what becomes of it; the world does not
   * automatically inherit, destroy or memorialise anything.
   */
  destroyedAt: SimTimeSchema.nullable().default(null),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
