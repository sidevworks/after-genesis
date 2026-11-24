// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import * as THREE from "three";
import type { SceneReference } from "./observatory-types";

export interface BuildingConstructionState {
  readonly active: boolean;
  readonly progress: number;
}

export interface ObservatoryBuildingVisual {
  readonly group: THREE.Group;
  update(elapsedSeconds: number): void;
  dispose(): void;
}

export type BuildingMaterialHint = "wood" | "metal" | "stone" | "default";

export interface BuildingMaterialProfile {
  readonly wall: number;
  readonly timber: number;
  readonly stone: number;
}

const BUILD_PRIMITIVES = new Set(["build", "building", "construction", "construct"]);

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Construction can be attached to the structure itself or to an acting entity
 * whose disclosed target is the structure. Unknown progress stays visibly
 * active at the earliest construction stage rather than inventing completion.
 */
export function buildingConstructionState(
  building: SceneReference,
  references: readonly SceneReference[],
): BuildingConstructionState {
  const activity = [building, ...references].find((candidate) => {
    if (candidate.activity === null) return false;
    const primitive = candidate.activity.primitive.toLowerCase();
    return (
      BUILD_PRIMITIVES.has(primitive) &&
      (candidate.refId === building.refId ||
        candidate.activity.targetRefs.includes(building.refId))
    );
  })?.activity;

  if (activity === null || activity === undefined) return { active: false, progress: 1 };
  return {
    active: true,
    progress:
      typeof activity.progress === "number" && Number.isFinite(activity.progress)
        ? clamp01(activity.progress)
        : 0,
  };
}

function material(
  colour: number,
  options: THREE.MeshStandardMaterialParameters = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: colour,
    roughness: 0.82,
    metalness: 0.02,
    ...options,
  });
}

export function getBuildingMaterial(
  structureKind: string,
  primaryResource?: string,
): THREE.MeshStandardMaterial {
  const resource = String(primaryResource ?? "").toLowerCase();
  const kind = structureKind.toLowerCase();
  if (kind.includes("forge") || kind.includes("workshop") || /(iron|copper|metal)/.test(resource)) {
    return material(0x4a5568, { roughness: 0.3, metalness: 0.8 });
  }
  if (/(wood|timber|log)/.test(resource)) {
    return material(0x744210, { roughness: 0.9, metalness: 0 });
  }
  return material(0xa0aec0, { roughness: 0.7, metalness: 0.1 });
}

function detectMaterialHint(reference: SceneReference): BuildingMaterialHint {
  const raw = String(reference.representation.material ?? "");
  const material = raw.toLowerCase();
  if (material.includes("iron") || material.includes("copper") || material.includes("metal")) {
    return "metal";
  }
  if (
    material.includes("wood") ||
    material.includes("timber") ||
    material.includes("log")
  ) {
    return "wood";
  }
  if (material.includes("stone") || material.includes("rock") || material.includes("marble")) {
    return "stone";
  }
  return "default";
}

function resolveBuildingMaterials(reference: SceneReference): BuildingMaterialProfile {
  const hint = detectMaterialHint(reference);
  if (hint === "metal") {
    return {
      wall: 0x4a5568,
      timber: 0x5b5d66,
      stone: 0x6e7380,
    };
  }
  if (hint === "wood") {
    return {
      wall: 0x744210,
      timber: 0x8b5a2b,
      stone: 0x9b7652,
    };
  }
  if (hint === "stone") {
    return {
      wall: 0x8f7f73,
      timber: 0x564737,
      stone: 0x6f6b74,
    };
  }
  return {
    wall: 0x9b7652,
    timber: 0x4e3523,
    stone: 0x777d80,
  };
}

/**
 * Creates recognizable, low-poly building geometry for the Observatory canvas.
 * The geometry is a visual projection only: canonical position and disclosed
 * activity progress decide placement and staging.
 */
export function createObservatoryBuildingVisual(
  reference: SceneReference,
  references: readonly SceneReference[],
): ObservatoryBuildingVisual {
  const group = new THREE.Group();
  const materialProfile = resolveBuildingMaterials(reference);
  group.name = `observatory-building:${reference.refId}`;
  group.userData.refId = reference.refId;
  group.position.set(
    reference.transform.position.x,
    reference.transform.position.y,
    reference.transform.position.z,
  );
  // Structures occupy a single canonical tile. Keep the richer house geometry
  // inside that footprint so neighbouring settlement tiles remain readable.
  group.scale.setScalar(0.42);

  const state = buildingConstructionState(reference, references);
  const wall = material(materialProfile.wall);
  const timber = material(materialProfile.timber);
  const stone = material(materialProfile.stone);
  const roof = material(0x6f382d, { roughness: 0.92 });
  const glass = material(0xffc75e, {
    emissive: 0x6b3c0b,
    emissiveIntensity: 0.75,
  });
  const scaffold = material(0xd9b36c, {
    transparent: true,
    opacity: 0.82,
  });
  const guide = material(0x56d7e8, {
    emissive: 0x164d57,
    transparent: true,
    opacity: 0.58,
  });
  const ownedMaterials = [wall, timber, stone, roof, glass, scaffold, guide];
  const ownedGeometries: THREE.BufferGeometry[] = [];
  const constructionParts: Array<{ mesh: THREE.Mesh; threshold: number }> = [];

  const addBox = (
    size: readonly [number, number, number],
    position: readonly [number, number, number],
    source: THREE.Material,
    threshold: number,
  ): THREE.Mesh => {
    const geometry = new THREE.BoxGeometry(...size);
    ownedGeometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, source);
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    constructionParts.push({ mesh, threshold });
    return mesh;
  };

  // Foundation and framed walls leave an unmistakable front doorway.
  addBox([3.4, 0.28, 2.8], [0, 0.14, 0], stone, 0.08);
  addBox([0.34, 2.25, 2.65], [-1.52, 1.35, 0], wall, 0.22);
  addBox([0.34, 2.25, 2.65], [1.52, 1.35, 0], wall, 0.34);
  addBox([2.7, 2.25, 0.3], [0, 1.35, 1.25], wall, 0.46);
  addBox([0.95, 2.25, 0.3], [-1.03, 1.35, -1.25], wall, 0.53);
  addBox([0.95, 2.25, 0.3], [1.03, 1.35, -1.25], wall, 0.6);
  addBox([0.72, 0.72, 0.12], [0.92, 1.48, -1.42], glass, 0.66);
  addBox([0.78, 1.72, 0.16], [0, 1.02, -1.43], timber, 0.7);

  // A pitched roof reads as a home from every camera angle.
  const roofLeft = addBox([2.2, 0.22, 3.35], [-0.78, 2.72, 0], roof, 0.78);
  roofLeft.rotation.z = -Math.PI / 4;
  const roofRight = addBox([2.2, 0.22, 3.35], [0.78, 2.72, 0], roof, 0.86);
  roofRight.rotation.z = Math.PI / 4;
  addBox([0.42, 1.25, 0.42], [0.88, 3.18, 0.48], stone, 0.94);

  const temporary: THREE.Mesh[] = [];
  if (state.active) {
    // Four luminous stakes provide exact placement feedback before walls rise.
    for (const [x, z] of [
      [-1.85, -1.55],
      [1.85, -1.55],
      [-1.85, 1.55],
      [1.85, 1.55],
    ] as const) {
      const geometry = new THREE.BoxGeometry(0.09, 0.7, 0.09);
      ownedGeometries.push(geometry);
      const stake = new THREE.Mesh(geometry, guide);
      stake.position.set(x, 0.35, z);
      group.add(stake);
      temporary.push(stake);
    }
    // Scaffold rails flank the structure while work remains in progress.
    for (const x of [-1.92, 1.92]) {
      for (const z of [-1.32, 1.32]) {
        const geometry = new THREE.BoxGeometry(0.09, 2.8, 0.09);
        ownedGeometries.push(geometry);
        const pole = new THREE.Mesh(geometry, scaffold);
        pole.position.set(x, 1.4, z);
        group.add(pole);
        temporary.push(pole);
      }
      for (const y of [0.8, 1.75]) {
        const geometry = new THREE.BoxGeometry(0.1, 0.1, 2.72);
        ownedGeometries.push(geometry);
        const rail = new THREE.Mesh(geometry, scaffold);
        rail.position.set(x, y, 0);
        group.add(rail);
        temporary.push(rail);
      }
    }
  }

  for (const part of constructionParts) {
    part.mesh.visible = !state.active || state.progress >= part.threshold;
  }

  return {
    group,
    update(elapsedSeconds) {
      if (!state.active) return;
      const pulse = 0.9 + Math.sin(elapsedSeconds * 4) * 0.1;
      for (let index = 0; index < 4; index += 1) {
        temporary[index]?.scale.setScalar(pulse);
      }
      // Give the latest placed component a subtle settling motion.
      const latest = constructionParts
        .filter((part) => part.mesh.visible)
        .at(-1)?.mesh;
      if (latest) latest.scale.y = 0.97 + Math.sin(elapsedSeconds * 5) * 0.03;
    },
    dispose() {
      for (const geometry of ownedGeometries) geometry.dispose();
      for (const ownedMaterial of ownedMaterials) ownedMaterial.dispose();
    },
  };
}
