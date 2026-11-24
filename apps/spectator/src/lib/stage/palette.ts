// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * The Stage palette — every colour the renderer draws, in one place.
 *
 * ## Why this file exists
 *
 * Colour is presentation. None of it is canonical: the engine records that a
 * tile is `forest`, not that forest is `#315f3f`. claude.md §12 requires that
 * generated media stay clearly distinguishable from canonical world actions,
 * and the cheapest way to keep that line honest is to keep every invented
 * visual value in one file that nothing canonical imports.
 *
 * The values continue the spectator's existing design language — the dark,
 * calm, cartographic palette in `app/globals.css` and the terrain colours the
 * previous viewport used — so the 3D view and the 2D chrome read as one
 * surface. Both the React layer and `terrain.ts` read from here; there is no
 * second copy of these numbers anywhere.
 *
 * Colours are plain `0xrrggbb` integers rather than `THREE.Color` instances so
 * that this module has no three.js dependency and can be unit-tested, imported
 * by React, and reasoned about without a WebGL context.
 */

/* -------------------------------------------------------------------------- */
/* Terrain                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The terrain kinds the canonical map generator emits, plus `unknown` for a
 * tile whose kind this build does not recognise. `unknown` is deliberately a
 * drab, unreadable slate: a terrain we cannot name must not be dressed up as
 * one we can.
 */
export type TerrainKind =
  | "water"
  | "plains"
  | "fertile"
  | "forest"
  | "stone"
  | "stone_deposit"
  | "barren"
  | "unknown";

export const TERRAIN_KINDS: readonly TerrainKind[] = [
  "water",
  "plains",
  "fertile",
  "forest",
  "stone",
  "stone_deposit",
  "barren",
  "unknown",
];

const TERRAIN_KIND_SET: ReadonlySet<string> = new Set<string>(TERRAIN_KINDS);

/** Narrow an arbitrary terrain string from the export to a kind we can draw. */
export function terrainKind(name: string | undefined): TerrainKind {
  return name !== undefined && TERRAIN_KIND_SET.has(name) ? (name as TerrainKind) : "unknown";
}

/**
 * Base tile colours. Carried over from the previous voxel viewport so the
 * world does not change hue when the renderer is replaced — the art direction
 * was right, only the architecture was wrong.
 */
export const TERRAIN_COLOURS: Readonly<Record<TerrainKind, number>> = {
  water: 0x24718a,
  plains: 0x6f8c52,
  fertile: 0x86a85c,
  forest: 0x315f3f,
  stone: 0x777d7f,
  stone_deposit: 0x8a8f8c,
  barren: 0x806a48,
  unknown: 0x29333a,
};

/**
 * How far a tile's colour may wander from its base, as a multiplier, driven by
 * a hash of the tile coordinate. Enough that a field of plains has texture;
 * little enough that terrain kind stays legible at a glance — a spectator must
 * never mistake jitter for a different terrain.
 */
export const TERRAIN_JITTER: Readonly<Record<TerrainKind, number>> = {
  water: 0.06,
  plains: 0.12,
  fertile: 0.11,
  forest: 0.14,
  stone: 0.1,
  stone_deposit: 0.1,
  barren: 0.12,
  unknown: 0.04,
};

/** Tile top height above the ground plane, in metres. One tile is one metre. */
export const TERRAIN_HEIGHTS: Readonly<Record<TerrainKind, number>> = {
  water: 0.72,
  plains: 0.9,
  fertile: 0.88,
  forest: 0.94,
  stone: 1.04,
  stone_deposit: 1.08,
  barren: 0.86,
  unknown: 0.8,
};

/** Surface finish per terrain. Only water is smooth enough to catch the sun. */
export const TERRAIN_ROUGHNESS: Readonly<Record<TerrainKind, number>> = {
  water: 0.24,
  plains: 0.92,
  fertile: 0.9,
  forest: 0.95,
  stone: 0.85,
  stone_deposit: 0.8,
  barren: 0.95,
  unknown: 0.98,
};

/* -------------------------------------------------------------------------- */
/* Scatter and structures                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Colours for the deterministic scatter — trees, boulders, reeds.
 *
 * These objects are **presentation only**. The canonical record says a tile is
 * forest; it does not say where the individual trees stand. See `terrain.ts`.
 */
export const SCATTER_COLOURS = {
  trunk: 0x4c3a28,
  crown: 0x2b5738,
  crownAlt: 0x35673f,
  boulder: 0x6b7173,
  reed: 0x5d7a4a,
} as const;

/** The plane the map floats on, and the horizon it fades into. */
export const VOID_COLOUR = 0x0a1219;

/* -------------------------------------------------------------------------- */
/* Sky                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Keyframe colours for the day/night cycle. `sky.ts` interpolates between them
 * as a pure function of the canonical `dayFraction`; nothing here is chosen per
 * frame or per mood.
 */
export const SKY_COLOURS = {
  /** Direct light. */
  sunNoon: 0xfff1d6,
  sunLow: 0xff9d54,
  moon: 0x93aecd,
  /** Hemisphere sky/ground fill. */
  domeNoon: 0xa9c9e1,
  domeLow: 0xd4956a,
  domeNight: 0x1b2a3c,
  bounceDay: 0x3b4a33,
  bounceNight: 0x121a20,
  /** Background and fog. */
  horizonNoon: 0x8fb4cd,
  horizonLow: 0xc2764a,
  horizonNight: 0x07131c,
} as const;

/* -------------------------------------------------------------------------- */
/* Inhabitants                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The Observatory's accent, used for the highlighted inhabitant's rim. Matches
 * `--color-amber` in globals.css.
 */
export const HIGHLIGHT_COLOUR = 0xd9a441;

/**
 * Body colour for an inhabitant, derived from a stable seed string.
 *
 * Hue is the only thing the seed moves. Saturation and lightness are fixed so
 * that no inhabitant can end up visually louder than another: the renderer must
 * not imply importance that the canonical record does not record (§11G — the
 * log describes events neutrally; the picture should too).
 */
export function inhabitantHsl(seed: string): { h: number; s: number; l: number } {
  return { h: hashString(seed) % 1, s: 0.42, l: 0.58 };
}

/**
 * Visual treatment for the three disclosure levels (cinema/types.ts).
 *
 * `envelope_only` and `unrecorded` are drawn *paler and flatter* than disclosed
 * time. This is the material half of the rule that `clips.ts` enforces on the
 * body: withheld time must look withheld. claude.md §11E classifies information
 * as observable, publicly recorded, or private; the renderer may not quietly
 * promote the third into the first.
 */
export const DISCLOSURE_TREATMENT = {
  disclosed: { saturation: 1, lightness: 1, emissive: 0 },
  envelope_only: { saturation: 0.35, lightness: 0.94, emissive: 0 },
  unrecorded: { saturation: 0.12, lightness: 0.8, emissive: 0 },
} as const;

/* -------------------------------------------------------------------------- */
/* Colour arithmetic                                                           */
/* -------------------------------------------------------------------------- */

/**
 * FNV-1a over a string, mapped to 0..1. The same hash the previous viewport
 * used for its fallback seeds, kept so inhabitant colours do not all change
 * when the renderer is replaced.
 */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0) / 0x100000000;
}

/** Linear blend between two packed colours. `t` is clamped to 0..1. */
export function mixHex(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

/** Scale a packed colour's channels, clamped to the byte range. */
export function shadeHex(hex: number, factor: number): number {
  const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  const r = clampByte(((hex >> 16) & 0xff) * factor);
  const g = clampByte(((hex >> 8) & 0xff) * factor);
  const b = clampByte((hex & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

/** `0xrrggbb` as a CSS string, for the React layer's legends and swatches. */
export function cssHex(hex: number): string {
  return `#${(hex >>> 0).toString(16).padStart(6, "0")}`;
}
