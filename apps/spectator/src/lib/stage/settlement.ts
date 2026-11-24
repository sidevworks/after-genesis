// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import {
  BoxGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Material,
  type Scene,
} from "three";
import {
  projectSettlementAt,
  type SettlementProjectionSource,
} from "../city/project-settlement";

interface BuildingVisual {
  readonly builtAt: number;
  readonly group: Group;
}

/** Persistent city-scale presentation reconstructed from canonical history. */
export class SettlementStage {
  private readonly buildings: BuildingVisual[] = [];
  private readonly roadMeshes = new Map<string, Mesh>();
  private readonly stockpileMeshes = new Map<string, Mesh[]>();
  private readonly geometries = [
    new BoxGeometry(1, 1, 1),
    new ConeGeometry(1, 0.7, 4),
  ];
  private readonly materials: Material[] = [
    new MeshStandardMaterial({ color: 0x806347, roughness: 1 }),
    new MeshStandardMaterial({ color: 0xa27745, roughness: 0.92 }),
    new MeshStandardMaterial({ color: 0x59636c, roughness: 0.96 }),
    new MeshStandardMaterial({ color: 0x4d3829, roughness: 1 }),
  ];
  private lastTick = -1;

  constructor(
    private readonly scene: Scene,
    private readonly source: SettlementProjectionSource,
  ) {
    for (const structure of source.map.structures) {
      const group = new Group();
      group.position.set(structure.at.x, 0, structure.at.y);
      const body = new Mesh(this.geometries[0]!, this.materials[1]!);
      body.position.y = 0.58;
      body.scale.set(structure.kind === "hall" ? 1.8 : 1.35, 1.08, 1.3);
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);

      const roof = new Mesh(this.geometries[1]!, this.materials[3]!);
      roof.position.y = 1.38;
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(structure.kind === "hall" ? 1.4 : 1.05, 0.7, structure.kind === "hall" ? 1.4 : 1.05);
      roof.castShadow = true;
      group.add(roof);

      const door = new Mesh(this.geometries[0]!, this.materials[3]!);
      door.position.set(0, 0.4, 0.66);
      door.scale.set(0.3, 0.64, 0.08);
      group.add(door);

      if (structure.kind === "well") {
        body.scale.set(0.9, 0.45, 0.9);
        roof.position.y = 1.42;
        roof.scale.set(0.78, 0.45, 0.78);
        door.visible = false;
        for (const x of [-0.52, 0.52]) {
          const post = new Mesh(this.geometries[0]!, this.materials[3]!);
          post.position.set(x, 0.76, 0);
          post.scale.set(0.12, 1.15, 0.12);
          post.castShadow = true;
          group.add(post);
        }
      } else if (structure.kind === "store") {
        body.scale.set(1.5, 0.85, 1.25);
        // External stacked goods make storage readable even in a wide shot.
        for (let index = 0; index < 3; index += 1) {
          const crate = new Mesh(this.geometries[0]!, this.materials[0]!);
          crate.position.set(-0.9 + index * 0.28, 0.16, 0.45);
          crate.scale.set(0.24, 0.28, 0.24);
          crate.castShadow = true;
          group.add(crate);
        }
      } else if (structure.kind === "workshop") {
        const chimney = new Mesh(this.geometries[0]!, this.materials[2]!);
        chimney.position.set(0.42, 1.42, -0.28);
        chimney.scale.set(0.22, 0.9, 0.22);
        chimney.castShadow = true;
        group.add(chimney);
        const awning = new Mesh(this.geometries[0]!, this.materials[0]!);
        awning.position.set(-0.66, 0.78, 0.48);
        awning.rotation.x = -0.22;
        awning.scale.set(0.72, 0.08, 0.54);
        awning.castShadow = true;
        group.add(awning);
      } else if (structure.kind === "bridge") {
        body.position.y = 0.18;
        body.scale.set(2.2, 0.24, 0.86);
        roof.visible = false;
        door.visible = false;
        for (const z of [-0.46, 0.46]) {
          const rail = new Mesh(this.geometries[0]!, this.materials[3]!);
          rail.position.set(0, 0.52, z);
          rail.scale.set(2.15, 0.1, 0.1);
          rail.castShadow = true;
          group.add(rail);
        }
      } else if (structure.kind === "monument") {
        body.position.y = 0.72;
        body.scale.set(0.72, 1.35, 0.72);
        roof.position.y = 1.72;
        roof.scale.set(0.58, 0.85, 0.58);
        door.visible = false;
      }
      group.visible = false;
      scene.add(group);
      this.buildings.push({ builtAt: structure.builtAt, group });
    }
  }

  update(tick: number): void {
    const wholeTick = Math.floor(tick);
    if (wholeTick === this.lastTick) return;
    this.lastTick = wholeTick;
    const projection = projectSettlementAt(this.source, wholeTick);

    for (const building of this.buildings) building.group.visible = building.builtAt <= wholeTick;

    const activeRoads = new Set<string>();
    for (const road of projection.roads.filter((item) => item.traversals >= 2)) {
      const key = `${road.at.x},${road.at.y}`;
      activeRoads.add(key);
      let mesh = this.roadMeshes.get(key);
      if (mesh === undefined) {
        mesh = new Mesh(this.geometries[0]!, this.materials[0]!);
        mesh.position.set(road.at.x, 0.018, road.at.y);
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        this.roadMeshes.set(key, mesh);
      }
      mesh.scale.set(0.88, 0.035, 0.88);
      mesh.visible = true;
    }
    for (const [key, mesh] of this.roadMeshes) {
      if (!activeRoads.has(key)) mesh.visible = false;
    }

    for (const stockpile of projection.stockpiles) {
      let crates = this.stockpileMeshes.get(stockpile.structureId);
      if (crates === undefined) {
        crates = Array.from({ length: 6 }, (_, index) => {
          const crate = new Mesh(this.geometries[0]!, this.materials[1]!);
          crate.position.set(
            stockpile.at.x + 0.85 + (index % 2) * 0.28,
            0.14 + Math.floor(index / 2) * 0.26,
            stockpile.at.y - 0.3 + (index % 2) * 0.26,
          );
          crate.scale.set(0.24, 0.24, 0.24);
          crate.castShadow = true;
          this.scene.add(crate);
          return crate;
        });
        this.stockpileMeshes.set(stockpile.structureId, crates);
      }
      const units = Object.values(stockpile.recordedNet).reduce((sum, value) => sum + Math.max(value ?? 0, 0), 0);
      const visible = Math.min(crates.length, Math.ceil(units / 4));
      crates.forEach((crate, index) => { crate.visible = index < visible; });
    }
  }

  dispose(): void {
    for (const building of this.buildings) this.scene.remove(building.group);
    for (const mesh of this.roadMeshes.values()) this.scene.remove(mesh);
    for (const crates of this.stockpileMeshes.values()) {
      for (const crate of crates) this.scene.remove(crate);
    }
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
  }
}
