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
    sex: "female",
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

  it("creates additional independent inhabitants deterministically", () => {
    const built = buildGenesis({
      ...config,
      inhabitants: [
        {
          id: "inh_ember",
          displayName: "Ember",
          sex: "male",
          modelId: "test-model",
          inventory: { energy: 800, compute: 500, food: 10, water: 10 },
          traits: { patience: 80 },
          values: ["careful observation"],
          privateGoals: ["learn from others"],
        },
      ],
    });

    expect(Object.keys(built.state.inhabitants).sort()).toEqual([
      "inh_ember",
      "inh_founder",
    ]);
    expect(built.state.inhabitants.inh_ember?.privateGoals).toEqual(["learn from others"]);
  });

  it("places every Genesis inhabitant on passable land", () => {
    const built = buildGenesis({
      ...config,
      width: 64,
      height: 64,
      inhabitants: Array.from({ length: 10 }, (_, index) => ({
        id: `inh_genesis_${index}`,
        displayName: `Genesis ${index}`,
        sex: index % 2 === 0 ? "female" : "male",
        modelId: "test-model",
        inventory: { energy: 800, compute: 500, food: 10, water: 10 },
      })),
    });

    for (const inhabitant of Object.values(built.state.inhabitants)) {
      const tile = built.state.map.terrain[
        inhabitant.location.y * built.state.map.width + inhabitant.location.x
      ];
      expect(tile).toBeDefined();
      expect(tile).not.toBe("water");
    }
  });

  it("rejects duplicate Genesis inhabitant ids", () => {
    expect(() =>
      buildGenesis({
        ...config,
        inhabitants: [
          {
            ...config.founder,
            displayName: "Duplicate",
          },
        ],
      }),
    ).toThrow("Genesis inhabitant ids must be unique");
  });
});
