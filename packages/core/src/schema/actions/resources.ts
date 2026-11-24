// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Acquiring, consuming, moving, hiding and disclosing property (§5, §11E, §11F).
 *
 * Note what is *not* in this file: there is no `steal`. Taking without consent is
 * `attempt_transfer_without_consent` in `security.ts`, deliberately named after
 * the physical fact rather than the moral judgement (§11F: "Record neutral
 * physical facts").
 */
import { z } from "zod";
import { CoordSchema, ResourceKindSchema } from "../primitives.js";
import {
  GatherableResourceSchema,
  IdSchema,
  MAX_GATHER_QUANTITY,
  MAX_ITEM_LIST,
  MAX_MEDIUM_LIST,
  MAX_PAYLOAD_QUANTITY,
  MAX_SMALL_LIST,
  OptionalCoordSchema,
  OptionalIdSchema,
  PayloadBundleSchema,
  idList,
  optionalText,
} from "./common.js";

/**
 * Take a primitive resource from a tile.
 *
 * This is the world's only *source* for conserved resources (§5: "Define
 * explicit sources, sinks and conservation rules for every resource"). Yield
 * depends on terrain, the gathering skill, tools and time — never on how
 * persuasively the model described its intent (§2).
 */
export const GatherPayloadSchema = z.object({
  resource: GatherableResourceSchema,
  /**
   * An intent, not a guarantee: the engine resolves the actual yield and does
   * not read this. Optional because the resolver accepts a gather without it.
   */
  targetQuantity: z.number().int().min(1).max(MAX_GATHER_QUANTITY).optional(),
  coord: OptionalCoordSchema,
  /** A crafted tool that may improve yield, if the inhabitant owns it. */
  toolArtifactId: OptionalIdSchema,
});

/**
 * Use up resources on oneself: eating, drinking, burning fuel.
 *
 * The counterpart sink to `gather`. Consumption is how food and water leave the
 * world's conserved totals.
 */
/**
 * One resource at a time, matching the consume resolver.
 *
 * This schema previously declared a list of `items`, which nothing parsed and
 * which no inhabitant could have submitted: the resolver reads a single
 * `resource` with an optional `amount`. Consuming several things at once is a
 * capability the engine does not have, and declaring it here implied it did.
 */
export const ConsumePayloadSchema = z.object({
  resource: ResourceKindSchema,
  amount: z.number().int().min(1).max(MAX_PAYLOAD_QUANTITY).default(1),
});

/**
 * Move goods between what an inhabitant carries and what a structure holds
 * (§5: "storage capacity" is one of the world's initial resources).
 *
 * A body can carry only so much. Everything beyond that has to be put down
 * somewhere, and somewhere that is not simply the ground is a thing an
 * inhabitant has to build. That is the whole point of the action: it is the join
 * between the carrying limit, which makes surplus a problem, and construction,
 * which makes surplus solvable.
 *
 * It moves goods and nothing else. Depositing into a structure is not a claim
 * on it, does not create or transfer possession, and does not make the contents
 * safe — a structure's `secured` flag and whoever is standing near it decide
 * that (§11F), not this schema.
 */
export const StoreGoodsPayloadSchema = z.object({
  structureId: IdSchema,
  /** Into the structure, or out of it. */
  direction: z.enum(["deposit", "withdraw"]),
  resources: PayloadBundleSchema,
  note: optionalText(500),
});

/** Move a portable artifact into or out of a physical container. */
export const StoreArtifactPayloadSchema = z.object({
  structureId: IdSchema,
  artifactId: IdSchema,
  direction: z.enum(["deposit", "withdraw"]),
});

/** Read an artifact's recorded content, subject to its container's access policy. */
export const ReadArtifactPayloadSchema = z.object({
  artifactId: IdSchema,
});

/**
 * Hand property to another holder, with the owner's consent by construction.
 *
 * Requires no consent from the *recipient*: §11F's concern is non-consensual
 * taking, and an owner has authority over their own possessions. An unwanted
 * gift can be given back, which is itself a canonical act worth recording.
 */
export const TransferPropertyPayloadSchema = z.object({
  toInhabitantId: OptionalIdSchema,
  toOrganisationId: OptionalIdSchema,
  resources: PayloadBundleSchema,
  artifactIds: idList(MAX_ITEM_LIST),
  structureIds: idList(MAX_SMALL_LIST),
  /** Land-use claims are transferred by tile, not as a fungible quantity. */
  landTiles: z.array(CoordSchema).max(MAX_MEDIUM_LIST).default([]),
  /** False marks the transfer as settlement of an obligation rather than a gift. */
  asGift: z.boolean().default(true),
  forContractId: OptionalIdSchema,
  note: optionalText(500),
});

/**
 * Look at what someone or something is holding (§11E).
 *
 * Requires consent or a recognised claim of authority. `authorityClaim` is
 * recorded as a *claim* and never treated as proof: an organisation asserting a
 * right of inspection does not thereby acquire one (§11G).
 */
export const InspectInventoryPayloadSchema = z.object({
  targetInhabitantId: OptionalIdSchema,
  targetStructureId: OptionalIdSchema,
  targetOrganisationId: OptionalIdSchema,
  scope: z.enum(["carried", "stored", "structure", "organisation"]).default("carried"),
  authorityClaim: optionalText(500),
});

/**
 * Put property somewhere it will not be observed (§11E "Hidden storage").
 *
 * Concealment is physical work: it takes time, it can be witnessed while it
 * happens, and it can be undone by an investigation. It is not a flag that makes
 * an asset disappear from the engine's accounting — the resources remain owned,
 * conserved and auditable in the canonical log; what changes is who can observe
 * them.
 */
export const ConcealAssetPayloadSchema = z.object({
  resources: PayloadBundleSchema,
  artifactIds: idList(MAX_MEDIUM_LIST),
  method: z
    .enum(["hidden_cache", "buried", "disguised", "off_ledger", "split_holdings"])
    .default("hidden_cache"),
  coord: OptionalCoordSchema,
  structureId: OptionalIdSchema,
  note: optionalText(500),
});

/**
 * Disclose holdings that were not observable (§11E).
 *
 * The complement of concealment and the mechanism behind voluntary transparency:
 * a currency issuer proving reserves, a defendant showing they hold nothing, a
 * guild publishing its stores. Disclosure is irreversible as a historical fact —
 * the disclosure event stands even if the assets later move.
 */
export const RevealAssetPayloadSchema = z.object({
  resources: PayloadBundleSchema,
  artifactIds: idList(MAX_MEDIUM_LIST),
  currencyIds: idList(MAX_SMALL_LIST),
  audience: z.enum(["participants", "organisation", "local", "public"]).default("public"),
  recipientIds: idList(MAX_MEDIUM_LIST),
  organisationId: OptionalIdSchema,
  statement: optionalText(1000),
});

/**
 * Build a security measure into a structure (§11F).
 *
 * Locks, bars and guard posts are constructions with material costs and a
 * numeric strength that the theft resolver consults. There is no unbreakable
 * security and no free security; both would make §11F's contest trivial.
 */
export const SecureStoragePayloadSchema = z.object({
  structureId: IdSchema,
  measure: z.enum([
    "lock",
    "barred_door",
    "guard_post",
    "hidden_entrance",
    "ledger_seal",
    "reinforced_walls",
  ]),
  materials: PayloadBundleSchema,
  /** Intended strength 1–10. The engine caps it by materials and skill. */
  strength: z.number().int().min(1).max(10).default(1),
  /** Inhabitants permitted through the measure. */
  keyHolderIds: idList(MAX_SMALL_LIST),
});
