/**
 * `observe`, `consume`, `rest` and `wait` — the maintenance actions (§13).
 *
 * These are the actions an inhabitant spends most of its life on, and they are
 * where the world's scarcity is felt. None of them is free: perceiving costs a
 * little energy and five minutes, eating destroys food, sleeping consumes the
 * night, and waiting consumes the clock exactly as fast as working does.
 *
 * A note on activity states. §11A fixes the vocabulary and it has no "eating"
 * or "observing" state. Rather than each resolver inventing a mapping, every
 * action's activity and interruption policy are read from `ACTION_CATALOGUE`,
 * which is the published declaration of that metadata. `observe`, `consume` and
 * `wait` are all declared `idle` there — they occupy attention without
 * committing it elsewhere — but each still books its time, because an activity
 * that cost nothing would be a free action, and §11A has none.
 */
import { getActionSpec } from "../../schema/actions/index.js";
import type { ResourceKind } from "../../schema/primitives.js";
import { isNight } from "../../time.js";
import {
  clampInt,
  idiv,
  recordDestroyed,
  updateInhabitant,
  type Inhabitant,
  type WorldRules,
  type WorldState,
} from "../state.js";
import { buildObservation, currentSightRadius } from "../observation.js";
import {
  advanceNeeds,
  beginActivity,
  capEnergy,
  energyOf,
  learnLocations,
  receive,
  spend,
  withNeed,
} from "./effects.js";
import { asObject, readEnum, readOptionalInt } from "./payload.js";
import { RejectionCode, reject, type ResolutionResult, type Resolver } from "./types.js";

/**
 * Declared metadata per action (§11A). Read from the catalogue so the engine
 * and the published action spec cannot drift apart.
 */
const SPEC = {
  observe: getActionSpec("observe"),
  consume: getActionSpec("consume"),
  rest: getActionSpec("rest"),
  wait: getActionSpec("wait"),
} as const;

/* ------------------------------------------------------------------------- */
/* observe                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * `observe` — look around (§13, §11E).
 *
 * The resolver does not return the observation itself. Observation content is
 * built by `buildObservation` at cognition time and goes into the model prompt;
 * putting it in the canonical event would write one inhabitant's private view
 * of the world into a log other inhabitants can read. What the event records is
 * the neutral, physical fact: this inhabitant spent five minutes looking, and
 * how much was in view.
 */
export const observeResolver: Resolver = (ctx): ResolutionResult => {
  const { state, actor } = ctx;
  const rules = state.rules;

  if (energyOf(actor) < rules.observeEnergyCost) {
    return reject(
      ctx,
      RejectionCode.InsufficientEnergy,
      `observing costs ${rules.observeEnergyCost} energy and only ${energyOf(actor)} is available`,
    );
  }

  const observation = buildObservation(state, actor.id);
  const paid = spend(actor, { energy: rules.observeEnergyCost });
  /* c8 ignore next 3 */
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientEnergy, "energy could not be spent");
  }

  const seen = learnLocations(
    {
      ...paid,
      needs: advanceNeeds(paid.needs, rules.observeDurationMinutes, rules),
    },
    observation.tiles.map((tile) => ({ x: tile.x, y: tile.y })),
  );

  let next = updateInhabitant(state, actor.id, () => seen);
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: SPEC.observe.activity,
    actionType: "observe",
    participants: [actor.id],
    location: actor.location,
    startedAt: ctx.simTime,
    minutes: rules.observeDurationMinutes,
    interruption: SPEC.observe.interruption,
    resourceCost: { energy: rules.observeEnergyCost },
  }).state;

  const detail = {
    sightRadius: currentSightRadius(state, actor.id),
    night: observation.night,
    tilesSeen: observation.tiles.length,
    inhabitantsSeen: observation.inhabitants.length,
    structuresSeen: observation.structures.length,
    energySpent: rules.observeEnergyCost,
    minutes: rules.observeDurationMinutes,
  };

  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.observe",
        actor: actor.id,
        simTime: ctx.simTime,
        inputs: {},
        resolution: detail,
        // What was seen is the observer's alone (§11E, §15).
        visibility: { kind: "private", owner: actor.id },
      },
    ],
  };
};

/* ------------------------------------------------------------------------- */
/* consume                                                                    */
/* ------------------------------------------------------------------------- */

/** What a body can actually use. Wood and stone are not food. */
export const CONSUMABLE: readonly ResourceKind[] = ["food", "water"];

interface ConsumeEffect {
  readonly need: "hunger" | "thirst";
  readonly relief: number;
  readonly energy: number;
}

function consumeEffect(resource: ResourceKind, rules: WorldRules): ConsumeEffect | null {
  if (resource === "food") {
    return { need: "hunger", relief: rules.foodHungerRelief, energy: rules.foodEnergyGain };
  }
  if (resource === "water") {
    return { need: "thirst", relief: rules.waterThirstRelief, energy: rules.waterEnergyGain };
  }
  /* c8 ignore next */
  return null;
}

/**
 * `consume` — eat or drink (§13).
 *
 * This is a declared resource *sink* (§5): the units leave the world entirely
 * and are recorded in `ledger.destroyed`, which is what keeps the conservation
 * equation balanced. Energy is created here, and legitimately so — energy is
 * not a conserved resource precisely because bodies convert matter into
 * capacity.
 */
export const consumeResolver: Resolver = (ctx, payload): ResolutionResult => {
  const object = asObject(payload);
  if (object === null) {
    return reject(ctx, RejectionCode.InvalidPayload, "consume payload must be an object");
  }
  const resource = readEnum<ResourceKind>(object, "resource", CONSUMABLE);
  if (resource === null) {
    return reject(
      ctx,
      RejectionCode.NotConsumable,
      `"resource" must be one of ${CONSUMABLE.join(", ")}`,
    );
  }
  const rules = ctx.state.rules;
  const amount = readOptionalInt(object, "amount", 1);
  if (amount === null || amount <= 0 || amount > rules.maxConsumePerAction) {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      `"amount" must be an integer between 1 and ${rules.maxConsumePerAction}`,
    );
  }

  const { state, actor } = ctx;
  const held = actor.inventory[resource] ?? 0;
  if (held < amount) {
    return reject(
      ctx,
      RejectionCode.InsufficientResources,
      `holds ${held} ${resource} but tried to consume ${amount}`,
    );
  }

  const effect = consumeEffect(resource, rules);
  /* c8 ignore next 3 */
  if (effect === null) {
    return reject(ctx, RejectionCode.NotConsumable, `${resource} cannot be consumed`);
  }

  const paid = spend(actor, { [resource]: amount } as Record<string, number>);
  /* c8 ignore next 3 */
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientResources, "resources could not be spent");
  }

  const energyBefore = energyOf(paid);
  const fed = capEnergy(receive(paid, { energy: effect.energy * amount }));
  const energyGained = energyOf(fed) - energyBefore;

  const relieved: Inhabitant = {
    ...fed,
    needs: withNeed(
      advanceNeeds(fed.needs, rules.consumeDurationMinutes, rules),
      effect.need,
      -effect.relief * amount,
    ),
  };

  let next = updateInhabitant(state, actor.id, () => relieved);
  // The units are gone from the world, not moved. Declared sink (§5).
  next = recordDestroyed(next, { [resource]: amount } as Record<string, number>);
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: SPEC.consume.activity,
    actionType: "consume",
    participants: [actor.id],
    location: actor.location,
    startedAt: ctx.simTime,
    minutes: rules.consumeDurationMinutes,
    interruption: SPEC.consume.interruption,
    resourceCost: { [resource]: amount } as Record<string, number>,
  }).state;

  const detail = {
    resource,
    amount,
    need: effect.need,
    needBefore: actor.needs[effect.need],
    needAfter: relieved.needs[effect.need],
    energyGained,
    minutes: rules.consumeDurationMinutes,
  };

  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.consume",
        actor: actor.id,
        simTime: ctx.simTime,
        inputs: { resource, amount },
        resolution: detail,
        visibility: { kind: "local", x: actor.location.x, y: actor.location.y },
      },
    ],
  };
};

/* ------------------------------------------------------------------------- */
/* rest                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * `rest` — sleep (§13, §11B "required rest").
 *
 * Rest is the world's source of energy, and it is paid for in the only currency
 * that cannot be gathered: hours. Night rest restores twice as fast, which is
 * what gives the day/night cycle consequences rather than decoration — an
 * inhabitant that works through the night pays for it.
 */
export const restResolver: Resolver = (ctx, payload): ResolutionResult => {
  const object = asObject(payload) ?? {};
  const rules = ctx.state.rules;
  const minutes = readOptionalInt(object, "minutes", rules.restDefaultMinutes);
  if (minutes === null || minutes <= 0 || minutes > rules.restMaxMinutes) {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      `"minutes" must be an integer between 1 and ${rules.restMaxMinutes}`,
    );
  }

  const { state, actor } = ctx;
  const night = isNight(ctx.simTime);
  const gain = minutes * rules.restEnergyPerMinute * (night ? 2 : 1);

  const energyBefore = energyOf(actor);
  const rested = capEnergy(receive(actor, { energy: gain }));
  const energyGained = energyOf(rested) - energyBefore;

  const fatigueRelief = idiv(minutes, rules.restMinutesPerFatigueRelief);
  const slept: Inhabitant = {
    ...rested,
    needs: withNeed(advanceNeeds(rested.needs, minutes, rules), "fatigue", -fatigueRelief),
  };

  let next = updateInhabitant(state, actor.id, () => slept);
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: SPEC.rest.activity,
    actionType: "rest",
    participants: [actor.id],
    location: actor.location,
    startedAt: ctx.simTime,
    minutes,
    // Sleep can be interrupted, and nothing is lost when it is.
    interruption: SPEC.rest.interruption,
    resourceCost: {},
  }).state;

  const detail = {
    minutes,
    night,
    energyGained,
    fatigueBefore: actor.needs.fatigue,
    fatigueAfter: slept.needs.fatigue,
  };

  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.rest",
        actor: actor.id,
        simTime: ctx.simTime,
        inputs: { minutes },
        resolution: detail,
        visibility: { kind: "local", x: actor.location.x, y: actor.location.y },
      },
    ],
  };
};

/* ------------------------------------------------------------------------- */
/* wait                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * `wait` — do nothing, deliberately (§13).
 *
 * Waiting still books an activity and still advances needs. An inhabitant that
 * waits all day is hungry by evening, exactly as one that worked all day is.
 * This matters because `wait` is the fallback for an invalid model response
 * (§14.11): if it were free, a model could avoid every cost by emitting
 * nonsense.
 */
export const waitResolver: Resolver = (ctx, payload): ResolutionResult => {
  const object = asObject(payload) ?? {};
  const rules = ctx.state.rules;
  const minutes = readOptionalInt(object, "minutes", rules.waitDefaultMinutes);
  if (minutes === null || minutes <= 0 || minutes > rules.waitMaxMinutes) {
    return reject(
      ctx,
      RejectionCode.InvalidPayload,
      `"minutes" must be an integer between 1 and ${rules.waitMaxMinutes}`,
    );
  }

  const { state, actor } = ctx;
  const waited: Inhabitant = {
    ...actor,
    needs: advanceNeeds(actor.needs, minutes, rules),
  };

  let next: WorldState = updateInhabitant(state, actor.id, () => waited);
  next = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: SPEC.wait.activity,
    actionType: "wait",
    participants: [actor.id],
    location: actor.location,
    startedAt: ctx.simTime,
    minutes,
    interruption: SPEC.wait.interruption,
    resourceCost: {},
  }).state;

  const detail = {
    minutes,
    hungerAfter: clampInt(waited.needs.hunger, 0, 100),
    thirstAfter: clampInt(waited.needs.thirst, 0, 100),
  };

  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.wait",
        actor: actor.id,
        simTime: ctx.simTime,
        inputs: { minutes },
        resolution: detail,
        visibility: { kind: "local", x: actor.location.x, y: actor.location.y },
      },
    ],
  };
};
