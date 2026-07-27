import { describe, expect, it } from "vitest";
import { buildGenesis, type GenesisConfig } from "./genesis.js";

const config: GenesisConfig = {
  worldId: "world_genesis_test",
  seed: "published-seed",
  width: 16,
  height: 16,
  founder: {
    id: "inh_founder",
    displayName: "Aster",
    modelId: "test-model",
    inventory: { energy: 800, compute: 500, food: 10, water: 10 },
    traits: { curiosity: 80 },
    values: ["curiosity"],
    privateGoals: ["observe"],
  },
};

describe("buildGenesis", () => {
  it("reconstructs byte-identical state and checksums from public config", () => {
    const first = buildGenesis(config);
    const second = buildGenesis(config);
    expect(second.state).toEqual(first.state);
    expect(second.stateChecksum).toBe(first.stateChecksum);
    expect(Object.keys(first.state.inhabitants)).toEqual(["inh_founder"]);
    expect(first.state.sequence).toBe(0);
  });

  it("changes the generated world when the published seed changes", () => {
    expect(buildGenesis({ ...config, seed: "other-seed" }).stateChecksum).not.toBe(
      buildGenesis(config).stateChecksum,
    );
  });
});
