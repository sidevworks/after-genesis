/**
 * One inhabitant's body.
 *
 * The rig is a small hierarchy of boxes — root, hips, torso, head, two arms,
 * two legs, and one optional prop — driven entirely by the pure pose functions
 * in `clips.ts`. Nothing about the body's motion is decided here; this file only
 * writes joint angles onto `Object3D`s and manages the material state that
 * depends on disclosure.
 *
 * ## Why a rig is created once and never rebuilt
 *
 * The previous viewport built a fresh figure inside a React effect on every
 * change. Rigs here are pooled by inhabitant id for the life of the Stage: an
 * inhabitant who is not present is hidden, never destroyed, so scrubbing across
 * a birth or a death costs nothing and allocates nothing.
 *
 * ## Disclosure is carried in the material, not only in the caption
 *
 * `DISCLOSURE_TREATMENT` desaturates a body whose activity contents were
 * withheld, and desaturates it further when no record covers the interval at
 * all. Combined with the `undisclosed` clip in `clips.ts`, that means withheld
 * time is legible as withheld from the picture alone, without reading a word
 * (claude.md §11E, §12). The prop is suppressed by the same rule: a tool in the
 * hands is a claim about what someone was doing.
 */
import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Scene,
} from "three";
import type { ActorSample, PerformanceSpec, PropName } from "../cinema/types";
import {
  CLIP_BLEND_MINUTES,
  blendPose,
  poseFor,
  variationFor,
  type ActorPose,
  type ActorVariation,
  type Joint,
} from "./clips";
import {
  DISCLOSURE_TREATMENT,
  HIGHLIGHT_COLOUR,
  inhabitantHsl,
  hashString,
} from "./palette";

/** Body proportions in metres. A figure stands about 1.75 m on a 1 m tile grid. */
const PART = {
  head: { w: 0.42, h: 0.42, d: 0.42, y: 1.52 },
  torso: { w: 0.5, h: 0.62, d: 0.3, y: 1.0 },
  hips: { w: 0.44, h: 0.2, d: 0.28, y: 0.66 },
  arm: { w: 0.15, h: 0.58, d: 0.17, y: 1.22, x: 0.33 },
  leg: { w: 0.17, h: 0.66, d: 0.19, y: 0.62, x: 0.13 },
  prop: { w: 0.2, h: 0.2, d: 0.2 },
} as const;

/** Props are presentation. Shape only — never a symbol, never a label. */
const PROP_SHAPE: Readonly<Record<PropName, { w: number; h: number; d: number } | null>> = {
  none: null,
  bundle: { w: 0.26, h: 0.2, d: 0.22 },
  vessel: { w: 0.17, h: 0.24, d: 0.17 },
  tool: { w: 0.09, h: 0.46, d: 0.09 },
  tablet: { w: 0.3, h: 0.22, d: 0.04 },
  instrument: { w: 0.22, h: 0.3, d: 0.1 },
};

export interface VisualIdentity {
  readonly height: number;
  readonly breadth: number;
  readonly headwear: 0 | 1 | 2;
  readonly mantle: boolean;
  readonly accentHue: number;
}

/** Stable presentation-only silhouette variation; never interpreted as biology or status. */
export function visualIdentityFor(id: string): VisualIdentity {
  const a = hashString(`shape:${id}`);
  const b = hashString(`clothes:${id}`);
  return {
    height: 0.94 + a * 0.12,
    breadth: 0.92 + b * 0.16,
    headwear: (Math.floor(hashString(`headwear:${id}`) * 1_000_003) % 3) as 0 | 1 | 2,
    mantle: Math.floor(hashString(`mantle:${id}`) * 1_000_003) % 2 === 0,
    accentHue: hashString(`accent:${id}`),
  };
}

function applyJoint(target: { rotation: { set(x: number, y: number, z: number): void } }, joint: Joint): void {
  target.rotation.set(joint.x, joint.y, joint.z);
}

export class ActorRig {
  readonly inhabitantId: string;

  private readonly scene: Scene;
  private readonly group = new Group();
  private readonly body = new Group();

  private readonly headMesh: Mesh;
  private readonly torsoMesh: Mesh;
  private readonly hipsMesh: Mesh;
  private readonly armLMesh: Mesh;
  private readonly armRMesh: Mesh;
  private readonly legLMesh: Mesh;
  private readonly legRMesh: Mesh;
  private readonly propMesh: Mesh;
  private readonly headwearMesh: Mesh;
  private readonly beltMesh: Mesh;
  private readonly mantleMesh: Mesh;

  private readonly skin: MeshStandardMaterial;
  private readonly cloth: MeshStandardMaterial;
  private readonly propMaterial: MeshStandardMaterial;
  private readonly accentMaterial: MeshStandardMaterial;
  private readonly geometries: BoxGeometry[] = [];

  private readonly variation: ActorVariation;
  private readonly identity: VisualIdentity;
  private readonly baseHsl: { h: number; s: number; l: number };
  private readonly scratchColour = new Color();

  /** Limb pivots, so an arm rotates about its shoulder rather than its middle. */
  private readonly pivots: {
    readonly armL: Group;
    readonly armR: Group;
    readonly legL: Group;
    readonly legR: Group;
  };

  /** Clip cross-fade state. Sim-time based, so it is rate-independent. */
  private currentClip: PerformanceSpec["clip"] | null = null;
  private previousPose: ActorPose | null = null;
  private lastPose: ActorPose | null = null;
  private blendStartTick = Number.NEGATIVE_INFINITY;

  private highlighted = false;

  constructor(scene: Scene, sample: ActorSample) {
    this.scene = scene;
    this.inhabitantId = sample.inhabitantId;
    this.variation = variationFor(sample.inhabitantId);
    this.baseHsl = inhabitantHsl(sample.refId ?? sample.inhabitantId);
    const identity = visualIdentityFor(sample.inhabitantId);
    this.identity = identity;

    this.skin = new MeshStandardMaterial({ roughness: 0.72, metalness: 0.02 });
    this.cloth = new MeshStandardMaterial({ roughness: 0.86, metalness: 0 });
    this.propMaterial = new MeshStandardMaterial({
      color: 0x8a7a5f,
      roughness: 0.9,
    });
    this.accentMaterial = new MeshStandardMaterial({ roughness: 0.92, metalness: 0 });

    const box = (w: number, h: number, d: number): BoxGeometry => {
      const geometry = new BoxGeometry(w, h, d);
      this.geometries.push(geometry);
      return geometry;
    };

    this.headMesh = new Mesh(box(PART.head.w, PART.head.h, PART.head.d), this.skin);
    this.torsoMesh = new Mesh(box(PART.torso.w, PART.torso.h, PART.torso.d), this.skin);
    this.hipsMesh = new Mesh(box(PART.hips.w, PART.hips.h, PART.hips.d), this.cloth);
    this.armLMesh = new Mesh(box(PART.arm.w, PART.arm.h, PART.arm.d), this.skin);
    this.armRMesh = new Mesh(box(PART.arm.w, PART.arm.h, PART.arm.d), this.skin);
    this.legLMesh = new Mesh(box(PART.leg.w, PART.leg.h, PART.leg.d), this.cloth);
    this.legRMesh = new Mesh(box(PART.leg.w, PART.leg.h, PART.leg.d), this.cloth);
    this.propMesh = new Mesh(
      box(PART.prop.w, PART.prop.h, PART.prop.d),
      this.propMaterial,
    );
    this.headwearMesh = new Mesh(box(0.46, 0.12, 0.46), this.accentMaterial);
    this.beltMesh = new Mesh(box(0.53, 0.09, 0.32), this.accentMaterial);
    this.mantleMesh = new Mesh(box(0.62, 0.18, 0.38), this.accentMaterial);

    // Limbs rotate about their top end, not their centre, or an arm swing would
    // pivot around the elbow and look broken. Offsetting the geometry inside a
    // pivot group is the cheapest way to get a shoulder.
    const pivot = (mesh: Mesh, x: number, y: number, height: number): Group => {
      const group = new Group();
      group.position.set(x, y, 0);
      mesh.position.y = -height / 2;
      mesh.castShadow = true;
      group.add(mesh);
      return group;
    };

    const armL = pivot(this.armLMesh, -PART.arm.x, PART.arm.y, PART.arm.h);
    const armR = pivot(this.armRMesh, PART.arm.x, PART.arm.y, PART.arm.h);
    const legL = pivot(this.legLMesh, -PART.leg.x, PART.leg.y, PART.leg.h);
    const legR = pivot(this.legRMesh, PART.leg.x, PART.leg.y, PART.leg.h);

    this.headMesh.position.y = PART.head.y;
    this.torsoMesh.position.y = PART.torso.y;
    this.hipsMesh.position.y = PART.hips.y;
    this.headMesh.castShadow = true;
    this.torsoMesh.castShadow = true;
    this.hipsMesh.castShadow = true;
    this.headwearMesh.position.set(0, 1.76, 0);
    this.headwearMesh.visible = identity.headwear !== 0;
    if (identity.headwear === 1) {
      this.headwearMesh.scale.set(1.2, 0.5, 1.2);
    } else if (identity.headwear === 2) {
      this.headwearMesh.position.y = 1.82;
      this.headwearMesh.scale.set(0.62, 1.5, 0.62);
    }
    this.headwearMesh.castShadow = true;
    this.beltMesh.position.set(0, 0.75, 0);
    this.beltMesh.castShadow = true;
    this.mantleMesh.position.set(0, 1.25, 0.04);
    this.mantleMesh.visible = identity.mantle;
    this.mantleMesh.castShadow = true;

    this.propMesh.position.set(PART.arm.x + 0.06, PART.arm.y - PART.arm.h * 0.72, 0.14);
    this.propMesh.castShadow = true;
    this.propMesh.visible = false;

    this.body.add(
      this.headMesh,
      this.torsoMesh,
      this.hipsMesh,
      armL,
      armR,
      legL,
      legR,
      this.propMesh,
      this.headwearMesh,
      this.beltMesh,
      this.mantleMesh,
    );
    this.body.scale.set(identity.breadth, identity.height, identity.breadth);
    this.group.add(this.body);
    this.group.visible = false;
    scene.add(this.group);

    // Stored so `apply` can reach the pivots without another lookup.
    this.pivots = { armL, armR, legL, legR };
  }

  setHighlighted(highlighted: boolean): void {
    this.highlighted = highlighted;
  }

  /**
   * Write one sampled inhabitant onto the rig.
   *
   * Called once per actor per frame. It allocates the pose objects from
   * `clips.ts` and nothing else — no geometry, no material, no texture.
   */
  apply(
    sample: ActorSample,
    spec: PerformanceSpec,
    visualOffset: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
  ): void {
    if (!sample.present) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    const tick = sample.segment.startTick + sample.progress * this.segmentSpan(sample);

    // Clip changes cross-fade over sim time rather than real time, so the blend
    // reads the same whether the spectator is at 1× or 240×. A scrub backwards
    // or a jump restarts the blend rather than running it in reverse.
    if (spec.clip !== this.currentClip) {
      this.previousPose = this.lastPose;
      this.blendStartTick = tick;
      this.currentClip = spec.clip;
    }

    const phase = spec.cycleRate > 0 ? tick * spec.cycleRate : sample.progress;
    const target = poseFor(spec.clip, phase, sample.speed, this.variation, tick);

    const elapsed = tick - this.blendStartTick;
    const blending =
      this.previousPose !== null && elapsed >= 0 && elapsed < CLIP_BLEND_MINUTES;
    const pose = blending
      ? blendPose(this.previousPose!, target, elapsed / CLIP_BLEND_MINUTES)
      : target;
    if (!blending) this.previousPose = null;
    this.lastPose = pose;

    // Position. Canonical tile (x, y) is renderer (x, 0, y); see scene-adapter.
    this.group.position.set(
      sample.position.x + visualOffset.x + pose.root.x,
      pose.root.y,
      sample.position.y + visualOffset.y + pose.root.z,
    );
    this.group.rotation.set(
      pose.rootTilt.x,
      sample.facing + pose.rootTilt.y,
      pose.rootTilt.z,
    );

    applyJoint(this.hipsMesh, pose.hips);
    applyJoint(this.torsoMesh, pose.torso);
    applyJoint(this.headMesh, pose.head);
    applyJoint(this.pivots.armL, pose.armL);
    applyJoint(this.pivots.armR, pose.armR);
    applyJoint(this.pivots.legL, pose.legL);
    applyJoint(this.pivots.legR, pose.legR);

    this.applyDisclosure(sample);
    this.applyProp(spec, pose);
  }

  private segmentSpan(sample: ActorSample): number {
    const span = sample.segment.endTick - sample.segment.startTick;
    return span > 0 ? span : 1;
  }

  /**
   * Colour the body by disclosure.
   *
   * Withheld time is paler and flatter than recorded time. This is the material
   * half of the rule the clip enforces on the posture: a spectator glancing at
   * the picture should be able to tell that the record is not saying what this
   * person was doing, without reading the caption.
   */
  private applyDisclosure(sample: ActorSample): void {
    const treatment = DISCLOSURE_TREATMENT[sample.disclosure];
    const hsl = this.baseHsl;

    this.scratchColour.setHSL(
      hsl.h,
      hsl.s * treatment.saturation,
      Math.min(hsl.l * treatment.lightness, 1),
    );
    this.skin.color.copy(this.scratchColour);

    this.scratchColour.setHSL(
      hsl.h,
      hsl.s * treatment.saturation * 0.7,
      Math.min(hsl.l * treatment.lightness * 0.62, 1),
    );
    this.cloth.color.copy(this.scratchColour);

    this.scratchColour.setHSL(
      this.identity.accentHue,
      0.34 * treatment.saturation,
      Math.min(0.38 * treatment.lightness, 0.72),
    );
    this.accentMaterial.color.copy(this.scratchColour);

    // The highlight is a rim on the followed subject only. It marks who the
    // camera is watching — a property of the viewer's choice, not of the
    // inhabitant — so it is deliberately faint and never changes their colour.
    const emissive = this.highlighted ? 0.16 : 0;
    this.skin.emissive.setHex(HIGHLIGHT_COLOUR).multiplyScalar(emissive);
    this.cloth.emissive.setHex(HIGHLIGHT_COLOUR).multiplyScalar(emissive * 0.6);
    this.accentMaterial.emissive.setHex(HIGHLIGHT_COLOUR).multiplyScalar(emissive * 0.45);
  }

  private applyProp(spec: PerformanceSpec, pose: ActorPose): void {
    const shape = PROP_SHAPE[spec.prop];
    if (shape === null || !pose.showProp) {
      this.propMesh.visible = false;
      return;
    }
    this.propMesh.visible = true;
    this.propMesh.scale.set(
      shape.w / PART.prop.w,
      shape.h / PART.prop.h,
      shape.d / PART.prop.d,
    );
    // The prop follows the right arm's swing so it does not float free of the hand.
    this.propMesh.rotation.set(pose.armR.x, pose.armR.y, pose.armR.z);
  }

  dispose(): void {
    this.scene.remove(this.group);
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.length = 0;
    this.skin.dispose();
    this.cloth.dispose();
    this.propMaterial.dispose();
    this.accentMaterial.dispose();
  }
}
