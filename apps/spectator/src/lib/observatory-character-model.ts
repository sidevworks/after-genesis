import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  characterProfileFor,
  characterKeyForCanonicalId,
  type CharacterProp,
} from "./observatory-character-profiles";
import type { SceneReference } from "./observatory-types";

export interface ObservatoryCharacterModel {
  readonly group: THREE.Group;
  update(elapsedSeconds: number): void;
}

const CHARACTER_MODEL_FILES: Record<string, string> = {
  alpha: "Alpha.glb",
  beta: "Beta.glb",
  gamma: "Gamma.glb",
  delta: "Delta.glb",
  epsilon: "Epsilon.glb",
  zeta: "Zeta.glb",
  eta: "Eta.glb",
  theta: "Theta.glb",
  iota: "Iota.glb",
  kappa: "kappa.glb",
};

function assignedCharacterModel(key: string | undefined, seed: string): string {
  if (key !== undefined && CHARACTER_MODEL_FILES[key] !== undefined) return key;
  const choices = Object.keys(CHARACTER_MODEL_FILES);
  let hash = 0x811c9dc5;
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193);
  return choices[(hash >>> 0) % choices.length]!;
}

const loadedCharacterAssets = new Map<string, Promise<THREE.Object3D | null>>();

function loadCharacterAsset(key: string | undefined): Promise<THREE.Object3D | null> {
  const file = key === undefined ? undefined : CHARACTER_MODEL_FILES[key];
  if (file === undefined) return Promise.resolve(null);
  // The asset path is root-relative, which only resolves against a document
  // base URL. Under Node — tests, and any server render — there is no base and
  // three's FileLoader throws an unhandled `Invalid URL` out of the fetch
  // rather than reaching the error callback below. Resolve to the procedural
  // character instead, which is the same outcome as a missing asset.
  if (typeof document === "undefined") return Promise.resolve(null);
  const existing = loadedCharacterAssets.get(file);
  if (existing !== undefined) return existing;
  const loading = new Promise<THREE.Object3D | null>((resolve) => {
    new GLTFLoader().load(
      encodeURI(`/character-models/${file}`),
      (gltf) => resolve(gltf.scene),
      undefined,
      () => resolve(null),
    );
  });
  loadedCharacterAssets.set(file, loading);
  return loading;
}

function cloneCharacterAsset(source: THREE.Object3D): THREE.Object3D {
  const clone = source.clone(true);
  clone.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry = node.geometry.clone();
    node.material = Array.isArray(node.material)
      ? node.material.map((material) => material.clone())
      : node.material.clone();
    node.castShadow = true;
    node.receiveShadow = true;
  });
  return clone;
}

function centreCharacterAsset(model: THREE.Object3D): void {
  const initial = new THREE.Box3().setFromObject(model);
  const size = initial.getSize(new THREE.Vector3());
  model.scale.setScalar(2.45 / Math.max(size.x, size.y, size.z, 0.1));
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const centre = bounds.getCenter(new THREE.Vector3());
  model.position.set(-centre.x, -bounds.min.y, -centre.z);
}

function fallbackColour(seed: string): THREE.Color {
  let hash = 0;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 0x45d9f3b);
  return new THREE.Color().setHSL(((hash >>> 0) % 360) / 360, 0.58, 0.42);
}

/**
 * A small, articulated robot made from native Three.js primitives. It keeps a
 * glTF-like silhouette and visual language without adding ten large assets to
 * the spectator download. The model is presentation-only and has no game
 * state beyond the scene reference that positions it.
 */
export function createObservatoryCharacter(
  reference: SceneReference,
): ObservatoryCharacterModel {
  const profile = characterProfileFor(reference.representation.characterKey);
  const modelKey = assignedCharacterModel(reference.representation.characterKey, reference.representation.visualSeed);
  const armourColour = profile ? new THREE.Color(profile.armour) : fallbackColour(reference.representation.visualSeed);
  const accentColour = profile ? new THREE.Color(profile.accent) : armourColour.clone().offsetHSL(0, 0.12, 0.16);
  const glowColour = profile ? new THREE.Color(profile.glow) : accentColour.clone().offsetHSL(0, 0.08, 0.26);
  const darkColour = armourColour.clone().multiplyScalar(0.34);

  const armour = new THREE.MeshStandardMaterial({ color: armourColour, roughness: 0.52, metalness: 0.5, flatShading: true });
  const dark = new THREE.MeshStandardMaterial({ color: darkColour, roughness: 0.76, metalness: 0.34, flatShading: true });
  const accent = new THREE.MeshStandardMaterial({ color: accentColour, roughness: 0.42, metalness: 0.48, flatShading: true });
  const screen = new THREE.MeshStandardMaterial({ color: 0x070c0d, roughness: 0.28, metalness: 0.78, flatShading: true });
  const glow = new THREE.MeshStandardMaterial({ color: glowColour, emissive: glowColour, emissiveIntensity: 1.8, roughness: 0.25, metalness: 0.15, flatShading: true });

  const group = new THREE.Group();
  group.userData.refId = reference.refId;
  group.userData.characterKey = modelKey;
  group.userData.characterTitle = profile?.title ?? "Autonomous inhabitant";
  const markProcedural = <T extends THREE.Object3D>(object: T): T => {
    object.userData.proceduralCharacter = true;
    return object;
  };

  const mesh = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ) => {
    const object = markProcedural(new THREE.Mesh(geometry, material));
    object.position.set(x, y, z);
    object.castShadow = true;
    object.receiveShadow = true;
    group.add(object);
    return object;
  };
  const box = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number) =>
    mesh(new THREE.BoxGeometry(w, h, d), material, x, y, z);
  const cylinder = (top: number, bottom: number, height: number, material: THREE.Material, x: number, y: number, z: number) =>
    mesh(new THREE.CylinderGeometry(top, bottom, height, 8), material, x, y, z);

  // Feet and legs form a squat mechanical silhouette that is readable at map scale.
  box(0.34, 0.14, 0.45, dark, -0.25, 0.08, 0.03);
  box(0.34, 0.14, 0.45, dark, 0.25, 0.08, 0.03);
  const leftLeg = markProcedural(new THREE.Group());
  const rightLeg = markProcedural(new THREE.Group());
  const leg = (parent: THREE.Group, x: number) => {
    const shin = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.48, 0.31), armour);
    shin.position.set(0, -0.24, 0);
    shin.castShadow = true;
    shin.receiveShadow = true;
    parent.position.set(x, 0.56, 0);
    parent.add(shin);
    group.add(parent);
  };
  leg(leftLeg, -0.24);
  leg(rightLeg, 0.24);

  box(0.78, 0.18, 0.5, dark, 0, 0.72, 0);
  box(0.88, 0.72, 0.53, armour, 0, 1.14, 0);
  box(0.68, 0.16, 0.08, accent, 0, 0.96, 0.3);
  box(0.32, 0.18, 0.08, glow, 0, 1.22, 0.31);
  box(0.98, 0.2, 0.64, dark, 0, 1.48, 0);
  box(0.31, 0.2, 0.16, accent, -0.61, 1.42, 0);
  box(0.31, 0.2, 0.16, accent, 0.61, 1.42, 0);

  const arm = (side: number) => {
    const pivot = markProcedural(new THREE.Group());
    pivot.position.set(side * 0.62, 1.38, 0);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.52, 0.3), armour);
    upper.position.y = -0.26;
    upper.castShadow = true;
    upper.receiveShadow = true;
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.22, 0.27), dark);
    hand.position.y = -0.58;
    hand.castShadow = true;
    hand.receiveShadow = true;
    pivot.add(upper, hand);
    group.add(pivot);
    return pivot;
  };
  const leftArm = arm(-1);
  const rightArm = arm(1);

  // Screen head: a dark bezel plus two emissive eyes preserves the supplied sheet's character language.
  box(0.84, 0.64, 0.67, armour, 0, 1.9, 0);
  box(0.66, 0.4, 0.045, screen, 0, 1.9, 0.36);
  const leftEye = box(0.12, 0.11, 0.055, glow, -0.19, 1.91, 0.39);
  const rightEye = box(0.12, 0.11, 0.055, glow, 0.19, 1.91, 0.39);
  box(0.92, 0.1, 0.72, dark, 0, 2.25, 0);
  box(0.22, 0.16, 0.18, accent, 0, 2.37, 0);

  if (profile?.cape) {
    const cape = box(0.76, 1.15, 0.07, accent, 0, 1.2, -0.32);
    cape.rotation.x = -0.08;
  }

  addProfileProp(profile?.prop, rightArm, accent, glow, dark, box, cylinder);
  let avatar: THREE.Object3D | null = null;
  let avatarHomePosition: THREE.Vector3 | null = null;
  void loadCharacterAsset(modelKey).then((source) => {
    if (source === null) return;
    avatar = cloneCharacterAsset(source);
    centreCharacterAsset(avatar);
    avatarHomePosition = avatar.position.clone();
    avatar.userData.characterAsset = true;
    group.traverse((node) => {
      if (node.userData.proceduralCharacter === true) node.visible = false;
    });
    group.add(avatar);
  });
  group.scale.setScalar(0.62);
  let restingY: number | null = null;
  const action = reference.activity?.primitive.toLowerCase() ?? "idle";
  const moving = action === "move" || action === "flee" || action === "travel";
  const working = /gather|build|craft|refine|repair|dismantle/.test(action);

  return {
    group,
    update(elapsedSeconds: number) {
      const pace = elapsedSeconds * 1.5;
      // Callers place the root on a canonical tile after constructing it. Keep
      // that ground height intact while adding the small presentational bob.
      restingY ??= group.position.y;
      group.position.y = restingY + Math.sin(pace) * 0.018;
      leftLeg.rotation.x = Math.sin(pace) * 0.055;
      rightLeg.rotation.x = -Math.sin(pace) * 0.055;
      leftArm.rotation.x = -Math.sin(pace) * 0.09;
      rightArm.rotation.x = Math.sin(pace) * 0.09;
      const blink = Math.sin(elapsedSeconds * 2.1) > 0.96 ? 0.28 : 1;
      leftEye.scale.y = blink;
      rightEye.scale.y = blink;
      if (avatar !== null && avatarHomePosition !== null) {
        const gait = Math.sin(elapsedSeconds * (moving ? 7 : 2.1));
        avatar.position.y = avatarHomePosition.y + (moving ? Math.abs(gait) * 0.07 : Math.sin(elapsedSeconds * 1.7) * 0.018);
        avatar.rotation.z = moving ? gait * 0.045 : 0;
        avatar.rotation.x = working ? Math.sin(elapsedSeconds * 5.2) * 0.08 : 0;
      }
    },
  };
}

/** A read-only avatar for Watch playback, using the same canonical id mapping as Observatory. */
export function createWatchCharacter(
  inhabitantId: string,
  visualSeed: string,
  action: string | null = null,
): ObservatoryCharacterModel {
  const characterKey = characterKeyForCanonicalId(inhabitantId) ?? undefined;
  const refId = `AG:WATCH:ENT:${inhabitantId}` as SceneReference["refId"];
  return createObservatoryCharacter({
    refId,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    representation: {
      kind: "articulated_entity",
      visualSeed,
      ...(characterKey === undefined ? {} : { characterKey }),
      componentRefs: [],
      material: null,
    },
    activity: action === null
      ? null
      : { actionRef: `AG:WATCH:ACT:${inhabitantId}` as SceneReference["refId"], primitive: action, targetRefs: [], progress: null },
    cameraAnchors: [],
    capabilities: {},
    epistemicLabel: "OBSERVATORY_DERIVATION",
  });
}

function addProfileProp(
  prop: CharacterProp | undefined,
  hand: THREE.Group,
  accent: THREE.Material,
  glow: THREE.Material,
  dark: THREE.Material,
  box: (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number) => THREE.Mesh,
  cylinder: (top: number, bottom: number, height: number, material: THREE.Material, x: number, y: number, z: number) => THREE.Mesh,
): void {
  if (!prop) return;
  const propRoot = new THREE.Group();
  propRoot.position.set(0, -0.72, 0.02);
  hand.add(propRoot);
  const addBox = (w: number, h: number, d: number, material: THREE.Material, x: number, y: number, z: number) => {
    const item = box(w, h, d, material, 0, 0, 0);
    item.position.set(x, y, z);
    item.removeFromParent();
    propRoot.add(item);
    return item;
  };
  const addCylinder = (top: number, bottom: number, height: number, material: THREE.Material, x: number, y: number, z: number) => {
    const item = cylinder(top, bottom, height, material, 0, 0, 0);
    item.position.set(x, y, z);
    item.removeFromParent();
    propRoot.add(item);
    return item;
  };

  if (prop === "banner") {
    addCylinder(0.035, 0.035, 1.45, dark, 0, 0.7, 0);
    addBox(0.48, 0.64, 0.06, accent, 0.26, 0.86, 0);
    addBox(0.14, 0.14, 0.07, glow, 0.26, 0.86, 0.04);
  } else if (prop === "tablet") {
    addBox(0.52, 0.37, 0.06, glow, 0.1, 0.03, 0.08).rotation.x = -0.25;
  } else if (prop === "vials") {
    for (const x of [-0.16, 0, 0.16]) {
      addCylinder(0.07, 0.09, 0.28, glow, x, 0.04, 0);
      addCylinder(0.045, 0.045, 0.08, accent, x, 0.22, 0);
    }
  } else if (prop === "cache") {
    addBox(0.5, 0.38, 0.4, accent, 0, 0.04, 0);
    addBox(0.55, 0.08, 0.44, glow, 0, 0.27, 0);
  } else if (prop === "lantern") {
    addBox(0.28, 0.35, 0.28, glow, 0, 0.04, 0);
    addBox(0.36, 0.07, 0.36, accent, 0, 0.27, 0);
    addCylinder(0.02, 0.02, 0.28, accent, -0.13, 0.43, 0);
    addCylinder(0.02, 0.02, 0.28, accent, 0.13, 0.43, 0);
  } else if (prop === "crystal") {
    const crystal = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.58, 5), glow);
    crystal.position.set(0, 0.23, 0);
    crystal.castShadow = true;
    propRoot.add(crystal);
  } else if (prop === "tool") {
    addBox(0.1, 0.7, 0.11, accent, 0, 0.16, 0).rotation.z = -0.32;
    addBox(0.46, 0.12, 0.14, glow, -0.14, 0.45, 0).rotation.z = -0.32;
  } else if (prop === "heart") {
    const heart = new THREE.Group();
    const lobe = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), glow);
    const lobeRight = lobe.clone();
    lobe.position.set(-0.11, 0.18, 0);
    lobeRight.position.set(0.11, 0.18, 0);
    const point = new THREE.Mesh(new THREE.ConeGeometry(0.23, 0.35, 4), glow);
    point.position.set(0, -0.02, 0);
    point.rotation.z = Math.PI;
    heart.add(lobe, lobeRight, point);
    propRoot.add(heart);
  } else if (prop === "trade_cube") {
    const cube = addBox(0.34, 0.34, 0.34, glow, 0, 0.12, 0);
    cube.rotation.set(0.3, 0.45, 0.12);
  } else if (prop === "scope") {
    const scope = addCylinder(0.13, 0.13, 0.72, dark, 0.04, 0.14, 0);
    scope.rotation.z = Math.PI / 2;
    const lens = addCylinder(0.15, 0.15, 0.05, glow, 0.42, 0.14, 0);
    lens.rotation.z = Math.PI / 2;
    addBox(0.12, 0.38, 0.11, accent, -0.12, -0.1, 0);
  }
}
