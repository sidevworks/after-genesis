import { describe, expect, it } from "vitest";
import { HashDomain, hashValue } from "./util/hash.js";
import {
  assertSealedManifest,
  buildGenesisManifest,
  hashGenesisManifest,
} from "./experiment.js";

const digest = (value: string) => hashValue(HashDomain.GenesisManifest, value);

function manifest(
  classification: "sealed_experiment" | "development_run" = "sealed_experiment",
) {
  return buildGenesisManifest({
    worldId: "world_sealed",
    classification,
    systemPromptTemplateHash: digest("prompt"),
    worldRulesHash: digest("rules"),
    actionSchemaHash: digest("actions"),
    initialStateHash: digest("initial"),
    sourceCommit: "abc1234",
    deployedDigest: "sha256:runtime-image",
    modelIds: ["model-b", "model-a", "model-a"],
    parametersHash: digest("parameters"),
    memoryPolicyHash: digest("memory"),
    retryPolicyHash: digest("retry"),
    randomSeed: "published-seed",
    initialPopulation: 1,
    evaluationCriteria: ["new persistent state", "multi-step causal chain"],
  });
}

describe("Genesis experiment manifest", () => {
  it("fixes all human-controlled inputs and hashes them deterministically", () => {
    const first = manifest();
    const second = manifest();
    expect(first.cognition.modelIds).toEqual(["model-a", "model-b"]);
    expect(hashGenesisManifest(first)).toBe(hashGenesisManifest(second));
    expect(Object.values(first.interventionPolicy)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("does not let a development run claim to be sealed", () => {
    expect(() => assertSealedManifest(manifest("development_run"), "world_sealed")).toThrow(
      /not sealed_experiment/,
    );
  });

  it("rejects mutable local provenance on a sealed run", () => {
    const value = {
      ...manifest(),
      constitution: { ...manifest().constitution, sourceCommit: "local-uncommitted" },
    };
    expect(() => assertSealedManifest(value, "world_sealed")).toThrow(/immutable commit/);
  });
});
