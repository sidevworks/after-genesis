"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

function disposeObject(object: THREE.Object3D): void {
  object.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry.dispose();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) material.dispose();
  });
}

function CharacterModelCanvas({ modelFile, name }: { modelFile: string; name: string }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;

    const scene = new THREE.Scene();
    scene.background = null;
    scene.fog = new THREE.FogExp2(0x090d14, 0.035);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    mount.replaceChildren(renderer.domElement);

    const key = new THREE.DirectionalLight(0xffe3bd, 3.2);
    key.position.set(4, 7, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const fill = new THREE.HemisphereLight(0x8dc8ff, 0x1d2632, 2.2);
    const rim = new THREE.DirectionalLight(0x6edcff, 1.5);
    rim.position.set(-5, 3, -4);
    scene.add(key, fill, rim);

    const shadowCanvas = document.createElement("canvas");
    shadowCanvas.width = shadowCanvas.height = 128;
    const shadowContext = shadowCanvas.getContext("2d");
    if (shadowContext !== null) {
      const gradient = shadowContext.createRadialGradient(64, 64, 3, 64, 64, 64);
      gradient.addColorStop(0, "rgba(0, 0, 0, 0.48)");
      gradient.addColorStop(0.55, "rgba(0, 0, 0, 0.18)");
      gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
      shadowContext.fillStyle = gradient;
      shadowContext.fillRect(0, 0, 128, 128);
    }
    const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    const contactShadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }),
    );
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.renderOrder = 1;
    scene.add(contactShadow);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 1;
    controls.maxDistance = 14;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.target.set(0, 1, 0);

    let model: THREE.Object3D | null = null;
    let frame = 0;
    let disposed = false;
    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      // Keep the WebGL drawing surface exactly aligned with its visible card.
      renderer.setSize(width, height);
    };
    const animate = () => {
      frame = window.requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();
    animate();

    new GLTFLoader().load(
      encodeURI(`/character-models/${modelFile}`),
      (gltf) => {
        if (disposed) {
          disposeObject(gltf.scene);
          return;
        }
        model = gltf.scene;
        const bounds = new THREE.Box3().setFromObject(model);
        const size = bounds.getSize(new THREE.Vector3());
        // Profiles use a common, deliberately modest presentation size. Viewers
        // can zoom in; the default must always show the entire inhabitant.
        const scale = 1.5 / Math.max(size.x, size.y, size.z, 0.1);
        model.scale.setScalar(scale);
        // GLB files can have arbitrary root offsets. Centre against the bounds after
        // scaling rather than assuming their authored origin is at their feet.
        model.position.set(0, 0, 0);
        model.updateMatrixWorld(true);
        const scaledBounds = new THREE.Box3().setFromObject(model);
        const scaledCentre = scaledBounds.getCenter(new THREE.Vector3());
        model.position.set(-scaledCentre.x, -scaledBounds.min.y + 0.08, -scaledCentre.z);
        model.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.castShadow = true;
            node.receiveShadow = true;
          }
        });
        scene.add(model);
        model.updateMatrixWorld(true);
        const framedBounds = new THREE.Box3().setFromObject(model);
        const framedCentre = framedBounds.getCenter(new THREE.Vector3());
        const framedSize = framedBounds.getSize(new THREE.Vector3());
        const radius = Math.max(framedBounds.getBoundingSphere(new THREE.Sphere()).radius, 0.75);
        contactShadow.position.set(framedCentre.x, framedBounds.min.y - 0.075, framedCentre.z);
        contactShadow.scale.set(
          Math.max(framedSize.x, framedSize.z) * 0.72,
          Math.max(framedSize.x, framedSize.z) * 0.48,
          1,
        );
        controls.target.copy(framedCentre);
        camera.near = Math.max(0.01, radius / 100);
        camera.far = radius * 100;
        camera.updateProjectionMatrix();
        // A fixed, distant default avoids a wide/tall source model taking over
        // the profile card. The inspector can still zoom in on demand.
        const distance = 3.5;
        camera.position.set(framedCentre.x, framedCentre.y + framedSize.y * 0.08, framedCentre.z + distance);
        camera.lookAt(framedCentre);
        controls.minDistance = 1.2;
        controls.maxDistance = 14;
        controls.update();
      },
      undefined,
      () => setError("This character model could not be loaded."),
    );

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      if (model !== null) disposeObject(model);
      contactShadow.geometry.dispose();
      (contactShadow.material as THREE.Material).dispose();
      shadowTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [modelFile]);

  return (
    <>
      <div ref={mountRef} className="size-full" aria-label={`${name} interactive three-dimensional model`} />
      {error && <p className="absolute inset-x-4 bottom-12 text-center text-sm text-rose-300">{error}</p>}
    </>
  );
}

/** The three-dimensional model is the profile preview; source video is not shown here. */
export function CharacterProfilePreview({ name, modelFile }: { name: string; modelFile: string }) {
  return (
    <section
      className="relative mx-auto w-full overflow-hidden"
      style={{ aspectRatio: "4 / 5", maxWidth: "22rem" }}
    >
      <CharacterModelCanvas modelFile={modelFile} name={name} />
      <div className="pointer-events-none absolute inset-x-0 top-3 text-center font-mono uppercase">
        <p className="text-[0.6rem] tracking-[0.18em] text-muted">Interactive 3D model</p>
        <p className="mt-1 text-[0.56rem] tracking-[0.12em] text-dim">Drag to rotate · scroll or pinch to zoom</p>
      </div>
    </section>
  );
}
