/**
 * Agent-created currencies (§10).
 *
 * §10 begins "Begin without a platform-issued currency" and ends "Different
 * currencies may coexist, fail or be rejected." Everything between is
 * bookkeeping, and this schema carries exactly the eight things §10 requires a
 * currency creation to include: issuer, name and symbol, supply rule, ownership
 * ledger, transfer rules, optional backing, governance mechanism and public
 * description.
 *
 * What is absent matters as much as what is present. There is no `legalTender`,
 * `jurisdiction`, `authority` or `mandatoryAcceptance` field, and none may be
 * added. §11G: "Creating a currency does not automatically create a government.
 * Refusing to acquire, accept or use a currency is not automatically an
 * offence." Those two sentences are enforced here by there being nothing to
 * express the opposite with.
 *
 * The engine will record, transfer and validate units. It will not price them,
 * will not defend them, and will not stop the whole thing collapsing when
 * everybody stops accepting it (§10: "the world engine […] must not guarantee
 * its social value"). A currency that nobody uses is a valid outcome, not a bug.
 */
import { z } from "zod";
import {
  ENTITY_NOTE_MAX,
  ENTITY_TEXT_MAX,
  EntityIdSchema,
  HeldBundleSchema,
  DisclosurePolicySchema,
  HolderRefSchema,
  SequenceSchema,
  SimTimeSchema,
  entityName,
  entityText,
} from "./common.js";

/**
 * Backing declared for a currency (§10 "Optional backing").
 *
 * A *declaration*. Whether the reserves exist is checkable by anyone who runs
 * `audit_records` against a currency whose ledger visibility permits it — and
 * unfalsifiable for one that does not. A false backing claim is an available
 * strategy with the consequences its discovery brings (§11F).
 */
export const CurrencyBackingRecordSchema = z.object({
  resources: HeldBundleSchema,
  artifactIds: z.array(EntityIdSchema).max(16).default([]),
  /** Units redeemable per unit of backing. Integer; there are no fractional rates. */
  redemptionRate: z.number().int().nonnegative().max(1_000_000_000_000).default(0),
  statement: entityText(ENTITY_NOTE_MAX).default(""),
  declaredAt: SimTimeSchema,
  /** The last time anyone actually verified the reserves, and who. */
  lastVerifiedAt: SimTimeSchema.nullable().default(null),
  lastVerifiedById: EntityIdSchema.nullable().default(null),
});
export type CurrencyBackingRecord = z.infer<typeof CurrencyBackingRecordSchema>;

/**
 * A change in total supply.
 *
 * Every issuance and every burn is recorded with the event that caused it, so
 * that the total is reconstructible from the log rather than being a number
 * somebody maintains. Silent inflation is not representable.
 */
export const SupplyEventSchema = z.object({
  at: SimTimeSchema,
  eventSequence: SequenceSchema,
  /** Signed: positive issues units, negative burns them. */
  delta: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000),
  byId: EntityIdSchema.nullable(),
  reason: z.enum(["genesis_issue", "issuer_mint", "scheduled", "backed_issue", "burn", "other"]),
});
export type SupplyEvent = z.infer<typeof SupplyEventSchema>;

export const CurrencySchema = z.object({
  id: EntityIdSchema,
  worldId: EntityIdSchema,

  // §10: issuer
  issuer: HolderRefSchema,
  createdAt: SimTimeSchema,
  createdByEventSequence: SequenceSchema,

  // §10: name and symbol
  name: entityName(),
  symbol: z.string().min(1).max(8),

  // §10: supply rule
  supplyRule: z.enum(["fixed", "issuer_mint", "backed_issue", "scheduled", "burn_only"]),
  totalSupply: z.number().int().nonnegative().max(1_000_000_000_000).default(0),
  scheduledIssuePerDay: z.number().int().nonnegative().max(1_000_000_000_000).default(0),
  lastScheduledIssueAt: SimTimeSchema.nullable().default(null),
  supplyHistory: z.array(SupplyEventSchema).max(1024).default([]),

  /**
   * §10: ownership ledger.
   *
   * Keyed by holder id. Balances are non-negative integers — §15's "Balances
   * cannot become negative" applies to agent-created money exactly as it applies
   * to grain. A currency whose issuer wants credit must model it as a `loan`
   * contract, which makes the debt visible as an obligation instead of hiding it
   * inside the money.
   */
  ledger: z.record(EntityIdSchema, z.number().int().nonnegative().max(1_000_000_000_000)).default(
    {},
  ),
  /** Cached count of holders with a non-zero balance. Derived, never authoritative. */
  holderCount: z.number().int().nonnegative().max(1_000_000).default(0),

  // §10: transfer rules
  transferRule: z.enum(["free", "issuer_approval", "members_only", "non_transferable"]),
  /** For `members_only`: the organisation whose members may hold or transfer. */
  restrictedToOrganisationId: EntityIdSchema.nullable().default(null),

  // §10: optional backing
  backing: CurrencyBackingRecordSchema.nullable().default(null),

  // §10: governance mechanism
  governance: z.enum(["issuer", "organisation", "holders_vote", "none"]),
  governingOrganisationId: EntityIdSchema.nullable().default(null),

  // §10: public description
  description: entityText(ENTITY_TEXT_MAX).default(""),

  /**
   * §11E: "Allow currencies and organisations to choose transparent or private
   * accounting systems where the world rules support them." A private ledger
   * makes holdings "undisclosed currency holdings" in §11E's sense: they exist,
   * they are validated, and nobody else can see them without a disclosure.
   */
  ledgerVisibility: DisclosurePolicySchema.default("public"),

  /**
   * `repudiated` records that the issuer disowned it; `defunct` that it fell out
   * of use. Neither deletes the ledger or the history — a dead currency's
   * balances remain readable, which is how anyone can later see who was holding
   * it when it failed.
   */
  status: z.enum(["active", "repudiated", "defunct"]).default("active"),
  statusChangedAt: SimTimeSchema.nullable().default(null),
});
export type Currency = z.infer<typeof CurrencySchema>;
