// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Promises (§10).
 *
 * A contract is the world's mechanism for an obligation that outlives the moment
 * it was agreed. §10 lists employment, service agreements, loans, joint
 * ownership and transferable promises; all of them are this one schema with
 * different obligations attached.
 *
 * The engine tracks obligations, records performance and records breach. It does
 * **not** enforce: nothing here seizes property from a party who fails to
 * perform. Enforcement is a social project requiring members, evidence,
 * procedures and power (§11G), and giving contracts automatic teeth would hand
 * every contracting party a private government.
 */
import { z } from "zod";
import {
  CurrencyAmountListSchema,
  DOCUMENT_MAX,
  IdSchema,
  MAX_ITEM_LIST,
  MAX_MEDIUM_LIST,
  MAX_SMALL_LIST,
  MAX_TERM_MINUTES,
  MESSAGE_MAX,
  NAME_MAX,
  OptionalIdSchema,
  PayloadBundleSchema,
  SHORT_TEXT_MAX,
  STATEMENT_MAX,
  idList,
  minutesInRange,
  optionalText,
  requiredIdList,
  requiredText,
} from "./common.js";

/**
 * One thing a party has undertaken to do.
 *
 * `obligorIndex` points into the contract's party list rather than naming an id,
 * so an obligation cannot be quietly attached to someone who is not a party.
 */
export const ObligationDraftSchema = z.object({
  obligorIndex: z.number().int().min(0).max(MAX_SMALL_LIST - 1),
  description: requiredText(SHORT_TEXT_MAX),
  /** Minutes after acceptance by which this falls due. 0 means immediately. */
  dueAfterMinutes: z.number().int().min(0).max(MAX_TERM_MINUTES).default(0),
  resources: PayloadBundleSchema,
  currency: CurrencyAmountListSchema,
  artifactIds: idList(MAX_SMALL_LIST),
  /** Work promised, in simulated minutes: this is what an employment contract is. */
  labourMinutes: z.number().int().min(0).max(MAX_TERM_MINUTES).default(0),
  /** Whether this obligation repeats for the life of the contract. */
  recurring: z.boolean().default(false),
  recurEveryMinutes: z.number().int().min(0).max(MAX_TERM_MINUTES).default(0),
});

/**
 * Propose a contract.
 *
 * `isPublic` decides whether the contract is publicly recorded or private
 * (§11E distinguishes "Published contracts" from "Private contracts"). A private
 * contract binds its parties exactly as much as a public one; what differs is
 * whether anyone else can ever prove it existed.
 */
export const OfferContractPayloadSchema = z.object({
  counterpartyIds: requiredIdList(MAX_SMALL_LIST),
  counterpartyOrganisationIds: idList(MAX_SMALL_LIST),
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
  title: requiredText(NAME_MAX),
  terms: requiredText(DOCUMENT_MAX),
  obligations: z.array(ObligationDraftSchema).max(MAX_MEDIUM_LIST).default([]),
  /** 0 means open-ended: the contract stands until terminated. */
  durationMinutes: z.number().int().min(0).max(MAX_TERM_MINUTES).default(0),
  expiresInMinutes: minutesInRange(1, MAX_TERM_MINUTES).default(1440),
  isPublic: z.boolean().default(false),
  organisationId: OptionalIdSchema,
  /** Replaces or renegotiates an existing contract rather than adding to it. */
  supersedesContractId: OptionalIdSchema,
});

/** Agree to be bound. Acceptance is the moment obligations begin to run. */
export const AcceptContractPayloadSchema = z.object({
  contractId: IdSchema,
  /** Accept only some obligations, by index. Empty means all of them. */
  acceptedObligationIndexes: z
    .array(z.number().int().min(0).max(MAX_MEDIUM_LIST - 1))
    .max(MAX_MEDIUM_LIST)
    .default([]),
  note: optionalText(STATEMENT_MAX),
});

/** Decline to be bound, optionally with a counter-proposal. */
export const RejectContractPayloadSchema = z.object({
  contractId: IdSchema,
  reason: optionalText(STATEMENT_MAX),
  counterProposal: optionalText(MESSAGE_MAX),
  counterContractId: OptionalIdSchema,
});

/**
 * Discharge an obligation.
 *
 * Performance is a real transfer of resources, artifacts, currency or time —
 * validated against actual holdings like any other transfer. Saying that a
 * contract has been performed does not perform it (§2).
 */
export const PerformContractPayloadSchema = z.object({
  contractId: IdSchema,
  obligationIndex: z.number().int().min(0).max(MAX_MEDIUM_LIST - 1).default(0),
  resources: PayloadBundleSchema,
  currency: CurrencyAmountListSchema,
  artifactIds: idList(MAX_ITEM_LIST),
  /** Minutes of work delivered under an employment or service obligation. */
  labourMinutes: z.number().int().min(0).max(MAX_TERM_MINUTES).default(0),
  /** True when the obligor asserts this completes the obligation. */
  claimsComplete: z.boolean().default(true),
  note: optionalText(STATEMENT_MAX),
});

/**
 * End a contract.
 *
 * `grounds` is the terminating party's characterisation, not the engine's
 * finding. The canonical event records that party X terminated contract Y
 * stating grounds Z; whether that was a lawful withdrawal or a breach is
 * precisely the kind of question §11G leaves to the inhabitants to argue about.
 */
export const TerminateContractPayloadSchema = z.object({
  contractId: IdSchema,
  grounds: z.enum([
    "completed",
    "mutual",
    "breach_by_counterparty",
    "impossible",
    "withdrawal",
    "counterparty_deceased",
  ]),
  reason: optionalText(STATEMENT_MAX),
  restitutionOffered: PayloadBundleSchema,
  restitutionCurrency: CurrencyAmountListSchema,
});
