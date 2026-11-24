// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { SceneDescription, SceneReference } from "@/lib/observatory-types";
import { resolveArtifactAsset, resolveStructureAsset } from "@/lib/observatory-asset-catalog";
import { ObservatoryActionEffects } from "@/lib/observatory-action-effects";
import { createObservatoryBuildingVisual } from "@/lib/observatory-building-visual";
import { createObservatoryCharacter, type ObservatoryCharacterModel } from "@/lib/observatory-character-model";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { assetUrl } from "@/lib/asset-url";

type ViewMode = "overview" | "first-person" | "third-person";

const TERRAIN: Record<string, number> = {
  water: 0x236b83,
  plains: 0x66824b,
  fertile: 0x7ea557,
  forest: 0x2d593a,
  stone: 0x747b80,
  stone_deposit: 0x838a8e,
  barren: 0x776143,
};

const TERRAIN_ASSET_URL = assetUrl("/terrain/tabletop_terrain.glb");

type AssetLoadResult = {
  scene: THREE.Object3D;
};

const modelAssetCache = new Map<string, Promise<AssetLoadResult | null>>();

function loadAssetModel(url: string): Promise<AssetLoadResult | null> {
  const cached = modelAssetCache.get(url);
  if (cached !== undefined) return cached;

  // Kenney's source GLBs refer to a sibling `Textures/colormap.png`. The
  // published library deliberately keeps its commercial and industrial colour
  // maps separate, so resolve that relative reference to the matching asset.
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((resourceUrl) =>
    resourceUrl.endsWith("Textures/colormap.png")
      ? url.endsWith("/well.glb")
        ? "/asset-library/textures/industrial-colormap.png"
        : "/asset-library/textures/commercial-colormap.png"
      : resourceUrl,
  );
  const loader = new GLTFLoader(manager);
  const loading = new Promise<AssetLoadResult | null>((resolve) => {
    loader.load(
      encodeURI(url),
      (gltf) => resolve({ scene: gltf.scene }),
      undefined,
      () => resolve(null),
    );
  });

  modelAssetCache.set(url, loading);
  return loading;
}

function terrainMaterialFromAsset(root: THREE.Object3D, name: string): THREE.MeshStandardMaterial | null {
  let found: THREE.MeshStandardMaterial | null = null;
  root.traverse((node) => {
    if (found !== null || !(node instanceof THREE.Mesh)) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    const candidate = materials.find((material) => material.name === name && material instanceof THREE.MeshStandardMaterial);
    if (candidate instanceof THREE.MeshStandardMaterial) found = candidate;
  });
  return found;
}

function cloneTerrainMaterial(source: THREE.MeshStandardMaterial, tint: number): THREE.MeshStandardMaterial {
  const clone = source.clone();
  clone.color.multiply(new THREE.Color(tint));
  clone.needsUpdate = true;
  return clone;
}

function terrainNoise(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return (hash >>> 0) / 0x1_0000_0000;
}

function placeTerrainRock(
  world: THREE.Scene,
  template: THREE.Object3D,
  position: THREE.Vector3,
  groundY: number,
  targetHeight: number,
): void {
  const prop = template.clone(true);
  prop.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.castShadow = true;
    node.receiveShadow = true;
    node.material = Array.isArray(node.material)
      ? node.material.map((material) => material.clone())
      : node.material.clone();
  });
  const bounds = new THREE.Box3().setFromObject(prop);
  const size = bounds.getSize(new THREE.Vector3());
  if (size.y <= 0.0001) return;
  const scale = targetHeight / size.y;
  const center = bounds.getCenter(new THREE.Vector3());
  prop.scale.setScalar(scale);
  prop.position.set(
    position.x - center.x * scale,
    groundY - bounds.min.y * scale,
    position.z - center.z * scale,
  );
  world.add(prop);
}

function disposeRenderedObject(object: THREE.Object3D): void {
  object.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      node.geometry?.dispose?.();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => material?.dispose?.());
    }
  });
}

function isEntity(reference: SceneReference): boolean {
  return reference.representation.kind === "articulated_entity";
}

function isStructure(reference: SceneReference): boolean {
  return (
    reference.representation.kind === "constructed_structure" ||
    reference.refId.includes(":OBJ:")
  );
}

function referenceClassFromRefId(refId: string): string {
  return refId.split(":")[2] ?? "";
}

function isArtifact(reference: SceneReference): boolean {
  return reference.representation.kind === "reference_marker" && referenceClassFromRefId(reference.refId) === "ASM";
}

function ObservatoryThreeViewport({
  scene,
  showTerrain,
  showStructures,
  showArtifacts,
  showEntities,
  viewMode,
  selectedRef,
  onSelect,
}: {
  scene: SceneDescription;
  showTerrain: boolean;
  showStructures: boolean;
  showArtifacts: boolean;
  showEntities: boolean;
  viewMode: ViewMode;
  selectedRef: string | null;
  onSelect: (refId: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const world = new THREE.Scene();
    world.background = new THREE.Color(0x1a1e24);
    world.fog = new THREE.FogExp2(0x1a1e24, 0.018);
    const camera = new THREE.PerspectiveCamera(47, 1, 0.08, 350);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    // Upgraded Lighting: "Studio" / "Golden Hour" Setup
    // Warmer, angled sun to create long, dramatic shadows across the voxels
    const sun = new THREE.DirectionalLight(0xffecd4, 3.5);
    sun.position.set(40, 45, 20); // Angled more to the side
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    // Expand shadow camera bounds so it covers the whole 32x32 grid
    sun.shadow.camera.left = sun.shadow.camera.bottom = -40;
    sun.shadow.camera.right = sun.shadow.camera.top = 40;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 150;
    sun.shadow.bias = -0.0005; // Prevents "shadow acne" on flat blocks

    // Richer ambient light to brighten the shadows
    const ambient = new THREE.HemisphereLight(0xcde1ff, 0x2b323c, 1.8);

    // Stronger warm bounce light to give faces dimensionality
    const warmFill = new THREE.DirectionalLight(0xff9a55, 1.2);
    warmFill.position.set(-30, -10, -30);
    warmFill.castShadow = false;

    world.add(ambient);
    world.add(warmFill);
    world.add(sun);


    const composer = new EffectComposer(renderer);
    const renderPass = new RenderPass(world, camera);

    const ssaoPass = new SSAOPass(
      world,
      camera,
      Math.max(mount.clientWidth, 1),
      Math.max(mount.clientHeight, 1),
    );
    ssaoPass.output = SSAOPass.OUTPUT.Default;
    ssaoPass.kernelRadius = 0.15; // Increased radius for softer, wider corner shadows
    ssaoPass.minDistance = 0.0005;
    ssaoPass.maxDistance = 0.1; // Brings the darkening in tighter to the geometry intersections

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(mount.clientWidth, 1), Math.max(mount.clientHeight, 1)),
      0.35, // Slightly stronger bloom
      0.4,
      0.85, // Lower threshold so bright daytime colors "bleed" nicely
    );

    const outputPass = new OutputPass();

    composer.addPass(renderPass);
    composer.addPass(ssaoPass);
    composer.addPass(bloomPass);
    composer.addPass(outputPass);

    const selectable: THREE.Object3D[] = [];
    const entities = new Map<string, ObservatoryCharacterModel>();
    const buildingVisuals: ReturnType<typeof createObservatoryBuildingVisual>[] = [];
    const artifactVisuals: THREE.Object3D[] = [];
    const structureModels: THREE.Object3D[] = [];
    const artifactModels: THREE.Object3D[] = [];
    const structureLoadJobs: Promise<unknown>[] = [];
    const artifactLoadJobs: Promise<unknown>[] = [];
    const terrainMeshes = new Map<string, THREE.Mesh[]>();
    const terrainReferences: SceneReference[] = [];
    let cancelled = false;

    const addStructureFallback = (reference: SceneReference) => {
      const fallback = createObservatoryBuildingVisual(reference, scene.references);
      const { x, y, z } = reference.transform.position;
      fallback.group.position.set(x, Math.max(y, 0.35), z);
      fallback.group.userData.refId = reference.refId;
      world.add(fallback.group);
      buildingVisuals.push(fallback);
      selectable.push(fallback.group);
    };

    const addArtifactFallback = (reference: SceneReference) => {
      const group = new THREE.Group();
      const baseMaterial = new THREE.MeshStandardMaterial({
        color: 0x7aa2f7,
        roughness: 0.5,
        metalness: 0.2,
      });
      const accentMaterial = new THREE.MeshStandardMaterial({
        color: 0xe8dd86,
        roughness: 0.2,
        metalness: 0.6,
      });
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.5, 0.18), baseMaterial);
      box.position.set(0, 0.25, 0);
      const tab = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.12, 16), accentMaterial);
      tab.position.set(0, 0.62, 0);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.18, 0.04, 8, 20),
        accentMaterial,
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(0, 0.68, 0);
      group.add(box, tab, ring);
      box.castShadow = true;
      box.receiveShadow = true;
      tab.castShadow = true;
      tab.receiveShadow = true;
      ring.castShadow = true;
      ring.receiveShadow = true;
      group.position.set(reference.transform.position.x, Math.max(reference.transform.position.y, 0.35), reference.transform.position.z);
      group.scale.setScalar(0.9);
      group.userData.refId = reference.refId;
      world.add(group);
      artifactVisuals.push(group);
      selectable.push(group);
    };

    const placeModel = (object: THREE.Object3D, reference: SceneReference) => {
      if (cancelled) {
        disposeRenderedObject(object);
        return;
      }

      const { x, y, z } = reference.transform.position;
      const bounds = new THREE.Box3().setFromObject(object);
      if (!bounds.isEmpty()) {
        const center = new THREE.Vector3();
        bounds.getCenter(center);
        object.position.set(x - center.x, Math.max(y, 0.35) - bounds.min.y, z - center.z);
      } else {
        object.position.set(x, Math.max(y, 0.35), z);
      }
      object.userData.refId = reference.refId;
      object.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.castShadow = true;
          node.receiveShadow = true;
        }
      });
      structureModels.push(object);
      world.add(object);
      selectable.push(object);
    };

    const placeArtifactModel = (object: THREE.Object3D, reference: SceneReference) => {
      if (cancelled) {
        disposeRenderedObject(object);
        return;
      }

      const { x, y, z } = reference.transform.position;
      const bounds = new THREE.Box3().setFromObject(object);
      if (!bounds.isEmpty()) {
        const center = new THREE.Vector3();
        bounds.getCenter(center);
        object.position.set(x - center.x, Math.max(y, 0.24) - bounds.min.y, z - center.z);
      } else {
        object.position.set(x, Math.max(y, 0.24), z);
      }
      object.scale.multiplyScalar(0.9);
      object.userData.refId = reference.refId;
      object.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.castShadow = true;
          node.receiveShadow = true;
        }
      });
      artifactModels.push(object);
      world.add(object);
      selectable.push(object);
    };

    const spawnStructure = (reference: SceneReference) => {
      const descriptor = resolveStructureAsset(reference.representation.material);
      const job = loadAssetModel(descriptor.modelUrl)
        .then((result) => {
          if (cancelled) return;
          if (result === null) {
            addStructureFallback(reference);
            return;
          }
          const clone = result.scene.clone(true);
          clone.scale.set(...descriptor.scale);
          placeModel(clone, reference);
        })
        .catch(() => {
          if (!cancelled) addStructureFallback(reference);
        });
      structureLoadJobs.push(job);
    };

    const spawnArtifact = (reference: SceneReference) => {
      const descriptor = resolveArtifactAsset(reference.representation.material);
      const job = loadAssetModel(descriptor.modelUrl)
        .then((result) => {
          if (cancelled) return;
      if (result === null) {
        addArtifactFallback(reference);
        return;
      }
      const clone = result.scene.clone(true);
      clone.scale.set(...descriptor.scale);
      placeArtifactModel(clone, reference);
        })
        .catch(() => {
          if (!cancelled) addArtifactFallback(reference);
        });
      artifactLoadJobs.push(job);
    };

    for (const reference of scene.references) {
      const { x, y, z } = reference.transform.position;
      if (reference.representation.kind === "surface" && showTerrain) {
        const material = reference.representation.material ?? "plains";
        const water = material === "water";

        // Shrink footprint from 0.98 to 0.96 to create pronounced grid gaps for SSAO
        const object = new THREE.Mesh(
          new THREE.BoxGeometry(0.96, water ? 0.22 : 0.65, 0.96),
          new THREE.MeshStandardMaterial({
            color: TERRAIN[material] ?? 0x566450,
            // Adjust roughness and metalness to make land matte and water glassy
            roughness: water ? 0.15 : 0.85,
            metalness: water ? 0.4 : 0.05,
            transparent: water,
            opacity: water ? 0.85 : 1,
            // Add flatShading for the crisp voxel/low-poly aesthetic
            flatShading: true,
          }),
        );
        object.position.set(x, water ? -0.15 : 0, z);
        object.receiveShadow = true;
        // Ensure land casts shadows, but water does not
        object.castShadow = !water;
        object.userData.refId = reference.refId;
        world.add(object);
        selectable.push(object);
        terrainMeshes.set(material, [...(terrainMeshes.get(material) ?? []), object]);
        terrainReferences.push(reference);
      } else if (isStructure(reference) && showStructures) {
        spawnStructure(reference);
      } else if (isArtifact(reference) && showArtifacts) {
        spawnArtifact(reference);
      } else if (isEntity(reference) && showEntities) {
        const character = createObservatoryCharacter(reference);
        character.group.position.set(x, Math.max(y, 0.35), z);
        world.add(character.group);
        entities.set(reference.refId, character);
        selectable.push(character.group);
      }
    }
    void loadAssetModel(TERRAIN_ASSET_URL).then((result) => {
      if (cancelled || result === null) return;
      const grass = terrainMaterialFromAsset(result.scene, "TerrainShader");
      const rock = terrainMaterialFromAsset(result.scene, "Rock");
      const apply = (terrain: string, source: THREE.MeshStandardMaterial | null, tint: number) => {
        if (source === null) return;
        for (const mesh of terrainMeshes.get(terrain) ?? []) {
          const previous = mesh.material;
          mesh.material = cloneTerrainMaterial(source, tint);
          if (!Array.isArray(previous)) previous.dispose();
        }
      };
      apply("plains", grass, 0x7b9752);
      apply("fertile", grass, 0x94ad59);
      apply("forest", grass, 0x476b40);
      apply("barren", grass, 0x877151);
      apply("stone", rock, 0x92979a);
      apply("stone_deposit", rock, 0x9ba1a4);

      const rockProp = result.scene.getObjectByName("Rock_9");
      if (rockProp === undefined) return;
      let placed = 0;
      for (const reference of terrainReferences) {
        if (placed >= 56 || cancelled) return;
        const terrain = reference.representation.material;
        if ((terrain !== "stone" && terrain !== "stone_deposit" && terrain !== "barren") || terrainNoise(reference.refId) <= 0.74) continue;
        const { x, y, z } = reference.transform.position;
        placeTerrainRock(
          world,
          rockProp,
          new THREE.Vector3(x + (terrainNoise(`${reference.refId}:x`) - 0.5) * 0.42, 0, z + (terrainNoise(`${reference.refId}:z`) - 0.5) * 0.42),
          Math.max(y, 0.34),
          0.32 + terrainNoise(`${reference.refId}:size`) * 0.34,
        );
        placed += 1;
      }
    });
    void Promise.allSettled(structureLoadJobs);
    void Promise.allSettled(artifactLoadJobs);
    const actionEffects = new ObservatoryActionEffects(world);

    const selectedCharacter =
      (selectedRef === null ? undefined : entities.get(selectedRef)) ?? entities.values().next().value;
    const selectedEntity = selectedCharacter?.group as THREE.Group | undefined;
    const center = new THREE.Vector3(scene.bounds.width / 2, 0, scene.bounds.height / 2);
    const anchor = selectedEntity?.position.clone() ?? center;
    if (selectedEntity && viewMode === "first-person") selectedEntity.visible = false;
    // Agent cameras initially face into the settlement rather than using the
    // overview's arbitrary orbit angle, which can point edge-dwelling agents
    // straight out into fog.
    let yaw =
      viewMode === "overview"
        ? Math.PI * 0.82
        : Math.atan2(center.x - anchor.x, center.z - anchor.z);
    let pitch = viewMode === "overview" ? 0.62 : 0.18;
    let distance = Math.max(scene.bounds.width, scene.bounds.height) * 0.9;
    if (viewMode === "third-person") distance = 7;
    let desiredYaw = yaw;
    let desiredPitch = pitch;
    let desiredDistance = distance;

    const updateCamera = () => {
      if (viewMode === "first-person") {
        const eye = anchor.clone().add(new THREE.Vector3(0, 1.82, 0));
        camera.position.copy(eye);
        camera.lookAt(
          eye.clone().add(
            new THREE.Vector3(
              Math.sin(yaw) * Math.cos(pitch),
              Math.sin(pitch),
              Math.cos(yaw) * Math.cos(pitch),
            ),
          ),
        );
        camera.fov = 68;
      } else {
        const target = anchor.clone().add(new THREE.Vector3(0, viewMode === "overview" ? 0 : 0.95, 0));
        const horizontal = Math.cos(pitch) * distance;
        camera.position.set(
          target.x + Math.sin(yaw) * horizontal,
          target.y + Math.sin(pitch) * distance,
          target.z + Math.cos(yaw) * horizontal,
        );
        camera.lookAt(target);
        camera.fov = viewMode === "overview" ? 47 : 54;
      }
      camera.updateProjectionMatrix();
    };

    let dragging = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;
    const canvas = renderer.domElement;
    const down = (event: PointerEvent) => {
      dragging = true;
      moved = false;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      moved ||= Math.abs(dx) + Math.abs(dy) > 2;
      desiredYaw -= dx * 0.007;
      desiredPitch = THREE.MathUtils.clamp(
        desiredPitch + dy * 0.005,
        viewMode === "first-person" ? -1.25 : 0.08,
        1.3,
      );
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const up = (event: PointerEvent) => {
      dragging = false;
      if (moved) return;
      const rect = canvas.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(selectable, true)[0]?.object;
      let current: THREE.Object3D | null = hit ?? null;
      while (current && typeof current.userData.refId !== "string") current = current.parent;
      if (current) onSelect(current.userData.refId as string);
    };
    const wheel = (event: WheelEvent) => {
      if (viewMode === "first-person") return;
      event.preventDefault();
      desiredDistance = THREE.MathUtils.clamp(
        desiredDistance + event.deltaY * 0.012,
        viewMode === "overview" ? 8 : 3.6,
        70,
      );
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", wheel, { passive: false });

    const resize = () => {
      const width = Math.max(mount.clientWidth, 1);
      const height = Math.max(mount.clientHeight, 1);
      // Keep the drawing buffer at device-pixel resolution but the canvas at
      // the mount's CSS size. Without this, high-DPI displays clipped the
      // centred camera to a corner of the oversized canvas.
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      composer.setSize(width, height);
      ssaoPass.setSize(width, height);
      bloomPass.setSize(width, height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    let raf = 0;
    const startedAt = performance.now();
    const render = () => {
      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      yaw = THREE.MathUtils.lerp(yaw, desiredYaw, viewMode === "first-person" ? 0.3 : 0.12);
      pitch = THREE.MathUtils.lerp(pitch, desiredPitch, 0.14);
      distance = THREE.MathUtils.lerp(distance, desiredDistance, 0.12);
      buildingVisuals.forEach((visual) => visual.update(elapsedSeconds));
      artifactVisuals.forEach((artifact) => {
        const intensity = 0.9 + Math.sin(elapsedSeconds * 3) * 0.08;
        artifact.rotation.y = elapsedSeconds * 0.2;
        artifact.scale.setScalar(0.9 * intensity);
      });
      entities.forEach((character) => character.update(elapsedSeconds));
      actionEffects.update(scene.references, elapsedSeconds);
      updateCamera();
      composer.render();
      raf = requestAnimationFrame(render);
    };
    render();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      cancelled = true;
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("wheel", wheel);
      actionEffects.dispose();
      buildingVisuals.forEach((visual) => visual.dispose());
      structureModels.forEach((structure) => disposeRenderedObject(structure));
      artifactVisuals.forEach((artifact) => {
        artifact.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.geometry?.dispose?.();
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            materials.forEach((material) => material?.dispose?.());
          }
        });
      });
      artifactModels.forEach((model) => disposeRenderedObject(model));
      world.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry?.dispose?.();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material?.dispose?.());
        }
      });
      composer.dispose();
      renderer.dispose();
      canvas.remove();
    };
  }, [
    onSelect,
    scene,
    selectedRef,
    showArtifacts,
    showEntities,
    showStructures,
    showTerrain,
    viewMode,
  ]);

  return (
    <div
      ref={mountRef}
      className="h-[34rem] min-h-[28rem] w-full cursor-grab active:cursor-grabbing"
      role="img"
      aria-label="Interactive Three.js rendering of the Observatory world"
    />
  );
}

export function ObservatoryScene({ scene }: { scene: SceneDescription }) {
  const [showTerrain, setShowTerrain] = useState(true);
  const [showStructures, setShowStructures] = useState(true);
  const [showEntities, setShowEntities] = useState(true);
  const [showArtifacts, setShowArtifacts] = useState(true);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("overview");
  const entities = scene.references.filter(isEntity);
  const structures = scene.references.filter(isStructure);
  const artifacts = scene.references.filter(isArtifact);
  const activeRecord = scene.references.find((reference) => reference.refId === selectedRef);
  const select = useCallback((refId: string) => setSelectedRef(refId), []);
  const chooseView = (mode: ViewMode) => {
    if (mode !== "overview" && !entities.some((entity) => entity.refId === selectedRef)) {
      setSelectedRef(entities[0]?.refId ?? null);
    }
    if (mode !== "overview") setShowEntities(true);
    setViewMode(mode);
  };

  return (
    <section className="relative overflow-hidden rounded-md border border-line bg-[#05080c] shadow-2xl" aria-labelledby="scene-title">
      <div className="absolute inset-x-0 top-0 z-20 flex flex-wrap items-start justify-between gap-3 bg-gradient-to-b from-[#05080c]/95 to-transparent p-4">
        <div>
          <p className="eyebrow">Universal Observatory · Tick {scene.worldTick}</p>
          <h2 id="scene-title" className="mt-1 text-base font-medium text-ink">W001 · Real-time 3D World</h2>
        </div>
        <div className="pointer-events-auto flex flex-wrap justify-end gap-2">
          <div className="flex rounded-md border border-line bg-panel/90 p-1 text-xs">
            {(["overview", "first-person", "third-person"] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={viewMode === mode} onClick={() => chooseView(mode)}
                className={`mono rounded px-2.5 py-1 capitalize ${viewMode === mode ? "bg-amber text-abyss" : "text-muted hover:text-ink"}`}>
                {mode.replace("-", " ")}
              </button>
            ))}
          </div>
          <div className="flex rounded-md border border-line bg-panel/90 p-1 text-xs">
            <button type="button" aria-pressed={showTerrain} onClick={() => setShowTerrain((value) => !value)} className={`mono rounded px-2 py-1 ${showTerrain ? "text-amber" : "text-dim"}`}>Terrain</button>
            <button type="button" aria-pressed={showStructures} onClick={() => setShowStructures((value) => !value)} className={`mono rounded px-2 py-1 ${showStructures ? "text-amber" : "text-dim"}`}>Buildings ({structures.length})</button>
            <button type="button" aria-pressed={showArtifacts} onClick={() => setShowArtifacts((value) => !value)} className={`mono rounded px-2 py-1 ${showArtifacts ? "text-amber" : "text-dim"}`}>Artifacts ({artifacts.length})</button>
            <button type="button" aria-pressed={showEntities} onClick={() => setShowEntities((value) => !value)} className={`mono rounded px-2 py-1 ${showEntities ? "text-amber" : "text-dim"}`}>Agents ({entities.length})</button>
          </div>
        </div>
      </div>

      <ObservatoryThreeViewport
        scene={scene}
        showTerrain={showTerrain}
        showStructures={showStructures}
        showArtifacts={showArtifacts}
        showEntities={showEntities}
        viewMode={viewMode}
        selectedRef={selectedRef}
        onSelect={select}
      />

      <div className="absolute inset-x-4 bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-panel/90 p-3 backdrop-blur-md">
        {activeRecord ? (
          <div className="flex items-center gap-3">
            <span className="mono rounded bg-amber/20 px-2 py-0.5 text-xs text-amber">{activeRecord.representation.kind}</span>
            <div>
              <p className="text-xs font-medium text-ink">Ref: {activeRecord.refId}</p>
              <p className="mono text-[0.65rem] text-dim">Pos: ({activeRecord.transform.position.x}, {activeRecord.transform.position.z}) · drag to look · wheel to zoom</p>
            </div>
            <a href={`/world/${scene.worldId}/ref/${encodeURIComponent(activeRecord.refId)}`} className="mono rounded border border-line px-2 py-1 text-xs text-amber">Inspect Record →</a>
          </div>
        ) : <p className="text-xs text-muted">Click terrain, a building, or an agent to inspect it. Select an agent for first/third person.</p>}
        <p className="mono text-[0.62rem] text-dim">{scene.references.length.toLocaleString()} references · live read only</p>
      </div>
    </section>
  );
}
