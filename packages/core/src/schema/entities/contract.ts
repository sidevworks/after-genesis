// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Contracts (§10).
 *
 * One schema covers everything §10 asks for — barter settlements, gifts, loans,
 * employment, service agreements, joint ownership and transferable promises.
 * They differ only in their obligations.
 *
 * The engine's role is bookkeeping and nothing more. It records what was
 * promised, records what was actually delivered, and marks an obligation overdue
 * when its time passes. It never seizes property, never fines, never compels
 * performance. §11G is explicit that enforcement requires members, evidence,
 * decision procedures, enforcement agents and sufficient power — a contract that
 * enforced itself would hand every party a private government for free.
 *
 * The consequence is that a breach is a *fact in the log* and nothing else.
 * Whether it costs the breaching party anything depends on reputation, on
 * whether anyone will contract with them again, and on whether some organisation
 * is willing to spend real resources doing something about it.
 */
import { z } from "zod";
import {
  ENTITY_DOCUMENT_MAX,
  ENTITY_LINE_MAX,
  ENTITY_NOTE_MAX,
  EntityIdSchema,
  HeldBundleSchema,
  CurrencyHoldingSchema,
  DisclosurePolicySchema,
  HolderRefSchema,
  SequenceSchema,
  SimTimeSchema,
  entityName,
  entityText,
} from "./common.js";

/** A party to a contract. Organisations may contract in their own right (§11). */
export const ContractPartySchema = z.object({
  holder: HolderRefSchema,
  /** The party's own description of its position: "employer", "lender", "carer". */
  role: entityText(ENTITY_LINE_MAX).default(""),
  acceptedAt: SimTimeSchema.nullable().default(null),
  acceptedByEventSequence: SequenceSchema.nullable().default(null),
  /** A party may withdraw before acceptance; after it, only termination applies. */
  status: z.enum(["offered", "accepted", "rejected", "withdrawn"]).default("offered"),
});
export type ContractParty = z.infer<typeof ContractPartySchema>;

/**
 * One undertaking by one party.
 *
 * `delivered*` accumulates what was actually transferred, separately from what
 * was promised. Keeping the two apart is what makes partial performance a
 * first-class state rather than a judgement call: a party that delivered nine of
 * ten promised wood is neither performing nor in breach until the deadline
 * decides.
 */
export const ObligationSchema = z.object({
  index: z.number().int().min(0).max(255),
  /** Index into the contract's party list. An obligation cannot name a non-party. */
  obligorIndex: z.number().int().min(0).max(255),
  description: entityText(ENTITY_NOTE_MAX),

  promisedResources: HeldBundleSchema,
  promisedCurrency: z.array(CurrencyHoldingSchema).max(8).default([]),
  promisedArtifactIds: z.array(EntityIdSchema).max(64).default([]),
  promisedLabourMinutes: z.number().int().nonnegative().max(5_256_000).default(0),

  deliveredResources: HeldBundleSchema,
  deliveredCurrency: z.array(CurrencyHoldingSchema).max(8).default([]),
  deliveredArtifactIds: z.array(EntityIdSchema).max(64).default([]),
  deliveredLabourMinutes: z.number().int().nonnegative().max(5_256_000).default(0),

  dueAt: SimTimeSchema.nullable().default(null),
  recurring: z.boolean().default(false),
  recurEveryMinutes: z.number().int().nonnegative().max(5_256_000).default(0),

  /**
   * `breached` is a neutral factual finding: the deadline passed and the
   * promised thing was not delivered. It carries no penalty and implies no
   * wrongdoing the engine recognises (§11G).
   */
  status: z
    .enum(["pending", "performed", "partially_performed", "overdue", "breached", "released"])
    .default("pending"),
  performances: z
    .array(
      z.object({
        at: SimTimeSchema,
        eventSequence: SequenceSchema,
        byId: EntityIdSchema,
        claimsComplete: z.boolean(),
      }),
    )
    .max(256)
    .default([]),
});
export type Obligation = z.infer<typeof ObligationSchema>;

/** An entry in the contract's own history, so its life is readable end to end. */
export const ContractHistoryEntrySchema = z.object({
  at: SimTimeSchema,
  eventSequence: SequenceSchema,
  actorId: EntityIdSchema.nullable(),
  kind: z.enum([
    "offered",
    "accepted",
    "rejected",
    "performed",
    "breached",
    "terminated",
    "expired",
    "superseded",
    "party_died",
  ]),
  note: entityText(ENTITY_NOTE_MAX).default(""),
});
export type ContractHistoryEntry = z.infer<typeof ContractHistoryEntrySchema>;

export const ContractSchema = z.object({
  id: EntityIdSchema,
  worldId: EntityIdSchema,
  kind: z.enum([
    "employment",
    "service",
    "loan",
    "lease",
    "sale",
    "joint_ownership",
    "apprenticeship",
    "care",
    "security",
    "iou",
    "custom",
  ]),
  title: entityName(),
  /** The parties' own text. The engine does not interpret it (§2). */
  terms: entityText(ENTITY_DOCUMENT_MAX).default(""),

  parties: z.array(ContractPartySchema).min(1).max(16),
  obligations: z.array(ObligationSchema).max(64).default([]),

  offeredById: EntityIdSchema,
  offeredAt: SimTimeSchema,
  offeredByEventSequence: SequenceSchema,
  /** When every party had accepted, and obligations began to run. */
  activatedAt: SimTimeSchema.nullable().default(null),
  /** When the offer lapses if not accepted. */
  offerExpiresAt: SimTimeSchema.nullable().default(null),
  /** End of term. Null means open-ended. */
  expiresAt: SimTimeSchema.nullable().default(null),

  status: z
    .enum(["offered", "active", "completed", "terminated", "breached", "rejected", "expired"])
    .default("offered"),
  terminatedAt: SimTimeSchema.nullable().default(null),
  terminatedById: EntityIdSchema.nullable().default(null),
  /** The terminating party's characterisation. Not a finding by the engine (§11G). */
  terminationGrounds: z
    .enum([
      "completed",
      "mutual",
      "breach_by_counterparty",
      "impossible",
      "withdrawal",
      "counterparty_deceased",
    ])
    .nullable()
    .default(null),

  /** §11E distinguishes published contracts from private ones. */
  visibility: DisclosurePolicySchema.default("participants"),
  organisationId: EntityIdSchema.nullable().default(null),
  supersedesContractId: EntityIdSchema.nullable().default(null),
  supersededByContractId: EntityIdSchema.nullable().default(null),

  /**
   * Preserved after any party dies (§8: contracts are among the things death
   * must never delete). Survivors decide what becomes of the obligations; the
   * world neither cancels nor inherits them automatically.
   */
  history: z.array(ContractHistoryEntrySchema).max(512).default([]),
});
export type Contract = z.infer<typeof ContractSchema>;
