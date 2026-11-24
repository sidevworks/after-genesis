// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * The ground the record happened on.
 *
 * ## Canonical and derived, precisely
 *
 * Canonical: which terrain kind occupies each tile. That is generated
 * deterministically from the published Genesis seed and is part of world state.
 *
 * Derived: everything else here. Block height, colour jitter, where individual
 * trees stand within a forest tile, where boulders sit on stone, the reeds at a
 * waterline, and the motion of the water. The record says a tile is `forest`; it
 * has never said anything about a tree. These objects exist so that a forest
 * tile reads as a forest, and they must never be mistaken for entities — they
 * carry no Reference ID, they cannot be selected, and nothing in the Observatory
 * indexes them (claude.md §12).
 *
 * ## Why it is instanced
 *
 * A 32×32 map is 1,024 ground tiles plus roughly as many scatter objects. The
 * previous viewport created a separate `Mesh` for each one and rebuilt all of
 * them whenever a prop changed. Here every tile of a given terrain kind is one
 * instance in a single `InstancedMesh`, so the whole map is a handful of draw
 * calls and the per-frame cost is zero except for the water.
 *
 * ## Why the scatter is hashed rather than random
 *
 * `Math.random()` would give a different forest on every page load, so two
 * spectators comparing the same tick would see different worlds and a
 * screenshot would not reproduce. Every placement here is a pure function of
 * the tile coordinate, so the world looks the same to everyone, forever.
 */
import {
  BoxGeometry,
  Color,
  ConeGeometry,
  DodecahedronGeometry,
  BufferGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  type Scene,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {
  SCATTER_COLOURS,
  TERRAIN_COLOURS,
  TERRAIN_HEIGHTS,
  TERRAIN_JITTER,
  TERRAIN_KINDS,
  TERRAIN_ROUGHNESS,
  hashString,
  shadeHex,
  terrainKind,
  type TerrainKind,
} from "./palette";

export interface TerrainMap {
  readonly width: number;
  readonly height: number;
  readonly terrain: readonly string[];
}

/** Sim minutes for one full swell of the water surface. Presentation. */
const WATER_PERIOD_MINUTES = 220;

/** Metres the water surface rises and falls. Small on purpose. */
const WATER_AMPLITUDE = 0.045;

/** Top of the ground plane sits at y = 0, so an actor's feet rest at zero. */
const GROUND_TOP = 0;

/** Water sits below the bank, which is what makes a shoreline read as one. */
const WATER_DROP = 0.16;

interface WaterInstance {
  readonly index: number;
  readonly x: number;
  readonly z: number;
  readonly phase: number;
}

/**
 * A deterministic 0..1 from a tile coordinate and a purpose.
 *
 * Salted per purpose so that the same tile does not produce correlated answers
 * for "how tall is this tree" and "is there a tree at all".
 */
function tileHash(x: number, z: number, salt: string): number {
  return hashString(`${salt}:${x},${z}`);
}

export class Terrain {
  private readonly scene: Scene;
  private readonly map: TerrainMap;
  private readonly meshes: InstancedMesh[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: MeshStandardMaterial[] = [];

  private waterMesh: InstancedMesh | null = null;
  private readonly waterInstances: WaterInstance[] = [];

  /** Reused for every matrix write; the point of the class is to allocate none. */
  private readonly scratch = new Object3D();
  private readonly scratchMatrix = new Matrix4();
  private readonly scratchColour = new Color();

  constructor(scene: Scene, map: TerrainMap) {
    this.scene = scene;
    this.map = map;
    this.buildGround();
    this.buildScatter();
  }

  /* ---------------------------------------------------------------- ground */

  private buildGround(): void {
    const byKind = new Map<TerrainKind, Array<{ x: number; z: number }>>();
    for (const kind of TERRAIN_KINDS) byKind.set(kind, []);

    for (let z = 0; z < this.map.height; z += 1) {
      for (let x = 0; x < this.map.width; x += 1) {
        const kind = terrainKind(this.map.terrain[z * this.map.width + x]);
        byKind.get(kind)?.push({ x, z });
      }
    }

    for (const kind of TERRAIN_KINDS) {
      const tiles = byKind.get(kind);
      if (tiles === undefined || tiles.length === 0) continue;

      const blockHeight = TERRAIN_HEIGHTS[kind];
      const geometry = new RoundedBoxGeometry(1, blockHeight, 1, 2, kind === "water" ? 0.03 : 0.05);
      const material = new MeshStandardMaterial({
        color: TERRAIN_COLOURS[kind],
        roughness: TERRAIN_ROUGHNESS[kind],
        metalness: kind === "water" ? 0.16 : 0,
        transparent: kind === "water",
        opacity: kind === "water" ? 0.86 : 1,
      });
      const mesh = new InstancedMesh(geometry, material, tiles.length);
      mesh.receiveShadow = true;
      mesh.castShadow = kind !== "water";

      const jitter = TERRAIN_JITTER[kind];
      for (const [index, tile] of tiles.entries()) {
        const drop = kind === "water" ? WATER_DROP : 0;
        this.scratch.position.set(
          tile.x,
          GROUND_TOP - blockHeight / 2 - drop,
          tile.z,
        );
        this.scratch.rotation.set(0, 0, 0);
        this.scratch.scale.set(1, 1, 1);
        this.scratch.updateMatrix();
        mesh.setMatrixAt(index, this.scratch.matrix);

        // Per-tile shade variation, so a field of one terrain kind does not
        // read as a single flat sheet of colour.
        const shade = 1 + (tileHash(tile.x, tile.z, "shade") - 0.5) * 2 * jitter;
        this.scratchColour.setHex(shadeHex(TERRAIN_COLOURS[kind], shade));
        mesh.setColorAt(index, this.scratchColour);

        if (kind === "water") {
          this.waterInstances.push({
            index,
            x: tile.x,
            z: tile.z,
            phase: tileHash(tile.x, tile.z, "wave"),
          });
        }
      }

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;

      if (kind === "water") this.waterMesh = mesh;
      this.scene.add(mesh);
      this.meshes.push(mesh);
      this.geometries.push(geometry);
      this.materials.push(material);
    }
  }

  /* --------------------------------------------------------------- scatter */

  /**
   * Trees, boulders and reeds.
   *
   * Placement, height and lean are all hashed from the tile coordinate. The
   * density thresholds are chosen so a forest reads as woodland rather than as
   * an orchard — roughly half of forest tiles carry a tree, and the ones that
   * do offset it from the tile centre so the rows do not line up.
   */
  private buildScatter(): void {
    const trunks: Array<{ x: number; z: number; h: number; ox: number; oz: number }> = [];
    const crowns: Array<{ x: number; z: number; h: number; ox: number; oz: number; alt: boolean }> =
      [];
    const boulders: Array<{ x: number; z: number; s: number; ox: number; oz: number }> = [];
    const reeds: Array<{ x: number; z: number; h: number; ox: number; oz: number }> = [];

    const kindAt = (x: number, z: number): TerrainKind | null => {
      if (x < 0 || z < 0 || x >= this.map.width || z >= this.map.height) return null;
      return terrainKind(this.map.terrain[z * this.map.width + x]);
    };

    for (let z = 0; z < this.map.height; z += 1) {
      for (let x = 0; x < this.map.width; x += 1) {
        const kind = kindAt(x, z);
        if (kind === null) continue;

        const offsetX = (tileHash(x, z, "ox") - 0.5) * 0.52;
        const offsetZ = (tileHash(x, z, "oz") - 0.5) * 0.52;

        if (kind === "forest" && tileHash(x, z, "tree") > 0.42) {
          const trunkHeight = 0.9 + tileHash(x, z, "th") * 0.8;
          trunks.push({ x, z, h: trunkHeight, ox: offsetX, oz: offsetZ });
          crowns.push({
            x,
            z,
            h: trunkHeight,
            ox: offsetX,
            oz: offsetZ,
            alt: tileHash(x, z, "crown") > 0.5,
          });
        }

        if ((kind === "stone" || kind === "stone_deposit") && tileHash(x, z, "rock") > 0.55) {
          boulders.push({
            x,
            z,
            s: 0.24 + tileHash(x, z, "rs") * 0.3,
            ox: offsetX,
            oz: offsetZ,
          });
        }

        // Reeds grow on the bank, not in the channel: a non-water tile that
        // touches water.
        if (kind !== "water" && tileHash(x, z, "reed") > 0.72) {
          const touchesWater =
            kindAt(x + 1, z) === "water" ||
            kindAt(x - 1, z) === "water" ||
            kindAt(x, z + 1) === "water" ||
            kindAt(x, z - 1) === "water";
          if (touchesWater) {
            reeds.push({
              x,
              z,
              h: 0.35 + tileHash(x, z, "rh") * 0.3,
              ox: offsetX,
              oz: offsetZ,
            });
          }
        }
      }
    }

    this.addInstances(
      trunks.length,
      new BoxGeometry(0.17, 1, 0.17),
      new MeshStandardMaterial({ color: SCATTER_COLOURS.trunk, roughness: 1 }),
      (index, mesh) => {
        const item = trunks[index]!;
        this.scratch.position.set(item.x + item.ox, GROUND_TOP + item.h / 2, item.z + item.oz);
        this.scratch.rotation.set(0, tileHash(item.x, item.z, "ry") * Math.PI, 0);
        this.scratch.scale.set(1, item.h, 1);
        this.scratch.updateMatrix();
        mesh.setMatrixAt(index, this.scratch.matrix);
      },
      true,
    );

    this.addInstances(
      crowns.length,
      new ConeGeometry(0.62, 1, 6),
      new MeshStandardMaterial({ color: SCATTER_COLOURS.crown, roughness: 0.95 }),
      (index, mesh) => {
        const item = crowns[index]!;
        const crownHeight = 1.1 + tileHash(item.x, item.z, "ch") * 0.7;
        this.scratch.position.set(
          item.x + item.ox,
          GROUND_TOP + item.h + crownHeight / 2 - 0.12,
          item.z + item.oz,
        );
        this.scratch.rotation.set(0, tileHash(item.x, item.z, "cy") * Math.PI, 0);
        this.scratch.scale.set(1, crownHeight, 1);
        this.scratch.updateMatrix();
        mesh.setMatrixAt(index, this.scratch.matrix);
        this.scratchColour.setHex(
          item.alt ? SCATTER_COLOURS.crownAlt : SCATTER_COLOURS.crown,
        );
        mesh.setColorAt(index, this.scratchColour);
      },
      true,
    );

    this.addInstances(
      boulders.length,
      new DodecahedronGeometry(1, 0),
      new MeshStandardMaterial({ color: SCATTER_COLOURS.boulder, roughness: 0.98 }),
      (index, mesh) => {
        const item = boulders[index]!;
        this.scratch.position.set(
          item.x + item.ox,
          GROUND_TOP + item.s * 0.62,
          item.z + item.oz,
        );
        this.scratch.rotation.set(
          tileHash(item.x, item.z, "rx") * 0.8,
          tileHash(item.x, item.z, "rry") * Math.PI,
          tileHash(item.x, item.z, "rz") * 0.8,
        );
        this.scratch.scale.set(item.s, item.s * 0.78, item.s);
        this.scratch.updateMatrix();
        mesh.setMatrixAt(index, this.scratch.matrix);
      },
      true,
    );

    this.addInstances(
      reeds.length,
      new BoxGeometry(0.06, 1, 0.06),
      new MeshStandardMaterial({ color: SCATTER_COLOURS.reed, roughness: 1 }),
      (index, mesh) => {
        const item = reeds[index]!;
        this.scratch.position.set(item.x + item.ox, GROUND_TOP + item.h / 2, item.z + item.oz);
        this.scratch.rotation.set(
          (tileHash(item.x, item.z, "lx") - 0.5) * 0.34,
          0,
          (tileHash(item.x, item.z, "lz") - 0.5) * 0.34,
        );
        this.scratch.scale.set(1, item.h, 1);
        this.scratch.updateMatrix();
        mesh.setMatrixAt(index, this.scratch.matrix);
      },
      false,
    );
  }

  private addInstances(
    count: number,
    geometry: BufferGeometry,
    material: MeshStandardMaterial,
    write: (index: number, mesh: InstancedMesh) => void,
    castShadow: boolean,
  ): void {
    if (count === 0) {
      geometry.dispose();
      material.dispose();
      return;
    }
    const mesh = new InstancedMesh(geometry, material, count);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    for (let index = 0; index < count; index += 1) write(index, mesh);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
    this.meshes.push(mesh);
    this.geometries.push(geometry);
    this.materials.push(material);
  }

  /* ----------------------------------------------------------------- frame */

  /**
   * The only per-frame work the ground does.
   *
   * Water rises and falls on a hashed per-tile phase, which is enough to stop
   * the map reading as a photograph without implying any canonical current or
   * weather. Nothing else in the terrain moves, because nothing else in the
   * record changes.
   */
  update(tick: number): void {
    const mesh = this.waterMesh;
    if (mesh === null || this.waterInstances.length === 0) return;

    const base = (tick / WATER_PERIOD_MINUTES) * Math.PI * 2;
    const blockHeight = TERRAIN_HEIGHTS.water;

    for (const instance of this.waterInstances) {
      const lift = Math.sin(base + instance.phase * Math.PI * 2) * WATER_AMPLITUDE;
      this.scratchMatrix.makeTranslation(
        instance.x,
        GROUND_TOP - blockHeight / 2 - WATER_DROP + lift,
        instance.z,
      );
      mesh.setMatrixAt(instance.index, this.scratchMatrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      this.scene.remove(mesh);
      mesh.dispose();
    }
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.meshes.length = 0;
    this.geometries.length = 0;
    this.materials.length = 0;
    this.waterInstances.length = 0;
    this.waterMesh = null;
  }
}
