import type { SceneDescription } from "@/lib/observatory-types";

const TERRAIN_COLOURS: Record<string, string> = {
  water: "#183846",
  plains: "#384b39",
  fertile: "#476044",
  forest: "#243f34",
  stone: "#4b5053",
  stone_deposit: "#4b5053",
  barren: "#514738",
};

function diamondPoints(x: number, y: number): string {
  const centerX = 320 + (x - y) * 9.4;
  const centerY = 44 + (x + y) * 4.8;
  return `${centerX},${centerY - 4.8} ${centerX + 9.4},${centerY} ${centerX},${centerY + 4.8} ${centerX - 9.4},${centerY}`;
}

function projectedPosition(x: number, z: number): { x: number; y: number } {
  return { x: 320 + (x - z) * 9.4, y: 40 + (x + z) * 4.8 };
}

export function ObservatoryScene({ scene }: { scene: SceneDescription }) {
  const locations = scene.references.filter(
    (reference) => reference.representation.kind === "surface",
  );
  const entities = scene.references.filter(
    (reference) => reference.representation.kind === "articulated_entity",
  );
  const otherSpatial = scene.references.filter(
    (reference) =>
      reference.representation.kind !== "surface" &&
      reference.representation.kind !== "articulated_entity",
  );

  return (
    <section
      className="observatory-stage relative overflow-hidden rounded-md border border-line"
      aria-labelledby="scene-title"
    >
      <div className="absolute top-0 right-0 left-0 z-10 flex items-start justify-between gap-4 p-4">
        <div>
          <p className="eyebrow">Renderer-neutral scene · tick {scene.worldTick}</p>
          <h2 id="scene-title" className="mt-1 text-base font-medium text-ink">
            W001 · current canonical state
          </h2>
        </div>
        <span className="mono rounded-sm border border-alive/30 bg-abyss/70 px-2 py-1 text-[0.62rem] tracking-wider text-alive uppercase">
          read only
        </span>
      </div>

      <svg
        viewBox="0 0 640 390"
        role="img"
        aria-label={`Oblique world view with ${entities.length} inhabitants`}
        className="block min-h-[25rem] w-full"
      >
        <defs>
          <radialGradient id="world-light" cx="48%" cy="35%" r="58%">
            <stop offset="0%" stopColor="#d9a441" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#060a0e" stopOpacity="0" />
          </radialGradient>
          <filter id="inhabitant-glow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect width="640" height="390" fill="#070d12" />
        <ellipse cx="320" cy="190" rx="305" ry="174" fill="url(#world-light)" />
        <g aria-label="Canonical terrain">
          {locations.map((reference) => {
            const x = reference.transform.position.x;
            const z = reference.transform.position.z;
            const material = reference.representation.material ?? "unknown";
            return (
              <a
                key={reference.refId}
                href={`/world/${scene.worldId}/ref/${encodeURIComponent(reference.refId)}`}
                aria-label={`Inspect location ${x}, ${z}`}
              >
                <polygon
                  points={diamondPoints(x, z)}
                  fill={TERRAIN_COLOURS[material] ?? "#394049"}
                  stroke="#0b151b"
                  strokeWidth="0.65"
                  className="transition-[filter] hover:brightness-150 focus:brightness-150"
                />
              </a>
            );
          })}
        </g>
        <g aria-label="Canonical spatial references">
          {otherSpatial.map((reference) => {
            const point = projectedPosition(
              reference.transform.position.x,
              reference.transform.position.z,
            );
            return (
              <a
                key={reference.refId}
                href={`/world/${scene.worldId}/ref/${encodeURIComponent(reference.refId)}`}
                aria-label={`Inspect ${reference.refId}`}
              >
                <rect
                  x={point.x - 3}
                  y={point.y - 7}
                  width="6"
                  height="6"
                  transform={`rotate(45 ${point.x} ${point.y - 4})`}
                  fill="#d9a441"
                />
              </a>
            );
          })}
          {entities.map((reference, index) => {
            const point = projectedPosition(
              reference.transform.position.x,
              reference.transform.position.z,
            );
            const colours = ["#79d3a3", "#d9a441", "#9b8fd8"];
            return (
              <a
                key={reference.refId}
                href={`/world/${scene.worldId}/ref/${encodeURIComponent(reference.refId)}`}
                aria-label={`Follow inhabitant ${reference.refId}`}
              >
                <line
                  x1={point.x}
                  y1={point.y}
                  x2={point.x}
                  y2={point.y - 17}
                  stroke={colours[index % colours.length]}
                  strokeOpacity="0.35"
                  strokeWidth="1"
                />
                <circle
                  cx={point.x}
                  cy={point.y - 18}
                  r="4.5"
                  fill={colours[index % colours.length]}
                  stroke="#e8f0f7"
                  strokeWidth="1"
                  filter="url(#inhabitant-glow)"
                  className="transition-transform hover:scale-150 focus:scale-150"
                />
              </a>
            );
          })}
        </g>
      </svg>

      <div className="absolute right-4 bottom-4 left-4 flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-md text-xs leading-relaxed text-muted">
          Terrain and positions are canonical. Lighting, projection, markers, and generated
          appearance are presentation metadata.
        </p>
        <p className="mono text-[0.62rem] text-dim">
          {scene.references.length.toLocaleString()} spatial references
        </p>
      </div>
    </section>
  );
}
