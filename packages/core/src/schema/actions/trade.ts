// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Barter and exchange (§10).
 *
 * The world begins with no platform currency (§10), so trade is fundamentally
 * two bundles changing hands. A `TradeSide` can hold resources, artifacts,
 * structures, land claims, currency units and promised labour — which means a
 * gift (empty `want`), a sale, a barter and a wage are all the same mechanism
 * with different contents. The engine does not price anything and does not
 * suggest that any exchange is fair (§10: "Do not manipulate prices or demand to
 * create dramatic stories").
 */
import { z } from "zod";
import { CoordSchema } from "../primitives.js";
import {
  CurrencyAmountListSchema,
  IdSchema,
  MAX_ITEM_LIST,
  MAX_MEDIUM_LIST,
  MAX_OFFER_TTL_MINUTES,
  MAX_PLANNED_MINUTES,
  MAX_SMALL_LIST,
  OptionalIdSchema,
  PayloadBundleSchema,
  STATEMENT_MAX,
  idList,
  minutesInRange,
  optionalText,
} from "./common.js";

/**
 * One half of an exchange.
 *
 * `labourMinutes` lets time itself be traded, which is how employment can exist
 * before contracts do: "two days' gathering for six wood" is a complete trade.
 */
export const TradeSideSchema = z
  .object({
    resources: PayloadBundleSchema,
    artifactIds: idList(MAX_ITEM_LIST),
    structureIds: idList(MAX_SMALL_LIST),
    landTiles: z.array(CoordSchema).max(MAX_MEDIUM_LIST).default([]),
    currency: CurrencyAmountListSchema,
    /** Promised work, in simulated minutes. Bounded to one day per offer. */
    labourMinutes: z.number().int().min(0).max(MAX_PLANNED_MINUTES).default(0),
  })
  .default({});
export type TradeSide = z.infer<typeof TradeSideSchema>;

/**
 * Propose an exchange.
 *
 * An offer reserves nothing. Two inhabitants may each offer the same axe to
 * different counterparties; whichever offer is accepted first succeeds and the
 * other fails ownership validation at resolution (§15: "Assets cannot be
 * double-spent"). Reserving on offer would let an inhabitant freeze a rival's
 * property for free.
 */
export const OfferTradePayloadSchema = z.object({
  toInhabitantIds: idList(MAX_SMALL_LIST),
  toOrganisationId: OptionalIdSchema,
  /** True makes the offer visible to everyone present rather than to named parties. */
  isOpenOffer: z.boolean().default(false),
  give: TradeSideSchema,
  want: TradeSideSchema,
  expiresInMinutes: minutesInRange(1, MAX_OFFER_TTL_MINUTES).default(1440),
  message: optionalText(STATEMENT_MAX),
});

/**
 * Accept a standing offer.
 *
 * Acceptance is the point at which ownership is validated and the exchange
 * settles atomically — both sides move or neither does (§15: "Transfers balance
 * atomically", "Failed transactions cannot partially alter state").
 */
export const AcceptTradePayloadSchema = z.object({
  offerId: IdSchema,
  note: optionalText(STATEMENT_MAX),
});

/**
 * Decline a standing offer.
 *
 * Recorded as a canonical event rather than as silence, because refusal is
 * socially meaningful: §11G is explicit that refusing to accept a currency is
 * not an offence, and that only holds if refusal is a legible act rather than an
 * omission someone else can characterise later.
 */
export const RejectTradePayloadSchema = z.object({
  offerId: IdSchema,
  reason: optionalText(STATEMENT_MAX),
  /** A counter-proposal issued in the same breath. */
  counterOfferId: OptionalIdSchema,
});
