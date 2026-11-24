// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * The sky suite.
 *
 * The assertion that matters most here is that the sky agrees with canonical
 * time. The engine records a `night` flag on actions resolved in darkness; if
 * `skyAt` said "day" at a `dayFraction` the engine calls night, the picture
 * would be contradicting the record. Everything else — continuity across
 * midnight, monotonic light through the morning, determinism — protects the
 * property that a given tick always looks the same.
 */

import { describe, expect, it } from "vitest";
import { MAX_SUN_ELEVATION, MIN_KEY_ELEVATION, skyAt } from "./sky";

const MIDNIGHT = 0;
const SUNRISE = 0.25;
const NOON = 0.5;
const SUNSET = 0.75;

describe("the sky follows canonical time", () => {
  it("puts the sun below the horizon before dawn and after dusk", () => {
    expect(skyAt(MIDNIGHT).sunElevation).toBeLessThan(0);
    expect(skyAt(0.1).sunElevation).toBeLessThan(0);
    expect(skyAt(0.9).sunElevation).toBeLessThan(0);
    expect(skyAt(MIDNIGHT).daylight).toBe(false);
  });

  it("crosses the horizon at the quarter and three-quarter marks", () => {
    expect(skyAt(SUNRISE).sunElevation).toBeCloseTo(0, 12);
    expect(skyAt(SUNSET).sunElevation).toBeCloseTo(0, 12);
    expect(skyAt(SUNRISE + 0.02).daylight).toBe(true);
    expect(skyAt(SUNSET + 0.02).daylight).toBe(false);
  });

  it("peaks at noon", () => {
    expect(skyAt(NOON).sunElevation).toBeCloseTo(MAX_SUN_ELEVATION, 12);
    expect(skyAt(NOON).phase).toBe("day");
    expect(skyAt(NOON).daylight).toBe(true);
  });

  it("names dawn before noon and dusk after it", () => {
    expect(skyAt(SUNRISE).phase).toBe("dawn");
    expect(skyAt(SUNSET).phase).toBe("dusk");
    expect(skyAt(MIDNIGHT).phase).toBe("night");
  });
});

describe("the sky is a deterministic function of dayFraction", () => {
  it("returns identical state for identical input", () => {
    expect(skyAt(0.318)).toEqual(skyAt(0.318));
  });

  it("treats the day as periodic", () => {
    expect(skyAt(1)).toEqual(skyAt(0));
    expect(skyAt(2.4)).toEqual(skyAt(0.4));
    expect(skyAt(-0.25)).toEqual(skyAt(0.75));
  });

  it("falls back to midnight rather than producing NaN light", () => {
    expect(skyAt(Number.NaN)).toEqual(skyAt(0));
  });

  it("never emits a non-finite or out-of-gamut value", () => {
    for (let i = 0; i < 512; i += 1) {
      const state = skyAt(i / 512);
      for (const colour of [
        state.keyColour,
        state.skyColour,
        state.groundColour,
        state.background,
        state.fogColour,
      ]) {
        expect(Number.isInteger(colour)).toBe(true);
        expect(colour).toBeGreaterThanOrEqual(0);
        expect(colour).toBeLessThanOrEqual(0xffffff);
      }
      expect(Number.isFinite(state.keyIntensity)).toBe(true);
      expect(state.keyIntensity).toBeGreaterThan(0);
      expect(state.starOpacity).toBeGreaterThanOrEqual(0);
      expect(state.starOpacity).toBeLessThanOrEqual(1);
      expect(state.fogDensity).toBeGreaterThan(0);
      expect(state.derived).toBe(true);
    }
  });
});

describe("the cycle is continuous, including across midnight", () => {
  it("changes light smoothly over the whole day", () => {
    const steps = 2048;
    const jumps: string[] = [];
    let previous = skyAt(0);
    for (let i = 1; i <= steps; i += 1) {
      const current = skyAt(i / steps);
      if (Math.abs(current.keyIntensity - previous.keyIntensity) > 0.05) {
        jumps.push(`intensity at ${i / steps}`);
      }
      if (Math.abs(current.keyDirection.y - previous.keyDirection.y) > 0.02) {
        jumps.push(`key elevation at ${i / steps}`);
      }
      if (Math.abs(current.starOpacity - previous.starOpacity) > 0.05) {
        jumps.push(`stars at ${i / steps}`);
      }
      previous = current;
    }
    expect(jumps.slice(0, 8)).toEqual([]);
  });

  it("never lets the key light fall below the horizon", () => {
    // A key below the horizon would light the undersides of the voxels.
    for (let i = 0; i < 512; i += 1) {
      const state = skyAt(i / 512);
      expect(state.keyDirection.y).toBeGreaterThanOrEqual(Math.sin(MIN_KEY_ELEVATION) - 1e-9);
    }
  });

  it("keeps the key direction a unit vector", () => {
    for (let i = 0; i < 64; i += 1) {
      const d = skyAt(i / 64).keyDirection;
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 10);
    }
  });
});

describe("the sky reads as light at noon and dark at midnight", () => {
  it("is brightest at noon and dimmest at night", () => {
    expect(skyAt(NOON).keyIntensity).toBeGreaterThan(skyAt(MIDNIGHT).keyIntensity * 5);
    expect(skyAt(NOON).ambientIntensity).toBeGreaterThan(skyAt(MIDNIGHT).ambientIntensity);
  });

  it("shows stars only when the sun is down", () => {
    expect(skyAt(MIDNIGHT).starOpacity).toBe(1);
    expect(skyAt(NOON).starOpacity).toBe(0);
    expect(skyAt(SUNRISE).starOpacity).toBeLessThan(1);
  });

  it("thickens the air and lifts exposure at night", () => {
    expect(skyAt(MIDNIGHT).fogDensity).toBeGreaterThan(skyAt(NOON).fogDensity);
    expect(skyAt(MIDNIGHT).exposure).toBeGreaterThan(skyAt(NOON).exposure);
  });

  it("keeps canonical night visibly legible without making it daylight", () => {
    const midnight = skyAt(MIDNIGHT);
    const noon = skyAt(NOON);
    expect(midnight.keyIntensity).toBeGreaterThanOrEqual(0.5);
    expect(midnight.ambientIntensity).toBeGreaterThanOrEqual(0.7);
    expect(midnight.exposure).toBeGreaterThanOrEqual(1.35);
    expect(midnight.keyIntensity).toBeLessThan(noon.keyIntensity / 5);
    expect(midnight.phase).toBe("night");
  });

  it("warms the key light near the horizon and cools it at midday", () => {
    const warmth = (hex: number): number => ((hex >> 16) & 0xff) - (hex & 0xff);
    expect(warmth(skyAt(SUNRISE + 0.01).keyColour)).toBeGreaterThan(
      warmth(skyAt(NOON).keyColour),
    );
    expect(warmth(skyAt(SUNSET - 0.01).keyColour)).toBeGreaterThan(
      warmth(skyAt(NOON).keyColour),
    );
    // Moonlight is cool: more blue than red.
    expect(warmth(skyAt(MIDNIGHT).keyColour)).toBeLessThan(0);
  });

  it("brightens monotonically from first light to noon", () => {
    let previous = skyAt(0.2).keyIntensity;
    for (let f = 0.21; f <= NOON; f += 0.01) {
      const current = skyAt(f).keyIntensity;
      expect(current).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = current;
    }
  });
});
