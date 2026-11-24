// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createObservatoryCharacter, type ObservatoryCharacterModel } from "@/lib/observatory-character-model";
import { characterKeyForCanonicalId } from "@/lib/observatory-character-profiles";
import { hasDedicatedStructureVisual, projectWorldMap, tilePosition } from "@/lib/world-map-projection";
import type { SceneReference } from "@/lib/observatory-types";
import type { Structure, Tile, WorldMap } from "@/lib/world-types";
import { assetUrl } from "@/lib/asset-url";

export interface MapTileSelection {
  readonly x: number;
  readonly y: number;
}

const TERRAIN: Record<string, number> = {
  water: 0x1d6882,
  plains: 0x5c7944,
  fertile: 0x769952,
  forest: 0x275339,
  stone: 0x6d7479,
  stone_deposit: 0x7f8588,
  barren: 0x6f5d43,
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const TERRAIN_ASSET_URL = assetUrl("/terrain/tabletop_terrain.glb");

type TerrainLibrary = {
  readonly terrain: THREE.MeshStandardMaterial | null;
  readonly rock: THREE.MeshStandardMaterial | null;
  readonly road: THREE.MeshStandardMaterial | null;
  readonly rockProp: THREE.Object3D | null;
};

let terrainLibraryLoad: Promise<TerrainLibrary | null> | null = null;

function findTerrainMaterial(root: THREE.Object3D, name: string): THREE.MeshStandardMaterial | null {
  let found: THREE.MeshStandardMaterial | null = null;
  root.traverse((node) => {
    if (found !== null || !(node instanceof THREE.Mesh)) return;
    const candidates = Array.isArray(node.material) ? node.material : [node.material];
    const candidate = candidates.find((entry) => entry.name === name && entry instanceof THREE.MeshStandardMaterial);
    if (candidate instanceof THREE.MeshStandardMaterial) found = candidate;
  });
  return found;
}

function loadTerrainLibrary(): Promise<TerrainLibrary | null> {
  if (terrainLibraryLoad !== null) return terrainLibraryLoad;
  terrainLibraryLoad = new Promise((resolve) => {
    new GLTFLoader().load(
      TERRAIN_ASSET_URL,
      ({ scene }) => resolve({
        terrain: findTerrainMaterial(scene, "TerrainShader"),
        rock: findTerrainMaterial(scene, "Rock"),
        road: findTerrainMaterial(scene, "Road"),
        // The supplied file's textured rock is a presentation-only prop: it
        // never alters a tile, path, or canonical resource record.
        rockProp: scene.getObjectByName("Rock_9") ?? null,
      }),
      undefined,
      () => resolve(null),
    );
  });
  return terrainLibraryLoad;
}

function cloneTerrainMaterial(
  source: THREE.MeshStandardMaterial,
  tint: number,
): THREE.MeshStandardMaterial {
  const clone = source.clone();
  clone.color.multiply(new THREE.Color(tint));
  clone.needsUpdate = true;
  return clone;
}

function placeTerrainProp(
  scene: THREE.Scene,
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
      ? node.material.map((entry) => entry.clone())
      : node.material.clone();
  });
  const bounds = new THREE.Box3().setFromObject(prop);
  const size = bounds.getSize(new THREE.Vector3());
  if (size.y <= 0.0001) return;
  const scale = targetHeight / size.y;
  const centre = bounds.getCenter(new THREE.Vector3());
  prop.scale.setScalar(scale);
  prop.position.set(
    position.x - centre.x * scale,
    groundY - bounds.min.y * scale,
    position.z - centre.z * scale,
  );
  scene.add(prop);
}

async function applyTerrainAsset(
  scene: THREE.Scene,
  terrainMeshes: ReadonlyMap<string, THREE.InstancedMesh>,
  map: WorldMap,
  canSee: (x: number, y: number) => boolean,
  cancelled: () => boolean,
): Promise<void> {
  const library = await loadTerrainLibrary();
  if (library === null || cancelled()) return;

  const applyMaterial = (kind: string, source: THREE.MeshStandardMaterial | null, tint: number) => {
    const mesh = terrainMeshes.get(kind);
    if (mesh === undefined || source === null) return;
    const previous = mesh.material;
    mesh.material = cloneTerrainMaterial(source, tint);
    if (!Array.isArray(previous)) previous.dispose();
  };
  applyMaterial("plains", library.terrain, 0x7b9752);
  applyMaterial("fertile", library.terrain, 0x94ad59);
  applyMaterial("forest", library.terrain, 0x476b40);
  applyMaterial("barren", library.terrain, 0x877151);
  applyMaterial("stone", library.rock, 0x92979a);

  const transportTiles = map.structures.filter((structure) => {
    const kind = structure.kind.toLowerCase();
    return kind.includes("road") || kind.includes("bridge");
  });
  if (library.road !== null && transportTiles.length > 0) {
    const paths = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.9, 0.025, 0.9),
      cloneTerrainMaterial(library.road, 0xffffff),
      transportTiles.length,
    );
    const matrix = new THREE.Matrix4();
    transportTiles.forEach((structure, index) => {
      const position = tilePosition(map, structure.at);
      matrix.makeTranslation(position.x, terrainSurfaceHeight(map.tiles[structure.at.y * map.width + structure.at.x]?.terrain ?? "plains") + 0.21, position.z);
      paths.setMatrixAt(index, matrix);
    });
    paths.instanceMatrix.needsUpdate = true;
    paths.receiveShadow = true;
    scene.add(paths);
  }

  let rocksPlaced = 0;
  for (const tile of map.tiles) {
    if (!canSee(tile.x, tile.y) || cancelled()) return;
    const position = tilePosition(map, tile);
    const surface = terrainSurfaceHeight(tile.terrain);
    if ((tile.terrain === "stone" || tile.terrain === "barren") && library.rockProp !== null && tileNoise(tile.x, tile.y, "asset-rock") > 0.74 && rocksPlaced < 56) {
      placeTerrainProp(
        scene,
        library.rockProp,
        new THREE.Vector3(position.x + (tileNoise(tile.x, tile.y, "asset-rock-x") - 0.5) * 0.42, 0, position.z + (tileNoise(tile.x, tile.y, "asset-rock-z") - 0.5) * 0.42),
        surface,
        0.32 + tileNoise(tile.x, tile.y, "asset-rock-size") * 0.34,
      );
      rocksPlaced += 1;
    }
  }
}

function material(colour: number, options: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({ color: colour, roughness: 0.74, metalness: 0.12, ...options });
}

/** A stable visual-only value. It never participates in world state. */
function tileNoise(x: number, y: number, salt: string): number {
  let value = 0x811c9dc5;
  for (const character of `${salt}:${x},${y}`) {
    value = Math.imul(value ^ character.charCodeAt(0), 0x01000193);
  }
  return (value >>> 0) / 0x1_0000_0000;
}

function terrainSurfaceHeight(terrain: string): number {
  if (terrain === "water") return -0.12;
  if (terrain === "stone" || terrain === "stone_deposit") return 0.36;
  if (terrain === "barren") return 0.2;
  return 0.25;
}

function addLandscape(
  scene: THREE.Scene,
  map: WorldMap,
  canSee: (x: number, y: number) => boolean,
): void {
  const trees: Array<{ x: number; z: number; h: number; scale: number }> = [];
  const grass: Array<{ x: number; z: number; h: number; scale: number }> = [];
  const rocks: Array<{ x: number; z: number; scale: number }> = [];
  const reeds: Array<{ x: number; z: number; h: number }> = [];
  const waterTiles: Tile[] = [];
  const terrainAt = (x: number, y: number) => map.tiles[y * map.width + x]?.terrain;

  for (const tile of map.tiles) {
    if (!canSee(tile.x, tile.y)) continue;
    const position = tilePosition(map, tile);
    const surface = terrainSurfaceHeight(tile.terrain);
    const a = tileNoise(tile.x, tile.y, "a");
    const b = tileNoise(tile.x, tile.y, "b");
    if (tile.terrain === "forest") {
      const count = a > 0.65 ? 3 : a > 0.24 ? 2 : 1;
      for (let index = 0; index < count; index += 1) {
        trees.push({
          x: position.x + (tileNoise(tile.x, tile.y, `tree-x-${index}`) - 0.5) * 0.62,
          z: position.z + (tileNoise(tile.x, tile.y, `tree-z-${index}`) - 0.5) * 0.62,
          h: surface + 0.75 + tileNoise(tile.x, tile.y, `tree-h-${index}`) * 0.7,
          scale: 0.7 + tileNoise(tile.x, tile.y, `tree-s-${index}`) * 0.38,
        });
      }
    } else if (tile.terrain === "plains" || tile.terrain === "fertile") {
      const count = tile.terrain === "fertile" ? 3 : 2;
      for (let index = 0; index < count; index += 1) {
        grass.push({
          x: position.x + (tileNoise(tile.x, tile.y, `grass-x-${index}`) - 0.5) * 0.72,
          z: position.z + (tileNoise(tile.x, tile.y, `grass-z-${index}`) - 0.5) * 0.72,
          h: surface + 0.08 + tileNoise(tile.x, tile.y, `grass-h-${index}`) * 0.15,
          scale: 0.65 + tileNoise(tile.x, tile.y, `grass-s-${index}`) * 0.55,
        });
      }
    } else if (tile.terrain === "stone" || tile.terrain === "barren") {
      if (a > 0.28) {
        rocks.push({
          x: position.x + (a - 0.5) * 0.56,
          z: position.z + (b - 0.5) * 0.56,
          scale: 0.22 + tileNoise(tile.x, tile.y, "rock-size") * 0.34,
        });
      }
    } else if (tile.terrain === "water") {
      waterTiles.push(tile);
    }

    if (tile.terrain !== "water" && (
      terrainAt(tile.x + 1, tile.y) === "water" || terrainAt(tile.x - 1, tile.y) === "water" ||
      terrainAt(tile.x, tile.y + 1) === "water" || terrainAt(tile.x, tile.y - 1) === "water"
    ) && a > 0.35) {
      reeds.push({ x: position.x + (a - 0.5) * 0.55, z: position.z + (b - 0.5) * 0.55, h: surface + 0.22 + a * 0.25 });
    }
  }

  const matrix = new THREE.Matrix4();
  const addInstances = (
    entries: readonly unknown[], geometry: THREE.BufferGeometry, surface: THREE.Material,
    apply: (mesh: THREE.InstancedMesh, index: number) => void,
  ) => {
    if (entries.length === 0) {
      geometry.dispose();
      surface.dispose();
      return;
    }
    const mesh = new THREE.InstancedMesh(geometry, surface, entries.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    for (let index = 0; index < entries.length; index += 1) apply(mesh, index);
    mesh.instanceMatrix.needsUpdate = true;
  };
  const instanceMatrix = (mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    matrix.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
    mesh.setMatrixAt(index, matrix);
  };

  addInstances(trees, new THREE.CylinderGeometry(0.075, 0.11, 1, 7), material(0x62432a, { roughness: 0.96 }), (mesh, index) => {
    const tree = trees[index]!;
    instanceMatrix(mesh, index, tree.x, tree.h / 2, tree.z, tree.scale, tree.h, tree.scale);
  });
  addInstances(trees, new THREE.ConeGeometry(0.55, 1, 7), material(0x234d31, { roughness: 0.92 }), (mesh, index) => {
    const tree = trees[index]!;
    instanceMatrix(mesh, index, tree.x, tree.h + 0.42 * tree.scale, tree.z, tree.scale, tree.scale, tree.scale);
  });
  addInstances(grass, new THREE.ConeGeometry(0.045, 0.34, 4), material(0x8baa55, { roughness: 1 }), (mesh, index) => {
    const tuft = grass[index]!;
    instanceMatrix(mesh, index, tuft.x, tuft.h, tuft.z, tuft.scale, tuft.scale, tuft.scale);
  });
  addInstances(rocks, new THREE.DodecahedronGeometry(0.5, 0), material(0x72716b, { roughness: 0.9 }), (mesh, index) => {
    const rock = rocks[index]!;
    const terrain = terrainAt(Math.round(rock.x + (map.width - 1) / 2), Math.round(rock.z + (map.height - 1) / 2)) ?? "barren";
    instanceMatrix(mesh, index, rock.x, terrainSurfaceHeight(terrain) + rock.scale * 0.55, rock.z, rock.scale, rock.scale * 0.8, rock.scale);
  });
  addInstances(reeds, new THREE.ConeGeometry(0.035, 0.45, 4), material(0xb1a96b, { roughness: 1 }), (mesh, index) => {
    const reed = reeds[index]!;
    instanceMatrix(mesh, index, reed.x, reed.h, reed.z, 0.75, 0.75, 0.75);
  });

  if (waterTiles.length > 0) {
    const water = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.98, 0.055, 0.98),
      material(0x1f7897, { roughness: 0.18, metalness: 0.38, transparent: true, opacity: 0.82 }),
      waterTiles.length,
    );
    water.receiveShadow = true;
    waterTiles.forEach((tile, index) => {
      const position = tilePosition(map, tile);
      matrix.makeTranslation(position.x, -0.075, position.z);
      water.setMatrixAt(index, matrix);
    });
    water.instanceMatrix.needsUpdate = true;
    scene.add(water);
  }
}

/**
 * Every structure kind which can be built by the engine gets an explicit
 * single-tile native model. Map records do not have an orientation field, so
 * directional structures render a symmetric footprint rather than inventing
 * a direction that the canonical state did not provide.
 */
function createStructure(structure: Structure): THREE.Group {
  const group = new THREE.Group();
  const kind = structure.kind.toLowerCase();
  const condition = clamp01(structure.condition);
  const integrityColour = new THREE.Color(0x9a7650).lerp(new THREE.Color(0x4a2f27), 1 - condition).getHex();
  const wall = material(integrityColour, { roughness: 0.88 });
  const stonework = material(0x77716a, { roughness: 0.94 });
  const dark = material(0x20262b, { roughness: 0.44, metalness: 0.62 });
  const roof = material(0x6d3930, { roughness: 0.8 });
  const accent = material(0xd4a94b, { emissive: 0x3b2608, emissiveIntensity: 0.35 });
  const window = material(0x7bb6bf, { roughness: 0.18, metalness: 0.2, emissive: 0x18343a, emissiveIntensity: 0.45 });
  const addBox = (w: number, h: number, d: number, source: THREE.Material, x: number, y: number, z: number) => {
    const item = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), source);
    item.position.set(x, y, z);
    item.castShadow = true;
    item.receiveShadow = true;
    group.add(item);
    return item;
  };
  const addCylinder = (top: number, bottom: number, h: number, source: THREE.Material, x: number, y: number, z: number) => {
    const item = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, h, 10), source);
    item.position.set(x, y, z);
    item.castShadow = true;
    item.receiveShadow = true;
    group.add(item);
    return item;
  };

  addBox(0.92, 0.1, 0.92, stonework, 0, 0.05, 0);
  if (kind.includes("well")) {
    addCylinder(0.32, 0.36, 0.35, stonework, 0, 0.22, 0);
    addCylinder(0.16, 0.16, 0.04, dark, 0, 0.42, 0);
    addBox(0.78, 0.08, 0.08, roof, 0, 0.9, 0);
    addBox(0.08, 0.72, 0.08, roof, -0.28, 0.62, 0);
    addBox(0.08, 0.72, 0.08, roof, 0.28, 0.62, 0);
  } else if (kind.includes("road") || kind.includes("bridge")) {
    addBox(0.92, 0.12, 0.92, kind.includes("bridge") ? roof : wall, 0, 0.14, 0);
    for (const z of [-0.28, 0, 0.28]) addBox(0.82, 0.035, 0.08, accent, 0, 0.23, z);
    if (kind.includes("bridge")) {
      for (const x of [-0.38, 0.38]) {
        addBox(0.05, 0.38, 0.05, dark, x, 0.38, -0.34);
        addBox(0.05, 0.38, 0.05, dark, x, 0.38, 0.34);
      }
    }
  } else if (kind.includes("wall") || kind.includes("enclosure")) {
    for (const [x, z, w, d] of [[0, -0.39, 0.9, 0.1], [0, 0.39, 0.9, 0.1], [-0.39, 0, 0.1, 0.9], [0.39, 0, 0.1, 0.9]] as const) {
      addBox(w, 0.55, d, wall, x, 0.34, z);
    }
    for (const [x, z] of [[-0.39, -0.39], [0.39, -0.39], [-0.39, 0.39], [0.39, 0.39]] as const) addCylinder(0.06, 0.08, 0.82, dark, x, 0.46, z);
  } else if (kind.includes("monument") || kind.includes("cairn")) {
    const obelisk = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.25, 4), stonework);
    obelisk.position.y = 0.7;
    obelisk.castShadow = true;
    group.add(obelisk);
    addBox(0.16, 0.16, 0.12, accent, 0, 0.64, 0.3);
  } else if (kind.includes("vault")) {
    addBox(0.84, 0.65, 0.78, dark, 0, 0.42, 0);
    addBox(0.58, 0.48, 0.05, stonework, 0, 0.42, 0.42);
    addCylinder(0.11, 0.11, 0.07, accent, 0, 0.42, 0.47).rotation.x = Math.PI / 2;
  } else if (kind.includes("workshop") || kind.includes("smelter") || kind.includes("forge")) {
    addBox(0.76, 0.58, 0.7, wall, 0, 0.36, 0);
    const roofLeft = addBox(0.48, 0.1, 0.78, roof, -0.18, 0.73, 0);
    roofLeft.rotation.z = -0.34;
    const roofRight = addBox(0.48, 0.1, 0.78, roof, 0.18, 0.73, 0);
    roofRight.rotation.z = 0.34;
    addBox(0.18, 0.52, 0.18, dark, 0.22, 0.84, 0.08);
    addBox(0.17, 0.11, 0.07, accent, -0.18, 0.42, 0.38);
    addBox(0.16, 0.21, 0.055, window, 0.12, 0.42, 0.38);
  } else if (kind.includes("hall") || kind.includes("assembly")) {
    addBox(0.84, 0.78, 0.76, wall, 0, 0.46, 0);
    const roofLeft = addBox(0.58, 0.12, 0.86, roof, -0.22, 0.94, 0);
    roofLeft.rotation.z = -0.32;
    const roofRight = addBox(0.58, 0.12, 0.86, roof, 0.22, 0.94, 0);
    roofRight.rotation.z = 0.32;
    addBox(0.12, 0.46, 0.08, accent, 0, 0.42, 0.42);
    addBox(0.16, 0.22, 0.055, window, -0.25, 0.55, 0.41);
    addBox(0.16, 0.22, 0.055, window, 0.25, 0.55, 0.41);
  } else if (kind.includes("store") || kind.includes("granary") || kind.includes("silo")) {
    addBox(0.78, 0.65, 0.72, wall, 0, 0.4, 0);
    addBox(0.87, 0.13, 0.81, roof, 0, 0.8, 0);
    addBox(0.5, 0.12, 0.06, accent, 0, 0.34, 0.39);
    for (const x of [-0.32, 0.32]) addBox(0.07, 0.7, 0.07, dark, x, 0.42, -0.29);
  } else if (kind.includes("shelter") || kind.includes("house")) {
    addBox(0.76, 0.54, 0.7, wall, 0, 0.34, 0);
    const roofLeft = addBox(0.55, 0.1, 0.78, roof, -0.2, 0.74, 0);
    roofLeft.rotation.z = -0.38;
    const roofRight = addBox(0.55, 0.1, 0.78, roof, 0.2, 0.74, 0);
    roofRight.rotation.z = 0.38;
    addBox(0.16, 0.3, 0.055, dark, 0, 0.23, 0.38);
    addBox(0.12, 0.14, 0.055, window, 0.24, 0.45, 0.38);
  } else {
    // Do not disguise an unknown future kind as a known building. The bright
    // beacon makes the incomplete visual vocabulary auditable in the map.
    const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.34, 0), material(0xff3d9b, { emissive: 0x5f062f, emissiveIntensity: 0.85 }));
    marker.position.y = 0.46;
    marker.castShadow = true;
    group.add(marker);
    group.userData.unsupportedCanonicalKind = !hasDedicatedStructureVisual(kind);
  }

  if (condition < 0.5) {
    const damage = addBox(0.6, 0.05, 0.05, dark, 0, 0.52, 0.43);
    damage.rotation.z = -0.35;
  }
  group.userData.structureId = structure.id;
  group.userData.mapTile = structure.at;
  return group;
}

function characterReference(
  occupant: WorldMap["occupants"][number],
): SceneReference {
  return {
    refId: `MAP:CURRENT:ENT:${occupant.id}` as SceneReference["refId"],
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    representation: {
      kind: "articulated_entity",
      visualSeed: occupant.id,
      ...(characterKeyForCanonicalId(occupant.id) === null ? {} : { characterKey: characterKeyForCanonicalId(occupant.id)! }),
      componentRefs: [],
      material: null,
    },
    activity: null,
    cameraAnchors: [],
    capabilities: {},
    epistemicLabel: "CANONICAL_FACT",
  };
}

export function WorldMapThreeView({
  map,
  compact = false,
  selected,
  onSelect,
}: {
  map: WorldMap;
  compact?: boolean;
  selected: MapTileSelection;
  onSelect: (tile: MapTileSelection) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const projection = projectWorldMap(map);
    const discovered = new Set(map.discovered ?? []);
    const canSee = (x: number, y: number) => map.discovered === undefined || discovered.has(`${x},${y}`);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x091016);
    scene.fog = new THREE.FogExp2(0x091016, 0.022);
    const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 150);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.22;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.replaceChildren(renderer.domElement);

    const worldRadius = Math.max(map.width, map.height) / 2;
    const sun = new THREE.DirectionalLight(0xffe3bc, 3.2);
    sun.position.set(worldRadius, worldRadius * 2.4, worldRadius * 0.7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -worldRadius - 4;
    sun.shadow.camera.right = sun.shadow.camera.top = worldRadius + 4;
    scene.add(new THREE.HemisphereLight(0xb9dcff, 0x253019, 1.65), sun);

    const selectable: THREE.Object3D[] = [];
    const terrainMeshes = new Map<string, THREE.InstancedMesh>();
    let terrainAssetCancelled = false;
    const terrainByKind = new Map<string, Tile[]>();
    for (const tile of map.tiles) {
      const kind = canSee(tile.x, tile.y) ? tile.terrain : "undiscovered";
      terrainByKind.set(kind, [...(terrainByKind.get(kind) ?? []), tile]);
    }
    for (const [kind, tiles] of terrainByKind) {
      const height = terrainSurfaceHeight(kind);
      const blockHeight = kind === "water" ? 0.12 : Math.max(0.24, height + 0.24);
      const terrain = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.985, blockHeight, 0.985),
        material(TERRAIN[kind] ?? 0x526252, {
          roughness: kind === "water" ? 0.2 : kind === "stone" || kind === "stone_deposit" ? 0.82 : 0.94,
          metalness: kind === "water" ? 0.3 : 0.01,
        }),
        tiles.length,
      );
      const matrix = new THREE.Matrix4();
      tiles.forEach((tile, index) => {
        const position = tilePosition(map, tile);
        matrix.makeTranslation(position.x, height - blockHeight / 2, position.z);
        terrain.setMatrixAt(index, matrix);
      });
      terrain.instanceMatrix.needsUpdate = true;
      terrain.receiveShadow = true;
      terrain.userData.mapTiles = tiles;
      scene.add(terrain);
      selectable.push(terrain);
      terrainMeshes.set(kind, terrain);
    }
    addLandscape(scene, map, canSee);
    void applyTerrainAsset(
      scene,
      terrainMeshes,
      map,
      canSee,
      () => terrainAssetCancelled,
    );

    const characterModels: ObservatoryCharacterModel[] = [];
    for (const structure of projection.structures) {
      if (!canSee(structure.at.x, structure.at.y)) continue;
      const model = createStructure(structure.structure);
      model.position.set(structure.position.x, terrainSurfaceHeight(map.tiles[structure.at.y * map.width + structure.at.x]?.terrain ?? "plains"), structure.position.z);
      scene.add(model);
      selectable.push(model);
    }
    const perTile = new Map<string, number>();
    for (const occupant of projection.inhabitants) {
      if (!canSee(occupant.at.x, occupant.at.y)) continue;
      const key = `${occupant.at.x},${occupant.at.y}`;
      const numberOnTile = perTile.get(key) ?? 0;
      perTile.set(key, numberOnTile + 1);
      const model = createObservatoryCharacter(characterReference(occupant));
      const tile = map.tiles[occupant.at.y * map.width + occupant.at.x];
      const offset = numberOnTile === 0 ? 0 : numberOnTile % 2 === 0 ? -0.18 : 0.18;
      model.group.position.set(occupant.position.x + offset, terrainSurfaceHeight(tile?.terrain ?? "plains"), occupant.position.z + (numberOnTile > 1 ? 0.12 : 0));
      model.group.userData.mapTile = occupant.at;
      model.group.userData.inhabitantId = occupant.id;
      if (occupant.status === "deceased") {
        model.group.scale.multiplyScalar(0.68);
        model.group.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            materials.forEach((source) => { source.transparent = true; source.opacity = 0.4; });
          }
        });
      }
      scene.add(model.group);
      selectable.push(model.group);
      characterModels.push(model);
    }

    const selection = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.03, 0.09, 1.03)),
      new THREE.LineBasicMaterial({ color: 0xf2c55c }),
    );
    scene.add(selection);
    const setSelection = (tile: MapTileSelection) => {
      const position = tilePosition(map, tile);
      selection.position.set(position.x, 0.34, position.z);
    };
    setSelection(selected);

    const centre = new THREE.Vector3(0, 0, 0);
    let yaw = Math.PI * 0.82;
    // Start high enough that the complete authoritative grid is legible; the
    // wheel then gives a close, model-level inspection without losing context.
    let pitch = 1.06;
    // Frame the complete world but keep individual buildings and landscape
    // materials readable at first load. The wheel still reaches a strategic
    // overview for a 64×64 settlement.
    let distance = Math.max(map.width, map.height) * 1.18;
    let wantedYaw = yaw;
    let wantedPitch = pitch;
    let wantedDistance = distance;
    const updateCamera = () => {
      const horizontal = Math.cos(pitch) * distance;
      camera.position.set(Math.sin(yaw) * horizontal, Math.sin(pitch) * distance, Math.cos(yaw) * horizontal);
      camera.lookAt(centre);
      camera.updateProjectionMatrix();
    };

    const canvas = renderer.domElement;
    let dragging = false;
    let moved = false;
    let lastX = 0;
    let lastY = 0;
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
      wantedYaw -= dx * 0.007;
      wantedPitch = THREE.MathUtils.clamp(wantedPitch + dy * 0.005, 0.18, 1.25);
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const up = (event: PointerEvent) => {
      dragging = false;
      if (moved) return;
      const bounds = canvas.getBoundingClientRect();
      const pointer = new THREE.Vector2(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
      const raycaster = new THREE.Raycaster();
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(selectable, true)[0];
      if (!hit) return;
      const instanceTile = hit.object instanceof THREE.InstancedMesh && hit.instanceId !== undefined
        ? (hit.object.userData.mapTiles as Tile[] | undefined)?.[hit.instanceId]
        : undefined;
      let owner: THREE.Object3D | null = hit.object;
      while (owner && owner.userData.mapTile === undefined) owner = owner.parent;
      const tile = instanceTile ?? owner?.userData.mapTile as MapTileSelection | undefined;
      if (tile) onSelectRef.current({ x: tile.x, y: tile.y });
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      wantedDistance = THREE.MathUtils.clamp(wantedDistance + event.deltaY * 0.015, 5, Math.max(map.width, map.height) * 2.3);
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", wheel, { passive: false });

    const resize = () => {
      const width = Math.max(mount.clientWidth, 1);
      const height = Math.max(mount.clientHeight, 1);
      // Three renders at device-pixel resolution. Leaving CSS sizing disabled
      // made a Retina canvas twice the size of its mount and clipped the view
      // to its top-left quarter, making the centred world look bottom-right.
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    const started = performance.now();
    let frame = 0;
    const render = () => {
      const elapsed = (performance.now() - started) / 1000;
      yaw = THREE.MathUtils.lerp(yaw, wantedYaw, 0.12);
      pitch = THREE.MathUtils.lerp(pitch, wantedPitch, 0.12);
      distance = THREE.MathUtils.lerp(distance, wantedDistance, 0.12);
      characterModels.forEach((character) => character.update(elapsed));
      updateCamera();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();

    return () => {
      terrainAssetCancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("wheel", wheel);
      scene.traverse((node) => {
        if (node instanceof THREE.Mesh || node instanceof THREE.InstancedMesh) {
          node.geometry.dispose();
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          materials.forEach((source) => source.dispose());
        }
      });
      renderer.dispose();
      canvas.remove();
    };
  }, [map, selected]);

  return <div ref={mountRef} className={`${compact ? "h-[22rem] min-h-[18rem]" : "h-[38rem] min-h-[30rem]"} w-full cursor-grab active:cursor-grabbing`} role="img" aria-label="Interactive authoritative 3D world map. Each character and structure is anchored to its recorded tile." />;
}
