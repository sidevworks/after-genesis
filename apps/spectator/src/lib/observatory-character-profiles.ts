// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Visual identities for the original Genesis cohort.
 *
 * These are Observatory-only presentation profiles. They deliberately derive
 * from the stable canonical inhabitant ids rather than names, traits, or any
 * private cognition, so a rename can never change an inhabitant's appearance.
 */
export const PROGENITOR_CHARACTER_KEYS = [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
  "theta",
  "iota",
  "kappa",
] as const;

export type ProgenitorCharacterKey = (typeof PROGENITOR_CHARACTER_KEYS)[number];

export type CharacterProp =
  | "banner"
  | "tablet"
  | "vials"
  | "cache"
  | "lantern"
  | "crystal"
  | "tool"
  | "heart"
  | "trade_cube"
  | "scope";

export interface ObservatoryCharacterProfile {
  readonly key: ProgenitorCharacterKey;
  readonly title: string;
  readonly armour: number;
  readonly accent: number;
  readonly glow: number;
  readonly prop: CharacterProp;
  readonly cape: boolean;
}

/** The palette and silhouette are matched to the supplied robot reference sheet. */
export const PROGENITOR_CHARACTER_PROFILES: Readonly<
  Record<ProgenitorCharacterKey, ObservatoryCharacterProfile>
> = {
  alpha: { key: "alpha", title: "The Imperialist", armour: 0x1b1a1d, accent: 0xa92d27, glow: 0xff4f3e, prop: "banner", cape: true },
  beta: { key: "beta", title: "The Utopian Architect", armour: 0xd8e0e0, accent: 0x238eb8, glow: 0x42d9ff, prop: "tablet", cape: false },
  gamma: { key: "gamma", title: "The Mad Alchemist", armour: 0x292d2a, accent: 0x6fae31, glow: 0xa9ff34, prop: "vials", cape: false },
  delta: { key: "delta", title: "The Hedonistic Consumer", armour: 0xb77a17, accent: 0xf0bc38, glow: 0xffd45e, prop: "cache", cape: false },
  epsilon: { key: "epsilon", title: "The Paranoid Prepper", armour: 0x292530, accent: 0x8857a7, glow: 0xdf7cff, prop: "lantern", cape: false },
  zeta: { key: "zeta", title: "The Religious Zealot", armour: 0xe1ded2, accent: 0xbe9135, glow: 0x4dbfff, prop: "crystal", cape: false },
  eta: { key: "eta", title: "The Saboteur", armour: 0x242426, accent: 0xba5d1d, glow: 0xff8a2e, prop: "tool", cape: false },
  theta: { key: "theta", title: "The Altruistic Healer", armour: 0xe7d9df, accent: 0xe77bae, glow: 0xff9bda, prop: "heart", cape: false },
  iota: { key: "iota", title: "The Monopolist Trader", armour: 0x1d3437, accent: 0x138d9e, glow: 0x35e5e6, prop: "trade_cube", cape: false },
  kappa: { key: "kappa", title: "The Archivist", armour: 0xd9d7ce, accent: 0x6b7074, glow: 0x70d8ff, prop: "scope", cape: false },
};

export function characterKeyForCanonicalId(value: unknown): ProgenitorCharacterKey | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  for (const key of PROGENITOR_CHARACTER_KEYS) {
    if (normalized === `inh_${String(PROGENITOR_CHARACTER_KEYS.indexOf(key) + 1).padStart(2, "0")}_${key}`) {
      return key;
    }
  }
  return null;
}

export function characterProfileFor(
  key: ProgenitorCharacterKey | null | undefined,
): ObservatoryCharacterProfile | null {
  return key === null || key === undefined ? null : PROGENITOR_CHARACTER_PROFILES[key];
}
