// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Canonical physical recipes. They are engine data, not model suggestions:
 * a model may select an id but cannot alter its inputs, location or output.
 */
import type { ResourceBundle, ResourceKind } from "./primitives.js";

export type MechanicalKind = "titanium_prybar";

export interface Recipe {
  readonly id: string;
  readonly action: "refine" | "craft" | "build";
  readonly inputs: ResourceBundle;
  readonly requiredStructure: "smelter" | "workshop";
  readonly output:
    | { readonly kind: "resource"; readonly item: ResourceKind; readonly quantity: number }
    | { readonly kind: "artifact"; readonly mechanicalKind: MechanicalKind; readonly durability: number }
    | { readonly kind: "structure"; readonly structureKind: "reinforced_vault"; readonly accessPolicy: "owner_only" };
}

export const RECIPE_REGISTRY: readonly Recipe[] = Object.freeze([
  { id: "recipe_refine_iron", action: "refine", inputs: { iron_ore: 2, wood: 1 }, requiredStructure: "smelter", output: { kind: "resource", item: "iron_ingot", quantity: 1 } },
  { id: "recipe_refine_titanium", action: "refine", inputs: { titanium_ore: 2, wood: 1 }, requiredStructure: "smelter", output: { kind: "resource", item: "titanium_ingot", quantity: 1 } },
  { id: "recipe_refine_copper", action: "refine", inputs: { copper_ore: 2, wood: 1 }, requiredStructure: "smelter", output: { kind: "resource", item: "copper_ingot", quantity: 1 } },
  { id: "recipe_refine_molybdenum", action: "refine", inputs: { molybdenum_ore: 2, wood: 1 }, requiredStructure: "smelter", output: { kind: "resource", item: "molybdenum_ingot", quantity: 1 } },
  { id: "recipe_craft_prybar", action: "craft", inputs: { titanium_ingot: 2, wood: 1 }, requiredStructure: "workshop", output: { kind: "artifact", mechanicalKind: "titanium_prybar", durability: 100 } },
  { id: "recipe_build_vault", action: "build", inputs: { stone: 20, iron_ingot: 10 }, requiredStructure: "workshop", output: { kind: "structure", structureKind: "reinforced_vault", accessPolicy: "owner_only" } },
]);

export const recipeById = (id: string): Recipe | null =>
  RECIPE_REGISTRY.find((recipe) => recipe.id === id) ?? null;
