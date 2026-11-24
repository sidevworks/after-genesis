// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
export type AssetCategory = "structure" | "artifact";

export interface ObservatoryAssetDescriptor {
  modelUrl: string;
  scale: [number, number, number];
  yOffset: number;
}

const ASSET_CATEGORY_DEFAULTS: Record<AssetCategory, ObservatoryAssetDescriptor> = {
  structure: {
    modelUrl: "/asset-library/structures/fallback.glb",
    scale: [0.95, 0.95, 0.95],
    yOffset: 0,
  },
  artifact: {
    modelUrl: "/asset-library/artifacts/fallback.glb",
    scale: [0.55, 0.55, 0.55],
    yOffset: 0.32,
  },
} as const;

export interface StructureAssetDescriptor extends ObservatoryAssetDescriptor {}

export interface ArtifactAssetDescriptor extends ObservatoryAssetDescriptor {}

type MatchRule = { match: readonly string[]; descriptor: ObservatoryAssetDescriptor };

const normalizeKind = (kind: string | null | undefined): string => kind?.trim().toLowerCase() ?? "";

const STRUCTURE_MATCHES: ReadonlyArray<MatchRule> = [
  {
    match: ["storehouse", "granary", "barn", "silo", "store"],
    descriptor: {
      modelUrl: "/asset-library/structures/storehouse.glb",
      scale: [1.1, 1.1, 1.1],
      yOffset: 0,
    },
  },
  {
    match: ["shelter", "home", "house", "hut", "habitat"],
    descriptor: {
      modelUrl: "/asset-library/structures/shelter.glb",
      scale: [0.95, 0.95, 0.95],
      yOffset: 0,
    },
  },
  {
    match: ["workshop", "assembly", "forge", "hall", "factory"],
    descriptor: {
      modelUrl: "/asset-library/structures/workshop.glb",
      scale: [1.02, 1.02, 1.02],
      yOffset: 0,
    },
  },
  {
    match: ["bridge", "causeway", "crossing"],
    descriptor: {
      modelUrl: "/asset-library/structures/bridge.glb",
      scale: [0.9, 0.9, 0.9],
      yOffset: 0,
    },
  },
  {
    match: ["well", "water", "fountain", "wellhouse"],
    descriptor: {
      modelUrl: "/asset-library/structures/well.glb",
      scale: [0.9, 0.9, 0.9],
      yOffset: 0,
    },
  },
];

function findMatch(rules: readonly MatchRule[], normalised: string): ObservatoryAssetDescriptor | null {
  const exact = rules.find((entry) =>
    entry.match.some(
      (candidate) => normalised === candidate || normalised.includes(candidate) || candidate.includes(normalised),
    ),
  );
  return exact?.descriptor ?? null;
}

/**
 * Maps canonical kind values to optional GLB assets for Observatory.
 */
export function resolveObservatoryAsset(
  kind: string | null | undefined,
  category: AssetCategory = "structure",
): ObservatoryAssetDescriptor {
  const normalised = normalizeKind(kind);
  // The checked-in library currently has a single generic artifact model. Do
  // not manufacture a dynamic URL here: a missing GLB becomes a visible loader
  // error in the Observatory. Specific artifact assets can be added alongside
  // this catalogue before their match rules are enabled.
  const matches = category === "artifact" ? [] : STRUCTURE_MATCHES;
  const base = findMatch(matches, normalised);
  const descriptor = base ?? ASSET_CATEGORY_DEFAULTS[category];
  if (base !== null || normalised === "" || normalised === "artifact") {
    return {
      ...descriptor,
    };
  }

  return { ...descriptor };
}

/**
 * Back-compat for existing structure callsites.
 */
export function resolveStructureAsset(kind: string | null | undefined): StructureAssetDescriptor {
  return resolveObservatoryAsset(kind, "structure");
}

/**
 * Resolve an artifact mesh for `ASM` (artifact) references by kind.
 */
export function resolveArtifactAsset(kind: string | null | undefined): ArtifactAssetDescriptor {
  return resolveObservatoryAsset(kind, "artifact");
}
