import {
  FOUNDING_COHORT_SIZE,
  HashDomain,
  buildGenesis,
  buildGenesisManifest,
  computeStateChecksum,
  hashValue,
  type GenesisConfig,
  type WorldState,
} from "@after-genesis/core";
import {
  FixedClock,
  MemoryEventStore,
  MemoryStateStore,
} from "@after-genesis/persistence";
import { describe, expect, it } from "vitest";
import { commitGenesis } from "./genesis.js";

const WORLD = "world_cohort";
const SEED = "cohort-seed";
const COMMIT = "abc1234";
const DIGEST = "sha256:runtime-image";
const digest = (value: string) => hashValue(HashDomain.GenesisManifest, value);

function progenitor(index: number) {
  return {
    id: `inh_${String(index).padStart(2, "0")}`,
    displayName: `P${index}`,
    modelId: "test-model",
    sex: index % 2 === 0 ? ("female" as const) : ("male" as const),
    inventory: { energy: 100, compute: 100 },
    traits: { curiosity: 50 },
    values: ["curiosity"],
    privateGoals: ["observe"],
  };
}

/** A Genesis config seeding `size` inhabitants: one founder plus the rest. */
function configFor(size: number): GenesisConfig {
  return {
    worldId: WORLD,
    seed: SEED,
    width: 16,
    height: 16,
    founder: progenitor(1),
    inhabitants: Array.from({ length: size - 1 }, (_, i) => progenitor(i + 2)),
  } as GenesisConfig;
}

function deps() {
  return {
    eventStore: new MemoryEventStore(),
    stateStore: new MemoryStateStore<WorldState>({ checksum: computeStateChecksum }),
    clock: new FixedClock(),
    provenance: { sourceCommit: COMMIT, deployedDigest: DIGEST },
  };
}

/**
 * A manifest that agrees with the config in every respect the other checks
 * examine — world, seed, population, state hash, models, provenance. Only the
 * cohort-size rule can reject it, so a failure here is that rule and not an
 * incidental mismatch.
 */
function consistentManifest(config: GenesisConfig, classification: "sealed_experiment" | "development_run") {
  const built = buildGenesis(config);
  return buildGenesisManifest({
    worldId: WORLD,
    classification,
    systemPromptTemplateHash: digest("prompt"),
    worldRulesHash: digest("rules"),
    actionSchemaHash: digest("actions"),
    initialStateHash: built.stateChecksum,
    sourceCommit: COMMIT,
    deployedDigest: DIGEST,
    modelIds: ["test-model"],
    parametersHash: digest("parameters"),
    memoryPolicyHash: digest("memory"),
    retryPolicyHash: digest("retry"),
    randomSeed: SEED,
    initialPopulation: Object.keys(built.state.inhabitants).length,
    evaluationCriteria: ["new persistent state"],
  });
}

describe("sealed Genesis requires the declared founding cohort (§1)", () => {
  it("commits when exactly the ten Progenitors are seeded", async () => {
    const config = configFor(FOUNDING_COHORT_SIZE);
    const result = await commitGenesis(
      deps(),
      config,
      consistentManifest(config, "sealed_experiment"),
    );

    expect(Object.keys(result.state.inhabitants)).toHaveLength(FOUNDING_COHORT_SIZE);
    expect(result.event.sequence).toBe(0);
  });

  it("refuses a sealed run that seeds fewer than the cohort", async () => {
    const config = configFor(3);
    await expect(
      commitGenesis(deps(), config, consistentManifest(config, "sealed_experiment")),
    ).rejects.toThrow(/must seed exactly 10 Progenitors/);
  });

  it("refuses a sealed run that seeds more than the cohort", async () => {
    const config = configFor(FOUNDING_COHORT_SIZE + 1);
    await expect(
      commitGenesis(deps(), config, consistentManifest(config, "sealed_experiment")),
    ).rejects.toThrow(/must seed exactly 10 Progenitors/);
  });

  it("refuses the single founder the specification used to describe", async () => {
    // The regression this rule exists for. Every document said "exactly one
    // founder" while the code seeded ten, and nothing enforced either number.
    const config = configFor(1);
    await expect(
      commitGenesis(deps(), config, consistentManifest(config, "sealed_experiment")),
    ).rejects.toThrow(/must seed exactly 10 Progenitors/);
  });

  it("leaves development runs free to seed any legal size", async () => {
    // Rehearsals and soak tests seed three routinely: cheaper, same mechanics.
    // The cohort rule constrains what may be *called* sealed, not what may run.
    const config = configFor(3);
    const result = await commitGenesis(
      deps(),
      config,
      consistentManifest(config, "development_run"),
    );

    expect(Object.keys(result.state.inhabitants)).toHaveLength(3);
  });

  it("leaves an unlabelled Genesis free to seed any legal size", async () => {
    const result = await commitGenesis(deps(), configFor(2));
    expect(Object.keys(result.state.inhabitants)).toHaveLength(2);
  });
});
