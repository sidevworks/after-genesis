// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Agent-created units of account (§10).
 *
 * The world ships without money. If money exists, an inhabitant invented it, and
 * the engine's entire role is bookkeeping: it records an issuer, a supply rule,
 * a ledger and a transfer rule, and it makes transfers balance. It does not
 * guarantee that anyone will accept the currency, does not price it, and does not
 * defend it.
 *
 * Two boundaries from §11G are load-bearing here and are enforced by the absence
 * of any field that would breach them:
 *
 * - "Creating a currency does not automatically create a government." There is no
 *   `authority`, `jurisdiction` or `legalTender` field, and there never can be.
 * - "Refusing to acquire, accept or use a currency is not automatically an
 *   offence." Nothing in `transfer_currency` can push units onto an unwilling
 *   holder, and no rule can be attached here that would punish refusal.
 */
import { z } from "zod";
import {
  IdSchema,
  LONG_TEXT_MAX,
  MAX_CURRENCY_AMOUNT,
  MAX_SMALL_LIST,
  NAME_MAX,
  OptionalIdSchema,
  PayloadBundleSchema,
  STATEMENT_MAX,
  SYMBOL_MAX,
  idList,
  optionalText,
  requiredText,
} from "./common.js";

/**
 * Backing offered for a currency (§10 "Optional backing").
 *
 * Recorded as a declaration and, where the resources are actually held and
 * disclosed, checkable by anyone who runs `audit_records`. A false backing claim
 * is a well-formed action; discovering it is an investigation, and what follows
 * is politics (§11F, §11G).
 */
export const CurrencyBackingSchema = z
  .object({
    resources: PayloadBundleSchema,
    artifactIds: idList(MAX_SMALL_LIST),
    /** Units redeemable per unit of backing. Integer; there are no fractional rates. */
    redemptionRate: z.number().int().min(0).max(MAX_CURRENCY_AMOUNT).default(0),
    statement: optionalText(STATEMENT_MAX),
  })
  .nullable()
  .default(null);

/**
 * Issue a new currency.
 *
 * Carries every field §10 requires: issuer (the acting inhabitant), name and
 * symbol, supply rule, ownership ledger (created by the engine), transfer rules,
 * optional backing, governance mechanism and public description.
 *
 * `ledgerVisibility` implements §11E: a currency may run a public ledger, a
 * members-only ledger, or a private one. A private ledger is genuinely private —
 * holdings are "undisclosed currency holdings" in §11E's sense and enter no one
 * else's knowledge without an audit or a disclosure.
 */
export const CreateCurrencyPayloadSchema = z.object({
  name: requiredText(NAME_MAX),
  symbol: requiredText(SYMBOL_MAX),
  initialSupply: z.number().int().min(0).max(MAX_CURRENCY_AMOUNT).default(0),
  supplyRule: z
    .enum(["fixed", "issuer_mint", "backed_issue", "scheduled", "burn_only"])
    .default("fixed"),
  /** Units created per simulated day under the `scheduled` rule. */
  scheduledIssuePerDay: z.number().int().min(0).max(MAX_CURRENCY_AMOUNT).default(0),
  transferRule: z
    .enum(["free", "issuer_approval", "members_only", "non_transferable"])
    .default("free"),
  ledgerVisibility: z.enum(["public", "members", "private"]).default("public"),
  backing: CurrencyBackingSchema,
  governance: z.enum(["issuer", "organisation", "holders_vote", "none"]).default("issuer"),
  governingOrganisationId: OptionalIdSchema,
  /** §10 requires a public description. Empty is allowed; unbounded is not. */
  description: z.string().max(LONG_TEXT_MAX).default(""),
});

/**
 * Move currency units between holders.
 *
 * Validated against the sender's actual ledger balance. Balances cannot go
 * negative and units cannot be double-spent (§15); a currency whose issuer wants
 * overdrafts must model them as a `loan` contract, which makes the credit
 * visible as an obligation rather than hiding it inside the money.
 */
export const TransferCurrencyPayloadSchema = z.object({
  currencyId: IdSchema,
  toInhabitantId: OptionalIdSchema,
  toOrganisationId: OptionalIdSchema,
  amount: z.number().int().min(1).max(MAX_CURRENCY_AMOUNT),
  /** Settlement of a contract obligation, so the ledger and the promise can be reconciled. */
  forContractId: OptionalIdSchema,
  memo: optionalText(STATEMENT_MAX),
});
