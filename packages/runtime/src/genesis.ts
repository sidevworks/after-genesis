import {
  GENESIS_PREV_HASH,
  buildGenesis,
  sealEvent,
  type CanonicalEvent,
  type AtomicCanonicalStore,
  type Clock,
  type EventStore,
  type GenesisConfig,
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
): Promise<GenesisResult> {
  const head = await deps.eventStore.headSequence(config.worldId);
  if (head !== -1) {
    throw new Error(`world ${config.worldId} already has canonical history`);
  }

  const built = buildGenesis(config);
  const event = sealEvent({
    worldId: built.config.worldId,
    sequence: 0,
    simTime: 0,
    realTimestamp: deps.clock.nowIso(),
    actor: null,
    type: "genesis",
    inputs: { genesis: built.config },
    resolution: {
      founderId: built.config.founder.id,
      founderLocation: built.state.inhabitants[built.config.founder.id]?.location ?? null,
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
