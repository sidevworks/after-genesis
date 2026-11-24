// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * The Stage — a persistent three.js scene that the Cinema layer drives.
 *
 * ## The architectural rule this file exists to enforce
 *
 * Mount once, live for the component's lifetime, allocate nothing per frame.
 *
 * The renderer it replaces created its scene inside a React effect keyed on its
 * props: every camera nudge disposed a thousand meshes and built a thousand
 * more. Here the constructor builds the world once, `render()` writes transforms
 * and uniforms, and `dispose()` frees everything exactly once. The only objects
 * allocated during playback are the small pose records from `clips.ts`.
 *
 * ## What this class deliberately does not own
 *
 * - **No clock.** The host advances sim time and passes a `WorldFrame`. A Stage
 *   that kept its own clock could not be scrubbed, and two spectators at the
 *   same tick could see different pictures.
 * - **No animation loop.** The host owns `requestAnimationFrame`.
 * - **No camera logic.** The director resolves a `CameraPose` from canonical
 *   positions; this class only applies it. That keeps the camera free of any
 *   navigation, collision or world dependency (observatory-architecture §7).
 * - **No connection of any kind.** There is no reader, writer, socket or fetch
 *   in this file or anything it imports.
 *
 * ## Orbit override
 *
 * A spectator can drag to look around. Doing so suspends the director's
 * framing for that shot and hands control over, because a camera the viewer
 * cannot move is a diagram rather than a window. The override is released on
 * the next cut, so the film resumes rather than stranding them.
 */
import {
  ACESFilmicToneMapping,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  FogExp2,
  HemisphereLight,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  SRGBColorSpace,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import type {
  ActorSample,
  CameraPose,
  Chronicle,
  PerformanceSpec,
  WorldFrame,
} from "../cinema/types";
import { frameSettlement, settlementBoundsAt } from "../cinema/settlement-framing";
import { ActorRig } from "./actor";
import { hashString, VOID_COLOUR } from "./palette";
import { applySky, skyAt, type SkyTargets } from "./sky";
import { Terrain, type TerrainMap } from "./terrain";
import { ProcessStage } from "./processes";
import { SettlementStage } from "./settlement";
import type { SettlementProjectionSource } from "../city/project-settlement";

export interface StageOptions {
  readonly map: TerrainMap;
  readonly chronicle: Chronicle;
  readonly settlementSource?: SettlementProjectionSource;
  /** Caps device pixel ratio. Lower it on machines that struggle. */
  readonly quality?: "low" | "high";
}

/** Stars are a fixed dome; only their opacity changes with the sky. */
const STAR_COUNT = 900;
const STAR_RADIUS = 150;

/** Camera smoothing. Higher follows the director more tightly. */
const POSE_LERP = 0.16;

/** Keep the lens over the playable surface rather than below a map edge. */
const CAMERA_GROUND_CLEARANCE = 2.4;

/** Shadow frustum half-width in metres, around the camera target. */
const SHADOW_EXTENT = 26;

/** Presentation-only personal space when several canonical positions share a tile. */
const ACTOR_SEPARATION = 0.62;

export class Stage {
  private readonly mount: HTMLElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(38, 1, 0.5, 400);

  private readonly key = new DirectionalLight(0xffffff, 2);
  private readonly ambient = new HemisphereLight(0xffffff, 0x000000, 1);
  private readonly fog = new FogExp2(0x07131c, 0.012);
  private readonly background = new Color(0x07131c);

  private readonly stars: Points;
  private readonly starMaterial: PointsMaterial;
  private readonly starGeometry: BufferGeometry;

  private readonly terrain: Terrain;
  private readonly processes: ProcessStage;
  private readonly settlement: SettlementStage | null;
  private readonly chronicle: Chronicle;
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  private readonly rigs = new Map<string, ActorRig>();
  private readonly skyTargets: SkyTargets;

  /** Smoothed camera state, so a shot's motion reads as a move rather than a jump. */
  private readonly cameraPosition = new Vector3();
  private readonly cameraTarget = new Vector3();
  private cameraReady = false;

  private highlightId: string | null = null;
  private lastShotId: string | null = null;

  /* Manual orbit override. */
  private overrideActive = false;
  private overrideAzimuth = 0;
  private overrideElevation = 0.45;
  private overrideDistance = 14;
  private dragging = false;
  private pointerX = 0;
  private pointerY = 0;

  private disposed = false;

  constructor(mount: HTMLElement, options: StageOptions) {
    this.mount = mount;
    this.mapWidth = options.map.width;
    this.mapHeight = options.map.height;
    this.chronicle = options.chronicle;

    this.renderer = new WebGLRenderer({ antialias: options.quality !== "low", alpha: false });
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, options.quality === "low" ? 1 : 2),
    );
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    mount.appendChild(this.renderer.domElement);

    this.scene.background = this.background;
    this.scene.fog = this.fog;

    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.camera.near = 1;
    this.key.shadow.camera.far = 200;
    this.key.shadow.bias = -0.0012;
    this.scene.add(this.key);
    this.scene.add(this.key.target);
    this.scene.add(this.ambient);

    const { geometry, material, points } = this.buildStars();
    this.starGeometry = geometry;
    this.starMaterial = material;
    this.stars = points;
    this.scene.add(this.stars);

    this.terrain = new Terrain(this.scene, options.map);
    this.processes = new ProcessStage(this.scene, options.chronicle);
    this.settlement =
      options.settlementSource === undefined
        ? null
        : new SettlementStage(this.scene, options.settlementSource);

    this.skyTargets = {
      key: this.key,
      ambient: this.ambient,
      background: this.background,
      fog: this.fog,
      starMaterial: this.starMaterial,
      renderer: this.renderer,
    };
    // Watch is an inspection surface: keep the terrain and inhabitants legible
    // at every simulated hour rather than making night-time visibility a factor.
    applySky(skyAt(0.5), this.skyTargets);

    this.attachPointerControls();
  }

  /**
   * A fixed star dome.
   *
   * Positions are hashed from the star index rather than randomised, so the
   * night sky is the same for every spectator — the same reason the terrain
   * scatter is hashed. It is presentation either way; determinism just means
   * two people describing the same night are describing the same picture.
   */
  private buildStars(): {
    geometry: BufferGeometry;
    material: PointsMaterial;
    points: Points;
  } {
    const positions = new Float32Array(STAR_COUNT * 3);
    for (let index = 0; index < STAR_COUNT; index += 1) {
      const u = hashString(`star-u:${index}`);
      const v = hashString(`star-v:${index}`);
      const theta = u * Math.PI * 2;
      // Only the upper hemisphere, and biased away from the horizon where fog
      // would swallow them anyway.
      const phi = Math.acos(0.08 + v * 0.9);
      positions[index * 3] = STAR_RADIUS * Math.sin(phi) * Math.cos(theta);
      positions[index * 3 + 1] = STAR_RADIUS * Math.cos(phi);
      positions[index * 3 + 2] = STAR_RADIUS * Math.sin(phi) * Math.sin(theta);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    const material = new PointsMaterial({
      color: 0xdfe9f5,
      size: 0.9,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    const points = new Points(geometry, material);
    points.frustumCulled = false;
    return { geometry, material, points };
  }

  setHighlight(inhabitantId: string | null): void {
    this.highlightId = inhabitantId;
    for (const [id, rig] of this.rigs) rig.setHighlighted(id === inhabitantId);
  }

  /* ----------------------------------------------------------------- frame */

  /**
   * Draw one frame.
   *
   * `performanceFor` is injected rather than imported so that the Stage has no
   * opinion about how a canonical activity maps to a body — that decision lives
   * in `cinema/performances.ts`, where the disclosure rules are tested.
   */
  render(
    frame: WorldFrame,
    pose: CameraPose,
    performanceFor: (actor: ActorSample) => PerformanceSpec,
  ): void {
    if (this.disposed) return;

    this.terrain.update(frame.tick);
    this.processes.update(frame.tick, frame.actors);
    this.settlement?.update(frame.tick);

    const occupied = new Map<string, ActorSample[]>();
    for (const actor of frame.actors) {
      if (!actor.present) continue;
      const key = `${actor.position.x.toFixed(3)}:${actor.position.y.toFixed(3)}`;
      const group = occupied.get(key);
      if (group === undefined) occupied.set(key, [actor]);
      else group.push(actor);
    }
    for (const group of occupied.values()) {
      group.sort((left, right) => left.inhabitantId.localeCompare(right.inhabitantId));
    }

    for (const actor of frame.actors) {
      let rig = this.rigs.get(actor.inhabitantId);
      if (rig === undefined) {
        rig = new ActorRig(this.scene, actor);
        rig.setHighlighted(actor.inhabitantId === this.highlightId);
        this.rigs.set(actor.inhabitantId, rig);
      }
      const key = `${actor.position.x.toFixed(3)}:${actor.position.y.toFixed(3)}`;
      const group = occupied.get(key) ?? [actor];
      const index = group.findIndex((candidate) => candidate.inhabitantId === actor.inhabitantId);
      const radius = group.length > 1 ? ACTOR_SEPARATION : 0;
      const angle = group.length > 1 ? (index / group.length) * Math.PI * 2 : 0;
      rig.apply(actor, performanceFor(actor), {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    }

    this.applyCamera(pose, frame);
    this.renderer.render(this.scene, this.camera);
  }

  private applyCamera(inputPose: CameraPose, frame: WorldFrame): void {
    const bounds =
      inputPose.kind === "ESTABLISH" || inputPose.kind === "FALLBACK_REFERENCE"
        ? settlementBoundsAt(this.chronicle, frame)
        : null;
    const pose = bounds === null ? inputPose : frameSettlement(inputPose, bounds);
    // A cut releases any manual orbit: the viewer looked around during a shot,
    // and the next shot is the film resuming.
    if (pose.shotId !== this.lastShotId) {
      this.lastShotId = pose.shotId;
      this.overrideActive = false;
    }

    const target = this.cameraTarget;
    const position = this.cameraPosition;

    if (this.overrideActive) {
      target.set(pose.target.x, pose.target.y, pose.target.z);
      const horizontal = Math.cos(this.overrideElevation) * this.overrideDistance;
      position.set(
        target.x + Math.sin(this.overrideAzimuth) * horizontal,
        target.y + Math.sin(this.overrideElevation) * this.overrideDistance,
        target.z + Math.cos(this.overrideAzimuth) * horizontal,
      );
    } else if (!this.cameraReady || pose.cut) {
      // A hard cut must not be smoothed, or every cut becomes a whip pan.
      position.set(pose.position.x, pose.position.y, pose.position.z);
      target.set(pose.target.x, pose.target.y, pose.target.z);
      this.cameraReady = true;
    } else {
      position.lerp(
        this.scratch.set(pose.position.x, pose.position.y, pose.position.z),
        POSE_LERP,
      );
      target.lerp(
        this.scratch.set(pose.target.x, pose.target.y, pose.target.z),
        POSE_LERP,
      );
    }

    // Canonical positions sit on the map, but wide cinematic offsets can put
    // the lens beyond its edge. From there the camera sees the vertical sides
    // and underside of the voxel slab. Constrain only the presentation camera:
    // this never changes the subject, target, or world state.
    position.x = Math.min(Math.max(position.x, -0.45), this.mapWidth - 0.55);
    position.z = Math.min(Math.max(position.z, -0.45), this.mapHeight - 0.55);
    position.y = Math.max(position.y, CAMERA_GROUND_CLEARANCE);
    target.x = Math.min(Math.max(target.x, 0), Math.max(this.mapWidth - 1, 0));
    target.z = Math.min(Math.max(target.z, 0), Math.max(this.mapHeight - 1, 0));

    this.camera.position.copy(position);
    this.camera.lookAt(target);
    if (this.camera.fov !== pose.fov) {
      this.camera.fov = pose.fov;
      this.camera.updateProjectionMatrix();
    }

    // Keep the shadow frustum around what the camera is looking at, so a 32×32
    // map still gets sharp shadows without a 200 m frustum's worth of blur.
    this.key.target.position.copy(target);
    this.key.target.updateMatrixWorld();
    this.key.position.add(target);
    const shadowCamera = this.key.shadow.camera;
    shadowCamera.left = -SHADOW_EXTENT;
    shadowCamera.right = SHADOW_EXTENT;
    shadowCamera.top = SHADOW_EXTENT;
    shadowCamera.bottom = -SHADOW_EXTENT;
    shadowCamera.updateProjectionMatrix();

    this.stars.position.copy(position);
  }

  private readonly scratch = new Vector3();

  /* -------------------------------------------------------------- controls */

  private attachPointerControls(): void {
    const canvas = this.renderer.domElement;

    const beginOverride = (): void => {
      if (this.overrideActive) return;
      const offset = this.scratch
        .copy(this.cameraPosition)
        .sub(this.cameraTarget);
      this.overrideDistance = Math.max(offset.length(), 3);
      this.overrideElevation = Math.asin(
        Math.min(Math.max(offset.y / this.overrideDistance, -1), 1),
      );
      this.overrideAzimuth = Math.atan2(offset.x, offset.z);
      this.overrideActive = true;
    };

    this.onPointerDown = (event: PointerEvent) => {
      this.dragging = true;
      this.pointerX = event.clientX;
      this.pointerY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      beginOverride();
    };

    this.onPointerMove = (event: PointerEvent) => {
      if (!this.dragging) return;
      this.overrideAzimuth -= (event.clientX - this.pointerX) * 0.008;
      this.overrideElevation = Math.min(
        Math.max(this.overrideElevation + (event.clientY - this.pointerY) * 0.006, 0.06),
        1.35,
      );
      this.pointerX = event.clientX;
      this.pointerY = event.clientY;
    };

    this.onPointerUp = () => {
      this.dragging = false;
    };

    this.onWheel = (event: WheelEvent) => {
      // Only capture wheel events for 3D camera zoom if modifier key is held
      if (event.ctrlKey || event.metaKey || event.altKey) {
        event.preventDefault();
        beginOverride();
        this.overrideDistance = Math.min(
          Math.max(this.overrideDistance + event.deltaY * 0.014, 3),
          70,
        );
      }
    };

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  private onPointerDown: (event: PointerEvent) => void = () => {};
  private onPointerMove: (event: PointerEvent) => void = () => {};
  private onPointerUp: () => void = () => {};
  private onWheel: (event: WheelEvent) => void = () => {};

  resize(): void {
    if (this.disposed) return;
    const width = this.mount.clientWidth;
    const height = Math.max(this.mount.clientHeight, 1);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerUp);
    canvas.removeEventListener("wheel", this.onWheel);

    for (const rig of this.rigs.values()) rig.dispose();
    this.rigs.clear();
    this.terrain.dispose();
    this.processes.dispose();
    this.settlement?.dispose();

    this.scene.remove(this.stars);
    this.starGeometry.dispose();
    this.starMaterial.dispose();

    this.renderer.dispose();
    if (canvas.parentNode === this.mount) this.mount.removeChild(canvas);
  }
}

/** Re-exported so the host does not need a separate import for the map shape. */
export type { TerrainMap };

/** The void colour, exposed for any surface that needs to match the horizon. */
export { VOID_COLOUR };
