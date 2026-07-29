"use client";

import { useState } from "react";
import type { SceneDescription } from "@/lib/observatory-types";

interface BiomeStyle {
  top: string;
  left: string;
  right: string;
  stroke: string;
  height: number;
}

const BIOME_STYLES: Record<string, BiomeStyle> = {
  water: { top: "#143342", left: "#0c232e", right: "#102c3a", stroke: "#1f4a5a", height: -4 },
  plains: { top: "#344d35", left: "#233824", right: "#2b422c", stroke: "#456346", height: 0 },
  fertile: { top: "#42663f", left: "#2c4a2a", right: "#375835", stroke: "#558052", height: 3 },
  forest: { top: "#224233", left: "#152c21", right: "#1b372a", stroke: "#325c49", height: 6 },
  stone: { top: "#484f54", left: "#31363a", right: "#3c4246", stroke: "#5f686e", height: 10 },
  stone_deposit: { top: "#50585e", left: "#373e43", right: "#434b51", stroke: "#6b757b", height: 12 },
  barren: { top: "#4a3f31", left: "#332a1f", right: "#3f3428", stroke: "#615242", height: 1 },
};

function projectIso(x: number, z: number, elevation: number = 0) {
  // Center (320, 200)
  const centerX = 320 + (x - z) * 11;
  const centerY = 50 + (x + z) * 5.5 - elevation;
  return { x: centerX, y: centerY };
}

function voxelPoints(x: number, z: number, elevation: number) {
  const top = projectIso(x, z, elevation);
  const dx = 11;
  const dy = 5.5;

  const topFace = `${top.x},${top.y - dy} ${top.x + dx},${top.y} ${top.x},${top.y + dy} ${top.x - dx},${top.y}`;
  const leftFace = `${top.x - dx},${top.y} ${top.x},${top.y + dy} ${top.x},${top.y + dy + 6} ${top.x - dx},${top.y + 6}`;
  const rightFace = `${top.x},${top.y + dy} ${top.x + dx},${top.y} ${top.x + dx},${top.y + 6} ${top.x},${top.y + dy + 6}`;

  return { top, topFace, leftFace, rightFace };
}

export function ObservatoryScene({ scene }: { scene: SceneDescription }) {
  const [zoom, setZoom] = useState(1);
  const [showVoxels, setShowVoxels] = useState(true);
  const [showStructures, setShowStructures] = useState(true);
  const [showEntities, setShowEntities] = useState(true);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [hoveredRef, setHoveredRef] = useState<string | null>(null);

  const locations = scene.references.filter(
    (reference) => reference.representation.kind === "surface",
  );
  const entities = scene.references.filter(
    (reference) => reference.representation.kind === "articulated_entity",
  );
  const structures = scene.references.filter(
    (reference) =>
      reference.representation.kind === "constructed_structure" ||
      reference.refId.includes(":OBJ:"),
  );

  const activeRef = hoveredRef ?? selectedRef;
  const activeRecord = scene.references.find((r) => r.refId === activeRef);

  return (
    <section
      className="observatory-stage relative overflow-hidden rounded-md border border-line bg-[#05080c] shadow-2xl"
      aria-labelledby="scene-title"
    >
      {/* Floating Control HUD */}
      <div className="absolute top-0 right-0 left-0 z-20 flex flex-wrap items-center justify-between gap-3 p-4 bg-gradient-to-b from-[#05080c]/95 via-[#05080c]/60 to-transparent backdrop-blur-md">
        <div>
          <div className="flex items-center gap-2">
            <p className="eyebrow">Universal Observatory · Tick {scene.worldTick}</p>
            <span className="mono rounded border border-amber/40 bg-amber/10 px-2 py-0.5 text-[0.62rem] text-amber font-medium">
              3D Voxel View
            </span>
          </div>
          <h2 id="scene-title" className="mt-1 text-base font-medium tracking-tight text-ink">
            W001 · High-Definition World Projection
          </h2>
        </div>

        {/* Layer & View Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-line bg-panel/90 p-1 text-xs backdrop-blur-md shadow-lg">
            <button
              type="button"
              onClick={() => setShowVoxels((v) => !v)}
              className={`mono rounded px-2.5 py-1 text-[0.65rem] transition-colors ${
                showVoxels ? "bg-panel-2 text-amber font-medium shadow-sm" : "text-dim hover:text-muted"
              }`}
            >
              Voxels
            </button>
            <button
              type="button"
              onClick={() => setShowStructures((v) => !v)}
              className={`mono rounded px-2.5 py-1 text-[0.65rem] transition-colors ${
                showStructures ? "bg-panel-2 text-amber font-medium shadow-sm" : "text-dim hover:text-muted"
              }`}
            >
              Buildings ({structures.length})
            </button>
            <button
              type="button"
              onClick={() => setShowEntities((v) => !v)}
              className={`mono rounded px-2.5 py-1 text-[0.65rem] transition-colors ${
                showEntities ? "bg-panel-2 text-amber font-medium shadow-sm" : "text-dim hover:text-muted"
              }`}
            >
              Agents ({entities.length})
            </button>
          </div>

          <div className="flex items-center gap-1 rounded-md border border-line bg-panel/90 p-1 text-xs backdrop-blur-md">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(z + 0.15, 1.6))}
              className="mono rounded px-2 py-0.5 text-muted hover:text-amber"
              title="Zoom In"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setZoom(1.0)}
              className="mono rounded px-2 py-0.5 text-dim hover:text-ink text-[0.65rem]"
              title="Reset Zoom"
            >
              100%
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(z - 0.15, 0.7))}
              className="mono rounded px-2 py-0.5 text-muted hover:text-amber"
              title="Zoom Out"
            >
              -
            </button>
          </div>

          <span className="mono rounded-sm border border-alive/30 bg-abyss/80 px-2.5 py-1 text-[0.62rem] tracking-wider text-alive uppercase">
            Live Read Only
          </span>
        </div>
      </div>

      {/* SVG 3D Canvas */}
      <div className="overflow-hidden">
        <svg
          viewBox="0 0 640 400"
          role="img"
          aria-label={`3D Voxel world view with ${entities.length} agents and ${structures.length} structures`}
          className="block min-h-[28rem] w-full transition-transform duration-300"
          style={{ transform: `scale(${zoom})` }}
        >
          <defs>
            <radialGradient id="sun-glow" cx="48%" cy="30%" r="65%">
              <stop offset="0%" stopColor="#d9a441" stopOpacity="0.25" />
              <stop offset="40%" stopColor="#d9a441" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#05080c" stopOpacity="0" />
            </radialGradient>

            <linearGradient id="roof-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#f5c26b" />
              <stop offset="100%" stopColor="#c08c28" />
            </linearGradient>

            <filter id="entity-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Background Atmosphere */}
          <rect width="640" height="400" fill="#05080c" />
          <ellipse cx="320" cy="200" rx="310" ry="180" fill="url(#sun-glow)" />

          {/* Grid Guidelines */}
          <g stroke="#1a2632" strokeWidth="0.5" opacity="0.4">
            <line x1="320" y1="40" x2="630" y2="195" />
            <line x1="320" y1="40" x2="10" y2="195" />
            <line x1="10" y1="195" x2="320" y2="350" />
            <line x1="630" y1="195" x2="320" y2="350" />
          </g>

          {/* 3D Voxel Terrain */}
          <g aria-label="3D Terrain Grid">
            {locations.map((reference) => {
              const x = reference.transform.position.x;
              const z = reference.transform.position.z;
              const material = reference.representation.material ?? "plains";
              const refId = reference.refId;
              const style = BIOME_STYLES[material] ?? BIOME_STYLES.plains!;
              const elevation = showVoxels ? style.height : 0;
              const voxel = voxelPoints(x, z, elevation);
              const isHovered = activeRef === refId;

              return (
                <g
                  key={refId}
                  onClick={() => setSelectedRef(refId)}
                  onMouseEnter={() => setHoveredRef(refId)}
                  onMouseLeave={() => setHoveredRef(null)}
                  className="cursor-pointer transition-all hover:brightness-125"
                >
                  {showVoxels && (
                    <>
                      <polygon points={voxel.leftFace} fill={style.left} />
                      <polygon points={voxel.rightFace} fill={style.right} />
                    </>
                  )}
                  <polygon
                    points={voxel.topFace}
                    fill={isHovered ? "#d9a441" : style.top}
                    stroke={isHovered ? "#fff" : style.stroke}
                    strokeWidth={isHovered ? "1.2" : "0.5"}
                  />
                </g>
              );
            })}
          </g>

          {/* 3D Buildings & Structures */}
          {showStructures && (
            <g aria-label="3D Structures">
              {structures.map((reference) => {
                const x = reference.transform.position.x;
                const z = reference.transform.position.z;
                const refId = reference.refId;
                const isHovered = activeRef === refId;
                const top = projectIso(x, z, showVoxels ? 4 : 0);

                return (
                  <g
                    key={refId}
                    onClick={() => setSelectedRef(refId)}
                    onMouseEnter={() => setHoveredRef(refId)}
                    onMouseLeave={() => setHoveredRef(null)}
                    className="cursor-pointer transition-all hover:brightness-150"
                  >
                    {/* Building Walls */}
                    <polygon
                      points={`${top.x - 8},${top.y} ${top.x},${top.y + 4} ${top.x},${top.y - 8} ${top.x - 8},${top.y - 12}`}
                      fill="#634c38"
                      stroke="#140f09"
                      strokeWidth="0.5"
                    />
                    <polygon
                      points={`${top.x},${top.y + 4} ${top.x + 8},${top.y} ${top.x + 8},${top.y - 12} ${top.x},${top.y - 8}`}
                      fill="#8a6948"
                      stroke="#140f09"
                      strokeWidth="0.5"
                    />

                    {/* Illuminated Door/Window */}
                    <rect
                      x={top.x - 2}
                      y={top.y - 4}
                      width="4"
                      height="5"
                      fill="#ffd275"
                      opacity="0.9"
                    />

                    {/* Pitched Roof */}
                    <polygon
                      points={`${top.x},${top.y - 19} ${top.x + 8},${top.y - 12} ${top.x},${top.y - 8} ${top.x - 8},${top.y - 12}`}
                      fill="url(#roof-gradient)"
                      stroke={isHovered ? "#fff" : "#f5c26b"}
                      strokeWidth={isHovered ? "1.2" : "0.6"}
                      filter={isHovered ? "url(#entity-glow)" : undefined}
                    />

                    {/* Roof Crest */}
                    <circle cx={top.x} cy={top.y - 14} r="1.5" fill="#fff" />
                  </g>
                );
              })}
            </g>
          )}

          {/* Inhabitant Avatars */}
          {showEntities && (
            <g aria-label="Inhabitant Agents">
              {entities.map((reference, index) => {
                const x = reference.transform.position.x;
                const z = reference.transform.position.z;
                const refId = reference.refId;
                const isHovered = activeRef === refId;
                const top = projectIso(x, z, showVoxels ? 6 : 0);
                const colours = ["#79d3a3", "#d9a441", "#a08ee6"];
                const color = colours[index % colours.length];

                return (
                  <g
                    key={refId}
                    onClick={() => setSelectedRef(refId)}
                    onMouseEnter={() => setHoveredRef(refId)}
                    onMouseLeave={() => setHoveredRef(null)}
                    className="cursor-pointer"
                  >
                    {/* Light Pole */}
                    <line
                      x1={top.x}
                      y1={top.y}
                      x2={top.x}
                      y2={top.y - 20}
                      stroke={color}
                      strokeOpacity="0.8"
                      strokeWidth="1.2"
                    />

                    {/* Glowing Head Badge */}
                    <circle
                      cx={top.x}
                      cy={top.y - 21}
                      r={isHovered ? "6.5" : "5"}
                      fill={color}
                      stroke="#ffffff"
                      strokeWidth="1"
                      filter="url(#entity-glow)"
                    />
                  </g>
                );
              })}
            </g>
          )}
        </svg>
      </div>

      {/* Glassmorphic Inspector Overlay */}
      <div className="absolute right-4 bottom-4 left-4 flex flex-wrap items-center justify-between gap-3 bg-panel/90 p-3 rounded-md border border-line backdrop-blur-md shadow-xl">
        {activeRecord ? (
          <div className="flex items-center gap-3">
            <span className="mono rounded bg-amber/20 px-2 py-0.5 text-xs font-medium text-amber">
              {activeRecord.representation.kind}
            </span>
            <div>
              <p className="text-xs font-medium text-ink">
                Ref: {activeRecord.refId}
              </p>
              <p className="mono text-[0.65rem] text-dim">
                Pos: ({activeRecord.transform.position.x}, {activeRecord.transform.position.z}) · Material:{" "}
                {activeRecord.representation.material ?? "N/A"}
              </p>
            </div>
            <a
              href={`/world/${scene.worldId}/ref/${encodeURIComponent(activeRecord.refId)}`}
              className="mono ml-2 rounded border border-line px-2 py-1 text-xs text-amber hover:bg-amber/10"
            >
              Inspect Record →
            </a>
          </div>
        ) : (
          <p className="text-xs text-muted">
            Hover or click any voxel tile, structure, or agent to inspect canonical data.
          </p>
        )}

        <p className="mono text-[0.62rem] text-dim">
          {scene.references.length.toLocaleString()} spatial references
        </p>
      </div>
    </section>
  );
}
