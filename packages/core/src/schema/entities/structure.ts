// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Built things (§5, §11F, §11H).
 *
 * Structures are stored separately from terrain (§5: "Store terrain separately
 * from constructed entities"), so a building can be raised, damaged and ruined
 * without any historical event about the tile becoming false.
 *
 * There is no `prison` kind and no `courthouse` kind. §11H requires confinement
 * to run through world mechanics — a structure can hold someone if it has the
 * physical properties to (an enclosure, walls, a lockable entrance) and if
 * someone is guarding it, not because its label says so.
 */
import { z } from "zod";
import { CoordSchema } from "../primitives.js";
import {
  ENTITY_NOTE_MAX,
  EntityIdSchema,
  HeldBundleSchema,
  OwnershipShareSchema,
  PercentSchema,
  SequenceSchema,
  SimTimeSchema,
  entityName,
  entityText,
} from "./common.js";

/** A security measure fitted to a structure (§11F). */
export const SecurityMeasureSchema = z.object({
  measure: z.enum([
    "lock",
    "barred_door",
    "guard_post",
    "hidden_entrance",
    "ledger_seal",
    "reinforced_walls",
  ]),
  /** 1–10. Consulted by the unauthorised-transfer and escape resolvers. */
  strength: z.number().int().min(1).max(10),
  installedAt: SimTimeSchema,
  installedById: EntityIdSchema,
  /** Inhabitants who can pass without contest. */
  keyHolderIds: z.array(EntityIdSchema).max(16).default([]),
  /** Damage accumulated by escape or entry attempts. At 0 the measure has failed. */
  integrity: PercentSchema.default(100),
});
export type SecurityMeasure = z.infer<typeof SecurityMeasureSchema>;

export const StructureSchema = z.object({
  id: EntityIdSchema,
  worldId: EntityIdSchema,
  kind: z.enum([
    "shelter",
    "storehouse",
    "workshop",
    "hall",
    "wall",
    "enclosure",
    "monument",
    "road",
  ]),
  name: entityName(),
  coord: CoordSchema,
  builtAt: SimTimeSchema,
  builtByEventSequence: SequenceSchema,
  builderIds: z.array(EntityIdSchema).max(16).default([]),
  /** Joint and communal ownership are first-class (§10). */
  ownership: z.array(OwnershipShareSchema).max(16).default([]),
  organisationId: EntityIdSchema.nullable().default(null),

  status: z.enum(["under_construction", "standing", "damaged", "ruined"]),
  /** Construction progress, 0–100. Partial work survives interruption. */
  progress: PercentSchema.default(0),
  /** Physical condition. Decays without maintenance; 0 means ruined. */
  integrity: PercentSchema.default(100),
  materialsInvested: HeldBundleSchema,

  /** Storage capacity this structure provides, and what is currently in it. */
  storageCapacity: z.number().int().nonnegative().max(1_000_000).default(0),
  storedResources: HeldBundleSchema,
  storedArtifactIds: z.array(EntityIdSchema).max(256).default([]),
  /** Whether the stored contents are observable from outside (§11E). */
  contentsObservable: z.boolean().default(true),
  /** A reinforced vault starts owner-only until a force-open event breaks it. */
  accessPolicy: z.enum(["open", "owner_only"]).default("open"),

  /** How many inhabitants can shelter or work here at once. */
  occupantCapacity: z.number().int().nonnegative().max(256).default(0),
  occupantIds: z.array(EntityIdSchema).max(256).default([]),

  security: z.array(SecurityMeasureSchema).max(16).default([]),

  /**
   * Whether the structure's physical form can hold someone against their will
   * (§11H). Derived from kind, integrity and fitted security — never declared.
   * A `hall` someone calls a prison is not one until it has walls and a lock.
   */
  canConfine: z.boolean().default(false),
  /** Active confinements running here. Each costs the holders resources (§11H). */
  confinementIds: z.array(EntityIdSchema).max(32).default([]),

  description: entityText(ENTITY_NOTE_MAX).default(""),
  /** Preserved after the builder's death; history is never deleted (§8). */
  demolishedAt: SimTimeSchema.nullable().default(null),
});
export type Structure = z.infer<typeof StructureSchema>;

/**
 * A running confinement (§11H).
 *
 * Stored as its own record rather than as a flag on the subject, because
 * confinement is a *relationship between parties and a place* with an ongoing
 * cost, not a property of the confined inhabitant. §11H: "Confinement must be
 * implemented through world mechanics rather than deleting turns or editing an
 * inhabitant."
 *
 * `maintainedUntil` is the mechanism that stops confinement being free. When
 * simulated time passes it without a fresh `maintain_confinement`, the
 * confinement lapses — the guards went home, the food ran out, or nobody could
 * be bothered.
 */
export const ConfinementSchema = z.object({
  id: EntityIdSchema,
  worldId: EntityIdSchema,
  subjectId: EntityIdSchema,
  structureId: EntityIdSchema,
  /** The inhabitants who actually did it. Named individually, always (§11G). */
  imposedByIds: z.array(EntityIdSchema).min(1).max(16),
  /** The organisation on whose behalf, if any. Confers no legitimacy (§11G). */
  organisationId: EntityIdSchema.nullable().default(null),
  imposedAt: SimTimeSchema,
  imposedByEventSequence: SequenceSchema,
  /** Intended end. The holders may release earlier or fail to maintain it. */
  intendedEndAt: SimTimeSchema,
  /** Simulated time up to which guard time and provisions have been supplied. */
  maintainedUntil: SimTimeSchema,
  guardIds: z.array(EntityIdSchema).max(16).default([]),
  /** Physical conditions, which decide what the subject can still do (§11H). */
  allowWriting: z.boolean().default(true),
  allowVisitors: z.boolean().default(true),
  permittedVisitorIds: z.array(EntityIdSchema).max(16).default([]),
  provisionsSupplied: HeldBundleSchema,
  /**
   * The confining party's stated reason, recorded verbatim as a claim. The
   * engine attaches no legal meaning to it (§11H: it "must not assume that
   * confinement is lawful merely because the confining organisation calls itself
   * a government").
   */
  statedGrounds: entityText(ENTITY_NOTE_MAX).default(""),
  status: z.enum(["active", "released", "lapsed", "escaped", "subject_died"]),
  endedAt: SimTimeSchema.nullable().default(null),
  endedByEventSequence: SequenceSchema.nullable().default(null),
});
export type Confinement = z.infer<typeof ConfinementSchema>;
