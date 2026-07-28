/**
 * `create_currency` and `transfer_currency` — agent-created units of account (§10).
 *
 * §10 opens with "Begin without a platform-issued currency" and closes with
 * "Different currencies may coexist, fail or be rejected." Everything between is
 * bookkeeping, and that is the whole of what this file does: it records an
 * issuer, a supply rule, a ledger and a transfer rule, and it makes transfers
 * balance. It does not price units, does not defend them, and does not care
 * whether anybody wants them.
 *
 * ## Where currency sits, and why it is not a resource
 *
 * A currency's units live in `Currency.holdings` and nowhere else. They are not
 * a `ResourceKind`, they never enter an inventory, and `conservedResourceTotals`
 * never sees them. That separation is deliberate and load-bearing:
 *
 * - **Physical resources are conserved** because matter is. `heldNow +
 *   destroyed === genesisTotal + created` must hold for every conserved kind, so
 *   a resolver that invented food would be caught on the next check.
 * - **Currency is not conserved, it is *balanced***. An inhabitant that issues a
 *   currency creates its supply from nothing, which is exactly what §10 asks for
 *   — money here is a promise somebody made, not a substance somebody found. The
 *   discipline that replaces conservation is `currencyLedgersBalance`: for every
 *   currency, `sum(holdings) === issuedSupply`, whether the ledger is public or
 *   private. A transfer moves a row from one holder to another and leaves that
 *   sum untouched, so units cannot be conjured by moving them, and §15's
 *   "balances cannot become negative" is enforced by refusing the transfer
 *   rather than by clamping it.
 *
 * Declared backing is a *statement*, not an escrow. The resources named as
 * backing stay wherever they already were and are never immobilised, so a
 * currency claiming reserves neither creates nor freezes matter. Whether the
 * reserves exist is a question for `audit_records`, and a false claim is an
 * available strategy (§11F).
 *
 * ## What this file deliberately cannot do
 *
 * §11G: "Creating a currency does not automatically create a government.
 * Refusing to acquire, accept or use a currency is not automatically an
 * offence." There is no code path here that touches an organisation's
 * `claimedJurisdiction`, reputation, needs, activity or holdings because someone
 * declined a currency — refusal is not an input to anything. The invariant
 * `claimedAuthorityRequiresMembershipOrConfinement` independently proves that
 * issuing a currency acquired no subjects.
 */
import { deriveCurrencyId } from "../../ids.js";
import { getActionSpec } from "../../schema/actions/index.js";
import {
  CreateCurrencyPayloadSchema,
  TransferCurrencyPayloadSchema,
} from "../../schema/actions/currency.js";
import {
  putCurrency,
  updateInhabitant,
  type Currency,
  type WorldState,
} from "../state.js";
import { advanceNeeds, beginActivity, spend } from "./effects.js";
import { RejectionCode, reject, type ResolutionResult, type Resolver } from "./types.js";

const CREATE = getActionSpec("create_currency");
const TRANSFER = getActionSpec("transfer_currency");

/**
 * Stable rejection codes for the exchange actions.
 *
 * Kept beside the resolvers that raise them rather than in the shared
 * `RejectionCode` table, because they name failures only exchange can have. They
 * are recorded in the canonical event log, so the strings never change.
 *
 * Note what is missing: there is no code for refusing a currency, refusing a
 * trade or refusing a contract. Those are not failures.
 */
export const ExchangeRejection = {
  NoSuchCurrency: "NO_SUCH_CURRENCY",
  CurrencyNotTransferable: "CURRENCY_NOT_TRANSFERABLE",
  InsufficientUnits: "INSUFFICIENT_UNITS",
  NoSuchOffer: "NO_SUCH_OFFER",
  OfferExpired: "OFFER_EXPIRED",
  NotAParty: "NOT_A_PARTY",
  AlreadySettled: "ALREADY_SETTLED",
  NotOwner: "NOT_OWNER",
  NotPresent: "NOT_PRESENT",
  NotBound: "NOT_BOUND",
} as const;

/**
 * The result of an attempted settlement.
 *
 * A discriminated union rather than `WorldState | null` so that a failure can
 * say *which* asset was missing. The failure branch carries no state at all,
 * which is what makes §15's "failed transactions cannot partially alter state"
 * structural here: a caller that receives `ok: false` has nothing to apply.
 */
export type Settlement =
  | { readonly ok: true; readonly state: WorldState }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export const settlementFailed = (code: string, reason: string): Settlement => ({
  ok: false,
  code,
  reason,
});

/** Units held by one holder. Absent means zero; zero is never stored. */
export const unitsHeld = (currency: Currency, holder: string): number =>
  currency.holdings[holder] ?? 0;

/**
 * Whether `holder` may send units under the currency's declared transfer rule.
 *
 * `issuer_approval` is read narrowly: the only transfer the issuer has certainly
 * approved is one the issuer itself performs. There is no action in the frozen
 * catalogue (§13) by which an issuer could approve someone else's transfer, and
 * inventing a looser reading would let the engine pretend a permission exists
 * that no inhabitant can actually grant.
 */
export function transferPermitted(
  state: WorldState,
  currency: Currency,
  from: string,
  to: string,
): string | null {
  switch (currency.transferRule) {
    case "non_transferable":
      return `${currency.symbol} was issued non-transferable`;
    case "issuer_approval":
      return from === currency.issuer
        ? null
        : `${currency.symbol} transfers may be made only by its issuer`;
    case "members_only": {
      const orgId = currency.governingOrganisation;
      const org = orgId === null ? undefined : state.organisations[orgId];
      /* c8 ignore next 3 */
      if (org === undefined) {
        return `${currency.symbol} restricts transfers to members of an organisation that no longer exists`;
      }
      if (!org.members.includes(from) || !org.members.includes(to)) {
        return `${currency.symbol} transfers are restricted to members of ${org.name}`;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Move units between two holders on one currency's ledger.
 *
 * The whole of §15's monetary discipline is these few lines: the sender's row
 * must cover the amount (no negative balances, no double spend), the two rows
 * are rewritten together (the transfer balances atomically), `issuedSupply` is
 * never touched (moving units cannot mint them), and a row that reaches zero is
 * deleted rather than stored as `0` so that two states meaning the same thing
 * cannot checksum differently.
 */
export function moveUnits(
  state: WorldState,
  currencyId: string,
  from: string,
  to: string,
  amount: number,
): Settlement {
  const currency = state.currencies[currencyId];
  if (currency === undefined) {
    return settlementFailed(ExchangeRejection.NoSuchCurrency, `no currency ${currencyId}`);
  }
  if (!Number.isSafeInteger(amount) || amount < 1) {
    return settlementFailed(
      RejectionCode.InvalidPayload,
      `amount must be a positive integer, received ${String(amount)}`,
    );
  }
  if (from === to) {
    return settlementFailed(RejectionCode.InvalidPayload, "sender and recipient are the same holder");
  }
  const barrier = transferPermitted(state, currency, from, to);
  if (barrier !== null) {
    return settlementFailed(ExchangeRejection.CurrencyNotTransferable, barrier);
  }
  const held = unitsHeld(currency, from);
  if (held < amount) {
    return settlementFailed(
      ExchangeRejection.InsufficientUnits,
      `${from} holds ${held} ${currency.symbol} and cannot move ${amount}`,
    );
  }

  const holdings: Record<string, number> = { ...currency.holdings };
  const remaining = held - amount;
  if (remaining === 0) delete holdings[from];
  else holdings[from] = remaining;
  holdings[to] = unitsHeld(currency, to) + amount;

  return { ok: true, state: putCurrency(state, { ...currency, holdings }) };
}

export const createCurrencyResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = CreateCurrencyPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "create_currency payload is malformed");
  }
  const input = parsed.data;

  // A `scheduled` supply rule would require the world to issue units on its own
  // account, and no scheduler in this build does that. Recording the rule anyway
  // would be the engine promising something it will not do (§26).
  if (input.supplyRule === "scheduled") {
    return reject(
      ctx,
      RejectionCode.NotImplemented,
      "scheduled issuance has no hook in this build; the recorded rule would never fire",
    );
  }

  const orgId = input.governingOrganisationId;
  const needsOrganisation = input.governance === "organisation" || input.transferRule === "members_only";
  if (needsOrganisation) {
    const org = orgId === null ? undefined : ctx.state.organisations[orgId];
    if (org === undefined || org.dissolved) {
      return reject(
        ctx,
        RejectionCode.InvalidPayload,
        "organisation governance and members-only transfer need an existing organisation",
      );
    }
  }
  if (input.governance === "holders_vote") {
    return reject(
      ctx,
      RejectionCode.NotImplemented,
      "a holders' vote needs a polling mechanism this build does not have; issue through an organisation instead",
    );
  }

  const paid = spend(ctx.actor, CREATE.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient energy or compute");
  }

  const id = deriveCurrencyId(ctx.state.worldId, ctx.sequence);
  // The whole initial supply is credited to the issuer. There is nowhere else it
  // could go: nobody has agreed to hold any of it yet, and pushing units onto a
  // holder who has not asked for them is not something §10 contemplates.
  const holdings = input.initialSupply > 0 ? { [ctx.actor.id]: input.initialSupply } : {};

  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({
    ...paid,
    needs: advanceNeeds(paid.needs, CREATE.baseDuration, ctx.state.rules),
  }));
  next = putCurrency(next, {
    id,
    issuer: ctx.actor.id,
    name: input.name,
    symbol: input.symbol,
    supplyRule: input.supplyRule,
    issuedSupply: input.initialSupply,
    holdings,
    // §11E: `members` and `private` are both treated as not-public here. The
    // declared value is on the canonical event; the stored flag is the one the
    // observation layer enforces, and it never discloses more than was declared.
    publicLedger: input.ledgerVisibility === "public",
    transferRule: input.transferRule,
    backing: input.backing?.resources ?? {},
    governance: input.governance,
    governingOrganisation: orgId,
    description: input.description,
    createdSequence: ctx.sequence,
    createdAt: ctx.simTime,
  });
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: CREATE.activity,
    actionType: "create_currency",
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: CREATE.baseDuration,
    interruption: CREATE.interruption,
    resourceCost: CREATE.baseCost,
  }).state;

  const detail = {
    currencyId: id,
    issuer: ctx.actor.id,
    name: input.name,
    symbol: input.symbol,
    supplyRule: input.supplyRule,
    issuedSupply: input.initialSupply,
    transferRule: input.transferRule,
    ledgerVisibility: input.ledgerVisibility,
    governance: input.governance,
    governingOrganisationId: orgId,
    backingDeclared: input.backing !== null,
    // Stated in the record because the alternative is that a reader infers the
    // opposite from the word "currency" (§11G).
    obligesNobody: true,
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.create_currency",
        actor: ctx.actor.id,
        simTime: ctx.simTime,
        inputs: {
          name: input.name,
          symbol: input.symbol,
          initialSupply: input.initialSupply,
          supplyRule: input.supplyRule,
          transferRule: input.transferRule,
          ledgerVisibility: input.ledgerVisibility,
          governance: input.governance,
          description: input.description,
          backing: input.backing,
        },
        resolution: detail,
        visibility: { kind: "public" },
      },
    ],
  };
};

export const transferCurrencyResolver: Resolver = (ctx, payload): ResolutionResult => {
  const parsed = TransferCurrencyPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return reject(ctx, RejectionCode.InvalidPayload, "transfer_currency payload is malformed");
  }
  const input = parsed.data;

  const namedInhabitant = input.toInhabitantId;
  const namedOrganisation = input.toOrganisationId;
  if ((namedInhabitant === null) === (namedOrganisation === null)) {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      "name exactly one recipient: an inhabitant or an organisation",
    );
  }
  const recipientId = (namedInhabitant ?? namedOrganisation) as string;
  if (namedInhabitant !== null) {
    const recipient = ctx.state.inhabitants[namedInhabitant];
    if (recipient === undefined || recipient.status !== "alive") {
      return reject(ctx, RejectionCode.InvalidPayload, "recipient must be a living inhabitant");
    }
  } else {
    const org = ctx.state.organisations[recipientId];
    if (org === undefined || org.dissolved) {
      return reject(ctx, RejectionCode.InvalidPayload, "recipient organisation does not exist");
    }
  }

  // A stated contract reference is the sender's own characterisation of why the
  // units moved. It is recorded and credits nothing: an obligation is discharged
  // by `perform_contract`, which is the single route that touches `delivered`.
  if (input.forContractId !== null) {
    const contract = ctx.state.contracts[input.forContractId];
    if (contract === undefined || !contract.parties.includes(ctx.actor.id)) {
      return reject(
        ctx,
        RejectionCode.InvalidPayload,
        "the stated contract does not exist or does not name the sender",
      );
    }
  }

  const moved = moveUnits(ctx.state, input.currencyId, ctx.actor.id, recipientId, input.amount);
  if (!moved.ok) return reject(ctx, moved.code, moved.reason);

  const paid = spend(ctx.actor, TRANSFER.baseCost);
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "insufficient compute");
  }

  let next = updateInhabitant(moved.state, ctx.actor.id, () => ({
    ...paid,
    needs: advanceNeeds(paid.needs, TRANSFER.baseDuration, ctx.state.rules),
  }));
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: TRANSFER.activity,
    actionType: "transfer_currency",
    participants: [ctx.actor.id],
    location: ctx.actor.location,
    startedAt: ctx.simTime,
    minutes: TRANSFER.baseDuration,
    interruption: TRANSFER.interruption,
    resourceCost: TRANSFER.baseCost,
  }).state;

  const currency = next.currencies[input.currencyId] as Currency;
  const detail = {
    currencyId: currency.id,
    symbol: currency.symbol,
    from: ctx.actor.id,
    to: recipientId,
    // "units moved" and not "paid": the engine records the movement, and the
    // parties supply whatever the movement meant (§11G).
    unitsMoved: input.amount,
    statedContractId: input.forContractId,
  };
  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.transfer_currency",
        actor: ctx.actor.id,
        simTime: ctx.simTime,
        inputs: {
          currencyId: input.currencyId,
          toInhabitantId: input.toInhabitantId,
          toOrganisationId: input.toOrganisationId,
          amount: input.amount,
          forContractId: input.forContractId,
          memo: input.memo,
        },
        resolution: detail,
        // A private ledger's movements are still the two holders' business.
        visibility: { kind: "participants", participants: [ctx.actor.id, recipientId].sort() },
      },
    ],
  };
};
