// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import {
  FOUNDING_COHORT_SIZE,
  GENESIS_PREV_HASH,
  GenesisManifestSchema,
  assertSealedManifest,
  buildGenesis,
  hashGenesisManifest,
  sealEvent,
  type CanonicalEvent,
  type AtomicCanonicalStore,
  type Clock,
  type EventStore,
  type GenesisConfig,
  type GenesisManifest,
  type StateStore,
  type WorldState,
} from "@after-genesis/core";

export interface GenesisDependencies {
  readonly eventStore: EventStore;
  readonly stateStore: StateStore<WorldState>;
  readonly atomicStore?: AtomicCanonicalStore<WorldState>;
  readonly clock: Clock;
  readonly provenance: {
    readonly sourceCommit: string;
    readonly deployedDigest: string;
  };
}

export interface GenesisResult {
  readonly event: CanonicalEvent;
  readonly state: WorldState;
}

/**
 * Commit the unique sequence-zero event and its materialised state.
 *
 * Refuses a non-empty log. Genesis is never an update or reset operation.
 */
export async function commitGenesis(
  deps: GenesisDependencies,
  config: GenesisConfig,
  manifest?: GenesisManifest,
): Promise<GenesisResult> {
  const head = await deps.eventStore.headSequence(config.worldId);
  if (head !== -1) {
    throw new Error(`world ${config.worldId} already has canonical history`);
  }

  const built = buildGenesis(config);
  const parsedManifest =
    manifest === undefined ? null : GenesisManifestSchema.parse(manifest);
  if (parsedManifest !== null) {
    if (parsedManifest.worldId !== built.config.worldId) {
      throw new Error(
        `manifest world ${parsedManifest.worldId} does not match ${built.config.worldId}`,
      );
    }
    if (parsedManifest.classification === "sealed_experiment") {
      assertSealedManifest(parsedManifest, built.config.worldId);
      // §1: a sealed experiment starts with the ten Progenitors and no other
      // number. The manifest/state agreement below would happily certify a
      // three-founder run as sealed, because it only checks that the manifest
      // describes what was built — internal consistency, not the constitution.
      // The cohort size decides what the experiment can be said to have shown,
      // it cannot be revised after sequence zero, and the world runs once.
      const population = Object.keys(built.state.inhabitants).length;
      if (population !== FOUNDING_COHORT_SIZE) {
        throw new Error(
          `a sealed experiment must seed exactly ${FOUNDING_COHORT_SIZE} Progenitors (§1); ` +
            `this Genesis builds ${population}. Seed the declared cohort, or classify the run ` +
            `as development_run.`,
        );
      }
      if (parsedManifest.constitution.initialStateHash !== built.stateChecksum) {
        throw new Error("sealed manifest initial-state hash does not match built Genesis state");
      }
      if (
        parsedManifest.genesis.randomSeed !== built.config.seed ||
        parsedManifest.genesis.initialPopulation !==
          Object.keys(built.state.inhabitants).length
      ) {
        throw new Error("sealed manifest Genesis seed or population does not match built state");
      }
      const configuredModels = [
        built.config.founder.modelId,
        ...(built.config.inhabitants ?? []).map((inhabitant) => inhabitant.modelId),
      ];
      const manifestModels = new Set(parsedManifest.cognition.modelIds);
      if (configuredModels.some((modelId) => !manifestModels.has(modelId))) {
        throw new Error("sealed manifest does not declare every configured cognition model");
      }
      if (
        parsedManifest.constitution.sourceCommit !== deps.provenance.sourceCommit ||
        parsedManifest.constitution.deployedDigest !== deps.provenance.deployedDigest
      ) {
        throw new Error("sealed manifest provenance does not match the committing runtime");
      }
    }
  }
  const event = sealEvent({
    worldId: built.config.worldId,
    sequence: 0,
    simTime: 0,
    realTimestamp: deps.clock.nowIso(),
    actor: null,
    type: "genesis",
    inputs: {
      genesis: built.config,
      experiment:
        parsedManifest === null
          ? {
              classification: "development_run",
              manifest: null,
              manifestHash: null,
            }
          : {
              classification: parsedManifest.classification,
              manifest: parsedManifest,
              manifestHash: hashGenesisManifest(parsedManifest),
            },
    },
    resolution: {
      founderId: built.config.founder.id,
      founderLocation: built.state.inhabitants[built.config.founder.id]?.location ?? null,
      inhabitantIds: Object.keys(built.state.inhabitants).sort(),
    },
    visibility: { kind: "public" },
    preStateChecksum: built.emptyStateChecksum,
    postStateChecksum: built.stateChecksum,
    provenance: {
      sourceCommit: deps.provenance.sourceCommit,
      deployedDigest: deps.provenance.deployedDigest,
      modelRequestHash: null,
      modelResponseHash: null,
      modelId: null,
    },
    schemaVersion: 1,
    prevHash: GENESIS_PREV_HASH,
  });

  if (deps.atomicStore !== undefined) {
    await deps.atomicStore.commit(event, built.state, 0, built.stateChecksum);
  } else {
    await deps.eventStore.append(event, 0);
    await deps.stateStore.save(
      built.config.worldId,
      built.state,
      0,
      built.stateChecksum,
    );
  }
  return { event, state: built.state };
}
