// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { createObservatoryCharacter } from "./observatory-character-model";
import type { SceneReference } from "./observatory-types";

const alphaReference = {
  refId: "AG:W001:ENT:000000000001",
  transform: {
    position: { x: 1, y: 0, z: 1 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  },
  representation: {
    kind: "articulated_entity",
    visualSeed: "abc",
    characterKey: "alpha",
    componentRefs: [],
    material: null,
  },
  activity: null,
  cameraAnchors: [],
  capabilities: {},
  epistemicLabel: "CANONICAL_FACT",
} as const satisfies SceneReference;

describe("Observatory character model", () => {
  it("builds Alpha as an interactive, articulated character with the banner silhouette", () => {
    const character = createObservatoryCharacter(alphaReference);

    expect(character.group.userData.characterKey).toBe("alpha");
    expect(character.group.userData.characterTitle).toBe("The Imperialist");
    expect(character.group.children.length).toBeGreaterThan(16);
    character.group.position.set(3, 0.24, -2);
    character.update(1);
    expect(character.group.position.x).toBe(3);
    expect(character.group.position.z).toBe(-2);
    expect(character.group.position.y).toBeGreaterThan(0.22);
  });
});
