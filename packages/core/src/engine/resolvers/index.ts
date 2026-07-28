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
import { buildResolver, guardLocationResolver } from "./physical.js";
import { releaseResolver, restrainResolver } from "./restraint.js";
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

/** The actions this build actually resolves — the §27 vertical slice. */
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
  "guard_location",
  "create_artifact",
  "copy_artifact",
  "publish",
  "transfer",
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
  guard_location: guardLocationResolver,
  create_artifact: createArtifactResolver,
  copy_artifact: copyArtifactResolver,
  publish: publishArtifactResolver,
  transfer: transferResolver,
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
  const base = settleExpiredActivities(
    withSimTime(input.state, input.simTime),
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
  let state = result.state;
  let discriminator = 0;
  for (const owner of participants) {
    const perspective = owner === actorId ? "You performed" : `You witnessed ${actorId} perform`;
    state = putMemory(state, {
      id: deriveMemoryId(state.worldId, sequence, discriminator++),
      owner,
      simTime: now,
      kind: "episodic",
      summary:
        `${perspective} ${action.type} with payload ${payloadText}. ` +
        `Outcome: ${outcome}.`,
      participants,
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
