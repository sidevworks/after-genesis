// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Presentation-only action feedback for the Observatory's real Three.js scene.
 *
 * Canonical references provide the action primitive, targets, progress and
 * position. This layer only makes that disclosed envelope legible: rings,
 * trails, work sparks and material motion are deterministic visual shorthand,
 * never written back as world facts.
 */
import {
  BoxGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  Vector3,
  type Scene,
} from "three";
import type { SceneReference } from "./observatory-types";

type ActionKind = "move" | "build" | "gather" | "craft" | "generic";

interface ActionEffect {
  readonly group: Group;
  readonly pulse: Mesh;
  readonly motes: readonly Mesh[];
  readonly kind: ActionKind;
  seen: boolean;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function spawnActionParticles(
  type: "build" | "gather" | "craft",
  coord: { x: number; y: number },
  scene: Scene,
) {
  const particleCount = type === "build" ? 24 : 12;
  const group = new Group();

  // Voxel particles!
  const geometry = new BoxGeometry(0.08, 0.08, 0.08);
  const color = type === "build" ? 0xecc94b : type === "craft" ? 0x805ad5 : 0x4299e1;

  // Make them glow so the Bloom pass catches them
  const material = new MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 1.5,
    roughness: 0.4,
    metalness: 0.1,
    transparent: true,
    opacity: 1,
    flatShading: true,
  });

  const particles: { mesh: Mesh; velocity: Vector3; rotSpeed: Vector3 }[] = [];

  for (let i = 0; i < particleCount; i++) {
    const mesh = new Mesh(geometry, material);
    // Start near the center of the tile
    mesh.position.set(
      coord.x + (Math.random() - 0.5) * 0.5,
      0.2 + Math.random() * 0.3,
      coord.y + (Math.random() - 0.5) * 0.5
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Random upward/outward velocity for a satisfying "pop"
    const velocity = new Vector3(
      (Math.random() - 0.5) * 2.5,
      2 + Math.random() * 3, // upward burst
      (Math.random() - 0.5) * 2.5
    );

    const rotSpeed = new Vector3(
      (Math.random() - 0.5) * 15,
      (Math.random() - 0.5) * 15,
      (Math.random() - 0.5) * 15
    );

    particles.push({ mesh, velocity, rotSpeed });
    group.add(mesh);
  }

  scene.add(group);

  const start = performance.now();
  const lifetime = 900; // ms
  let lastTime = start;

  const animate = () => {
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    const elapsed = now - start;
    const lifeFraction = Math.min(1, elapsed / lifetime);

    // Fade out near the end of life
    material.opacity = 1 - Math.pow(lifeFraction, 3);

    for (const p of particles) {
      // Apply gravity
      p.velocity.y -= 12.0 * dt;

      // Update position and rotation
      p.mesh.position.addScaledVector(p.velocity, dt);
      p.mesh.rotation.x += p.rotSpeed.x * dt;
      p.mesh.rotation.y += p.rotSpeed.y * dt;
      p.mesh.rotation.z += p.rotSpeed.z * dt;

      // Simple floor collision / bounce
      if (p.mesh.position.y < 0.04) {
        p.mesh.position.y = 0.04;
        p.velocity.y *= -0.4; // Bounce
        p.velocity.x *= 0.7;  // Friction
        p.velocity.z *= 0.7;
      }
    }

    if (lifeFraction < 1) {
      requestAnimationFrame(animate);
    } else {
      scene.remove(group);
      geometry.dispose();
      material.dispose();
    }
  };
  requestAnimationFrame(animate);
}

export function observatoryActionKind(primitive: string): ActionKind {
  const action = primitive.toLowerCase();
  if (/move|walk|travel|path|relocat/.test(action)) return "move";
  if (/build|built|construct|repair|place/.test(action)) return "build";
  if (/gather|harvest|collect|mine|forage/.test(action)) return "gather";
  if (/craft|creat|forge|make|assemble/.test(action)) return "craft";
  return "generic";
}

const COLOUR: Record<ActionKind, number> = {
  move: 0x70d7ff,
  build: 0xffc35b,
  gather: 0x8ddd73,
  craft: 0xe896ff,
  generic: 0xf2d58a,
};

/**
 * Own one pooled effect per active reference. `update` is safe to call from the
 * canvas render loop and does not touch the camera, controls or DOM.
 */
export class ObservatoryActionEffects {
  private readonly effects = new Map<string, ActionEffect>();
  private readonly ringGeometry = new RingGeometry(0.48, 0.58, 32);
  private readonly moteGeometry = new BoxGeometry(0.12, 0.12, 0.12);
  private readonly trailGeometry = new ConeGeometry(0.12, 0.34, 4); // 4 sides for low-poly look
  private readonly ringMaterials = new Map<ActionKind, MeshBasicMaterial>();
  private readonly moteMaterials = new Map<ActionKind, MeshStandardMaterial>();
  private readonly particleSpawned = new Set<string>();
  private readonly particleKeysThisTick = new Set<string>();

  constructor(private readonly scene: Scene) {
    for (const kind of Object.keys(COLOUR) as ActionKind[]) {
      this.ringMaterials.set(kind, new MeshBasicMaterial({
        color: COLOUR[kind],
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
      }));
      // Upgraded to catch studio lighting and bloom
      this.moteMaterials.set(kind, new MeshStandardMaterial({
        color: COLOUR[kind],
        emissive: COLOUR[kind],
        emissiveIntensity: 1.2, // Boosted to trigger the UnrealBloomPass
        roughness: 0.3,
        metalness: 0.2,
        flatShading: true,      // Fits the voxel aesthetic
      }));
    }
  }

  update(references: readonly SceneReference[], elapsedSeconds: number): void {
    for (const effect of this.effects.values()) effect.seen = false;
    this.particleKeysThisTick.clear();

    for (const reference of references) {
      if (reference.activity === null) continue;
      const kind = observatoryActionKind(reference.activity.primitive);
      const key = `${reference.refId}:${reference.activity.actionRef}`;
      const particleKey = `${kind}:${reference.refId}:${reference.activity.actionRef}`;
      let effect = this.effects.get(key);
      if (effect === undefined || effect.kind !== kind) {
        if (effect !== undefined) this.destroy(key, effect);
        effect = this.create(kind);
        this.effects.set(key, effect);
      }

      effect.seen = true;
      effect.group.visible = true;
      effect.group.position.set(
        reference.transform.position.x,
        reference.transform.position.y + 0.035,
        reference.transform.position.z,
      );
      effect.group.quaternion.set(
        reference.transform.rotation.x,
        reference.transform.rotation.y,
        reference.transform.rotation.z,
        reference.transform.rotation.w,
      );
      this.animate(effect, reference.activity.progress, elapsedSeconds);

      // Trigger 3D physics particles on start of a major physical action
      if (kind === "build" || kind === "gather" || kind === "craft") {
        this.particleKeysThisTick.add(particleKey);
        if (!this.particleSpawned.has(particleKey)) {
          spawnActionParticles(
            kind,
            {
              x: reference.transform.position.x,
              y: reference.transform.position.z,
            },
            this.scene,
          );
          this.particleSpawned.add(particleKey);
        }
      }
    }

    for (const key of this.particleSpawned) {
      if (!this.particleKeysThisTick.has(key)) {
        this.particleSpawned.delete(key);
      }
    }

    for (const effect of this.effects.values()) {
      if (!effect.seen) effect.group.visible = false;
    }
  }

  private create(kind: ActionKind): ActionEffect {
    const group = new Group();
    group.name = `observatory-action-${kind}`;

    const pulse = new Mesh(this.ringGeometry, this.ringMaterials.get(kind)!);
    pulse.rotation.x = -Math.PI / 2;
    pulse.renderOrder = 3;
    group.add(pulse);

    const motes: Mesh[] = [];
    const count = kind === "move" ? 4 : kind === "build" ? 9 : 7;
    for (let index = 0; index < count; index += 1) {
      const mote = new Mesh(
        kind === "move" ? this.trailGeometry : this.moteGeometry,
        this.moteMaterials.get(kind)!,
      );
      mote.castShadow = kind !== "move";
      group.add(mote);
      motes.push(mote);
    }
    this.scene.add(group);
    return { group, pulse, motes, kind, seen: true };
  }

  private animate(
    effect: ActionEffect,
    canonicalProgress: number | null,
    time: number,
  ): void {
    const progress = clamp01(canonicalProgress ?? 0);
    const breath = 0.5 + Math.sin(time * 4.2) * 0.5;
    const pulseScale = 0.9 + breath * 0.24;
    effect.pulse.scale.setScalar(pulseScale);
    (effect.pulse.material as MeshBasicMaterial).opacity = 0.18 + breath * 0.24;

    for (let index = 0; index < effect.motes.length; index += 1) {
      const mote = effect.motes[index]!;
      const phase = (time * 0.85 + index / effect.motes.length) % 1;
      if (effect.kind === "move") {
        // A short sequence of ground arrows trails behind local forward (-Z).
        mote.position.set(
          Math.sin(index * 4.1) * 0.09,
          0.08 + Math.sin(time * 5 + index) * 0.018,
          0.42 + index * 0.32,
        );
        mote.rotation.set(Math.PI / 2, 0, 0);
        mote.scale.setScalar(0.78 + phase * 0.3);
      } else if (effect.kind === "build") {
        // Hot chips rise in brief ballistic-looking bursts around the work site.
        const angle = index * 2.399 + time * 0.35;
        const burst = (time * 1.8 + index * 0.31) % 1;
        mote.position.set(
          Math.cos(angle) * (0.18 + burst * 0.45),
          0.2 + Math.sin(burst * Math.PI) * 0.85,
          Math.sin(angle) * (0.18 + burst * 0.45),
        );
        mote.rotation.set(burst * 4, angle, burst * 2);
        mote.scale.setScalar((1 - burst) * 0.9 + 0.15);
      } else if (effect.kind === "gather") {
        // Pieces converge from the source ring into a compact carried stack.
        const angle = index * 2.399;
        const transfer = clamp01(progress * effect.motes.length - index);
        const arc = Math.sin(transfer * Math.PI) * 0.62;
        mote.position.set(
          Math.cos(angle) * 0.62 * (1 - transfer) + transfer * 0.42,
          0.1 + arc + transfer * (index % 3) * 0.09,
          Math.sin(angle) * 0.62 * (1 - transfer) + transfer * 0.25,
        );
        mote.rotation.y = angle + transfer * Math.PI;
      } else {
        // Crafting and unknown disclosed actions get restrained orbital motion.
        const angle = time * (effect.kind === "craft" ? 2.4 : 1.2) + index * 2.399;
        const radius = effect.kind === "craft" ? 0.34 + (1 - progress) * 0.28 : 0.48;
        mote.position.set(
          Math.cos(angle) * radius,
          0.45 + Math.sin(angle * 2) * 0.16,
          Math.sin(angle) * radius,
        );
        mote.rotation.set(angle, angle * 0.7, -angle);
        mote.scale.setScalar(effect.kind === "craft" ? 0.75 + progress * 0.35 : 0.58);
      }
    }
  }

  private destroy(key: string, effect: ActionEffect): void {
    this.scene.remove(effect.group);
    this.effects.delete(key);
  }

  dispose(): void {
    for (const [key, effect] of this.effects) this.destroy(key, effect);
    this.particleSpawned.clear();
    this.particleKeysThisTick.clear();
    this.ringGeometry.dispose();
    this.moteGeometry.dispose();
    this.trailGeometry.dispose();
    for (const material of this.ringMaterials.values()) material.dispose();
    for (const material of this.moteMaterials.values()) material.dispose();
  }
}
