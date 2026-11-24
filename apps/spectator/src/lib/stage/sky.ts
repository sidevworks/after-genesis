// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Sky — light, colour and air as a pure function of canonical time.
 *
 * ## Why this is a pure function of `dayFraction`
 *
 * The engine already decides what time it is. `WorldFrame.dayFraction` is 0..1
 * through the world day with 0 at midnight, computed from canonical sim time,
 * and the engine records a `night` flag on actions resolved in darkness. If the
 * renderer picked its own lighting mood — a warmer dusk here because the shot
 * looked better, a longer golden hour there — the picture would start
 * contradicting the record, and a spectator would have no way to tell which one
 * was true. So every value below comes from `dayFraction` and nothing else: no
 * clock, no weather, no dramatic licence. Given a tick, the sky is decided.
 *
 * That is also what makes it testable. `skyAt` returns plain numbers with no
 * three.js involvement; `applySky` is the only part that touches the scene, and
 * it only writes values it was handed.
 *
 * ## What is canonical here and what is not
 *
 * Canonical: the time of day, and therefore whether it is dark. Presentation:
 * the specific hues, the fog, the stars, the position of the moon. claude.md
 * §12 — generated media must stay distinguishable from canonical world actions.
 * Nothing in this file is ever written back to anything.
 */

import type { Color, DirectionalLight, FogExp2, HemisphereLight, PointsMaterial } from "three";
import { SKY_COLOURS, mixHex } from "./palette";

const TAU = Math.PI * 2;

/**
 * Peak solar elevation, radians. About 66°, a temperate mid-latitude summer.
 * The world's map has no latitude in its canonical record, so this is a single
 * declared constant rather than something derived — a stated presentation
 * choice, held still for every day of the world's history.
 */
export const MAX_SUN_ELEVATION = 1.16;

/** How far out the key light sits. Only affects shadow-camera framing. */
export const KEY_LIGHT_DISTANCE = 46;

/**
 * The lowest the key light is allowed to sit, radians. See `skyAt` — it is what
 * keeps shadows from flipping across the world at sunrise and sunset.
 */
export const MIN_KEY_ELEVATION = 0.16;

export type SkyPhase = "night" | "dawn" | "day" | "dusk";

export interface SkyState {
  readonly phase: SkyPhase;
  /** True while the sun is above the horizon. Agrees with the engine's `night`. */
  readonly daylight: boolean;
  /** Solar elevation in radians. Negative below the horizon. */
  readonly sunElevation: number;
  /**
   * Unit direction from the ground toward the key light. Renderer space:
   * +x east, +y up, +z south. At night this points at the moon instead, which
   * is why it is named for the role rather than for the body.
   */
  readonly keyDirection: { readonly x: number; readonly y: number; readonly z: number };
  readonly keyColour: number;
  readonly keyIntensity: number;
  readonly skyColour: number;
  readonly groundColour: number;
  readonly ambientIntensity: number;
  readonly background: number;
  readonly fogColour: number;
  readonly fogDensity: number;
  /** 0 in daylight, 1 at full dark. */
  readonly starOpacity: number;
  readonly exposure: number;
  /** Never canonical. Present so no consumer can mistake this for world state. */
  readonly derived: true;
}

/** Hermite ease between two thresholds. Continuous, and flat at both ends. */
function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(Math.max((value - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * The whole day/night cycle.
 *
 * The shape: elevation is `-cos(2π·f)` scaled, so midnight is the trough,
 * sunrise lands at f = 0.25, noon at the peak and sunset at f = 0.75. Everything
 * else is a function of that elevation — light level, colour temperature, air
 * density, stars — which is why dawn and dusk get the same warm low sun without
 * either being special-cased.
 *
 * Once the sun is down the key light becomes moonlight — dim, cool, and held
 * just above the horizon. A scene with no key at night would have no shadows
 * and would read as flat rather than as dark, and a world that cannot be seen
 * at night cannot be watched at night.
 */
export function skyAt(dayFraction: number): SkyState {
  const f = Number.isFinite(dayFraction) ? ((dayFraction % 1) + 1) % 1 : 0;

  const sunElevation = MAX_SUN_ELEVATION * -Math.cos(TAU * f);
  // Azimuth: 0 at sunrise (due east, +x), π/2 at noon (due south, +z), π at
  // sunset (due west). Renderer convention from lib/scene-adapter.ts.
  const azimuth = TAU * (f - 0.25);

  // How much of full daylight this elevation delivers. The lower threshold sits
  // just below the horizon so that first light arrives slightly before sunrise,
  // as it does in the world the map is modelled on.
  const day = smoothstep(-0.06, 0.24, sunElevation);
  // How close the sun is to the horizon while still up: the golden term.
  const golden = sunElevation > 0 ? 1 - smoothstep(0.02, 0.42, sunElevation) : 1;

  // The key light never dips below the horizon. Once the sun has set it stands
  // in for moonlight, held at a shallow elevation and still sweeping with the
  // sun's azimuth. That is a continuity choice, not an astronomical claim: a
  // key that snapped to the true antisolar point at sunset would flip every
  // shadow in the world in one frame, and a key that genuinely went below the
  // horizon would light the undersides of things. Neither is watchable, and
  // neither would tell a spectator anything the record does not already say.
  const keyElevation = Math.max(sunElevation, MIN_KEY_ELEVATION);
  const horizontal = Math.cos(keyElevation);
  const keyDirection = {
    x: Math.cos(azimuth) * horizontal,
    y: Math.sin(keyElevation),
    z: Math.sin(azimuth) * horizontal,
  };

  // Colour temperature tracks the sun's *elevation*, not the light level. They
  // are different curves on purpose: the sun is already deep orange at the
  // moment it crosses the horizon, when the light level is still near nothing.
  // Blending the moon in by light level instead would leave sunrise blue.
  const night = 1 - smoothstep(-0.2, -0.02, sunElevation);
  const warm = mixHex(SKY_COLOURS.sunNoon, SKY_COLOURS.sunLow, golden);
  const keyColour = mixHex(warm, SKY_COLOURS.moon, night);
  // Watch mode must remain readable through a whole canonical night. This is
  // deliberately still much dimmer and cooler than daylight, but strong enough
  // to preserve silhouettes, terrain edges and actor gestures on ordinary
  // laptop displays.
  const keyIntensity = 0.5 + 2.21 * day;

  const domeDay = mixHex(SKY_COLOURS.domeNoon, SKY_COLOURS.domeLow, golden);
  const horizonDay = mixHex(SKY_COLOURS.horizonNoon, SKY_COLOURS.horizonLow, golden);

  const background = mixHex(SKY_COLOURS.horizonNight, horizonDay, day);
  const starOpacity = 1 - smoothstep(-0.16, 0.06, sunElevation);

  return {
    phase: phaseOf(sunElevation, f),
    daylight: sunElevation > 0,
    sunElevation,
    keyDirection,
    keyColour,
    keyIntensity,
    skyColour: mixHex(SKY_COLOURS.domeNight, domeDay, day),
    groundColour: mixHex(SKY_COLOURS.bounceNight, SKY_COLOURS.bounceDay, day),
    ambientIntensity: 0.72 + 0.88 * day,
    background,
    fogColour: background,
    // Night air is drawn thicker. Practical as much as atmospheric: it is what
    // dissolves the edge of a 32×32 map into the dark instead of ending it at a
    // visible cliff.
    fogDensity: 0.013 + 0.006 * (1 - day),
    starOpacity,
    exposure: 1.04 + 0.34 * (1 - day),
    derived: true,
  };
}

function phaseOf(elevation: number, dayFraction: number): SkyPhase {
  if (elevation < -0.1) return "night";
  if (elevation > 0.26) return "day";
  // Between those, the sun is near the horizon. Which side of noon we are on is
  // what makes it dawn rather than dusk.
  return dayFraction < 0.5 ? "dawn" : "dusk";
}

/* -------------------------------------------------------------------------- */
/* Application                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The scene objects the sky writes to.
 *
 * Every one of these is created once by the Stage and mutated in place —
 * `Color.setHex`, not `new Color`. That is the whole reason the pure function
 * returns packed integers instead of `THREE.Color` instances: there is nothing
 * to allocate on the way from `skyAt` to the scene.
 */
export interface SkyTargets {
  readonly key: DirectionalLight;
  readonly ambient: HemisphereLight;
  /** The scene's background colour instance, mutated rather than replaced. */
  readonly background: Color;
  readonly fog: FogExp2;
  readonly starMaterial: PointsMaterial;
  /** Only `toneMappingExposure` is touched. */
  readonly renderer: { toneMappingExposure: number };
}

export function applySky(state: SkyState, targets: SkyTargets): void {
  targets.key.position.set(
    state.keyDirection.x * KEY_LIGHT_DISTANCE,
    state.keyDirection.y * KEY_LIGHT_DISTANCE,
    state.keyDirection.z * KEY_LIGHT_DISTANCE,
  );
  targets.key.color.setHex(state.keyColour);
  targets.key.intensity = state.keyIntensity;

  targets.ambient.color.setHex(state.skyColour);
  targets.ambient.groundColor.setHex(state.groundColour);
  targets.ambient.intensity = state.ambientIntensity;

  targets.background.setHex(state.background);
  targets.fog.color.setHex(state.fogColour);
  targets.fog.density = state.fogDensity;

  targets.starMaterial.opacity = state.starOpacity;
  targets.starMaterial.visible = state.starOpacity > 0.01;

  targets.renderer.toneMappingExposure = state.exposure;
}
