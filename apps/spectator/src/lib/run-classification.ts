// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
export type PublicRunClassification =
  | "SEALED EXPERIMENT"
  | "DEVELOPMENT RUN"
  | "DEVELOPMENT FIXTURE";

/**
 * A hash chain proves integrity, not experimental status. The UI claims a
 * sealed experiment only when deployment publishes both the sealed
 * classification and the sequence-zero manifest hash.
 */
export function publicRunClassification(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PublicRunClassification {
  const source = env.NEXT_PUBLIC_WORLD_SOURCE ?? "fixture";
  const classification = env.NEXT_PUBLIC_RUN_CLASSIFICATION;
  const manifestHash = env.NEXT_PUBLIC_GENESIS_MANIFEST_HASH ?? "";
  if (
    source === "firestore" &&
    classification === "sealed_experiment" &&
    /^[0-9a-f]{64}$/.test(manifestHash)
  ) {
    return "SEALED EXPERIMENT";
  }
  return source === "fixture" ? "DEVELOPMENT FIXTURE" : "DEVELOPMENT RUN";
}
