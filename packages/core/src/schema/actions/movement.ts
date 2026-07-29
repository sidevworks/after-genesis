/**
 * Perception, movement and the two ways of spending time on nothing (§13).
 *
 * `observe`, `move`, `rest` and `wait` are the actions an inhabitant can perform
 * with nothing but its own body. They are also the only actions available to a
 * newborn (§11B), which is why every one of them sits at maturity 0 or 1.
 */
import { z } from "zod";
import { CoordSchema } from "../primitives.js";
import {
  MAX_PATH_LENGTH,
  MAX_PLANNED_MINUTES,
  OptionalCoordSchema,
  OptionalIdSchema,
  minutesInRange,
  optionalText,
} from "./common.js";

/**
 * Look at the world.
 *
 * `observe` never returns more than the inhabitant may legitimately perceive
 * (§11E); the focus below narrows *what it attends to*, it does not request
 * privileged access. Asking to observe a distant inhabitant's private storage is
 * a well-formed payload that resolves to seeing nothing.
 */
export const ObservePayloadSchema = z.object({
  focus: z
    .enum(["surroundings", "inhabitant", "structure", "artifact", "tile"])
    .default("surroundings"),
  targetId: OptionalIdSchema,
  coord: OptionalCoordSchema,
  /**
   * Chebyshev radius in tiles. Capped at 8 on a 32×32 grid: perception is local,
   * and a larger radius would make the observation builder the thing that
   * decides what is knowable rather than the world's geometry.
   */
  radius: z.number().int().min(0).max(8).default(1),
});

/**
 * Travel to another tile.
 *
 * `path` is the route the inhabitant intends to take. It is a proposal: the
 * engine validates passability (§5, water is impassable) and may resolve a
 * shorter or different route. An interrupted journey keeps the ground already
 * covered, so travel is the one long action that is never wasted.
 */
export const MovePayloadSchema = z.object({
  /**
   * Named `to` because that is the key the move resolver reads. This schema and
   * the resolver disagreed for a long time — the schema said `destination`,
   * nothing parsed it, and the disagreement was invisible because the declared
   * schema is documentation rather than the gate. A resolver-contract test now
   * fails if they diverge again.
   */
  to: CoordSchema,
  path: z.array(CoordSchema).max(MAX_PATH_LENGTH).default([]),
  /** Travel faster for more energy. A choice the inhabitant makes, not a modifier. */
  haste: z.boolean().default(false),
  reason: optionalText(300),
});

/**
 * Sleep or recuperate.
 *
 * Rest is the cheapest action in the world and one of the longest: it consumes
 * no resources and restores energy, but it consumes a large block of the day's
 * attention, which is exactly the scarcity §11A is built on. An inhabitant that
 * never rests runs out of energy; one that rests constantly achieves nothing.
 */
export const RestPayloadSchema = z.object({
  /** Minutes, matching the resolver. Capped at 16 hours: sleeping longer is a condition, not a decision. */
  minutes: z.number().int().min(1).max(16 * 60).default(8 * 60),
  structureId: OptionalIdSchema,
});

/**
 * Deliberately do nothing for a while.
 *
 * Distinct from `rest`: waiting restores nothing. It exists so that "hold my
 * position until the others arrive" is a first-class canonical act with a
 * recorded reason, rather than an absence in the log.
 */
export const WaitPayloadSchema = z.object({
  /** Named `minutes` because that is the key the wait resolver reads. */
  minutes: minutesInRange(1, MAX_PLANNED_MINUTES).default(60),
  reason: optionalText(300),
  /** If set, the wait ends early when this activity completes. */
  untilActivityId: OptionalIdSchema,
});
