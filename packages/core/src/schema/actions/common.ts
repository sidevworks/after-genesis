/**
 * Shared bounds and building blocks for action payloads.
 *
 * Everything under `schema/actions/` parses **untrusted model output** (§2:
 * "Every model response must be treated as untrusted input"). A payload arrives
 * as whatever text a language model emitted; it is not a trusted internal type.
 * Two consequences drive every declaration in this file:
 *
 * 1. **Nothing is unbounded.** Every string has a `.max()`, every array has a
 *    `.max()`, every number has an explicit integer range. A model that emits a
 *    10 MB string or a 100 000-element array must be rejected at the schema
 *    boundary, before it can be written to the append-only event log — where it
 *    would live forever and be re-hashed on every replay (§16).
 *
 * 2. **Absence is normalised, never left `undefined`.** Optional fields use
 *    `.nullable().default(null)` rather than `.optional()`. A validated payload
 *    is hashed with `canonicalJson`, which rejects `undefined` outright and
 *    would otherwise give two different hashes to "key omitted" and "key present
 *    but empty". Fixing the canonical shape at parse time means the hash of an
 *    action depends on what the model *meant*, not on which keys it bothered to
 *    type.
 *
 * No floats appear anywhere. Percentages are integers 0–100 and probabilities
 * are integers per mille, because IEEE 754 arithmetic is not reproducible across
 * platforms and replay must produce an identical checksum (§15).
 */
import { z } from "zod";
import { CoordSchema, QuantitySchema, type ResourceKind } from "../primitives.js";

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Ids are derived hashes (see ids.ts), currently 28 characters. 128 leaves room
 * for longer prefixes and composite keys without letting a model use an id field
 * as a smuggling channel for free text.
 */
export const MAX_ID_LENGTH = 128;

export const IdSchema = z.string().min(1).max(MAX_ID_LENGTH);

/** An id the model may legitimately omit. Always present as `null` after parsing. */
export const OptionalIdSchema = IdSchema.nullable().default(null);

// ---------------------------------------------------------------------------
// Text budgets
//
// Free text is the most dangerous field class in the world: it is stored
// verbatim on a canonical event, replayed forever, and re-read into other
// inhabitants' bounded context windows (§11B, §19). Each ceiling below is chosen
// against a purpose, not picked round.
// ---------------------------------------------------------------------------

/** A short symbol for a currency, e.g. "MK". Long enough to be distinctive, too short to be a slogan. */
export const SYMBOL_MAX = 8;

/** A role, tag or trait word. One or two words. */
export const LABEL_MAX = 64;

/** A display name or title: an inhabitant, structure, artifact, organisation, rule. */
export const NAME_MAX = 120;

/** A one-line note: a task description, a symptom, a known-location remark. */
export const SHORT_TEXT_MAX = 300;

/** A brief accompanying remark on a mechanical action ("here, take these"). */
export const NOTE_MAX = 500;

/** A stated position, reason or purpose. A paragraph. */
export const STATEMENT_MAX = 1000;

/**
 * One conversational utterance, roughly 500 tokens. Bounded at this size so a
 * single speaker cannot consume a listener's whole retrieval budget in one turn
 * (§11B) — attention is a scarce canonical resource (§11A), including attention
 * spent reading.
 */
export const MESSAGE_MAX = 2000;

/** A public announcement, accusation, report or description. Several paragraphs. */
export const LONG_TEXT_MAX = 4000;

/**
 * A structured document: an organisation charter, a contract's terms, a proposed
 * rule, a treatment method. Long enough for genuinely detailed governance, short
 * enough that reading one is an affordable fraction of a turn.
 */
export const DOCUMENT_MAX = 8000;

/**
 * The body of a creative artifact (§12), roughly 5000 tokens.
 *
 * This is the largest string the world accepts anywhere. It bounds one act of
 * creation to something a single bounded inference can produce and a single
 * bounded observation can carry. Longer works are built from multiple artifacts
 * with `derivedFromArtifactId` provenance, which also gives them a revision
 * history — a novel is a sequence of canonical events, not one enormous blob.
 */
export const ARTIFACT_CONTENT_MAX = 20_000;

/** A bounded string factory, for fields that need no further constraint. */
export const boundedText = (max: number) => z.string().max(max);

/** A bounded string the model may omit; normalised to `null`. */
export const optionalText = (max: number) => z.string().max(max).nullable().default(null);

/** A bounded, non-empty string. Used where an empty value would be meaningless. */
export const requiredText = (max: number) => z.string().min(1).max(max);

// ---------------------------------------------------------------------------
// List bounds
// ---------------------------------------------------------------------------

/** Co-creators, accomplices, tools: a handful. */
export const MAX_TINY_LIST = 4;

/** Conversation participants, students, collaborators, obligations per party. */
export const MAX_SMALL_LIST = 8;

/** Invitees, guards, witnesses, work assignments, evidence items. */
export const MAX_MEDIUM_LIST = 16;

/** Item lists: artifacts transferred, structures, founding members, event references. */
export const MAX_ITEM_LIST = 32;

/**
 * A declared travel path. The initial grid is 32×32 (§5), so no sensible route
 * exceeds 64 steps even doubling back; anything longer is malformed rather than
 * ambitious.
 */
export const MAX_PATH_LENGTH = 64;

/** Trait and value hints supplied to `create_inhabitant`. */
export const MAX_TRAIT_HINTS = 12;

// ---------------------------------------------------------------------------
// Numeric bounds
// ---------------------------------------------------------------------------

/**
 * The largest quantity of a primitive resource nameable in one payload. A model
 * cannot request a transfer of a quantity that does not exist, but it also must
 * not be able to name a number so large that downstream integer arithmetic
 * leaves the safe range.
 */
export const MAX_PAYLOAD_QUANTITY = 1_000_000;

/** Gathering is bounded far below the general ceiling: one action, one trip. */
export const MAX_GATHER_QUANTITY = 10_000;

/**
 * Currency is agent-created and unbacked by default (§10), so it has no natural
 * physical ceiling. 10^12 keeps every sum, product and ledger total inside
 * `Number.MAX_SAFE_INTEGER` (~9×10^15) with room for aggregation.
 */
export const MAX_CURRENCY_AMOUNT = 1_000_000_000_000;

/** One simulated day (§11A: a day's attention is the unit of scarcity). */
export const MAX_PLANNED_MINUTES = 1440;

/** 30 simulated days: how long an unaccepted offer may stand. */
export const MAX_OFFER_TTL_MINUTES = 43_200;

/** 10 simulated years, in minutes. The ceiling for a contract or a confinement. */
export const MAX_TERM_MINUTES = 5_256_000;

/** An integer percentage. Confidence, condition severity, ownership share. */
export const PercentSchema = z.number().int().min(0).max(100);

/** A signed integer percentage, e.g. emotional valence or trait emphasis. */
export const SignedPercentSchema = z.number().int().min(-100).max(100);

/** A count of simulated minutes proposed by a model. Never negative, never fractional. */
export const minutesInRange = (min: number, max: number) => z.number().int().min(min).max(max);

// ---------------------------------------------------------------------------
// Composite building blocks
// ---------------------------------------------------------------------------

/** A coordinate the model may omit; normalised to `null`. */
export const OptionalCoordSchema = CoordSchema.nullable().default(null);

const payloadQuantity = QuantitySchema.max(MAX_PAYLOAD_QUANTITY);

/**
 * A bundle of primitive resources named in a payload.
 *
 * Written out key by key rather than as a `z.record` so that every one of the
 * eight resources (§5) carries its own bound, and so that a parsed bundle always
 * has the same eight keys in the same canonical form regardless of what the
 * model sent. `_PayloadBundleCoversResourceKinds` below is a compile-time proof
 * that this list stays in step with `ResourceKind`.
 */
export const PayloadBundleSchema = z
  .object({
    food: payloadQuantity.default(0),
    water: payloadQuantity.default(0),
    wood: payloadQuantity.default(0),
    stone: payloadQuantity.default(0),
    energy: payloadQuantity.default(0),
    compute: payloadQuantity.default(0),
    land_use_rights: payloadQuantity.default(0),
    storage_capacity: payloadQuantity.default(0),
  })
  .default({});
export type PayloadBundle = z.infer<typeof PayloadBundleSchema>;

/**
 * Compile-time proof that `PayloadBundleSchema` covers exactly the eight
 * primitive resources. If §5's resource list changes, this alias stops resolving
 * to `true` and the build fails.
 */
export type _PayloadBundleCoversResourceKinds = keyof PayloadBundle extends ResourceKind
  ? ResourceKind extends keyof PayloadBundle
    ? true
    : never
  : never;

/**
 * The four resources that can be taken from the world by `gather` (§5).
 *
 * `energy` and `compute` regenerate rather than being harvested;
 * `land_use_rights` and `storage_capacity` are claims and capacities, created by
 * building and by social recognition, not found lying on a tile.
 */
export const GatherableResourceSchema = z.enum(["food", "water", "wood", "stone"]);
export type GatherableResource = z.infer<typeof GatherableResourceSchema>;

/** Compile-time proof that every gatherable resource is a real resource kind. */
export type _GatherableIsResourceKind = GatherableResource extends ResourceKind ? true : never;

/** An amount of one agent-created currency (§10). */
export const CurrencyAmountSchema = z.object({
  currencyId: IdSchema,
  amount: z.number().int().min(1).max(MAX_CURRENCY_AMOUNT),
});
export type CurrencyAmount = z.infer<typeof CurrencyAmountSchema>;

/** A list of currency amounts. Defaults to empty rather than absent. */
export const CurrencyAmountListSchema = z
  .array(CurrencyAmountSchema)
  .max(MAX_SMALL_LIST)
  .default([]);

/** A list of ids the model may omit; normalised to `[]`. */
export const idList = (max: number) => z.array(IdSchema).max(max).default([]);

/** A non-empty list of ids. Used where an action is meaningless without a target. */
export const requiredIdList = (max: number) => z.array(IdSchema).min(1).max(max);

/**
 * References to canonical events, by sequence number (§16). Used by
 * investigations, accusations and evidence, so that a claim can point at the
 * neutral record rather than restating it (§11G).
 */
export const EventReferenceListSchema = z
  .array(z.number().int().nonnegative())
  .max(MAX_ITEM_LIST)
  .default([]);

/**
 * Who an action's result is addressed to.
 *
 * Distinct from the event's `visibility`: an inhabitant may *address* the public
 * and still be observed by only those present. Audience is intent; visibility is
 * fact (§11E).
 */
export const AudienceSchema = z.enum(["participants", "organisation", "local", "public"]);

/**
 * Developmental gates (§11B: "Young inhabitants must have […] restricted action
 * capabilities. Their cognitive access expands through development").
 *
 * These are floors on `ActionSpec.minimumMaturity`, not a lifecycle: an
 * inhabitant's maturity rises with age, health and education, and a permanently
 * impaired inhabitant (§7) may never pass a gate. Nothing here is a penalty
 * applied to output — it is a restriction on which actions can be proposed at
 * all, which is the honest way to model a child who cannot yet do a thing.
 */
export const MATURITY = {
  /** Newly created. Perceive, rest, eat, speak, be cared for. */
  NEWBORN: 0,
  /** May move about, gather, study, and be taught. */
  CHILD: 1,
  /** May build, craft, trade, join organisations, publish. */
  ADOLESCENT: 2,
  /** The full vocabulary, including creation, medicine, enforcement and finance. */
  ADULT: 3,
} as const;
