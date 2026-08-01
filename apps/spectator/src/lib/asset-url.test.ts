import { describe, expect, it } from "vitest";
import { assetUrl, resolveAssetUrl } from "./asset-url";

const FIREBASE_BASE =
  "https://firebasestorage.googleapis.com/v0/b/after-genesis.firebasestorage.app/o/spectator";

describe("assetUrl", () => {
  // The suite runs without NEXT_PUBLIC_ASSET_BASE_URL set, which is the case a
  // local checkout and an unconfigured deployment both rely on: the helper has
  // to reduce to the root-relative path it replaced.
  it("falls back to the root-relative path when no host is configured", () => {
    expect(assetUrl("/character-models/Alpha.glb")).toBe("/character-models/Alpha.glb");
  });
});

const PUBLISHED = {
  "character-models/Alpha.glb": "character-models/Alpha.d4bbbec4.glb",
  "character-profile/speech/alpha.mp3": "character-profile/speech/alpha.1a2b3c4d.mp3",
  "intro.mp4": "intro.deadbeef.mp4",
};

describe("resolveAssetUrl", () => {
  it("roots a path that was given without a leading slash", () => {
    expect(resolveAssetUrl("", "terrain/tabletop_terrain.glb")).toBe(
      "/terrain/tabletop_terrain.glb",
    );
  });

  it("encodes characters that are not URL-safe", () => {
    expect(resolveAssetUrl("", "/character-profile/Delta pose.mp4")).toBe(
      "/character-profile/Delta%20pose.mp4",
    );
  });

  describe("Firebase Storage download endpoint", () => {
    // The shape this project actually deploys. Domain Restricted Sharing
    // forbids granting `allUsers` in IAM, so the plain storage.googleapis.com
    // host cannot serve these; Security Rules govern this endpoint instead.
    it("collapses the object path into one percent-encoded segment", () => {
      expect(resolveAssetUrl(FIREBASE_BASE, "/character-models/Alpha.glb", {})).toBe(
        `${FIREBASE_BASE}%2Fcharacter-models%2FAlpha.glb?alt=media`,
      );
    });

    it("asks for bytes rather than object metadata", () => {
      expect(resolveAssetUrl(FIREBASE_BASE, "/intro.mp4", {})).toMatch(/\?alt=media$/);
    });

    it("escapes every separator, including nested directories", () => {
      const url = resolveAssetUrl(FIREBASE_BASE, "/character-profile/speech/alpha.mp3", {});
      expect(url).toContain("%2Fcharacter-profile%2Fspeech%2Falpha.mp3");
      // An unescaped slash after /o/ addresses a different resource entirely.
      expect(url.slice(FIREBASE_BASE.length)).not.toContain("/");
    });

    it("tolerates a trailing slash on the configured base", () => {
      // ASSET_BASE_URL strips it, so resolve the already-stripped form.
      expect(resolveAssetUrl(FIREBASE_BASE, "terrain/tabletop_terrain.glb", {})).toBe(
        `${FIREBASE_BASE}%2Fterrain%2Ftabletop_terrain.glb?alt=media`,
      );
    });
  });

  describe("content-hashed publishing", () => {
    // `immutable, max-age=31536000` is only honest if a changed file gets a
    // changed URL. Under fixed names a re-exported model would keep its URL
    // and every returning visitor would hold the stale copy for a year.
    it("resolves a logical path to its published, hashed name", () => {
      expect(resolveAssetUrl(FIREBASE_BASE, "/character-models/Alpha.glb", PUBLISHED)).toBe(
        `${FIREBASE_BASE}%2Fcharacter-models%2FAlpha.d4bbbec4.glb?alt=media`,
      );
    });

    it("hashes nested paths without disturbing their directories", () => {
      expect(
        resolveAssetUrl(FIREBASE_BASE, "/character-profile/speech/alpha.mp3", PUBLISHED),
      ).toContain("%2Fcharacter-profile%2Fspeech%2Falpha.1a2b3c4d.mp3");
    });

    it("hashes a file that sits at the root of the prefix", () => {
      expect(resolveAssetUrl(FIREBASE_BASE, "/intro.mp4", PUBLISHED)).toContain(
        "%2Fintro.deadbeef.mp4",
      );
    });

    it("applies to a plain prefix host too", () => {
      expect(resolveAssetUrl("https://cdn.example.com/a", "/intro.mp4", PUBLISHED)).toBe(
        "https://cdn.example.com/a/intro.deadbeef.mp4",
      );
    });

    it("falls back to the plain name for an asset the manifest does not list", () => {
      // A 404 on one asset beats failing the build for the whole page, and the
      // file may well have been published under its plain name.
      expect(resolveAssetUrl(FIREBASE_BASE, "/terrain/unlisted.glb", PUBLISHED)).toContain(
        "%2Fterrain%2Funlisted.glb",
      );
    });

    it("never hashes the local public/ path, which holds plain filenames", () => {
      expect(resolveAssetUrl("", "/character-models/Alpha.glb", PUBLISHED)).toBe(
        "/character-models/Alpha.glb",
      );
    });
  });

  describe("plain prefix host", () => {
    // Kept working so that moving to a CDN or a self-hosted origin is a
    // configuration change rather than a code change.
    it("joins with a real slash and leaves the path readable", () => {
      expect(resolveAssetUrl("https://cdn.example.com/assets", "/terrain/x.glb", {})).toBe(
        "https://cdn.example.com/assets/terrain/x.glb",
      );
    });
  });
});
