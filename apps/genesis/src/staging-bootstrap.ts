// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { GenesisConfig, WorldState } from "@after-genesis/core";
import { computeStateChecksum } from "@after-genesis/core";
import {
  FileEventStore,
  FileStateStore,
  SystemClock,
} from "@after-genesis/persistence";
import { commitGenesis } from "@after-genesis/runtime";

export interface StagingBootstrapOptions {
  readonly worldId: string;
  readonly seed?: string;
  readonly founderName?: string;
  readonly outputDir?: string;
  readonly provenance?: {
    readonly sourceCommit: string;
    readonly deployedDigest: string;
  };
}

export interface StagingBootstrapResult {
  readonly worldId: string;
  readonly seed: string;
  readonly founderId: string;
  readonly founderName: string;
  readonly stateChecksum: string;
  readonly outputDir: string;
}

export function isStagingWorldId(worldId: string): boolean {
  return worldId.startsWith("staging-") || worldId.startsWith("test-staging-");
}

export function assertStagingWorldId(worldId: string): void {
  if (!isStagingWorldId(worldId)) {
    throw new Error(
      `Refusing action on world "${worldId}". ` +
        `Target world ID must start with "staging-" to prevent accidental mutation of production or canonical worlds.`,
    );
  }
}

export function buildStagingGenesisConfig(
  worldId: string,
  seed = `staging-seed-${Date.now()}`,
  founderName = "Staging Founder",
): GenesisConfig {
  assertStagingWorldId(worldId);
  return {
    worldId,
    seed,
    width: 64,
    height: 64,
    founder: {
      id: "inh_staging_founder",
      displayName: founderName,
      modelId: "gemini-3.6-flash",
      sex: "female",
      inventory: { energy: 800, compute: 500, food: 10, water: 10 },
      traits: { curiosity: 75, patience: 60 },
      values: ["curiosity", "continuity"],
      privateGoals: ["verify staging infrastructure resilience"],
    },
  };
}

export async function bootstrapStagingWorld(
  options: StagingBootstrapOptions,
): Promise<StagingBootstrapResult> {
  assertStagingWorldId(options.worldId);

  const outputDir = resolve(options.outputDir ?? ".worlds/staging-bootstrap");
  const config = buildStagingGenesisConfig(
    options.worldId,
    options.seed,
    options.founderName,
  );

  const eventStore = await FileEventStore.open(outputDir);
  const stateStore = await FileStateStore.open<WorldState>(outputDir, {
    checksum: computeStateChecksum,
  });
  const clock = new SystemClock();
  const provenance = options.provenance ?? {
    sourceCommit: "staging-bootstrap-local",
    deployedDigest: "staging-fixture",
  };

  const result = await commitGenesis(
    { eventStore, stateStore, clock, provenance },
    config,
  );

  return {
    worldId: config.worldId,
    seed: config.seed,
    founderId: config.founder.id,
    founderName: config.founder.displayName,
    stateChecksum: result.event.postStateChecksum,
    outputDir,
  };
}

export async function teardownStagingWorld(
  worldId: string,
  outputDir = ".worlds/staging-bootstrap",
): Promise<void> {
  assertStagingWorldId(worldId);
  const resolvedDir = resolve(outputDir);

  const eventStore = await FileEventStore.open(resolvedDir);
  const stateStore = await FileStateStore.open<WorldState>(resolvedDir, {
    checksum: computeStateChecksum,
  });
  await Promise.all([
    rm(eventStore.pathFor(worldId), { force: true }),
    rm(stateStore.pathFor(worldId), { force: true }),
    rm(resolve(resolvedDir, "audit", worldId), { recursive: true, force: true }),
  ]);
}
