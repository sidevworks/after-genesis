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
import type { ActorSample, Chronicle, ChronicleSegment } from "../cinema/types";
import { hashString } from "./palette";

export type ProcessKind = "construction" | "gathering" | "crafting";
export type ConstructionPhase =
  | "survey"
  | "foundation"
  | "framing"
  | "roofing"
  | "complete";

export interface ProcessVisual {
  readonly key: string;
  readonly kind: ProcessKind;
  readonly progress: number;
  readonly x: number;
  readonly z: number;
  readonly resource: string | null;
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
    resource:
      typeof actor.segment.detail?.resource === "string"
        ? actor.segment.detail.resource
        : null,
    derived: true,
  };
}

/** Number of visible construction blocks at a given canonical segment progress. */
export function constructionBlockCount(progress: number, total = 18): number {
  if (total <= 0) return 0;
  return Math.min(total, Math.max(1, Math.ceil(clamp01(progress) * total)));
}

/** Turns continuous progress into a legible, presentation-only site phase. */
export function constructionPhase(progress: number): ConstructionPhase {
  const value = clamp01(progress);
  if (value < 0.12) return "survey";
  if (value < 0.32) return "foundation";
  if (value < 0.72) return "framing";
  if (value < 0.96) return "roofing";
  return "complete";
}

interface Effect {
  readonly group: Group;
  readonly meshes: readonly Mesh[];
  readonly processMeshCount: number;
  kind: ProcessKind;
  resource: string | null;
  seen: boolean;
}

const WOOD = 0x8a6240;
const STONE = 0x8c9597;
const FOOD = 0x788d45;
const CRAFT = 0xb9894f;
const WATER = 0x4d9fbd;

export class ProcessStage {
  private readonly effects = new Map<string, Effect>();
  private readonly constructionSegments: readonly ChronicleSegment[];
  private readonly geometry = new BoxGeometry(1, 1, 1);
  private readonly wood = new MeshStandardMaterial({ color: WOOD, roughness: 0.9 });
  private readonly stone = new MeshStandardMaterial({ color: STONE, roughness: 0.96 });
  private readonly scaffold = new MeshStandardMaterial({
    color: 0xd9b36c, roughness: 0.86, transparent: true, opacity: 0.78,
  });
  private readonly placement = new MeshStandardMaterial({
    color: 0x72d7e8, emissive: 0x163a42, roughness: 0.5,
    transparent: true, opacity: 0.68,
  });
  private readonly food = new MeshStandardMaterial({ color: FOOD, roughness: 1 });
  private readonly craft = new MeshStandardMaterial({ color: CRAFT, roughness: 0.82 });
  private readonly water = new MeshStandardMaterial({
    color: WATER, roughness: 0.28, metalness: 0.08, transparent: true, opacity: 0.86,
  });

  constructor(private readonly scene: Scene, chronicle: Chronicle) {
    const byActivity = new Map<string, ChronicleSegment>();
    for (const track of chronicle.tracks) {
      for (const segment of track.segments) {
        if (
          segment.disclosure !== "disclosed" ||
          (segment.actionType !== "build" && segment.activityState !== "building")
        ) {
          continue;
        }
        const key = segment.activityId ?? segment.id;
        if (!byActivity.has(key)) byActivity.set(key, segment);
      }
    }
    this.constructionSegments = [...byActivity.values()].sort(
      (left, right) => left.startTick - right.startTick,
    );
  }

  update(tick: number, actors: readonly ActorSample[]): void {
    for (const effect of this.effects.values()) effect.seen = false;

    // Shared activities can appear on several participant tracks. The canonical
    // activity id ensures they drive one work site, not duplicate buildings.
    const visuals = new Map<string, ProcessVisual>();

    // Completed structures remain in the replay after their action finishes,
    // and direct seeking reconstructs them without requiring playback to have
    // visited their construction interval first.
    for (const segment of this.constructionSegments) {
      if (tick < segment.startTick) continue;
      if (tick > segment.endTick) continue;
      const duration = Math.max(segment.endTick - segment.startTick, 1);
      const progress = clamp01((tick - segment.startTick) / duration);
      const key = segment.activityId ?? segment.id;
      visuals.set(key, {
        key,
        kind: "construction",
        progress,
        x: segment.focus?.x ?? segment.to.x,
        z: segment.focus?.y ?? segment.to.y,
        resource: null,
        derived: true,
      });
    }

    for (const actor of actors) {
      const visual = processVisualFor(actor);
      if (visual !== null && !visuals.has(visual.key)) visuals.set(visual.key, visual);
    }

    for (const visual of visuals.values()) {
      let effect = this.effects.get(visual.key);
      if (
        effect === undefined ||
        effect.kind !== visual.kind ||
        effect.resource !== visual.resource
      ) {
        if (effect !== undefined) this.destroy(effect);
        effect = this.create(visual.kind, visual.key, visual.resource);
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

  private create(kind: ProcessKind, key: string, resource: string | null): Effect {
    const group = new Group();
    group.rotation.y = hashString(`process:${key}`) * Math.PI * 2;
    const processMeshCount = kind === "construction" ? 33 : kind === "gathering" ? 8 : 10;
    const count = processMeshCount + (kind === "construction" ? 12 : 0);
    const meshes: Mesh[] = [];
    for (let index = 0; index < count; index += 1) {
      const material =
        kind === "construction"
          ? index < 9
            ? this.stone
            : index < processMeshCount
              ? this.wood
              : index < processMeshCount + 4
                ? this.placement
                : this.scaffold
          : kind === "gathering"
            ? resource === "water" ? this.water
              : resource === "stone" ? this.stone
                : resource === "wood" ? this.wood : this.food
            : this.craft;
      const mesh = new Mesh(this.geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      meshes.push(mesh);
    }
    this.scene.add(group);
    return { group, meshes, processMeshCount, kind, resource, seen: true };
  }

  private apply(effect: Effect, visual: ProcessVisual): void {
    if (visual.kind === "construction") {
      const visible = constructionBlockCount(visual.progress, effect.processMeshCount);
      const phase = constructionPhase(visual.progress);
      const parts: Array<readonly [number, number, number, number, number, number]> = [];
      // Stone foundation: a complete 3×3 footprint.
      for (let z = -1; z <= 1; z += 1) {
        for (let x = -1; x <= 1; x += 1) {
          parts.push([x * 0.62, 0.12, z * 0.62, 0.58, 0.22, 0.58]);
        }
      }
      // Two wall courses. The front-centre opening remains a real doorway.
      for (const y of [0.48, 0.86]) {
        for (let x = -1; x <= 1; x += 1) {
          parts.push([x * 0.62, y, -0.68, 0.58, 0.34, 0.22]);
          if (x !== 0 || y > 0.6) {
            parts.push([x * 0.62, y, 0.68, 0.58, 0.34, 0.22]);
          }
        }
        parts.push([-0.68, y, 0, 0.22, 0.34, 0.58]);
        parts.push([0.68, y, 0, 0.22, 0.34, 0.58]);
      }
      // Stepped roof: a readable finished silhouette rather than freestanding walls.
      for (let x = -1; x <= 1; x += 1) {
        const roofY = 1.22 + (1 - Math.abs(x)) * 0.22;
        for (let z = -1; z <= 1; z += 1) {
          parts.push([x * 0.48, roofY, z * 0.62, 0.56, 0.18, 0.66]);
        }
      }

      for (let index = 0; index < effect.processMeshCount; index += 1) {
        const mesh = effect.meshes[index]!;
        const [x, y, z, sx, sy, sz] = parts[index] ?? [0, 0, 0, 0, 0, 0];
        // Each course arrives from a nearby material stack, settles downward,
        // and grows into its final dimensions. The local fraction preserves
        // monotonic canonical progress while avoiding the old instant pop.
        const local = clamp01(visual.progress * effect.processMeshCount - index);
        const eased = local * local * (3 - 2 * local);
        const side = index % 2 === 0 ? -1 : 1;
        mesh.position.set(
          x + side * (1 - eased) * 0.42,
          y + (1 - eased) * 0.72,
          z + (1 - eased) * 0.22,
        );
        mesh.scale.set(sx * (0.72 + eased * 0.28), sy * eased, sz * (0.72 + eased * 0.28));
        mesh.rotation.set(
          (1 - eased) * 0.22,
          side * (1 - eased) * 0.3,
          side * (1 - eased) * 0.16,
        );
        mesh.visible = index < visible;
      }

      // Stakes preview the exact footprint before the walls make it obvious.
      const showStakes = phase === "survey" || phase === "foundation";
      const stakePositions = [
        [-1.02, -1.02], [1.02, -1.02], [-1.02, 1.02], [1.02, 1.02],
      ] as const;
      for (let index = 0; index < 4; index += 1) {
        const stake = effect.meshes[effect.processMeshCount + index]!;
        const [x, z] = stakePositions[index]!;
        const pulse = 1 + Math.sin(visual.progress * Math.PI * 18 + index) * 0.08;
        stake.position.set(x, 0.22, z);
        stake.scale.set(0.07 * pulse, 0.44, 0.07 * pulse);
        stake.visible = showStakes;
      }

      // Temporary scaffold frames make active building unmistakable, then clear
      // during the final handoff so completion has a strong visual beat.
      const showScaffold = phase === "framing" || phase === "roofing";
      for (let side = 0; side < 2; side += 1) {
        const x = side === 0 ? -1.12 : 1.12;
        const base = effect.processMeshCount + 4 + side * 4;
        for (let pole = 0; pole < 2; pole += 1) {
          const mesh = effect.meshes[base + pole]!;
          mesh.position.set(x, 0.72, pole === 0 ? -0.82 : 0.82);
          mesh.scale.set(0.07, 1.44, 0.07);
          mesh.visible = showScaffold;
        }
        for (let rail = 0; rail < 2; rail += 1) {
          const mesh = effect.meshes[base + 2 + rail]!;
          mesh.position.set(x, 0.46 + rail * 0.58, 0);
          mesh.scale.set(0.08, 0.07, 1.72);
          mesh.visible = showScaffold;
        }
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
        const transfer = clamp01(visual.progress * effect.meshes.length - index);
        const lift = gathered ? Math.sin(transfer * Math.PI) * 0.34 : 0;
        const sourceX = Math.cos(angle) * (0.34 + index * 0.035);
        const sourceZ = Math.sin(angle) * (0.34 + index * 0.035);
        const pileX = 0.72 + (index % 2) * 0.18;
        const pileZ = 0.42;
        mesh.position.set(
          sourceX + (pileX - sourceX) * transfer,
          0.07 + lift + transfer * Math.floor(index / 2) * 0.11,
          sourceZ + (pileZ - sourceZ) * transfer,
        );
        if (effect.resource === "wood") {
          mesh.scale.set(0.12, 0.12, 0.32);
          mesh.rotation.x = Math.PI / 2;
        } else if (effect.resource === "water") {
          mesh.scale.set(0.17, 0.08, 0.17);
        } else {
          mesh.scale.set(0.14, 0.12, 0.14);
        }
        // Keep both the remaining source and transferred pile legible for the
        // whole action; position, rather than disappearance, communicates flow.
        mesh.visible = true;
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
      } else if (index === 4) {
        mesh.position.set(0, 0.74, 0);
        mesh.scale.set(1.25, 0.12, 0.72);
        mesh.visible = true;
      } else if (index < 9) {
        const assembly = clamp01(visual.progress * 1.5 - index * 0.035);
        const beat = Math.sin(visual.progress * Math.PI * 12 + index) * 0.018;
        mesh.position.set((index - 6) * 0.42 * (1 - assembly), 0.78 + beat, 0);
        mesh.rotation.set(0, (1 - assembly) * (index - 6) * 0.28, beat * 4);
        mesh.scale.set(0.24 * assembly, 0.08, 0.2 * assembly);
        mesh.visible = visual.progress > (index - 4) * 0.1;
      } else {
        const reveal = clamp01((visual.progress - 0.82) / 0.18);
        const eased = reveal * reveal * (3 - 2 * reveal);
        mesh.position.set(0, 0.83 + eased * 0.14, 0);
        mesh.rotation.set(0, (1 - eased) * Math.PI, 0);
        mesh.scale.set(0.34 * eased, 0.28 * eased, 0.18 * eased);
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
    this.scaffold.dispose();
    this.placement.dispose();
    this.food.dispose();
    this.craft.dispose();
    this.water.dispose();
  }
}
