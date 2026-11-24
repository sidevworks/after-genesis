// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Making things (§13).
 *
 * `build` places a persistent structure on a tile; `craft` turns primitive
 * resources into a portable artifact. Both are bounded by §5: "New artifact
 * types may emerge from combinations of primitives, but inhabitants cannot
 * create unlimited physical resources by naming them." A model may name whatever
 * it likes in `itemName`; what it *gets* is decided by the materials it actually
 * holds and the skill it has actually practised.
 */
import { z } from "zod";
import { CoordSchema } from "../primitives.js";
import {
  MAX_SMALL_LIST,
  NAME_MAX,
  OptionalIdSchema,
  PayloadBundleSchema,
  STATEMENT_MAX,
  idList,
  optionalText,
  requiredText,
} from "./common.js";

/**
 * Erect or extend a structure on a tile.
 *
 * The structure kinds are deliberately generic. There is no "prison", no
 * "courthouse" and no "church": an `enclosure` becomes a prison when inhabitants
 * confine someone in it and call it one, and a `hall` becomes a courthouse the
 * same way (§11G — the engine records structures, inhabitants supply the
 * meaning).
 */
export const BuildPayloadSchema = z.object({
  structureKind: z.enum([
    "assembly",
    "shelter",
    "storehouse",
    "workshop",
    "hall",
    "wall",
    "enclosure",
    "monument",
    "road",
    "smelter",
    "reinforced_vault",
  ]),
  coord: CoordSchema,
  name: requiredText(NAME_MAX),
  materials: PayloadBundleSchema,
  /** Helpers who have agreed to work on this site. Each spends their own time (§11D). */
  collaboratorIds: idList(MAX_SMALL_LIST),
  /** Continue work on a part-built structure rather than starting a new one. */
  continuesStructureId: OptionalIdSchema,
  /** Build on behalf of an organisation, which then holds the structure. */
  organisationId: OptionalIdSchema,
  purpose: optionalText(STATEMENT_MAX),
});

/**
 * Combine materials into a portable artifact.
 *
 * `intendedUse` is a hint to the resolver about which skill applies and which
 * mechanical affordance the result may carry (a `lock` can be fitted to a
 * structure; a `tool` can improve gathering). It is not a licence: crafting a
 * "medicine" produces something that treats a condition only if the crafter's
 * treatment knowledge supports it (§8 — outcomes depend on knowledge, skill and
 * controlled probability, not on persuasive naming).
 */
export const CraftPayloadSchema = z.object({
  /** A canonical recipe. Omit only for non-mechanical expressive artifacts. */
  recipeId: z.string().max(NAME_MAX).nullable().default(null),
  itemName: requiredText(NAME_MAX),
  description: optionalText(STATEMENT_MAX),
  materials: PayloadBundleSchema,
  quantity: z.number().int().min(1).max(100).default(1),
  intendedUse: z
    .enum(["tool", "container", "lock", "instrument", "furnishing", "medicine", "other"])
    .default("other"),
  /** A workshop whose tools and shelter improve the outcome. */
  structureId: OptionalIdSchema,
  /** A design or research note being followed, which may raise the ceiling on quality. */
  fromArtifactId: OptionalIdSchema,
  collaboratorIds: idList(MAX_SMALL_LIST),
});

/** Convert a declared raw ore into an ingot at an existing smelter. */
export const RefinePayloadSchema = z.object({
  recipeId: z.enum([
    "recipe_refine_iron",
    "recipe_refine_titanium",
    "recipe_refine_copper",
    "recipe_refine_molybdenum",
  ]),
  structureId: OptionalIdSchema,
});
