/**
 * Presentation-derived physical process props.
 *
 * Canonical activities say what happened, where, and for how long. They do not
 * record individual blocks, tool strokes, or material piles. This module turns
 * disclosed activity progress into a deterministic visual proxy without
 * promoting those invented sub-steps to world facts.
 */
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Scene,
} from "three";
import type { ActorSample } from "../cinema/types";
import { hashString } from "./palette";

export type ProcessKind = "construction" | "gathering" | "crafting";

export interface ProcessVisual {
  readonly key: string;
  readonly kind: ProcessKind;
  readonly progress: number;
  readonly x: number;
  readonly z: number;
  /** Always true: block order and prop motion are not canonical facts. */
  readonly derived: true;
}

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

export function processVisualFor(actor: ActorSample): ProcessVisual | null {
  if (!actor.present || actor.disclosure !== "disclosed") return null;
  const action = actor.actionType.toLowerCase();
  const state = actor.activityState.toLowerCase();
  const kind: ProcessKind | null =
    action === "build" ||
    action === "structure.built" ||
    state === "building" ||
    state === "construction"
      ? "construction"
      : action === "gather" || state === "gathering"
        ? "gathering"
        : action === "craft" || action === "artifact.created" || state === "crafting"
          ? "crafting"
          : null;
  if (kind === null) return null;
  return {
    key: actor.segment.activityId ?? actor.segment.id,
    kind,
    progress: clamp01(actor.progress),
    x: actor.segment.focus?.x ?? actor.position.x,
    z: actor.segment.focus?.y ?? actor.position.y,
    derived: true,
  };
}

/** Number of visible construction blocks at a given canonical segment progress. */
export function constructionBlockCount(progress: number, total = 18): number {
  if (total <= 0) return 0;
  return Math.min(total, Math.max(1, Math.ceil(clamp01(progress) * total)));
}

interface Effect {
  readonly group: Group;
  readonly meshes: readonly Mesh[];
  kind: ProcessKind;
  seen: boolean;
}

const WOOD = 0x8a6240;
const STONE = 0x8c9597;
const FOOD = 0x788d45;
const CRAFT = 0xb9894f;

export class ProcessStage {
  private readonly effects = new Map<string, Effect>();
  private readonly geometry = new BoxGeometry(1, 1, 1);
  private readonly wood = new MeshStandardMaterial({ color: WOOD, roughness: 0.9 });
  private readonly stone = new MeshStandardMaterial({ color: STONE, roughness: 0.96 });
  private readonly food = new MeshStandardMaterial({ color: FOOD, roughness: 1 });
  private readonly craft = new MeshStandardMaterial({ color: CRAFT, roughness: 0.82 });

  constructor(private readonly scene: Scene) {}

  update(actors: readonly ActorSample[]): void {
    for (const effect of this.effects.values()) effect.seen = false;

    // Shared activities can appear on several participant tracks. The canonical
    // activity id ensures they drive one work site, not duplicate buildings.
    const visuals = new Map<string, ProcessVisual>();
    for (const actor of actors) {
      const visual = processVisualFor(actor);
      if (visual !== null && !visuals.has(visual.key)) visuals.set(visual.key, visual);
    }

    for (const visual of visuals.values()) {
      let effect = this.effects.get(visual.key);
      if (effect === undefined || effect.kind !== visual.kind) {
        if (effect !== undefined) this.destroy(effect);
        effect = this.create(visual.kind, visual.key);
        this.effects.set(visual.key, effect);
      }
      effect.seen = true;
      effect.group.visible = true;
      effect.group.position.set(visual.x, 0, visual.z);
      this.apply(effect, visual);
    }

    for (const effect of this.effects.values()) {
      if (!effect.seen) effect.group.visible = false;
    }
  }

  private create(kind: ProcessKind, key: string): Effect {
    const group = new Group();
    group.rotation.y = hashString(`process:${key}`) * Math.PI * 2;
    const count = kind === "construction" ? 18 : kind === "gathering" ? 8 : 10;
    const meshes: Mesh[] = [];
    for (let index = 0; index < count; index += 1) {
      const material =
        kind === "construction"
          ? index < 6 ? this.stone : this.wood
          : kind === "gathering" ? this.food : this.craft;
      const mesh = new Mesh(this.geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      meshes.push(mesh);
    }
    this.scene.add(group);
    return { group, meshes, kind, seen: true };
  }

  private apply(effect: Effect, visual: ProcessVisual): void {
    if (visual.kind === "construction") {
      const visible = constructionBlockCount(visual.progress, effect.meshes.length);
      for (let index = 0; index < effect.meshes.length; index += 1) {
        const mesh = effect.meshes[index]!;
        const layer = Math.floor(index / 6);
        const slot = index % 6;
        const positions = [
          [-0.72, -0.72], [0, -0.72], [0.72, -0.72],
          [-0.72, 0.72], [0, 0.72], [0.72, 0.72],
        ] as const;
        const [x, z] = positions[slot]!;
        mesh.position.set(x, 0.14 + layer * 0.42, z);
        mesh.scale.set(0.62, layer === 0 ? 0.26 : 0.38, 0.28);
        mesh.visible = index < visible;
      }
      return;
    }

    if (visual.kind === "gathering") {
      // Source pieces diminish while a carried pile beside the worker grows.
      const collected = Math.floor(visual.progress * effect.meshes.length);
      for (let index = 0; index < effect.meshes.length; index += 1) {
        const mesh = effect.meshes[index]!;
        const gathered = index < collected;
        const angle = index * 2.399;
        mesh.position.set(
          gathered ? 0.72 + (index % 2) * 0.18 : Math.cos(angle) * (0.34 + index * 0.035),
          0.07 + (gathered ? Math.floor(index / 2) * 0.11 : 0),
          gathered ? 0.42 : Math.sin(angle) * (0.34 + index * 0.035),
        );
        mesh.scale.set(0.14, 0.12, 0.14);
        mesh.visible = gathered ? visual.progress > 0.08 : collected < effect.meshes.length;
      }
      return;
    }

    // Crafting: raw pieces converge onto a bench, then a compact finished item
    // rises at the end. The exact recipe choreography remains presentation.
    for (let index = 0; index < effect.meshes.length; index += 1) {
      const mesh = effect.meshes[index]!;
      if (index < 4) {
        mesh.position.set(index < 2 ? -0.55 : 0.55, 0.42, index % 2 ? 0.38 : -0.38);
        mesh.scale.set(0.13, 0.72, 0.13);
        mesh.visible = true;
      } else if (index < 9) {
        const assembly = clamp01(visual.progress * 1.5 - index * 0.035);
        mesh.position.set((index - 6) * 0.2 * (1 - assembly), 0.76, 0);
        mesh.scale.set(0.24, 0.08, 0.2);
        mesh.visible = visual.progress > (index - 4) * 0.1;
      } else {
        mesh.position.set(0, 0.92, 0);
        mesh.scale.set(0.34, 0.28, 0.18);
        mesh.visible = visual.progress >= 0.82;
      }
    }
  }

  private destroy(effect: Effect): void {
    this.scene.remove(effect.group);
  }

  dispose(): void {
    for (const effect of this.effects.values()) this.destroy(effect);
    this.effects.clear();
    this.geometry.dispose();
    this.wood.dispose();
    this.stone.dispose();
    this.food.dispose();
    this.craft.dispose();
  }
}
