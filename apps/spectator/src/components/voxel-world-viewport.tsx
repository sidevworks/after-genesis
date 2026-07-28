"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
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
  colour: THREE.Color,
  isTarget: boolean,
): THREE.Group {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: colour,
    roughness: 0.72,
    metalness: 0.04,
    emissive: isTarget ? colour.clone().multiplyScalar(0.14) : new THREE.Color(0x000000),
  });
  const darkMaterial = new THREE.MeshStandardMaterial({
    color: colour.clone().multiplyScalar(0.58),
    roughness: 0.82,
  });
  const faceMaterial = new THREE.MeshStandardMaterial({
    color: colour.clone().offsetHSL(0, -0.08, 0.12),
    roughness: 0.7,
  });

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.72, 0.72), faceMaterial);
  head.position.y = 2.45;
  head.castShadow = true;
  group.add(head);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.82, 1.05, 0.48), bodyMaterial);
  torso.position.y = 1.55;
  torso.castShadow = true;
  group.add(torso);

  const limbGeometry = new THREE.BoxGeometry(0.27, 0.95, 0.3);
  for (const x of [-0.56, 0.56]) {
    const arm = new THREE.Mesh(limbGeometry, bodyMaterial);
    arm.position.set(x, 1.55, 0);
    arm.castShadow = true;
    group.add(arm);
  }
  for (const x of [-0.23, 0.23]) {
    const leg = new THREE.Mesh(limbGeometry, darkMaterial);
    leg.position.set(x, 0.57, 0);
    leg.castShadow = true;
    group.add(leg);
  }

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
  return group;
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

    if (mode === "follow") {
      for (const inhabitant of run.inhabitants) {
        const relativeX = inhabitant.location.x - focus.x;
        const relativeZ = inhabitant.location.y - focus.y;
        if (Math.abs(relativeX) > radius || Math.abs(relativeZ) > radius) continue;
        addCharacter(
          scene,
          new THREE.Vector3(relativeX, 0.42, relativeZ),
          seedColour(inhabitant.id === targetId ? visualSeed : fallbackSeed(inhabitant.id)),
          inhabitant.id === targetId,
        );
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
      addCharacter(
        scene,
        new THREE.Vector3(actorPoint.x - focus.x, 0.42, actorPoint.y - focus.y),
        seedColour(visualSeed),
        true,
      );
    }

    const target = new THREE.Vector3(0, 1.3, 0);
    let azimuth = mode === "follow" ? 0.72 : 0.88;
    let elevation = mode === "follow" ? 0.38 : 0.58;
    let distance = mode === "follow" ? 10.5 : 12.5;
    const updateCamera = () => {
      const horizontal = Math.cos(elevation) * distance;
      camera.position.set(
        Math.sin(azimuth) * horizontal,
        Math.sin(elevation) * distance + 1,
        Math.cos(azimuth) * horizontal,
      );
      camera.lookAt(target);
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
      azimuth -= (event.clientX - previousX) * 0.008;
      elevation = Math.max(0.16, Math.min(1.08, elevation + (event.clientY - previousY) * 0.006));
      previousX = event.clientX;
      previousY = event.clientY;
      updateCamera();
    };
    const onPointerUp = () => {
      dragging = false;
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      distance = Math.max(5.5, Math.min(22, distance + event.deltaY * 0.012));
      updateCamera();
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
    const render = () => {
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
  }, [focus.x, focus.y, mode, movement, phase, run, targetId, targetName, visualSeed]);

  return (
    <div className="voxel-viewport">
      <div
        ref={mountRef}
        className="voxel-viewport__canvas"
        role="img"
        aria-label={`Interactive voxel view centred on ${targetName}`}
      />
      <p className="voxel-viewport__help">Drag to orbit · wheel to zoom</p>
    </div>
  );
}
