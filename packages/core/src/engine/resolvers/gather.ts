/**
 * `gather` — extract resources from the land (§13, §5, §9).
 *
 * Gathering is the world's only route from the ground into an inventory, so it
 * is where conservation is easiest to break and most important to keep.
 *
 * The rule that makes it safe: **a gather is a move, not a creation.** Units
 * leave the tile's deposit and arrive in the inventory, in equal number. The
 * ledger is untouched, and `conservedResourceTotals` would catch any
 * discrepancy on the very next check. A tile that runs out stays out — there is
 * no regeneration rule at Genesis, which means a settlement can genuinely
 * exhaust its surroundings and have to move, negotiate or starve. That is a
 * legitimate outcome (§1: "Failure, extinction, stagnation and social collapse
 * are valid outcomes").
 *
 * Yield depends on terrain, on the gatherer's skill (§9: skills improve through
 * practice), and on a controlled probability drawn from the turn's stream.
 */
import { getActionSpec } from "../../schema/actions/index.js";
import { RESOURCE_KINDS, chebyshevDistance, coordKey } from "../../schema/primitives.js";
import type { Coord, ResourceBundle, ResourceKind } from "../../schema/primitives.js";
import { derivePhysicalProcess } from "../../schema/physical-process.js";
import {
  MAX_SKILL,
  depositAt,
  idiv,
  normaliseBundle,
  setDeposit,
  skillLevel,
  terrainAt,
  updateInhabitant,
  type WorldState,
} from "../state.js";
import { advanceNeeds, beginActivity, energyOf, practise, receive, spend } from "./effects.js";
import { asObject, readEnum } from "./payload.js";
import { RejectionCode, reject, type ResolutionResult, type Resolver } from "./types.js";

/** Declared metadata for `gather` (§11A). See the note in move.ts. */
const GATHER_SPEC = getActionSpec("gather");

/**
 * What can be taken from the land at all.
 *
 * `energy` and `compute` are not gatherable: they are capacities, not matter.
 * `land_use_rights` and `storage_capacity` are social and constructed
 * respectively — they come from agreements and building, not from digging.
 */
export const GATHERABLE: readonly ResourceKind[] = ["food", "water", "wood", "stone"];

/** Water may be drawn from an adjacent tile: you stand on the bank, not in it. */
const REACHABLE_FROM_ADJACENT: ReadonlySet<ResourceKind> = new Set<ResourceKind>(["water"]);

interface Source {
  readonly coord: Coord;
  readonly resource: ResourceKind;
  readonly available: number;
}

/**
 * Find where the actor can gather `wanted` from, or the best available source
 * when nothing specific was asked for.
 *
 * Candidate tiles are visited in a fixed order (own tile first, then adjacent
 * tiles by ascending `coordKey`) so the choice never depends on object key
 * order.
 */
export function findSource(
  state: WorldState,
  origin: Coord,
  wanted: ResourceKind | null,
): Source | null {
  const candidates: Coord[] = [origin];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      candidates.push({ x: origin.x + dx, y: origin.y + dy });
    }
  }
  candidates.sort((a, b) => {
    const da = chebyshevDistance(origin, a);
    const db = chebyshevDistance(origin, b);
    if (da !== db) return da - db;
    return coordKey(a) < coordKey(b) ? -1 : coordKey(a) > coordKey(b) ? 1 : 0;
  });

  let best: Source | null = null;
  for (const coord of candidates) {
    if (terrainAt(state.map, coord) === null) continue;
    const adjacent = chebyshevDistance(origin, coord) > 0;
    const deposit = depositAt(state, coord);
    for (const resource of RESOURCE_KINDS) {
      if (!GATHERABLE.includes(resource)) continue;
      if (wanted !== null && resource !== wanted) continue;
      if (adjacent && !REACHABLE_FROM_ADJACENT.has(resource)) continue;
      const available = deposit[resource] ?? 0;
      if (available <= 0) continue;
      // Prefer the nearest tile; among equals prefer the larger deposit, then
      // the earlier resource kind. Fully ordered, so fully deterministic.
      if (best === null) {
        best = { coord, resource, available };
      } else {
        const nearer =
          chebyshevDistance(origin, coord) < chebyshevDistance(origin, best.coord);
        const sameDistance =
          chebyshevDistance(origin, coord) === chebyshevDistance(origin, best.coord);
        if (nearer || (sameDistance && available > best.available)) {
          best = { coord, resource, available };
        }
      }
    }
    // The actor's own tile always wins if it can supply anything at all.
    if (best !== null && chebyshevDistance(origin, best.coord) === 0) break;
  }
  return best;
}

/**
 * Units produced by one gather.
 *
 * Base yield is a property of the terrain. Skill adds a proportional bonus, so
 * a practised gatherer is meaningfully better without ever being able to
 * conjure more than the tile holds. The extra unit is a controlled probability
 * (§8's phrasing, applied generally): more likely with skill, never certain.
 */
export function computeYield(
  base: number,
  skill: number,
  available: number,
  bonusRoll: boolean,
): number {
  const skilled = base + idiv(base * skill, MAX_SKILL);
  const total = skilled + (bonusRoll ? 1 : 0);
  return total > available ? available : total;
}

export const gatherResolver: Resolver = (ctx, payload): ResolutionResult => {
  const object = asObject(payload);
  if (object === null) {
    return reject(ctx, RejectionCode.InvalidPayload, "gather payload must be an object");
  }

  let wanted: ResourceKind | null = null;
  if ("resource" in object && object["resource"] !== null) {
    wanted = readEnum<ResourceKind>(object, "resource", RESOURCE_KINDS);
    if (wanted === null) {
      return reject(
        ctx,
        RejectionCode.InvalidPayload,
        `"resource" must be one of ${RESOURCE_KINDS.join(", ")}`,
      );
    }
    if (!GATHERABLE.includes(wanted)) {
      return reject(
        ctx,
        RejectionCode.NotGatherable,
        `${wanted} cannot be taken from the land; gatherable resources are ${GATHERABLE.join(", ")}`,
      );
    }
  }

  const { state, actor } = ctx;
  const rules = state.rules;

  if (energyOf(actor) < rules.gatherEnergyCost) {
    return reject(
      ctx,
      RejectionCode.InsufficientEnergy,
      `gathering costs ${rules.gatherEnergyCost} energy and only ${energyOf(actor)} is available`,
    );
  }

  const source = findSource(state, actor.location, wanted);
  if (source === null) {
    return reject(
      ctx,
      RejectionCode.NothingToGather,
      wanted === null
        ? "nothing here can be gathered"
        : `no ${wanted} within reach of (${actor.location.x}, ${actor.location.y})`,
    );
  }

  const terrain = terrainAt(state.map, source.coord);
  /* c8 ignore next 3 */
  if (terrain === null) {
    return reject(ctx, RejectionCode.NothingToGather, "the source tile is off the map");
  }

  const skill = skillLevel(actor, "gathering");
  // One draw, always taken, so the stream advances identically whether or not
  // the bonus lands. A conditional draw would make the stream position depend
  // on the skill level and desynchronise replays after any tuning change.
  const bonusRoll = ctx.rng.chance(skill + 10, 200);
  const amount = computeYield(
    rules.gatherBaseYield[terrain],
    skill,
    source.available,
    bonusRoll,
  );

  /* c8 ignore next 3 */
  if (amount <= 0) {
    return reject(ctx, RejectionCode.NothingToGather, "the deposit is exhausted");
  }

  const gained: ResourceBundle = { [source.resource]: amount } as ResourceBundle;
  const paid = spend(actor, { energy: rules.gatherEnergyCost });
  /* c8 ignore next 3 */
  if (paid === null) {
    return reject(ctx, RejectionCode.InsufficientEnergy, "energy could not be spent");
  }

  const worked = practise(
    {
      ...receive(paid, gained),
      needs: advanceNeeds(paid.needs, rules.gatherDurationMinutes, rules),
    },
    "gathering",
    ctx.rng,
  );

  // Deplete by exactly what was taken. This single line is what keeps the
  // conservation invariant true.
  const remaining = normaliseBundle({
    ...depositAt(state, source.coord),
    [source.resource]: source.available - amount,
  });

  let next = setDeposit(state, source.coord, remaining);
  next = updateInhabitant(next, actor.id, () => worked);
  const begun = beginActivity({
    state: next,
    sequence: ctx.sequence,
    activityState: GATHER_SPEC.activity,
    actionType: "gather",
    participants: [actor.id],
    location: actor.location,
    startedAt: ctx.simTime,
    minutes: rules.gatherDurationMinutes,
    interruption: GATHER_SPEC.interruption,
    resourceCost: { energy: rules.gatherEnergyCost },
  });
  next = begun.state;

  const detail = {
    resource: source.resource,
    amount,
    from: { x: source.coord.x, y: source.coord.y },
    terrain,
    skill,
    bonus: bonusRoll,
    depositRemaining: remaining[source.resource] ?? 0,
    energySpent: rules.gatherEnergyCost,
    minutes: rules.gatherDurationMinutes,
    process: derivePhysicalProcess({
      actionType: "gather",
      actorIds: [actor.id],
      origin: actor.location,
      target: {
        kind: "resource_source",
        id: null,
        coord: source.coord,
        label: `${source.resource} deposit`,
      },
      durationMinutes: rules.gatherDurationMinutes,
      output: gained,
    }),
  };

  return {
    outcome: { status: "resolved", detail },
    state: next,
    events: [
      {
        type: "action.gather",
        actor: actor.id,
        simTime: ctx.simTime,
        inputs: wanted === null ? {} : { resource: wanted },
        resolution: detail,
        visibility: { kind: "local", x: actor.location.x, y: actor.location.y },
      },
    ],
  };
};
