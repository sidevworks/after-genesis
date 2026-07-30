import { describe, expect, it } from "vitest";
import { publicRunClassification } from "./run-classification";

describe("public run classification", () => {
  it("labels committed demo data as a fixture", () => {
    expect(publicRunClassification({ NEXT_PUBLIC_WORLD_SOURCE: "fixture" })).toBe(
      "DEVELOPMENT FIXTURE",
    );
  });

  it("does not infer sealed status from a live data source", () => {
    expect(publicRunClassification({ NEXT_PUBLIC_WORLD_SOURCE: "firestore" })).toBe(
      "DEVELOPMENT RUN",
    );
  });

  it("requires both an explicit sealed classification and a manifest hash", () => {
    expect(
      publicRunClassification({
        NEXT_PUBLIC_WORLD_SOURCE: "firestore",
        NEXT_PUBLIC_RUN_CLASSIFICATION: "sealed_experiment",
        NEXT_PUBLIC_GENESIS_MANIFEST_HASH: "a".repeat(64),
      }),
    ).toBe("SEALED EXPERIMENT");
  });
});
