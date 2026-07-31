/**
 * World primitives: quantities, resources, terrain and coordinates (§5).
 *
 * The resource set is deliberately small. Inhabitants may combine primitives
 * into artifacts, but they cannot conjure a new physical resource by naming one
 * — every resource here has declared sources, sinks and conservation rules, and
 * the engine's conservation invariant is checked against this list.
 */
import { z } from "zod";

/**
 * A quantity of anything, as an integer in that resource's smallest unit.
 *
 * There are no fractional quantities anywhere in the world. Halving an odd
 * number of units yields a remainder that must be assigned explicitly by the
 * rule doing the halving; it may not silently become 0.5. See canonical.ts for
 * why floating point is banned.
 */
export const QuantitySchema = z.number().int().nonnegative();
export type Quantity = number;

/** A signed change in quantity. Used in ledger deltas, never in a balance. */
export const DeltaSchema = z.number().int();

/**
 * The primitive resources, expanded to include the full material encyclopedia.
 *
 * `energy` and `compute` are an inhabitant's capacity to act and allowance for
 * cognition (§11B). Both are consumed by living, which is what makes time and
 * attention genuinely scarce rather than nominally scarce.
 */
export const ResourceKindSchema = z.enum([
  "food",
  "water",
  "wood",
  "stone",
  "energy",
  "compute",
  "land_use_rights",
  "storage_capacity",
  "aluminum",
  "antimony",
  "barite",
  "beryllium",
  "coal",
  "cobalt",
  "copper",
  "gypsum",
  "halite",
  "iron_ore",
  "kaolin",
  "lead",
  "limestone",
  "lithium",
  "manganese",
  "molybdenum",
  "nickel",
  "quartz",
  "rare_earth_elements",
  "silver",
  "sulfur",
  "tantalum",
  "titanium",
  "vanadium",
  "zinc",
  // Canonical industrial materials. The older mineral names above remain valid
  // world resources; these explicit ore/ingot forms are what recipe resolution
  // consumes and produces.
  "copper_ore",
  "titanium_ore",
  "molybdenum_ore",
  "iron_ingot",
  "titanium_ingot",
  "copper_ingot",
  "molybdenum_ingot",
]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

export const RESOURCE_KINDS = ResourceKindSchema.options;

/**
 * Whether a resource is conserved under transfer.
 *
 * `energy` and `compute` are *not* conserved: they regenerate from rest and from
 * the world's compute budget, and are destroyed by use. Every other resource is
 * conserved, meaning the sum across all holders changes only through a declared
 * source (gathering) or sink (consumption, decay, construction).
 */
export const CONSERVED_RESOURCES: ReadonlySet<ResourceKind> = new Set([
  "food",
  "water",
  "wood",
  "stone",
  "land_use_rights",
  "storage_capacity",
  "aluminum",
  "antimony",
  "barite",
  "beryllium",
  "coal",
  "cobalt",
  "copper",
  "gypsum",
  "halite",
  "iron_ore",
  "kaolin",
  "lead",
  "limestone",
  "lithium",
  "manganese",
  "molybdenum",
  "nickel",
  "quartz",
  "rare_earth_elements",
  "silver",
  "sulfur",
  "tantalum",
  "titanium",
  "vanadium",
  "zinc",
  "copper_ore",
  "titanium_ore",
  "molybdenum_ore",
  "iron_ingot",
  "titanium_ingot",
  "copper_ingot",
  "molybdenum_ingot",
]);

/** A bundle of resources. Absent keys mean zero. */
export const ResourceBundleSchema = z.record(ResourceKindSchema, QuantitySchema);
export type ResourceBundle = Partial<Record<ResourceKind, Quantity>>;

export const EMPTY_BUNDLE: ResourceBundle = Object.freeze({});

/** Sum of two bundles. Pure; neither input is mutated. */
export function addBundles(a: ResourceBundle, b: ResourceBundle): ResourceBundle {
  const out: ResourceBundle = {};
  for (const kind of RESOURCE_KINDS) {
    const total = (a[kind] ?? 0) + (b[kind] ?? 0);
    if (total !== 0) out[kind] = total;
  }
  return out;
}

/**
 * `a` minus `b`, or null if `b` exceeds `a` in any resource.
 *
 * Returning null rather than a negative bundle is what enforces §15's "balances
 * cannot become negative" — callers must handle insufficiency explicitly and
 * cannot accidentally write a negative balance.
 */
export function subtractBundles(a: ResourceBundle, b: ResourceBundle): ResourceBundle | null {
  const out: ResourceBundle = {};
  for (const kind of RESOURCE_KINDS) {
    const remaining = (a[kind] ?? 0) - (b[kind] ?? 0);
    if (remaining < 0) return null;
    if (remaining !== 0) out[kind] = remaining;
  }
  return out;
}

/** True if `holder` contains at least `required` of every resource. */
export function bundleCovers(holder: ResourceBundle, required: ResourceBundle): boolean {
  return subtractBundles(holder, required) !== null;
}

/** Total units across all resources. Used for carry-weight and storage limits. */
export function bundleTotal(bundle: ResourceBundle): Quantity {
  let total = 0;
  for (const kind of RESOURCE_KINDS) total += bundle[kind] ?? 0;
  return total;
}

/** The six terrain types (§5). Terrain is immutable after map generation. */
export const TerrainSchema = z.enum([
  "plains",
  "forest",
  "stone_deposit",
  "water",
  "fertile",
  "barren",
]);
export type Terrain = z.infer<typeof TerrainSchema>;

export const TERRAINS = TerrainSchema.options;

/** Terrain an inhabitant cannot stand on. */
export const IMPASSABLE_TERRAIN: ReadonlySet<Terrain> = new Set(["water"]);

/** A tile coordinate on the world grid. */
export const CoordSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});
export type Coord = z.infer<typeof CoordSchema>;

export const coordKey = (c: Coord): string => `${c.x},${c.y}`;

export function parseCoordKey(key: string): Coord {
  const [x, y] = key.split(",");
  return { x: Number(x), y: Number(y) };
}

export const coordEquals = (a: Coord, b: Coord): boolean => a.x === b.x && a.y === b.y;

/**
 * Chebyshev distance — the number of moves needed on a grid allowing diagonals.
 * Used for travel time and for what counts as "nearby" when building an
 * inhabitant's observation.
 */
export function chebyshevDistance(a: Coord, b: Coord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Manhattan distance. Used where diagonal movement is disallowed. */
export function manhattanDistance(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
