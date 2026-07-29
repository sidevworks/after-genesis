"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Structure, Tile, WorldMap } from "@/lib/world-types";
import { TERRAIN_COLOUR, TERRAIN_LABEL, formatSimTime, generationColour, percent } from "@/lib/format";

/**
 * The world map.
 *
 * Everything here is a reading control: hover, select, zoom, and links to
 * profiles. Nothing on this surface sends anything toward world state — the
 * component is not even given a way to.
 */

function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 255) * (1 + amount));
  const g = clamp(((n >> 8) & 255) * (1 + amount));
  const b = clamp((n & 255) * (1 + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function StructureGlyph({ structure }: { structure: Structure }) {
  const { x, y } = structure.at;
  const cx = x + 0.5;
  const cy = y + 0.5;

  if (structure.kind === "monument" || structure.kind === "cairn") {
    return (
      <g>
        <polygon
          points={`${cx},${cy - 0.35} ${cx + 0.32},${cy} ${cx},${cy + 0.35} ${cx - 0.32},${cy}`}
          fill="#0b1016"
          stroke="var(--color-amber)"
          strokeWidth={0.08}
        />
        <circle cx={cx} cy={cy} r={0.08} fill="var(--color-amber)" />
      </g>
    );
  }

  if (structure.kind === "bridge") {
    return (
      <g stroke="var(--color-amber)" strokeWidth={0.1} fill="none">
        <line x1={x + 0.15} y1={cy} x2={x + 0.85} y2={cy} />
        <line x1={x + 0.3} y1={cy - 0.18} x2={x + 0.3} y2={cy + 0.18} />
        <line x1={x + 0.7} y1={cy - 0.18} x2={x + 0.7} y2={cy + 0.18} />
      </g>
    );
  }

  if (structure.kind === "well") {
    return (
      <g fill="none" stroke="var(--color-amber)" strokeWidth={0.09}>
        <circle cx={cx} cy={cy} r={0.28} />
        <circle cx={cx} cy={cy} r={0.12} fill="var(--color-amber)" stroke="none" />
      </g>
    );
  }

  if (structure.kind === "shelter" || structure.kind === "house") {
    return (
      <g fill="#0b1016" stroke="var(--color-amber)" strokeWidth={0.07}>
        <path d={`M ${x + 0.2},${y + 0.75} L ${cx},${y + 0.25} L ${x + 0.8},${y + 0.75} Z`} />
        <rect x={x + 0.42} y={y + 0.55} width={0.16} height={0.2} fill="var(--color-amber)" stroke="none" />
      </g>
    );
  }

  if (structure.kind === "store" || structure.kind === "stockpile" || structure.kind === "granary") {
    return (
      <g fill="#0b1016" stroke="var(--color-amber)" strokeWidth={0.07}>
        <rect x={x + 0.2} y={y + 0.2} width={0.6} height={0.6} rx={0.06} />
        <line x1={x + 0.2} y1={y + 0.2} x2={x + 0.8} y2={y + 0.8} strokeWidth={0.05} />
        <line x1={x + 0.8} y1={y + 0.2} x2={x + 0.2} y2={y + 0.8} strokeWidth={0.05} />
      </g>
    );
  }

  if (structure.kind === "hall" || structure.kind === "assembly") {
    return (
      <g fill="#0b1016" stroke="var(--color-amber)" strokeWidth={0.07}>
        <polygon points={`${x + 0.15},${y + 0.4} ${cx},${y + 0.2} ${x + 0.85},${y + 0.4}`} />
        <rect x={x + 0.18} y={y + 0.4} width={0.64} height={0.4} rx={0.04} />
        <line x1={x + 0.32} y1={y + 0.4} x2={x + 0.32} y2={y + 0.8} strokeWidth={0.06} />
        <line x1={cx} y1={y + 0.4} x2={cx} y2={y + 0.8} strokeWidth={0.06} />
        <line x1={x + 0.68} y1={y + 0.4} x2={x + 0.68} y2={y + 0.8} strokeWidth={0.06} />
      </g>
    );
  }

  if (structure.kind === "workshop" || structure.kind === "smithy" || structure.kind === "forge") {
    return (
      <g fill="#0b1016" stroke="var(--color-amber)" strokeWidth={0.07}>
        <rect x={x + 0.2} y={y + 0.3} width={0.6} height={0.5} rx={0.06} />
        <rect x={x + 0.6} y={y + 0.15} width={0.14} height={0.25} fill="var(--color-amber)" stroke="none" />
        <circle cx={x + 0.67} cy={y + 0.1} r={0.04} fill="var(--color-amber)" stroke="none" />
      </g>
    );
  }

  if (structure.kind === "enclosure" || structure.kind === "wall" || structure.kind === "palisade") {
    return (
      <g fill="none" stroke="var(--color-amber)" strokeWidth={0.08} strokeDasharray="0.12 0.08">
        <rect x={x + 0.15} y={y + 0.15} width={0.7} height={0.7} rx={0.04} />
      </g>
    );
  }

  if (structure.kind === "farm" || structure.kind === "field") {
    return (
      <g fill="none" stroke="var(--color-amber)" strokeWidth={0.06}>
        <rect x={x + 0.15} y={y + 0.15} width={0.7} height={0.7} strokeWidth={0.07} />
        <line x1={x + 0.25} y1={y + 0.35} x2={x + 0.75} y2={y + 0.35} />
        <line x1={x + 0.25} y1={y + 0.5} x2={x + 0.75} y2={y + 0.5} />
        <line x1={x + 0.25} y1={y + 0.65} x2={x + 0.75} y2={y + 0.65} />
      </g>
    );
  }

  return (
    <g fill="#0b1016" stroke="var(--color-amber)" strokeWidth={0.08}>
      <rect x={x + 0.2} y={y + 0.2} width={0.6} height={0.6} rx={0.08} />
      <line x1={x + 0.2} y1={y + 0.35} x2={x + 0.8} y2={y + 0.35} strokeWidth={0.05} />
    </g>
  );
}

export function WorldMapView({
  map,
  variant = "full",
}: {
  map: WorldMap;
  variant?: "full" | "compact";
}) {
  const router = useRouter();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState<{ x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<{ x: number; y: number }>({ x: 15, y: 17 });
  const [zoom, setZoom] = useState(1);
  const liveId = useId();

  const tileAt = useCallback(
    (x: number, y: number): Tile | undefined => map.tiles[y * map.width + x],
    [map],
  );

  const structuresByTile = useMemo(() => {
    const index = new Map<string, Structure[]>();
    for (const s of map.structures) {
      const key = `${s.at.x},${s.at.y}`;
      index.set(key, [...(index.get(key) ?? []), s]);
    }
    return index;
  }, [map.structures]);

  const occupantsByTile = useMemo(() => {
    const index = new Map<string, WorldMap["occupants"]>();
    for (const o of map.occupants) {
      const key = `${o.at.x},${o.at.y}`;
      index.set(key, [...(index.get(key) ?? []), o]);
    }
    return index;
  }, [map.occupants]);

  const active = hovered ?? selected;
  const activeTile = tileAt(active.x, active.y);
  const activeStructures = structuresByTile.get(`${active.x},${active.y}`) ?? [];
  const activeOccupants = occupantsByTile.get(`${active.x},${active.y}`) ?? [];

  const pointerToTile = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = Math.floor(((clientX - rect.left) / rect.width) * map.width);
    const y = Math.floor(((clientY - rect.top) / rect.height) * map.height);
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) return null;
    return { x, y };
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      PageUp: [0, -8],
      PageDown: [0, 8],
    };
    const delta = deltas[event.key];
    if (delta) {
      event.preventDefault();
      setHovered(null);
      setSelected((prev) => ({
        x: Math.max(0, Math.min(map.width - 1, prev.x + delta[0])),
        y: Math.max(0, Math.min(map.height - 1, prev.y + delta[1])),
      }));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setSelected({ x: 0, y: 0 });
    }
    if (event.key === "End") {
      event.preventDefault();
      setSelected({ x: map.width - 1, y: map.height - 1 });
    }
  };

  const compact = variant === "compact";

  const summaryLine = activeTile
    ? `Tile ${active.x}, ${active.y}. ${TERRAIN_LABEL[activeTile.terrain]}. ${
        activeStructures.length > 0
          ? `${activeStructures.map((s) => s.name).join(", ")}. `
          : ""
      }${
        activeOccupants.length > 0
          ? `Present: ${activeOccupants.map((o) => o.name).join(", ")}.`
          : "No inhabitant present."
      }`
    : "";

  return (
    <div className={compact ? "" : "grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]"}>
      <div className="panel overflow-hidden">
        <div className="panel-head">
          <div>
            <p className="eyebrow">World map</p>
            <h2 className="text-[0.95rem] font-medium tracking-tight">
              {map.width}&thinsp;×&thinsp;{map.height} grid
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {!compact && (
              <div className="flex items-center gap-1" role="group" aria-label="Zoom">
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.max(1, Number((z - 0.25).toFixed(2))))}
                  className="mono rounded-sm border border-line px-2 py-0.5 text-xs text-muted hover:border-amber-dim hover:text-amber"
                  aria-label="Zoom out"
                >
                  −
                </button>
                <span className="mono w-10 text-center text-xs text-dim">{zoom.toFixed(2)}×</span>
                <button
                  type="button"
                  onClick={() => setZoom((z) => Math.min(4, Number((z + 0.25).toFixed(2))))}
                  className="mono rounded-sm border border-line px-2 py-0.5 text-xs text-muted hover:border-amber-dim hover:text-amber"
                  aria-label="Zoom in"
                >
                  +
                </button>
              </div>
            )}
            <p className="mono text-xs text-dim">
              ({active.x},{active.y})
            </p>
          </div>
        </div>

        <div className={compact ? "p-3" : "overflow-auto p-3"}>
          <div
            tabIndex={0}
            role="group"
            aria-label={`World map, ${map.width} by ${map.height} tiles. Use the arrow keys to move the tile cursor.`}
            aria-describedby={liveId}
            onKeyDown={onKeyDown}
            className="rounded-sm"
            style={{ width: compact ? "100%" : `${zoom * 100}%`, maxWidth: compact ? undefined : "none" }}
          >
            <svg
              ref={svgRef}
              viewBox={`0 0 ${map.width} ${map.height}`}
              className="block h-auto w-full rounded-sm"
              style={{ background: "#050809", shapeRendering: "crispEdges" }}
              onMouseMove={(e) => setHovered(pointerToTile(e.clientX, e.clientY))}
              onMouseLeave={() => setHovered(null)}
              onClick={(e) => {
                const tile = pointerToTile(e.clientX, e.clientY);
                if (tile) setSelected(tile);
              }}
              aria-hidden
            >
              {map.tiles.map((tile) => (
                <rect
                  key={`${tile.x},${tile.y}`}
                  x={tile.x}
                  y={tile.y}
                  width={1}
                  height={1}
                  fill={shade(TERRAIN_COLOUR[tile.terrain], (tile.fertility - 0.4) * 0.28)}
                />
              ))}

              {/* Recorded land-use claims. A dotted edge, not a fence. */}
              <g fill="none" stroke="rgba(217,164,65,0.45)" strokeWidth={0.06} strokeDasharray="0.16 0.12">
                {map.tiles
                  .filter((t) => t.claimedBy)
                  .map((t) => (
                    <rect key={`c${t.x},${t.y}`} x={t.x + 0.05} y={t.y + 0.05} width={0.9} height={0.9} />
                  ))}
              </g>

              <g style={{ shapeRendering: "geometricPrecision" }}>
                {map.structures.map((s) => (
                  <StructureGlyph key={s.id} structure={s} />
                ))}
              </g>

              <g style={{ shapeRendering: "geometricPrecision" }}>
                {map.occupants.map((o, index) => {
                  const same = map.occupants.filter(
                    (other) => other.at.x === o.at.x && other.at.y === o.at.y,
                  );
                  const idx = same.indexOf(o);
                  const offset = same.length > 1 ? (idx - (same.length - 1) / 2) * 0.34 : 0;
                  const deceased = o.status === "deceased";
                  return (
                    <circle
                      key={o.id + index}
                      cx={o.at.x + 0.5 + offset}
                      cy={o.at.y + 0.5}
                      r={0.26}
                      fill={deceased ? "none" : generationColour(o.generation)}
                      stroke={deceased ? "var(--color-gone)" : "#050809"}
                      strokeWidth={0.08}
                      strokeDasharray={deceased ? "0.1 0.08" : undefined}
                      style={{ cursor: "pointer" }}
                      onClick={(e) => {
                        e.stopPropagation();
                        router.push(`/inhabitants/${o.id}`);
                      }}
                    />
                  );
                })}
              </g>

              <rect
                x={active.x}
                y={active.y}
                width={1}
                height={1}
                fill="none"
                stroke="var(--color-amber)"
                strokeWidth={0.12}
              />
            </svg>
          </div>
        </div>

        <p id={liveId} aria-live="polite" className="sr-only">
          {summaryLine}
        </p>

        <div className="hairline flex flex-wrap gap-x-4 gap-y-1.5 px-4 py-2.5">
          {(Object.keys(TERRAIN_COLOUR) as Array<keyof typeof TERRAIN_COLOUR>).map((terrain) => (
            <span key={terrain} className="flex items-center gap-1.5 text-[0.68rem] text-muted">
              <span
                aria-hidden
                className="inline-block size-2.5 rounded-[1px]"
                style={{ background: TERRAIN_COLOUR[terrain] }}
              />
              {TERRAIN_LABEL[terrain]}
            </span>
          ))}
          <span className="flex items-center gap-1.5 text-[0.68rem] text-muted">
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-[1px] border border-amber"
              style={{ background: "#0b1016" }}
            />
            Structure
          </span>
          <span className="flex items-center gap-1.5 text-[0.68rem] text-muted">
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-full border border-dashed border-gone"
            />
            Deceased
          </span>
        </div>
      </div>

      {!compact && (
        <div className="panel h-fit">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Tile readout</p>
              <h2 className="mono text-[0.95rem] font-medium">
                ({active.x}, {active.y})
              </h2>
            </div>
            <span className="text-xs text-dim">{hovered ? "hover" : "selected"}</span>
          </div>

          {activeTile && (
            <div className="space-y-4 px-4 py-4">
              <div>
                <p className="eyebrow">Terrain</p>
                <p className="mt-1 flex items-center gap-2 text-sm">
                  <span
                    aria-hidden
                    className="inline-block size-3 rounded-[2px]"
                    style={{ background: TERRAIN_COLOUR[activeTile.terrain] }}
                  />
                  {TERRAIN_LABEL[activeTile.terrain]}
                  <span className="mono text-xs text-dim">
                    fertility {percent(activeTile.fertility)}
                  </span>
                </p>
              </div>

              <div>
                <p className="eyebrow">Deposit</p>
                <p className="mono mt-1 text-sm text-muted">
                  {activeTile.deposit
                    ? `${activeTile.deposit.remaining} units of ${activeTile.deposit.resource}`
                    : "none recorded"}
                </p>
              </div>

              <div>
                <p className="eyebrow">Recorded land-use rights</p>
                <p className="mono mt-1 text-sm text-muted">
                  {activeTile.claimedBy ?? "unclaimed"}
                </p>
              </div>

              <div>
                <p className="eyebrow">Structures</p>
                {activeStructures.length === 0 ? (
                  <p className="mt-1 text-sm text-dim">None on this tile.</p>
                ) : (
                  <ul className="mt-1 space-y-2">
                    {activeStructures.map((s) => (
                      <li key={s.id} className="text-sm">
                        <span className="text-ink">{s.name}</span>
                        <span className="mono ml-1.5 text-xs text-dim">{s.id}</span>
                        <p className="mono text-xs text-dim">
                          {s.kind} · built {formatSimTime(s.builtAt)} · condition{" "}
                          {percent(s.condition)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <p className="eyebrow">Present</p>
                {activeOccupants.length === 0 ? (
                  <p className="mt-1 text-sm text-dim">No inhabitant at this tile.</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {activeOccupants.map((o) => (
                      <li key={o.id}>
                        <Link
                          href={`/inhabitants/${o.id}`}
                          className="flex items-center gap-2 text-sm text-ink underline decoration-line underline-offset-2 hover:decoration-amber"
                        >
                          <span
                            aria-hidden
                            className="inline-block size-2.5 rounded-full"
                            style={{
                              background:
                                o.status === "deceased" ? "transparent" : generationColour(o.generation),
                              border:
                                o.status === "deceased" ? "1px dashed var(--color-gone)" : undefined,
                            }}
                          />
                          {o.name}
                          <span className="mono text-xs text-dim">
                            gen {o.generation}
                            {o.status === "deceased" ? " · deceased" : ""}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <p className="hairline pt-3 text-xs leading-relaxed text-dim">
                Arrow keys move the tile cursor. Selecting a tile reads the world; it does not
                touch it.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
