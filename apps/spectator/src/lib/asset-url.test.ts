import { describe, expect, it } from "vitest";
import { assetUrl } from "./asset-url";

describe("assetUrl", () => {
  // The suite runs without NEXT_PUBLIC_ASSET_BASE_URL set, which is the case a
  // local checkout and the current deployment both rely on: the helper has to
  // reduce to the root-relative path it replaced.
  it("falls back to the root-relative path when no host is configured", () => {
    expect(assetUrl("/character-models/Alpha.glb")).toBe("/character-models/Alpha.glb");
  });

  it("roots a path that was given without a leading slash", () => {
    expect(assetUrl("terrain/tabletop_terrain.glb")).toBe("/terrain/tabletop_terrain.glb");
  });

  it("encodes characters that are not URL-safe", () => {
    expect(assetUrl("/character-profile/Delta pose.mp4")).toBe(
      "/character-profile/Delta%20pose.mp4",
    );
  });
});
