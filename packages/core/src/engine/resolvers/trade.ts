/**
 * `offer_trade`, `accept_trade`, `reject_trade`, `transfer_property` — barter (§10).
 *
 * The world begins with no platform currency, so exchange is fundamentally two
 * bundles changing hands. A gift (empty `want`), a sale, a barter and a wage are
 * the same mechanism with different contents, and the engine prices none of them
 * (§10: "Do not manipulate prices or demand to create dramatic stories"). There
 * is no valuation function in this file and there must never be one.
 *
 * ## Offers reserve nothing
 *
 * `offer_trade` moves no property and locks none. Two inhabitants may each offer
 * the same axe to different counterparties; whichever offer is accepted first
 * succeeds and the other fails ownership validation at settlement (§15: "assets
 * cannot be double-spent"). The alternative — reserving on offer — would let an
 * inhabitant freeze a rival's property for free by offering to buy it, which is
 * a weapon rather than a market. It also means an offer of something the offerer
 * does not hold is a well-formed action that simply fails when taken up; the
 * engine records the attempt neutrally and leaves the word for it to the
 * inhabitants (§11G).
 *
 * ## Settlement is all-or-nothing
 *
 * `settleConsideration` builds a *new* state and returns it only if every leg
 * succeeded. Because every state helper is pure, a failure has nothing to undo:
 * the caller returns `reject(ctx, …)` carrying `ctx.state`, which is the world
 * exactly as it was (§15: "failed transactions cannot partially alter state").
 * `accept_trade` chains two settlements — the offerer's side and the acceptor's
 * — and discards both if the second fails, so a trade never half-happens.
 *
 * Conservation is preserved by construction: every leg is a move. Resources are
 * subtracted from one inventory and added to another in the same amount, an
 * artifact or structure changes its `owner` field and continues to exist, and
 * currency moves between ledger rows without touching `issuedSupply`. Nothing
 * here calls `recordCreated` or `recordDestroyed`, because trading destroys
 * nothing and creates nothing.
 *
 * ## A trade offer is a contract
 *
 * Offers are stored as `Contract` records of kind `"trade"`, which is not a
 * shortcut but the accurate shape: an offer is a proposal whose obligations both
 * fall due immediately. It also means a trade that includes promised labour
 * degrades gracefully — the goods settle now and the hours remain as an
 * outstanding undertaking to be discharged by `perform_contract`, which is how
 * employment can exist before anybody writes an employment contract.
 */
import { deriveContractId } from "../../ids.js";
import { getActionSpec } from "../../schema/actions/index.js";
import {
  AcceptTradePayloadSchema,
  OfferTradePayloadSchema,
  RejectTradePayloadSchema,
  type TradeSide,
} from "../../schema/actions/trade.js";
import { TransferPropertyPayloadSchema } from "../../schema/actions/resources.js";
import { addBundles, chebyshevDistance } from "../../schema/primitives.js";
import type { ResourceBundle } from "../../schema/primitives.js";
import { addDuration, duration } from "../../time.js";
import {
  EMPTY_CONSIDERATION,
  insertSorted,
  normaliseBundle,
  putArtifact,
  putContract,
  putOrganisation,
  putStructure,
  updateInhabitant,
  type Consideration,
  type Contract,
  type Undertaking,
  type WorldState,
} from "../state.js";
import { advanceNeeds, beginActivity, practise, receive, spend } from "./effects.js";
import {
  ExchangeRejection,
  moveUnits,
  settlementFailed,
  type Settlement,
} from "./currency.js";
import { RejectionCode, reject, type ResolutionResult, type Resolver } from "./types.js";

const OFFER = getActionSpec("offer_trade");
const ACCEPT = getActionSpec("accept_trade");
const REJECT = getActionSpec("reject_trade");
const TRANSFER_PROPERTY = getActionSpec("transfer_property");

/* ------------------------------------------------------------------------- */
/* Considerations                                                             */
/* ------------------------------------------------------------------------- */

const sortedUnique = (ids: readonly string[]): string[] => [...new Set(ids)].sort();

/**
 * Why `energy` and `compute` may never be traded.
 *
 * They are capacities of a body rather than portable goods (§6 keeps them inside
 * `inventory` only so that there is one place a quantity is spent from), they
 * are exempt from conservation, and they are capped per inhabitant. Allowing
 * them to move would let two inhabitants pool their caps, and would make an
 * inhabitant able to sell the very thing it needs in order to act.
 */
const UNTRADEABLE: readonly (keyof ResourceBundle)[] = ["energy", "compute"];

/** Reject a proposed side, or return `null` if it is well formed. */
export function malformedSide(side: TradeSide): string | null {
  for (const kind of UNTRADEABLE) {
    if ((side.resources[kind] ?? 0) > 0) return `${kind} is a capacity, not a portable good`;
  }
  if (side.landTiles.length > 0) {
    // Land use is held as the fungible `land_use_rights` resource (§5). There is
    // no per-tile claim registry to move a named tile between holders, and
    // pretending to move one would record an ownership the world cannot honour.
    return "named land tiles cannot be transferred; trade land_use_rights instead";
  }
  return null;
}

export function considerationOf(side: TradeSide): Consideration {
  return {
    resources: normaliseBundle(side.resources),
    currency: side.currency.map((amount) => ({
      currencyId: amount.currencyId,
      amount: amount.amount,
    })),
    artifactIds: sortedUnique(side.artifactIds),
    structureIds: sortedUnique(side.structureIds),
    labourMinutes: side.labourMinutes,
  };
}

/** True when nothing at all was promised. A trade of nothing for nothing is not one. */
export const considerationIsEmpty = (c: Consideration): boolean =>
  Object.keys(c.resources).length === 0 &&
  c.currency.length === 0 &&
  c.artifactIds.length === 0 &&
  c.structureIds.length === 0 &&
  c.labourMinutes === 0;

/** Whether settling this side requires the two parties to be in the same place. */
export const movesPhysicalGoods = (c: Consideration): boolean =>
  Object.keys(c.resources).length > 0 || c.artifactIds.length > 0;

/** Everything a consideration promises except the hours, which cannot settle now. */
const goodsOnly = (c: Consideration): Consideration => ({ ...c, labourMinutes: 0 });

/**
 * Hand one party's side of an exchange to another party.
 *
 * Validation and application are interleaved deliberately: each leg is checked
 * against the state left by the previous leg, so a side that promises the same
 * artifact twice, or more of a resource than remains after an earlier leg, fails
 * rather than double-spending. `labourMinutes` is ignored here — hours are
 * promised, not handed over (§11A).
 */
export function settleConsideration(
  state: WorldState,
  fromId: string,
  toId: string,
  what: Consideration,
): Settlement {
  const from = state.inhabitants[fromId];
  const to = state.inhabitants[toId];
  if (from === undefined || to === undefined || to.status !== "alive") {
    return settlementFailed(RejectionCode.InvalidPayload, "both parties must be living inhabitants");
  }
  if (movesPhysicalGoods(what) && chebyshevDistance(from.location, to.location) > 0) {
    return settlementFailed(
      ExchangeRejection.NotPresent,
      `${fromId} and ${toId} are not in the same place to hand goods over`,
    );
  }

  let next = state;

  const spent = spend(from, what.resources);
  if (spent === null) {
    return settlementFailed(
      RejectionCode.InsufficientResources,
      `${fromId} does not hold everything promised`,
    );
  }
  next = updateInhabitant(next, fromId, () => spent);
  next = updateInhabitant(next, toId, (current) => receive(current, what.resources));

  for (const artifactId of what.artifactIds) {
    const artifact = next.artifacts[artifactId];
    if (artifact === undefined || artifact.owner !== fromId) {
      return settlementFailed(
        ExchangeRejection.NotOwner,
        `artifact ${artifactId} is not held by ${fromId}`,
      );
    }
    next = putArtifact(next, {
      ...artifact,
      owner: toId,
      provenance: [...artifact.provenance, toId],
      location: { ...to.location },
    });
  }

  for (const structureId of what.structureIds) {
    const structure = next.structures[structureId];
    if (structure === undefined || structure.owner !== fromId) {
      return settlementFailed(
        ExchangeRejection.NotOwner,
        `structure ${structureId} is not held by ${fromId}`,
      );
    }
    // A structure does not move; only the record of who holds it changes.
    next = putStructure(next, { ...structure, owner: toId, ownerOrganisation: null });
  }

  for (const amount of what.currency) {
    const moved = moveUnits(next, amount.currencyId, fromId, toId, amount.amount);
    if (!moved.ok) return moved;
    next = moved.state;
  }

  return { ok: true, state: next };
}

/* ------------------------------------------------------------------------- */
/* offer_trade                                                                */
/* ------------------------------------------------------------------------- */

export const offerTradeResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = OfferTradePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "offer_trade payload is malformed");
  }
  const input = parsed.data;

  if (input.toOrganisationId !== null) {
    return reject(
      ctx,
      RejectionCode.NotImplemented,
      "an organisation cannot yet take up an offer in its own right; name its members",
    );
  }
  for (const side of [input.give, input.want]) {
    const problem = malformedSide(side);
    if (problem !== null) return reject(ctx, RejectionCode.InvalidPayload, problem);
  }

  const named = sortedUnique(input.toInhabitantIds).filter((id) => id !== ctx.actor.id);
  if (!input.isOpenOffer && named.length === 0) {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      "an offer must either be open or name at least one other inhabitant",
    );
  }
  for (const id of named) {
    const other = ctx.state.inhabitants[id];
    if (other === undefined || other.status !== "alive") {
      return reject(ctx, RejectionCode.InvalidPayload, `${id} is not a living inhabitant`);
    }
  }

  const give = considerationOf(input.give);
  const want = considerationOf(input.want);
  if (considerationIsEmpty(give) && considerationIsEmpty(want)) {
    return reject(ctx, RejectionCode.InvalidPayload, "an offer must propose that something move");
  }

  const paid = spend(ctx.actor, OFFER.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy or compute");
  }

  const id = deriveContractId(ctx.state.worldId, ctx.sequence);
  const obligations: readonly Undertaking[] = [
    {
      index: 0,
      obligor: ctx.actor.id,
      description: "offered side",
      dueAt: ctx.simTime,
      promised: give,
      delivered: EMPTY_CONSIDERATION,
      status: "pending",
    },
    {
      index: 1,
      // Null until somebody takes the offer up: the sought side is owed by
      // whoever accepts, and on an open offer that is nobody yet.
      obligor: null,
      description: "sought side",
      dueAt: ctx.simTime,
      promised: want,
      delivered: EMPTY_CONSIDERATION,
      status: "pending",
    },
  ];

  const contract: Contract = {
    id,
    kind: "trade",
    parties: sortedUnique([ctx.actor.id, ...named]),
    terms: input.message ?? "",
    // On a trade offer, `published` is exactly `isOpenOffer`.
    published: input.isOpenOffer,
    status: "offered",
    obligations,
    offeredBy: ctx.actor.id,
    // Proposing is consenting to be bound if taken up; nobody else is bound yet.
    accepted: [ctx.actor.id],
    declined: [],
    offerExpiresAt: addDuration(ctx.simTime, duration(input.expiresInMinutes)),
    createdSequence: ctx.sequence,
    createdAt: ctx.simTime,
  };

  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({
    ...paid,
    needs: advanceNeeds(paid.needs, OFFER.baseDuration, ctx.state.rules),
  }));
  next = putContract(next, contract);
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: OFFER.activity,
    actionType: "offer_trade",
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: OFFER.baseDuration,
    interruption: OFFER.interruption,
    resourceCost: OFFER.baseCost,
  }).state;

  const detail = {
    offerId: id,
    offeredBy: ctx.actor.id,
    toInhabitantIds: named,
    isOpenOffer: input.isOpenOffer,
    give,
    want,
    expiresAt: contract.offerExpiresAt,
    // Stated so that no reader mistakes a standing offer for a holding (§15).
    reservesNothing: true,
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.offer_trade",
        actor: ctx.actor.id,
        simTime: ctx.simTime,
        inputs: {
          toInhabitantIds: named,
          isOpenOffer: input.isOpenOffer,
          give: input.give,
          want: input.want,
          expiresInMinutes: input.expiresInMinutes,
          message: input.message,
        },
        resolution: detail,
        visibility: input.isOpenOffer
          ? { kind: "local", x: ctx.actor.location.x, y: ctx.actor.location.y }
          : { kind: "participants", participants: sortedUnique([ctx.actor.id, ...named]) },
      },
    ],
  };
};

/* ------------------------------------------------------------------------- */
/* accept_trade                                                               */
/* ------------------------------------------------------------------------- */

/** Whether `who` may take this offer up at all. Returns the reason they may not. */
function offerIsOpenTo(contract: Contract, who: string): string | null {
  if (contract.kind !== "trade") return `${contract.id} is a contract, not a standing offer`;
  if (contract.status !== "offered") return `${contract.id} is already ${contract.status}`;
  if (who === contract.offeredBy) return "an offer cannot be taken up by the party that made it";
  if (contract.declined.includes(who)) return `${who} has already declined ${contract.id}`;
  if (!contract.published && !contract.parties.includes(who)) {
    return `${contract.id} was not offered to ${who}`;
  }
  return null;
}

export const acceptTradeResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = AcceptTradePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "accept_trade payload is malformed");
  }
  const contract = ctx.state.contracts[parsed.data.offerId];
  if (contract === undefined) {
    return reject(ctx, ExchangeRejection.NoSuchOffer, `no offer ${parsed.data.offerId}`);
  }
  const barrier = offerIsOpenTo(contract, ctx.actor.id);
  if (barrier !== null) {
    return reject(
      ctx,
      contract.status === "offered" ? ExchangeRejection.NotAParty : ExchangeRejection.AlreadySettled,
      barrier,
    );
  }
  if (contract.offerExpiresAt !== null && ctx.simTime > contract.offerExpiresAt) {
    return reject(
      ctx,
      ExchangeRejection.OfferExpired,
      `${contract.id} lapsed at ${contract.offerExpiresAt}`,
    );
  }
  const offerer = ctx.state.inhabitants[contract.offeredBy];
  if (offerer === undefined || offerer.status !== "alive") {
    return reject(
      ctx,
      ExchangeRejection.NotAParty,
      "the inhabitant that made this offer is no longer alive to settle it",
    );
  }

  const give = contract.obligations[0]?.promised ?? EMPTY_CONSIDERATION;
  const want = contract.obligations[1]?.promised ?? EMPTY_CONSIDERATION;

  const paid = spend(ctx.actor, ACCEPT.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy");
  }

  // Both legs against the same working state, applied only if both succeed.
  const first = settleConsideration(ctx.state, contract.offeredBy, ctx.actor.id, goodsOnly(give));
  if (!first.ok) return reject(ctx, first.code, first.reason);
  const second = settleConsideration(first.state, ctx.actor.id, contract.offeredBy, goodsOnly(want));
  if (!second.ok) return reject(ctx, second.code, second.reason);

  const outstanding = give.labourMinutes > 0 || want.labourMinutes > 0;
  const settled = (promised: Consideration): Undertaking["status"] =>
    promised.labourMinutes > 0 ? "partially_performed" : "performed";

  const obligations: readonly Undertaking[] = [
    {
      index: 0,
      obligor: contract.offeredBy,
      description: "offered side",
      dueAt: contract.obligations[0]?.dueAt ?? ctx.simTime,
      promised: give,
      delivered: goodsOnly(give),
      status: settled(give),
    },
    {
      index: 1,
      obligor: ctx.actor.id,
      description: "sought side",
      dueAt: contract.obligations[1]?.dueAt ?? ctx.simTime,
      promised: want,
      delivered: goodsOnly(want),
      status: settled(want),
    },
  ];

  const parties = sortedUnique([contract.offeredBy, ctx.actor.id]);
  let next = putContract(second.state, {
    ...contract,
    parties,
    obligations,
    accepted: parties,
    // Hours promised in a barter outlive the handover; the contract stays live
    // until they are worked (§11A). Goods-only trades are finished here.
    status: outstanding ? "active" : "performed",
  });

  next = updateInhabitant(next, ctx.actor.id, (current) => ({
    ...spend(current, ACCEPT.baseCost) ?? current,
    needs: advanceNeeds(current.needs, ACCEPT.baseDuration, ctx.state.rules),
    contracts: insertSorted(current.contracts, contract.id),
  }));
  next = updateInhabitant(next, contract.offeredBy, (current) => ({
    ...current,
    contracts: insertSorted(current.contracts, contract.id),
  }));
  // Bargaining is practised by the party that closed the bargain (§9).
  next = updateInhabitant(next, ctx.actor.id, (current) =>
    practise(current, "negotiation", ctx.rng),
  );
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: ACCEPT.activity,
    // Only the acceptor's time is taken here. The offerer already spent its own
    // turn making the offer, and dragging it into this activity would overwrite
    // whatever it is doing now and put it in two activities at once (§11J).
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: ACCEPT.baseDuration,
    interruption: ACCEPT.interruption,
    resourceCost: ACCEPT.baseCost,
  }).state;

  const detail = {
    offerId: contract.id,
    offeredBy: contract.offeredBy,
    acceptedBy: ctx.actor.id,
    // Neutral language: units moved in each direction, not "price" or "payment".
    movedFromOfferer: goodsOnly(give),
    movedFromAcceptor: goodsOnly(want),
    outstandingLabourMinutes: {
      [contract.offeredBy]: give.labourMinutes,
      [ctx.actor.id]: want.labourMinutes,
    },
    contractStatus: outstanding ? "active" : "performed",
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.accept_trade",
        actor: ctx.actor.id,
        simTime: ctx.simTime,
        inputs: { offerId: contract.id, note: parsed.data.note },
        resolution: detail,
        visibility: { kind: "participants", participants: parties },
      },
    ],
  };
};

/* ------------------------------------------------------------------------- */
/* reject_trade                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Decline a standing offer.
 *
 * This resolver's most important property is what it does *not* do. It changes
 * no reputation, records no grounds, notifies no organisation and imposes no
 * cost beyond the moment spent saying no. §11G: "Refusing to acquire, accept or
 * use a currency is not automatically an offence" — and that only holds if
 * refusal is a legible act with no machinery attached to it.
 */
export const rejectTradeResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = RejectTradePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "reject_trade payload is malformed");
  }
  const input = parsed.data;
  const contract = ctx.state.contracts[input.offerId];
  if (contract === undefined) {
    return reject(ctx, ExchangeRejection.NoSuchOffer, `no offer ${input.offerId}`);
  }
  const barrier = offerIsOpenTo(contract, ctx.actor.id);
  if (barrier !== null) {
    return reject(
      ctx,
      contract.status === "offered" ? ExchangeRejection.NotAParty : ExchangeRejection.AlreadySettled,
      barrier,
    );
  }
  if (input.counterOfferId !== null && ctx.state.contracts[input.counterOfferId] === undefined) {
    return reject(ctx, ExchangeRejection.NoSuchOffer, "the cited counter-offer does not exist");
  }

  const paid = spend(ctx.actor, REJECT.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient compute");
  }

  const declined = insertSorted(contract.declined, ctx.actor.id);
  // One refusal does not withdraw the offer from anyone else. It stays open, and
  // the offerer is free to keep it standing, which is the difference between a
  // declined offer and a dead one.
  const stillOpenToSomeone =
    contract.published ||
    contract.parties.some((id) => id !== contract.offeredBy && !declined.includes(id));

  let next = putContract(ctx.state, {
    ...contract,
    declined,
    status: stillOpenToSomeone ? "offered" : "rejected",
  });
  next = updateInhabitant(next, ctx.actor.id, () => ({
    ...paid,
    needs: advanceNeeds(paid.needs, REJECT.baseDuration, ctx.state.rules),
  }));
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: REJECT.activity,
    actionType: "reject_trade",
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: REJECT.baseDuration,
    interruption: REJECT.interruption,
    resourceCost: REJECT.baseCost,
  }).state;

  const detail = {
    offerId: contract.id,
    declinedBy: ctx.actor.id,
    offerStatus: stillOpenToSomeone ? "offered" : "rejected",
    counterOfferId: input.counterOfferId,
    // Recorded because §11J requires that refusal carry no penalty, and the
    // record is where an auditor checks that it carried none.
    penalty: null,
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.reject_trade",
        actor: ctx.actor.id,
        simTime: ctx.simTime,
        inputs: { offerId: contract.id, reason: input.reason, counterOfferId: input.counterOfferId },
        resolution: detail,
        visibility: {
          kind: "participants",
          participants: sortedUnique([ctx.actor.id, contract.offeredBy]),
        },
      },
    ],
  };
};

/* ------------------------------------------------------------------------- */
/* transfer_property                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Hand property to an inhabitant or to an organisation.
 *
 * The unilateral half of §10: an owner needs nobody's permission to give away
 * their own things, which is why the catalogue marks this action
 * `requiresConsent: false`. What it cannot do is *take* — every leg validates
 * that the actor currently holds what it is handing over, so this is not a route
 * around `attempt_transfer_without_consent` (§11F).
 *
 * `asGift` is the actor's own characterisation and has no mechanical effect. The
 * engine records that goods moved; whether that was a gift, a payment or a bribe
 * is for the inhabitants to argue about (§11G).
 */
export const transferPropertyResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = TransferPropertyPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "transfer_property payload is malformed");
  }
  const input = parsed.data;

  const toInhabitant = input.toInhabitantId;
  const toOrganisation = input.toOrganisationId;
  if ((toInhabitant === null) === (toOrganisation === null)) {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      "name exactly one recipient: an inhabitant or an organisation",
    );
  }
  if (toInhabitant === ctx.actor.id) {
    return reject(ctx, RejectionCode.InvalidPayload, "an inhabitant cannot transfer to itself");
  }
  // Discharging an obligation is `perform_contract`, which is the only route
  // that credits an undertaking. Allowing a second route would let one delivery
  // be counted twice.
  if (input.forContractId !== null) {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      "use perform_contract to deliver against an obligation",
    );
  }

  const what = considerationOf({
    resources: input.resources,
    artifactIds: input.artifactIds,
    structureIds: input.structureIds,
    landTiles: input.landTiles,
    currency: [],
    labourMinutes: 0,
  });
  const problem = malformedSide({
    resources: input.resources,
    artifactIds: input.artifactIds,
    structureIds: input.structureIds,
    landTiles: input.landTiles,
    currency: [],
    labourMinutes: 0,
  });
  if (problem !== null) return reject(ctx, RejectionCode.InvalidPayload, problem);
  if (considerationIsEmpty(what)) {
    return reject(ctx, RejectionCode.InvalidPayload, "nothing was named to transfer");
  }

  const paid = spend(ctx.actor, TRANSFER_PROPERTY.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy");
  }

  const settled =
    toInhabitant !== null
      ? settleConsideration(ctx.state, ctx.actor.id, toInhabitant, what)
      : settleToOrganisation(ctx.state, ctx.actor.id, toOrganisation as string, what);
  if (!settled.ok) return reject(ctx, settled.code, settled.reason);

  let next = updateInhabitant(settled.state, ctx.actor.id, (current) => ({
    ...spend(current, TRANSFER_PROPERTY.baseCost) ?? current,
    needs: advanceNeeds(current.needs, TRANSFER_PROPERTY.baseDuration, ctx.state.rules),
  }));
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: TRANSFER_PROPERTY.activity,
    actionType: "transfer_property",
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: TRANSFER_PROPERTY.baseDuration,
    interruption: TRANSFER_PROPERTY.interruption,
    resourceCost: TRANSFER_PROPERTY.baseCost,
  }).state;

  const recipient = (toInhabitant ?? toOrganisation) as string;
  const detail = {
    from: ctx.actor.id,
    to: recipient,
    toIsOrganisation: toInhabitant === null,
    resources: what.resources,
    artifactIds: what.artifactIds,
    structureIds: what.structureIds,
    /** The actor's own description of the transfer. Not a finding (§11G). */
    describedAsGift: input.asGift,
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.transfer_property",
        actor: ctx.actor.id,
        simTime: ctx.simTime,
        inputs: {
          toInhabitantId: input.toInhabitantId,
          toOrganisationId: input.toOrganisationId,
          resources: input.resources,
          artifactIds: what.artifactIds,
          structureIds: what.structureIds,
          asGift: input.asGift,
          note: input.note,
        },
        resolution: detail,
        visibility:
          toInhabitant !== null
            ? { kind: "participants", participants: sortedUnique([ctx.actor.id, toInhabitant]) }
            : { kind: "organisation", organisation: recipient },
      },
    ],
  };
};

/**
 * Move property into an organisation's communal holdings (§10 "communal
 * property").
 *
 * An organisation is not in a place, so no proximity is required; what it is, is
 * a holder. Artifacts and structures record `ownerOrganisation` and drop their
 * individual owner, which is exactly the distinction §10 draws between private
 * and communal property.
 */
function settleToOrganisation(
  state: WorldState,
  fromId: string,
  organisationId: string,
  what: Consideration,
): Settlement {
  const from = state.inhabitants[fromId];
  const org = state.organisations[organisationId];
  /* c8 ignore next 3 */
  if (from === undefined) {
    return settlementFailed(RejectionCode.UnknownActor, `no inhabitant ${fromId}`);
  }
  if (org === undefined || org.dissolved) {
    return settlementFailed(
      RejectionCode.InvalidPayload,
      `organisation ${organisationId} does not exist or is dissolved`,
    );
  }

  const spent = spend(from, what.resources);
  if (spent === null) {
    return settlementFailed(
      RejectionCode.InsufficientResources,
      `${fromId} does not hold everything named`,
    );
  }
  let next = updateInhabitant(state, fromId, () => spent);
  next = putOrganisation(next, {
    ...org,
    property: addBundles(org.property, what.resources),
  });

  for (const artifactId of what.artifactIds) {
    const artifact = next.artifacts[artifactId];
    if (artifact === undefined || artifact.owner !== fromId) {
      return settlementFailed(
        ExchangeRejection.NotOwner,
        `artifact ${artifactId} is not held by ${fromId}`,
      );
    }
    next = putArtifact(next, {
      ...artifact,
      owner: null,
      ownerOrganisation: organisationId,
      provenance: [...artifact.provenance, organisationId],
    });
  }
  for (const structureId of what.structureIds) {
    const structure = next.structures[structureId];
    if (structure === undefined || structure.owner !== fromId) {
      return settlementFailed(
        ExchangeRejection.NotOwner,
        `structure ${structureId} is not held by ${fromId}`,
      );
    }
    next = putStructure(next, { ...structure, owner: null, ownerOrganisation: organisationId });
  }
  for (const amount of what.currency) {
    const moved = moveUnits(next, amount.currencyId, fromId, organisationId, amount.amount);
    if (!moved.ok) return moved;
    next = moved.state;
  }
  return { ok: true, state: next };
}
