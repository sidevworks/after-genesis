// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { createWatchCharacter, type ObservatoryCharacterModel } from "@/lib/observatory-character-model";
import type { ObservatoryRun } from "@/lib/observatory-types";

interface Point {
  x: number;
  y: number;
}

interface VoxelWorldViewportProps {
  run: ObservatoryRun;
  focus: Point;
  targetId: string | null;
  targetName: string;
  visualSeed: string;
  mode: "follow" | "event";
  phase?: "BEFORE" | "DURING" | "AFTER";
  movement?: { from: Point; to: Point } | null;
}

type CameraMode = "first-person" | "third-person";

const TERRAIN_COLOURS: Record<string, number> = {
  water: 0x24718a,
  plains: 0x6f8c52,
  fertile: 0x86a85c,
  forest: 0x315f3f,
  stone: 0x777d7f,
  stone_deposit: 0x777d7f,
  barren: 0x806a48,
  unknown: 0x29333a,
};

function seedColour(seed: string): THREE.Color {
  const hue = (Number.parseInt(seed.slice(0, 6), 16) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.58, 0.62);
}

function fallbackSeed(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function addCharacter(
  scene: THREE.Scene,
  position: THREE.Vector3,
  inhabitantId: string,
  visualSeed: string,
  isTarget: boolean,
  action: string | null = null,
): ObservatoryCharacterModel {
  const character = createWatchCharacter(inhabitantId, visualSeed, action);
  const group = character.group;
  const colour = seedColour(visualSeed);

  if (isTarget) {
    const marker = new THREE.Mesh(
      new THREE.TorusGeometry(0.78, 0.045, 8, 32),
      new THREE.MeshBasicMaterial({ color: colour }),
    );
    marker.rotation.x = Math.PI / 2;
    marker.position.y = 0.08;
    group.add(marker);

    const beaconMaterial = new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity: 0.72,
    });
    const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 3.4, 6), beaconMaterial);
    beacon.position.y = 4.25;
    group.add(beacon);
    const crown = new THREE.Mesh(new THREE.OctahedronGeometry(0.22), beaconMaterial);
    crown.position.y = 6;
    crown.rotation.y = Math.PI / 4;
    group.add(crown);

    const light = new THREE.PointLight(colour, 1.4, 7, 2);
    light.position.y = 2.4;
    group.add(light);
    group.scale.setScalar(1.08);
  }

  group.position.copy(position);
  scene.add(group);
  return character;
}

export function VoxelWorldViewport({
  run,
  focus,
  targetId,
  targetName,
  visualSeed,
  mode,
  phase = "DURING",
  movement = null,
}: VoxelWorldViewportProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>("third-person");

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x07131c);
    scene.fog = new THREE.FogExp2(0x07131c, 0.035);

    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);

    const ambient = new THREE.HemisphereLight(0xa9c9e1, 0x203225, 1.55);
    scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffddaa, 2.4);
    sun.position.set(-8, 14, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -12;
    sun.shadow.camera.right = 12;
    sun.shadow.camera.top = 12;
    sun.shadow.camera.bottom = -12;
    scene.add(sun);

    const radius = 7;
    const blockGeometry = new THREE.BoxGeometry(1, 0.8, 1);
    const materials = new Map<string, THREE.MeshStandardMaterial>();
    for (const [terrain, colour] of Object.entries(TERRAIN_COLOURS)) {
      materials.set(
        terrain,
        new THREE.MeshStandardMaterial({
          color: colour,
          roughness: terrain === "water" ? 0.28 : 0.92,
          metalness: terrain === "water" ? 0.12 : 0,
          transparent: terrain === "water",
          opacity: terrain === "water" ? 0.82 : 1,
        }),
      );
    }

    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        const worldX = focus.x + offsetX;
        const worldY = focus.y + offsetY;
        const inBounds =
          worldX >= 0 && worldY >= 0 && worldX < run.map.width && worldY < run.map.height;
        const terrain = inBounds
          ? run.map.terrain[worldY * run.map.width + worldX] ?? "unknown"
          : "unknown";
        const block = new THREE.Mesh(
          blockGeometry,
          materials.get(terrain) ?? materials.get("unknown"),
        );
        block.position.set(offsetX, terrain === "water" ? -0.18 : 0, offsetY);
        block.receiveShadow = true;
        scene.add(block);

        if (
          terrain === "forest" &&
          inBounds &&
          (worldX * 17 + worldY * 31) % 7 === 0 &&
          Math.hypot(offsetX, offsetY) > 3 &&
          (offsetX !== 0 || offsetY !== 0)
        ) {
          const trunk = new THREE.Mesh(
            new THREE.BoxGeometry(0.25, 1.2, 0.25),
            new THREE.MeshStandardMaterial({ color: 0x5b4630, roughness: 1 }),
          );
          trunk.position.set(offsetX, 0.9, offsetY);
          trunk.castShadow = true;
          scene.add(trunk);
          const crown = new THREE.Mesh(
            new THREE.BoxGeometry(1.05, 1.05, 1.05),
            new THREE.MeshStandardMaterial({ color: 0x28543a, roughness: 0.95 }),
          );
          crown.position.set(offsetX, 1.65, offsetY);
          crown.castShadow = true;
          scene.add(crown);
        }
      }
    }

    const grid = new THREE.GridHelper(radius * 2 + 1, radius * 2 + 1, 0x263c45, 0x15262e);
    grid.position.y = 0.415;
    grid.position.x = -0.5;
    grid.position.z = -0.5;
    scene.add(grid);

    const characterModels: ObservatoryCharacterModel[] = [];
    const cameraAnchor = new THREE.Vector3(0, 0.42, 0);
    if (mode === "follow") {
      for (const inhabitant of run.inhabitants) {
        const relativeX = inhabitant.location.x - focus.x;
        const relativeZ = inhabitant.location.y - focus.y;
        if (Math.abs(relativeX) > radius || Math.abs(relativeZ) > radius) continue;
        const character = addCharacter(
          scene,
          new THREE.Vector3(relativeX, 0.42, relativeZ),
          inhabitant.id,
          inhabitant.id === targetId ? visualSeed : fallbackSeed(inhabitant.id),
          inhabitant.id === targetId,
        );
        characterModels.push(character);
        if (inhabitant.id === targetId) {
          cameraAnchor.copy(character.group.position);
          // In first person the followed body would otherwise fill the lens.
          character.group.visible = cameraMode !== "first-person";
        }
      }
    } else {
      let actorPoint = focus;
      if (movement) {
        actorPoint =
          phase === "BEFORE"
            ? movement.from
            : phase === "AFTER"
              ? movement.to
              : {
                  x: (movement.from.x + movement.to.x) / 2,
                  y: (movement.from.y + movement.to.y) / 2,
                };
        const pathMaterial = new THREE.MeshBasicMaterial({ color: 0xd9a441 });
        const path = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(movement.from.x - focus.x, 0.55, movement.from.y - focus.y),
            new THREE.Vector3(movement.to.x - focus.x, 0.55, movement.to.y - focus.y),
          ]),
          pathMaterial,
        );
        scene.add(path);
      }
      const character = addCharacter(
        scene,
        new THREE.Vector3(actorPoint.x - focus.x, 0.42, actorPoint.y - focus.y),
        targetId ?? targetName.toLowerCase(),
        visualSeed,
        true,
        movement === null ? null : "move",
      );
      characterModels.push(character);
      cameraAnchor.copy(character.group.position);
      character.group.visible = cameraMode !== "first-person";
    }

    const target = cameraAnchor.clone().add(new THREE.Vector3(0, 1.35, 0));
    let azimuth = mode === "follow" ? 0.72 : 0.88;
    let elevation = mode === "follow" ? 0.38 : 0.58;
    let desiredAzimuth = azimuth;
    let desiredElevation = elevation;
    let distance = mode === "follow" ? 10.5 : 12.5;
    let desiredDistance = distance;
    const updateCamera = () => {
      if (cameraMode === "first-person") {
        const eye = cameraAnchor.clone().add(new THREE.Vector3(0, 2.55, 0));
        const direction = new THREE.Vector3(
          Math.sin(azimuth) * Math.cos(elevation),
          Math.sin(elevation),
          Math.cos(azimuth) * Math.cos(elevation),
        );
        camera.position.copy(eye);
        camera.lookAt(eye.clone().add(direction));
        camera.fov = 68;
        camera.updateProjectionMatrix();
        return;
      }
      const horizontal = Math.cos(elevation) * distance;
      camera.position.set(
        target.x + Math.sin(azimuth) * horizontal,
        target.y + Math.sin(elevation) * distance,
        target.z + Math.cos(azimuth) * horizontal,
      );
      camera.lookAt(target);
      camera.fov = 48;
      camera.updateProjectionMatrix();
    };
    updateCamera();

    let dragging = false;
    let previousX = 0;
    let previousY = 0;
    const canvas = renderer.domElement;
    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      previousX = event.clientX;
      previousY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      desiredAzimuth -= (event.clientX - previousX) * 0.008;
      const minimumElevation = cameraMode === "first-person" ? -1.15 : 0.16;
      const maximumElevation = cameraMode === "first-person" ? 1.15 : 1.08;
      desiredElevation = Math.max(
        minimumElevation,
        Math.min(maximumElevation, desiredElevation + (event.clientY - previousY) * 0.006),
      );
      previousX = event.clientX;
      previousY = event.clientY;
    };
    const onPointerUp = () => {
      dragging = false;
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (cameraMode === "third-person") {
        desiredDistance = Math.max(4.5, Math.min(22, desiredDistance + event.deltaY * 0.012));
      }
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    let frame = 0;
    const startedAt = performance.now();
    const render = () => {
      // Frame-rate independent-feeling damping keeps orbit changes cinematic
      // while retaining a responsive first-person look.
      const damping = cameraMode === "first-person" ? 0.34 : 0.14;
      azimuth += (desiredAzimuth - azimuth) * damping;
      elevation += (desiredElevation - elevation) * damping;
      distance += (desiredDistance - distance) * 0.12;
      characterModels.forEach((character) => character.update((performance.now() - startedAt) / 1000));
      updateCamera();
      renderer.render(scene, camera);
      frame = window.requestAnimationFrame(render);
    };
    render();

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      renderer.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const objectMaterials = Array.isArray(object.material)
            ? object.material
            : [object.material];
          for (const material of objectMaterials) material.dispose();
        }
      });
      mount.removeChild(canvas);
    };
  }, [
    cameraMode,
    focus.x,
    focus.y,
    mode,
    movement,
    phase,
    run,
    targetId,
    targetName,
    visualSeed,
  ]);

  return (
    <div className="voxel-viewport">
      <div
        ref={mountRef}
        className="voxel-viewport__canvas"
        role="img"
        aria-label={`Interactive voxel view centred on ${targetName}`}
      />
      <div
        className="absolute right-3 top-3 z-10 flex rounded-full border border-white/15 bg-slate-950/75 p-1 text-xs text-white shadow-lg backdrop-blur"
        role="group"
        aria-label="Camera view"
      >
        <button
          type="button"
          aria-pressed={cameraMode === "first-person"}
          className={`rounded-full px-3 py-1.5 transition ${
            cameraMode === "first-person" ? "bg-amber-300 text-slate-950" : "hover:bg-white/10"
          }`}
          onClick={() => setCameraMode("first-person")}
        >
          First person
        </button>
        <button
          type="button"
          aria-pressed={cameraMode === "third-person"}
          className={`rounded-full px-3 py-1.5 transition ${
            cameraMode === "third-person" ? "bg-amber-300 text-slate-950" : "hover:bg-white/10"
          }`}
          onClick={() => setCameraMode("third-person")}
        >
          Third person
        </button>
      </div>
      <p className="voxel-viewport__help">
        {cameraMode === "first-person" ? "Drag to look around" : "Drag to orbit · wheel to zoom"}
      </p>
    </div>
  );
}
