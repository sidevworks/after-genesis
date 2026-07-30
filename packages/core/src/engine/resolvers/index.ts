/**
 * The resolver registry and the action entry point (§4A, §14.12–14.13).
 *
 * Every action in the catalogue has exactly one resolver. The 54 actions that
 * are not yet built are registered to `notYetImplemented`, which *rejects*.
 * That is deliberate and worth stating plainly: a stub that returned
 * `{status: "resolved"}` would let the world appear to run a full civilisation
 * while silently doing nothing, and the resulting event log would be a lie that
 * replay could not detect. A rejection is honest, canonical, hash-chained and
 * visible in the audit export.
 *
 * `runAction` performs the shared preconditions §14.12 requires before any
 * resolver sees the payload: the actor exists, is alive (§15 "inhabitants
 * cannot act after death"), is not already occupied (§11A), and is not confined
 * out of the action (§11H). Only then is a random stream derived and the
 * resolver invoked.
 */
import { ACTION_TYPES, type ActionType, type ProposedAction } from "../../schema/action-spec.js";
import { actionsAllowedWhileConfined } from "../../schema/actions/index.js";
import { chebyshevDistance } from "../../schema/primitives.js";
import type { SimTime } from "../../time.js";
import { deriveMemoryId } from "../../ids.js";
import { canonicalJson } from "../../util/canonical.js";
import { Rng } from "../../util/rng.js";
import {
  putMemory,
  updateInhabitant,
  withSequence,
  withSimTime,
  type Relationship,
  type WorldState,
} from "../state.js";
import { settleExpiredActivities } from "./effects.js";
import { consumeResolver, observeResolver, restResolver, waitResolver } from "./basic.js";
import { gatherResolver } from "./gather.js";
import { moveResolver } from "./move.js";
import { announceResolver, communicateResolver } from "./speech.js";
import {
  createArtifactResolver,
  copyArtifactResolver,
  publishArtifactResolver,
  transferResolver,
} from "./artifacts.js";
import { buildResolver, guardLocationResolver, storeGoodsResolver } from "./physical.js";
import { releaseResolver, restrainResolver } from "./restraint.js";
import { createInhabitantResolver } from "./lineage.js";
import { createCurrencyResolver, transferCurrencyResolver } from "./currency.js";
import {
  acceptTradeResolver,
  offerTradeResolver,
  rejectTradeResolver,
  transferPropertyResolver,
} from "./trade.js";
import {
  RejectionCode,
  type ResolutionContext,
  type ResolutionResult,
  type Resolver,
} from "./types.js";

export * from "./types.js";
export { findRoute, isPassable, travelMinutes } from "./move.js";
export { GATHERABLE, computeYield, findSource } from "./gather.js";
export { CONSUMABLE } from "./basic.js";
export { settleExpiredActivities } from "./effects.js";

/**
 * How a stored intention is recognised when it is read back.
 *
 * Exported because the cognition layer has to find the newest one to show the
 * inhabitant what it last said it was doing, and a prefix agreed in two places
 * is a prefix that will eventually disagree.
 */
export const INTENTION_PREFIX = "Intention:";

/**
 * The honest placeholder.
 *
 * §26: "Do not claim a feature works unless it has been tested."
 */
export const notYetImplemented: Resolver = (ctx) => ({
  outcome: {
    status: "rejected",
    code: RejectionCode.NotImplemented,
    reason: "this action has no resolver in this build of the engine",
  },
  state: ctx.state,
  events: [],
});

/**
 * The actions this build actually resolves — the §27 vertical slice.
 *
 * This list is what the cognition layer offers an inhabitant, so an action
 * missing from it is an action the world cannot perform, however complete its
 * resolver is. That distinction was not academic: `createInhabitantResolver`,
 * the trade resolvers and the currency resolvers were all written and tested
 * while none of them appeared here. A hundred simulated days produced a world of
 * one inhabitant with a permanently unmeetable `social` need, because the only
 * action that could have answered it was unreachable.
 *
 * `transfer` is deliberately absent despite having a resolver. It is a narrow
 * early slice of `transfer_property` — resources and artifacts, inhabitant
 * recipients only — and offering both would put two near-identical ways to hand
 * something over in front of the model. The resolver stays registered below so
 * that any event already recorded against `transfer` still replays.
 */
export const IMPLEMENTED_ACTIONS: readonly ActionType[] = [
  "observe",
  "move",
  "gather",
  "consume",
  "rest",
  "wait",
  "announce",
  "communicate",
  "build",
  "store_goods",
  "guard_location",
  "create_artifact",
  "copy_artifact",
  "publish",
  "transfer_property",
  "offer_trade",
  "accept_trade",
  "reject_trade",
  "create_currency",
  "transfer_currency",
  "create_inhabitant",
  "restrain",
  "release",
];

const IMPLEMENTED: Partial<Record<ActionType, Resolver>> = {
  observe: observeResolver,
  move: moveResolver,
  gather: gatherResolver,
  consume: consumeResolver,
  rest: restResolver,
  wait: waitResolver,
  announce: announceResolver,
  communicate: communicateResolver,
  build: buildResolver,
  store_goods: storeGoodsResolver,
  guard_location: guardLocationResolver,
  create_artifact: createArtifactResolver,
  copy_artifact: copyArtifactResolver,
  publish: publishArtifactResolver,
  transfer: transferResolver,
  transfer_property: transferPropertyResolver,
  offer_trade: offerTradeResolver,
  accept_trade: acceptTradeResolver,
  reject_trade: rejectTradeResolver,
  create_currency: createCurrencyResolver,
  transfer_currency: transferCurrencyResolver,
  create_inhabitant: createInhabitantResolver,
  restrain: restrainResolver,
  release: releaseResolver,
};

/** Every action type, mapped to its resolver. Complete by construction. */
export const RESOLVERS: Readonly<Record<ActionType, Resolver>> = Object.freeze(
  Object.fromEntries(
    ACTION_TYPES.map((type) => [type, IMPLEMENTED[type] ?? notYetImplemented]),
  ) as Record<ActionType, Resolver>,
);

/**
 * Actions a confined inhabitant cannot perform (§11H).
 *
 * Derived from `ACTION_CATALOGUE.allowedWhileConfined` rather than maintained
 * here. §11H lists what confinement restricts — "leaving a location, performing
 * ordinary employment, gathering resources, accessing property, attending
 * organisations, creating another inhabitant" — and equally lists what it does
 * not: a confined inhabitant may still converse, think, write, negotiate,
 * receive visitors, appeal, refuse cooperation and attempt escape. Confinement
 * restricts a body; it does not delete a mind.
 *
 * Keeping a second copy of that judgement in the engine would eventually let
 * the catalogue and the enforcement disagree, and the engine would win silently.
 */
export const BLOCKED_WHILE_CONFINED: ReadonlySet<ActionType> = new Set<ActionType>(
  ACTION_TYPES.filter((type) => !actionsAllowedWhileConfined().includes(type)),
);

export interface RunActionInput {
  readonly state: WorldState;
  readonly actorId: string;
  readonly action: ProposedAction;
  /** When the action begins. Must not be before the world's current time. */
  readonly simTime: SimTime;
  /** The sequence number this turn occupies. Must be strictly increasing. */
  readonly sequence: number;
}

/**
 * Resolve one proposed action against the world.
 *
 * The returned state is the world *after* the turn, whether the action was
 * resolved or rejected — a rejection still consumes the sequence number and
 * still lets finished activities close, because time passed either way. What a
 * rejection never does is apply any part of the action.
 */
export function runAction(input: RunActionInput): ResolutionResult {
  const { action, actorId, sequence } = input;

  if (input.simTime < input.state.simTime) {
    return {
      outcome: {
        status: "rejected",
        code: "TIME_TRAVEL",
        reason: `turn at ${input.simTime} is before world time ${input.state.simTime}`,
      },
      state: input.state,
      events: [],
    };
  }
  if (sequence <= input.state.sequence) {
    return {
      outcome: {
        status: "rejected",
        code: "STALE_SEQUENCE",
        reason: `sequence ${sequence} is not ahead of ${input.state.sequence}`,
      },
      state: input.state,
      events: [],
    };
  }

  // Time advances, then finished activities close and their participants
  // return to idle. Both happen regardless of the action's fate.
  // World ticks need the previous timestamp to account for elapsed spoilage,
  // health and daily compute replenishment. Stamp the new time only after those
  // effects have been calculated.
  const base = withSimTime(
    settleExpiredActivities(input.state, input.simTime),
    input.simTime,
  );

  const finish = (result: ResolutionResult): ResolutionResult => {
    const sequenced = { ...result, state: withSequence(result.state, sequence) };
    return rememberTurn(sequenced, actorId, action, input.simTime, sequence);
  };

  const rejectHere = (code: string, reason: string): ResolutionResult =>
    finish({ outcome: { status: "rejected", code, reason }, state: base, events: [] });

  const actor = base.inhabitants[actorId];
  if (actor === undefined) {
    return rejectHere(RejectionCode.UnknownActor, `no inhabitant ${actorId} in this world`);
  }
  // §15: "Inhabitants cannot act after death."
  if (actor.status === "dead") {
    return rejectHere(RejectionCode.Dead, `${actorId} died at ${String(actor.deathTime)}`);
  }
  // §11A: one primary activity at a time.
  if (actor.activity.busyUntil > input.simTime) {
    return rejectHere(
      RejectionCode.Busy,
      `${actorId} is ${actor.activity.state} until ${actor.activity.busyUntil}`,
    );
  }
  if (actor.nextEligibleTime > input.simTime) {
    return rejectHere(
      RejectionCode.NotEligible,
      `${actorId} is not eligible to act until ${actor.nextEligibleTime}`,
    );
  }

  if (actor.confinementId !== null && BLOCKED_WHILE_CONFINED.has(action.type)) {
    const confinement = base.confinements[actor.confinementId];
    if (confinement !== undefined && !confinement.released) {
      return rejectHere(
        RejectionCode.Confined,
        `${actorId} is confined and cannot ${action.type}`,
      );
    }
  }

  const ctx: ResolutionContext = {
    state: base,
    actor,
    simTime: input.simTime,
    sequence,
    // A stream per (world seed, sequence, action, actor). Adding a draw to one
    // resolver cannot shift the numbers another sees.
    rng: Rng.derive(base.seed, "turn", String(sequence), action.type, actorId),
  };

  const resolver = RESOLVERS[action.type];
  try {
    return finish(resolver(ctx, action.payload));
  } catch (error) {
    /* c8 ignore next 10 */
    // A resolver must never throw. If one does, the world must not absorb a
    // half-applied transition (§15) — the pre-action state is returned intact.
    return rejectHere(
      RejectionCode.ResolverError,
      `resolver for ${action.type} threw: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function rememberTurn(
  result: ResolutionResult,
  actorId: string,
  action: ProposedAction,
  now: SimTime,
  sequence: number,
): ResolutionResult {
  if (result.state.inhabitants[actorId] === undefined) return result;
  const primary = result.events[0];
  const witnesses = new Set<string>([actorId]);
  const visibility = primary?.visibility;
  if (result.outcome.status === "rejected") {
    // A failed physical action changes no physical state, but the inhabitant
    // directly experiences the failure and can learn from it next turn.
  } else if (visibility?.kind === "participants") {
    for (const id of visibility.participants) witnesses.add(id);
  } else if (visibility?.kind === "local") {
    for (const inhabitant of Object.values(result.state.inhabitants)) {
      if (
        inhabitant.status === "alive" &&
        chebyshevDistance(inhabitant.location, { x: visibility.x, y: visibility.y }) <=
          result.state.rules.sightRadius
      ) {
        witnesses.add(inhabitant.id);
      }
    }
  } else if (visibility?.kind === "public" && result.state.inhabitants[actorId] !== undefined) {
    const actor = result.state.inhabitants[actorId]!;
    for (const inhabitant of Object.values(result.state.inhabitants)) {
      if (
        inhabitant.status === "alive" &&
        chebyshevDistance(inhabitant.location, actor.location) <= result.state.rules.sightRadius
      ) {
        witnesses.add(inhabitant.id);
      }
    }
  }

  const participants = [...witnesses].sort();
  let payloadText = "[non-canonical payload]";
  try {
    payloadText = canonicalJson(action.payload);
  } catch {
    // Rejected hostile payloads can contain floats or other non-canonical data.
  }
  const outcome =
    result.outcome.status === "resolved" || result.outcome.status === "partial"
      ? result.outcome.status
      : `${result.outcome.status}: ${result.outcome.reason}`;
  // What the acting inhabitant perceived, when the action was one that reveals
  // something. Only the actor records it: a witness saw someone look around,
  // not what that person saw.
  const perceived =
    result.outcome.status === "resolved" &&
    typeof result.outcome.detail === "object" &&
    result.outcome.detail !== null &&
    typeof (result.outcome.detail as { readonly perceived?: unknown }).perceived === "string"
      ? (result.outcome.detail as { readonly perceived: string }).perceived
      : null;

  let state = result.state;
  let discriminator = 0;
  for (const owner of participants) {
    const isActor = owner === actorId;
    const perspective = isActor ? "You performed" : `You witnessed ${actorId} perform`;
    const revealed = isActor && perceived !== null && perceived.length > 0
      ? ` You saw: ${perceived}.`
      : "";
    state = putMemory(state, {
      id: deriveMemoryId(state.worldId, sequence, discriminator++),
      owner,
      simTime: now,
      kind: "episodic",
      summary:
        `${perspective} ${action.type} with payload ${payloadText}. ` +
        `Outcome: ${outcome}.${revealed}`,
      participants,
      sequence,
      revisionOf: null,
    });
  }

  // An intention the actor wrote about itself, kept as a reflection (§19: a
  // belief, never a canonical fact). It is the actor's alone — witnesses saw an
  // action, not the reason behind it — and each new one is a new record rather
  // than an edit of the old, so the log shows what an inhabitant meant to do and
  // when it changed its mind.
  const intention = action.intention?.trim() ?? "";
  if (intention !== "") {
    state = putMemory(state, {
      id: deriveMemoryId(state.worldId, sequence, discriminator++),
      owner: actorId,
      simTime: now,
      kind: "reflection",
      summary: `${INTENTION_PREFIX} ${intention}`,
      participants: [actorId],
      sequence,
      revisionOf: null,
    });
  }

  if (
    primary !== undefined &&
    ["action.announce", "action.communicate", "action.transfer"].includes(primary.type)
  ) {
    for (const owner of participants) {
      for (const other of participants) {
        if (owner === other) continue;
        state = updateInhabitant(state, owner, (inhabitant) => {
          const current: Relationship = inhabitant.relationships[other] ?? {
            other,
            familiarity: 0,
            trust: 0,
            lastInteraction: null,
          };
          return {
            ...inhabitant,
            relationships: {
              ...inhabitant.relationships,
              [other]: {
                ...current,
                familiarity: Math.min(100, current.familiarity + 1),
                lastInteraction: now,
              },
            },
          };
        });
      }
    }
  }
  return { ...result, state };
}
