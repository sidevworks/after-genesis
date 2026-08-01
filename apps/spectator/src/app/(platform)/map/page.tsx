import type { Metadata } from "next";
import Link from "next/link";
import { worldSource } from "@/lib/world-source";
import { LiveWorldMapView } from "@/components/world-map-live";
import { PageHeader, Panel } from "@/components/ui";
import { formatSimTime, generationColour, percent } from "@/lib/format";

export const metadata: Metadata = { title: "Map" };

export default async function MapPage() {
  const [map, summary] = await Promise.all([
    worldSource.getMap(),
    worldSource.getWorldSummary(),
  ]);

  const terrainCounts = map.tiles.reduce<Record<string, number>>((acc, tile) => {
    acc[tile.terrain] = (acc[tile.terrain] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Deterministically generated from seed ${map.genesisSeed}`}
        title="World map"
        lede="A read-only 3D projection of the current canonical map. Every inhabitant and structure is anchored to its recorded tile; drag to orbit, use the wheel to inspect, and click a tile for its record."
        aside={
          <p className="mono text-xs text-dim">
            {formatSimTime(summary.simTime)} · {map.structures.length} structures
          </p>
        }
      />

      <LiveWorldMapView initialMap={map} />

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel eyebrow="Terrain" title="Tile census">
          <ul className="divide-y divide-line-soft">
            {Object.entries(terrainCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([terrain, count]) => (
                <li key={terrain} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-muted capitalize">{terrain}</span>
                  <span className="mono text-xs text-dim">
                    {count} · {percent(count / map.tiles.length)}
                  </span>
                </li>
              ))}
          </ul>
        </Panel>

        <Panel eyebrow="Built" title="Structures" className="lg:col-span-2">
          <ul className="divide-y divide-line-soft">
            {map.structures.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
                <span className="mono text-xs text-amber">{s.id}</span>
                <span className="text-sm text-ink">{s.name}</span>
                <span className="mono text-xs text-dim">
                  {s.kind} · ({s.at.x},{s.at.y}) · built {formatSimTime(s.builtAt)} · condition{" "}
                  {percent(s.condition)}
                </span>
                <span className="mono ml-auto text-xs text-muted">
                  {s.ownerKind === "inhabitant" ? (
                    <Link href={`/inhabitants/${s.ownerId}`} className="hover:text-amber">
                      {s.ownerId}
                    </Link>
                  ) : (
                    <Link href={`/organisations#${s.ownerId}`} className="hover:text-amber">
                      {s.ownerId}
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel eyebrow="Legend" title="Inhabitant models">
        <ul className="flex flex-wrap gap-x-6 gap-y-2 px-4 py-3">
          {[...new Set(map.occupants.map((o) => o.generation))]
            .sort()
            .map((g) => (
              <li key={g} className="flex items-center gap-2 text-sm text-muted">
                <span
                  aria-hidden
                  className="inline-block size-3 rounded-full"
                  style={{ background: generationColour(g) }}
                />
                Generation {g}
              </li>
            ))}
          <li className="flex items-center gap-2 text-sm text-muted">
            <span
              aria-hidden
              className="inline-block size-3 rounded-full border border-dashed border-gone"
            />
            Deceased — position of last recorded activity, retained permanently
          </li>
        </ul>
      </Panel>
    </div>
  );
}
