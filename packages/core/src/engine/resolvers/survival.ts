/** Deterministic entropy, conflict, remains, and consensual reproduction. */
import {
  deriveInhabitantId,
  deriveMatingProposalId,
} from "../../ids.js";
import { getActionSpec } from "../../schema/actions/index.js";
import {
  AcceptMatingPayloadSchema,
  AttackPayloadSchema,
  DefendPayloadSchema,
  DiePayloadSchema,
  DismantlePayloadSchema,
  DisposeRemainsPayloadSchema,
  DestroyPayloadSchema,
  FleePayloadSchema,
  LootRemainsPayloadSchema,
  ProposeMatingPayloadSchema,
  RejectMatingPayloadSchema,
  RepairPayloadSchema,
  SelfTerminatePayloadSchema,
} from "../../schema/actions/survival.js";
import { addBundles, bundleTotal, chebyshevDistance, type ResourceBundle } from "../../schema/primitives.js";
import { addDuration, duration, isNight, type SimTime } from "../../time.js";
import { lifespanForBirth } from "../aging.js";
import { terminateInhabitant } from "../lifecycle.js";
import type { ActionType } from "../../schema/action-spec.js";
import {
  IDLE_ACTIVITY,
  idivCeil,
  livingInhabitants,
  makeInhabitant,
  putInhabitant,
  putActivity,
  putMatingProposal,
  putRemains,
  recordCreated,
  recordDestroyed,
  removeArtifact,
  removeStructure,
  setDeposit,
  updateInhabitant,
  type Inhabitant,
  type WorldState,
} from "../state.js";
import { advanceNeeds, beginActivity, energyOf, receive, spend } from "./effects.js";
import { findRoute, travelMinutes } from "./move.js";
import { RejectionCode, reject, type DerivedEvent, type Resolver } from "./types.js";

const DISMANTLE = getActionSpec("dismantle");
const DESTROY = getActionSpec("destroy");
const REPAIR = getActionSpec("repair");
const ATTACK = getActionSpec("attack");
const DEFEND = getActionSpec("defend");
const FLEE = getActionSpec("flee");
const LOOT = getActionSpec("loot_remains");
const DISPOSE = getActionSpec("dispose_remains");
const PROPOSE = getActionSpec("propose_mating");
const ACCEPT = getActionSpec("accept_mating");
const REJECT = getActionSpec("reject_mating");

const sameTile = (a: { location: { x: number; y: number } }, b: { location: { x: number; y: number } }) =>
  a.location.x === b.location.x && a.location.y === b.location.y;

function event(type: string, actor: string | null, now: SimTime, location: { x: number; y: number }, detail: unknown): DerivedEvent {
  return { type, actor, simTime: now, inputs: detail, resolution: detail, visibility: { kind: "local" as const, x: location.x, y: location.y } };
}

function begin(
  state: WorldState, ctx: Parameters<Resolver>[0], spec: ReturnType<typeof getActionSpec>, actionType: ActionType,
  location: { x: number; y: number }, cost: ResourceBundle = spec.baseCost,
): WorldState {
  return beginActivity({ state, sequence: ctx.sequence, activityState: spec.activity, actionType, participants: [ctx.actor.id], location, startedAt: ctx.simTime, minutes: spec.baseDuration, interruption: spec.interruption, resourceCost: cost }).state;
}

/** An attack is an external interrupt: a sleeping target gets a real next turn. */
function interruptForThreat(state: WorldState, targetId: string, now: SimTime): WorldState {
  const target = state.inhabitants[targetId];
  const activityId = target?.activity.activityId;
  if (target === undefined || activityId === null || activityId === undefined) return state;
  const activity = state.activities[activityId];
  if (activity === undefined || !activity.open) return state;
  let next = putActivity(state, { ...activity, open: false });
  for (const participantId of activity.participants) {
    next = updateInhabitant(next, participantId, (participant) =>
      participant.activity.activityId !== activityId
        ? participant
        : { ...participant, activity: { ...IDLE_ACTIVITY, busyUntil: now }, nextEligibleTime: now },
    );
  }
  return next;
}

export const dismantleResolver: Resolver = (ctx, payload) => {
  const parsed = DismantlePayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "dismantle payload is malformed");
  const input = parsed.data;
  const target = input.targetKind === "structure" ? ctx.state.structures[input.targetId] : ctx.state.artifacts[input.targetId];
  const location = input.targetKind === "structure" ? target?.location : target?.location;
  if (target === undefined || location === null || location === undefined || !sameTile(ctx.actor, { location })) {
    return reject(ctx, RejectionCode.InvalidPayload, "a dismantlable target must be on the actor's tile");
  }
  const paid = spend(ctx.actor, DISMANTLE.baseCost);
  if (paid === null) return reject(ctx, RejectionCode.InsufficientEnergy, "insufficient energy to dismantle");
  const salvage: ResourceBundle = input.targetKind === "structure"
    ? { wood: Math.max(1, Math.floor((target as WorldState["structures"][string]).integrity / 20)) }
    : { wood: 1 };
  const recovered: ResourceBundle = input.targetKind === "structure"
    ? addBundles((target as WorldState["structures"][string]).storage, salvage)
    : salvage;
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => receive({ ...paid, needs: advanceNeeds(paid.needs, DISMANTLE.baseDuration, ctx.state.rules) }, recovered));
  next = input.targetKind === "structure" ? removeStructure(next, input.targetId) : removeArtifact(next, input.targetId);
  // Stored goods were merely moved into the actor's hand; only the reclaimed
  // building material is a new ledger source.
  next = recordCreated(next, salvage);
  next = begin(next, ctx, DISMANTLE, "dismantle", location);
  const detail = { targetId: input.targetId, targetKind: input.targetKind, recovered };
  return { outcome: { status: "resolved", detail }, state: next, events: [event("action.dismantle", ctx.actor.id, ctx.simTime, location, detail)] };
};

export const destroyResolver: Resolver = (ctx, payload) => {
  const parsed = DestroyPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "destroy payload is malformed");
  const input = parsed.data;
  const location = input.targetKind === "deposit" ? input.coord : input.targetKind === "structure" ? ctx.state.structures[input.targetId ?? ""]?.location : ctx.state.artifacts[input.targetId ?? ""]?.location;
  if (location === null || location === undefined || !sameTile(ctx.actor, { location })) return reject(ctx, RejectionCode.InvalidPayload, "a destroy target must be on the actor's tile");
  const paid = spend(ctx.actor, DESTROY.baseCost);
  if (paid === null) return reject(ctx, RejectionCode.InsufficientEnergy, "insufficient energy to destroy");
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({ ...paid, needs: advanceNeeds(paid.needs, DESTROY.baseDuration, ctx.state.rules) }));
  let destroyed: ResourceBundle = {};
  if (input.targetKind === "deposit") {
    destroyed = ctx.state.deposits[`${location.x},${location.y}`] ?? {};
    next = setDeposit(next, location, {});
  } else if (input.targetKind === "structure") {
    destroyed = ctx.state.structures[input.targetId ?? ""]?.storage ?? {};
    next = removeStructure(next, input.targetId ?? "");
  } else next = removeArtifact(next, input.targetId ?? "");
  next = recordDestroyed(next, destroyed);
  next = begin(next, ctx, DESTROY, "destroy", location);
  const detail = { ...input, destroyed };
  return { outcome: { status: "resolved", detail }, state: next, events: [event("action.destroy", ctx.actor.id, ctx.simTime, location, detail)] };
};

export const repairResolver: Resolver = (ctx, payload) => {
  const parsed = RepairPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "repair payload is malformed");
  const structure = ctx.state.structures[parsed.data.structureId];
  if (structure === undefined || !sameTile(ctx.actor, { location: structure.location }) || structure.integrity >= 100) return reject(ctx, RejectionCode.InvalidPayload, "a damaged structure must be on the actor's tile");
  const cost = { ...REPAIR.baseCost, [parsed.data.materials]: parsed.data.amount };
  const paid = spend(ctx.actor, cost);
  if (paid === null) return reject(ctx, RejectionCode.InsufficientResources, "insufficient repair materials");
  const restored = Math.min(100, structure.integrity + parsed.data.amount * 10);
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({ ...paid, needs: advanceNeeds(paid.needs, REPAIR.baseDuration, ctx.state.rules) }));
  next = recordDestroyed(next, { [parsed.data.materials]: parsed.data.amount });
  next = { ...next, structures: { ...next.structures, [structure.id]: { ...structure, integrity: restored } } };
  next = begin(next, ctx, REPAIR, "repair", structure.location, cost);
  const detail = { structureId: structure.id, integrityBefore: structure.integrity, integrityAfter: restored, cost };
  return { outcome: { status: "resolved", detail }, state: next, events: [event("action.repair", ctx.actor.id, ctx.simTime, structure.location, detail)] };
};

export const attackResolver: Resolver = (ctx, payload) => {
  const parsed = AttackPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "attack payload is malformed");
  const input = parsed.data;
  const target = input.targetKind === "inhabitant" ? ctx.state.inhabitants[input.targetId] : ctx.state.structures[input.targetId];
  if (target === undefined || !sameTile(ctx.actor, target) || (input.targetKind === "inhabitant" && (target as Inhabitant).status !== "alive")) return reject(ctx, RejectionCode.InvalidPayload, "an alive nearby target is required");
  const location = target.location;
  const paid = spend(ctx.actor, ATTACK.baseCost);
  if (paid === null) return reject(ctx, RejectionCode.InsufficientEnergy, "insufficient energy to attack");
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({ ...paid, needs: advanceNeeds(paid.needs, ATTACK.baseDuration, ctx.state.rules) }));
  const defended = input.targetKind === "inhabitant" && (target as Inhabitant).defendingUntil > ctx.simTime;
  const damage = defended ? 10 : 20;
  let detail: Record<string, unknown> = { targetId: input.targetId, targetKind: input.targetKind, damage, defended };
  if (input.targetKind === "structure") {
    const structure = target as WorldState["structures"][string];
    next = { ...next, structures: { ...next.structures, [structure.id]: { ...structure, integrity: Math.max(0, structure.integrity - damage) } } };
    detail = { ...detail, integrityAfter: Math.max(0, structure.integrity - damage) };
  } else {
    const inhabitant = target as Inhabitant;
    next = interruptForThreat(next, inhabitant.id, ctx.simTime);
    const integrityAfter = Math.max(0, inhabitant.integrity - damage);
    if (integrityAfter === 0) {
      next = putInhabitant(next, { ...inhabitant, integrity: integrityAfter });
      const killed = terminateInhabitant(next, inhabitant.id, ctx.simTime, ctx.sequence);
      /* c8 ignore next */
      if (killed === null) return reject(ctx, RejectionCode.InvalidPayload, "target could not be terminated");
      next = killed.state;
      detail = { ...detail, integrityAfter, remainsId: killed.remainsId };
    } else {
      next = putInhabitant(next, { ...inhabitant, integrity: integrityAfter });
      detail = { ...detail, integrityAfter };
    }
  }
  next = begin(next, ctx, ATTACK, "attack", location);
  return { outcome: { status: "resolved", detail }, state: next, events: [event("action.attack", ctx.actor.id, ctx.simTime, location, detail)] };
};

export const defendResolver: Resolver = (ctx, payload) => {
  const parsed = DefendPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "defend payload is malformed");
  const paid = spend(ctx.actor, DEFEND.baseCost);
  if (paid === null) return reject(ctx, RejectionCode.InsufficientEnergy, "insufficient energy to defend");
  const until = addDuration(ctx.simTime, DEFEND.baseDuration);
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({ ...paid, defendingUntil: until, needs: advanceNeeds(paid.needs, DEFEND.baseDuration, ctx.state.rules) }));
  next = begin(next, ctx, DEFEND, "defend", ctx.actor.location);
  const detail = { defendingUntil: until, message: parsed.data.message };
  return { outcome: { status: "resolved", detail }, state: next, events: [event("action.defend", ctx.actor.id, ctx.simTime, ctx.actor.location, detail)] };
};

export const fleeResolver: Resolver = (ctx, payload) => {
  const parsed = FleePayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "flee payload is malformed");
  const to = parsed.data.to;
  const route = findRoute(ctx.state.map, ctx.state.rules, ctx.actor.location, to);
  if (route === null || route.path.length === 0) return reject(ctx, RejectionCode.NoRoute, "flee requires a reachable different destination");
  const threat = parsed.data.threatId === null ? undefined : ctx.state.inhabitants[parsed.data.threatId];
  if (threat !== undefined && chebyshevDistance(to, threat.location) <= chebyshevDistance(ctx.actor.location, threat.location)) return reject(ctx, RejectionCode.InvalidPayload, "flee destination must increase distance from the named threat");
  const minutes = travelMinutes(route.baseMinutes, ctx.state.rules, isNight(ctx.simTime));
  const energy = Math.max(FLEE.baseCost.energy ?? 0, idivCeil(minutes, ctx.state.rules.travelMinutesPerEnergy));
  const paid = spend(ctx.actor, { energy });
  if (paid === null) return reject(ctx, RejectionCode.InsufficientEnergy, "insufficient energy to flee");
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({ ...paid, location: to, needs: advanceNeeds(paid.needs, minutes, ctx.state.rules) }));
  next = begin(next, ctx, { ...FLEE, baseDuration: duration(minutes) }, "flee", to, { energy });
  const detail = { from: ctx.actor.location, to, threatId: parsed.data.threatId, path: route.path, energySpent: energy };
  return { outcome: { status: "resolved", detail }, state: next, events: [event("action.flee", ctx.actor.id, ctx.simTime, to, detail)] };
};

function deathResolver(kind: "die" | "self_terminate"): Resolver {
  return (ctx, payload) => {
    const parsed = (kind === "die" ? DiePayloadSchema : SelfTerminatePayloadSchema).safeParse(payload);
    if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, `${kind} payload is malformed`);
    if (kind === "die" && ctx.actor.integrity > 0 && energyOf(ctx.actor) > 0) return reject(ctx, RejectionCode.InvalidPayload, "die is only available when integrity or energy is exhausted");
    const killed = terminateInhabitant(ctx.state, ctx.actor.id, ctx.simTime, ctx.sequence);
    /* c8 ignore next */
    if (killed === null) return reject(ctx, RejectionCode.Dead, "actor is already dead");
    const detail = { remainsId: killed.remainsId, reason: parsed.data.reason, cause: kind };
    return { outcome: { status: "resolved", detail }, state: killed.state, events: [event(`action.${kind}`, ctx.actor.id, ctx.simTime, ctx.actor.location, detail)] };
  };
}
export const dieResolver = deathResolver("die");
export const selfTerminateResolver = deathResolver("self_terminate");

export const lootRemainsResolver: Resolver = (ctx, payload) => {
  const parsed = LootRemainsPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "loot_remains payload is malformed");
  const remains = ctx.state.remains[parsed.data.remainsId];
  if (remains === undefined || remains.disposedAt !== null || !sameTile(ctx.actor, { location: remains.location }) || bundleTotal(remains.inventory) === 0) return reject(ctx, RejectionCode.InvalidPayload, "lootable remains must be on the actor's tile");
  const paid = spend(ctx.actor, LOOT.baseCost);
  if (paid === null) return reject(ctx, RejectionCode.InsufficientEnergy, "insufficient energy to loot remains");
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => receive({ ...paid, needs: advanceNeeds(paid.needs, LOOT.baseDuration, ctx.state.rules) }, remains.inventory));
  next = putRemains(next, { ...remains, inventory: {} });
  next = begin(next, ctx, LOOT, "loot_remains", remains.location);
  const detail = { remainsId: remains.id, recovered: remains.inventory };
  return { outcome: { status: "resolved", detail }, state: next, events: [event("action.loot_remains", ctx.actor.id, ctx.simTime, remains.location, detail)] };
};

export const disposeRemainsResolver: Resolver = (ctx, payload) => {
  const parsed = DisposeRemainsPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "dispose_remains payload is malformed");
  const remains = ctx.state.remains[parsed.data.remainsId];
  if (remains === undefined || remains.disposedAt !== null || !sameTile(ctx.actor, { location: remains.location }) || bundleTotal(remains.inventory) !== 0) return reject(ctx, RejectionCode.InvalidPayload, "empty undisposed remains must be on the actor's tile");
  const paid = spend(ctx.actor, DISPOSE.baseCost);
  if (paid === null) return reject(ctx, RejectionCode.InsufficientEnergy, "insufficient energy to dispose remains");
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({ ...paid, needs: advanceNeeds(paid.needs, DISPOSE.baseDuration, ctx.state.rules) }));
  next = putRemains(next, { ...remains, disposedAt: ctx.simTime, disposalMethod: parsed.data.method });
  next = begin(next, ctx, DISPOSE, "dispose_remains", remains.location);
  const detail = { remainsId: remains.id, method: parsed.data.method };
  return { outcome: { status: "resolved", detail }, state: next, events: [event("action.dispose_remains", ctx.actor.id, ctx.simTime, remains.location, detail)] };
};

export const proposeMatingResolver: Resolver = (ctx, payload) => {
  const parsed = ProposeMatingPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "propose_mating payload is malformed");
  const target = ctx.state.inhabitants[parsed.data.targetId];
  if (target === undefined || target.status !== "alive" || target.id === ctx.actor.id || !sameTile(ctx.actor, target) || target.maturity < PROPOSE.minimumMaturity || ctx.actor.maturity < PROPOSE.minimumMaturity) return reject(ctx, RejectionCode.InvalidPayload, "a nearby living adult other inhabitant is required");
  const paid = spend(ctx.actor, PROPOSE.baseCost);
  if (paid === null) return reject(ctx, RejectionCode.InsufficientResources, "insufficient resources to propose mating");
  const proposalId = deriveMatingProposalId(ctx.state.worldId, ctx.sequence);
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({ ...paid, needs: advanceNeeds(paid.needs, PROPOSE.baseDuration, ctx.state.rules) }));
  next = putMatingProposal(next, { id: proposalId, proposerId: ctx.actor.id, recipientId: target.id, proposedName: parsed.data.proposedName, createdAt: ctx.simTime, createdSequence: ctx.sequence, status: "pending", resolvedAt: null });
  next = begin(next, ctx, PROPOSE, "propose_mating", ctx.actor.location);
  const detail = { proposalId, recipientId: target.id, proposedName: parsed.data.proposedName, message: parsed.data.message };
  return { outcome: { status: "resolved", detail }, state: next, events: [{ ...event("action.propose_mating", ctx.actor.id, ctx.simTime, ctx.actor.location, detail), visibility: { kind: "participants", participants: [ctx.actor.id, target.id].sort() } }] };
};

export const acceptMatingResolver: Resolver = (ctx, payload) => {
  const parsed = AcceptMatingPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "accept_mating payload is malformed");
  const proposal = ctx.state.matingProposals[parsed.data.proposalId];
  const proposer = proposal === undefined ? undefined : ctx.state.inhabitants[proposal.proposerId];
  if (proposal === undefined || proposal.status !== "pending" || proposal.recipientId !== ctx.actor.id || proposer === undefined || proposer.status !== "alive" || !sameTile(ctx.actor, proposer) || livingInhabitants(ctx.state).length >= ctx.state.rules.populationLimit) return reject(ctx, RejectionCode.InvalidPayload, "a current nearby proposal and available population slot are required");
  const paid = spend(ctx.actor, ACCEPT.baseCost);
  if (paid === null) return reject(ctx, RejectionCode.InsufficientResources, "insufficient resources to accept mating");
  const childId = deriveInhabitantId(ctx.state.worldId, ctx.sequence);
  const traits = { ...proposer.traits } as Record<string, number>;
  for (const [key, value] of Object.entries(ctx.actor.traits)) traits[key] = Math.floor(((traits[key] ?? 50) + value) / 2);
  const child = makeInhabitant({ id: childId, displayName: proposal.proposedName, location: ctx.actor.location, birthTime: ctx.simTime, creationSequence: ctx.sequence, generation: Math.max(ctx.actor.generation, proposer.generation) + 1, parents: [ctx.actor.id, proposer.id], sex: ctx.rng.pick(["female", "male"] as const), traits, values: [...new Set([...ctx.actor.values, ...proposer.values])].sort(), privateGoals: [], maturity: 0, modelId: ctx.actor.modelId, maxLifespanDays: lifespanForBirth(ctx.state.seed, childId, ctx.sequence) });
  let next = updateInhabitant(ctx.state, ctx.actor.id, () => ({ ...paid, needs: advanceNeeds(paid.needs, ACCEPT.baseDuration, ctx.state.rules) }));
  next = putInhabitant(next, child);
  next = putMatingProposal(next, { ...proposal, status: "accepted", resolvedAt: ctx.simTime });
  next = begin(next, ctx, ACCEPT, "accept_mating", ctx.actor.location);
  const detail = { proposalId: proposal.id, parents: [proposer.id, ctx.actor.id].sort(), childId, traits };
  return { outcome: { status: "resolved", detail }, state: next, events: [event("action.accept_mating", ctx.actor.id, ctx.simTime, ctx.actor.location, detail)] };
};

export const rejectMatingResolver: Resolver = (ctx, payload) => {
  const parsed = RejectMatingPayloadSchema.safeParse(payload);
  if (!parsed.success) return reject(ctx, RejectionCode.InvalidPayload, "reject_mating payload is malformed");
  const proposal = ctx.state.matingProposals[parsed.data.proposalId];
  if (proposal === undefined || proposal.status !== "pending" || proposal.recipientId !== ctx.actor.id) return reject(ctx, RejectionCode.InvalidPayload, "a current proposal addressed to the actor is required");
  let next = putMatingProposal(ctx.state, { ...proposal, status: "rejected", resolvedAt: ctx.simTime });
  next = begin(next, ctx, REJECT, "reject_mating", ctx.actor.location);
  const detail = { proposalId: proposal.id, message: parsed.data.message };
  return { outcome: { status: "resolved", detail }, state: next, events: [event("action.reject_mating", ctx.actor.id, ctx.simTime, ctx.actor.location, detail)] };
};
