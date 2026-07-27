/**
 * Shared building blocks for materialised entities (§4E).
 *
 * Entities are *derived* state — a cache rebuilt by replaying the event log
 * (§4D, §4E). That makes them a different trust boundary from action payloads:
 * an entity is written by the engine, not by a model. They are still bounded,
 * for two reasons. First, an unbounded entity field is a place where an
 * unbounded payload field could eventually land. Second, these schemas are the
 * contract the replay verifier checks a reconstructed world against (§16), and a
 * contract with no bounds proves nothing.
 *
 * As with payloads: no floats. Anything that would want to be a fraction is an
 * integer percent (0–100) or per mille (0–1000). See util/canonical.ts.
 */
import { z } from "zod";

/** Ids are derived hashes with a type prefix (see ids.ts). */
export const EntityIdSchema = z.string().min(1).max(128);

/** Simulated minutes since Genesis (see time.ts). Never negative, never fractional. */
export const SimTimeSchema = z.number().int().nonnegative();

/** A canonical event's sequence number (§16). */
export const SequenceSchema = z.number().int().nonnegative();

/** An integer percentage, 0–100. */
export const PercentSchema = z.number().int().min(0).max(100);

/** A signed integer scale, −100…100. Used for affinity, valence and trait strength. */
export const SignedPercentSchema = z.number().int().min(-100).max(100);

/**
 * An integer per mille, 0–1000. Used where percent is too coarse to be honest:
 * treatment efficacy, daily mortality risk, ownership shares.
 */
export const PermilleSchema = z.number().int().min(0).max(1000);

export const ENTITY_NAME_MAX = 120;
export const ENTITY_LABEL_MAX = 64;
export const ENTITY_LINE_MAX = 300;
export const ENTITY_NOTE_MAX = 1000;
export const ENTITY_TEXT_MAX = 4000;
export const ENTITY_DOCUMENT_MAX = 8000;
export const ENTITY_CONTENT_MAX = 20_000;

export const entityName = () => z.string().min(1).max(ENTITY_NAME_MAX);
export const entityText = (max: number) => z.string().max(max);

/**
 * A stored `ResourceBundle` (§5).
 *
 * Written out key by key so every holding carries an explicit bound and so a
 * materialised bundle always has the same canonical shape — the state checksum
 * must not depend on whether a holder happens to have zero wood.
 */
const heldQuantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const HeldBundleSchema = z
  .object({
    food: heldQuantity.default(0),
    water: heldQuantity.default(0),
    wood: heldQuantity.default(0),
    stone: heldQuantity.default(0),
    energy: heldQuantity.default(0),
    compute: heldQuantity.default(0),
    land_use_rights: heldQuantity.default(0),
    storage_capacity: heldQuantity.default(0),
  })
  .default({});
export type HeldBundle = z.infer<typeof HeldBundleSchema>;

/** A holding of one agent-created currency (§10). */
export const CurrencyHoldingSchema = z.object({
  currencyId: EntityIdSchema,
  amount: z.number().int().nonnegative(),
});
export type CurrencyHolding = z.infer<typeof CurrencyHoldingSchema>;

/**
 * Who holds a thing. Property may belong to an inhabitant, an organisation, or
 * be held jointly — §10 requires private, communal and joint ownership.
 */
export const HolderRefSchema = z.object({
  kind: z.enum(["inhabitant", "organisation"]),
  id: EntityIdSchema,
});
export type HolderRef = z.infer<typeof HolderRefSchema>;

/**
 * A share of ownership, in per mille. Shares across an entity's owners are
 * expected to total 1000; the engine enforces it, and integers make that
 * enforceable exactly rather than approximately.
 */
export const OwnershipShareSchema = z.object({
  holder: HolderRefSchema,
  sharePermille: PermilleSchema,
  since: SimTimeSchema,
});
export type OwnershipShare = z.infer<typeof OwnershipShareSchema>;

/**
 * Visibility declared by an entity about itself (§11E).
 *
 * Distinct from an event's `Visibility`: this is a standing policy — a
 * currency's ledger, an organisation's accounts, a contract's terms — whereas an
 * event's visibility is a fact about one moment.
 */
export const DisclosurePolicySchema = z.enum(["public", "members", "participants", "private"]);
export type DisclosurePolicy = z.infer<typeof DisclosurePolicySchema>;
