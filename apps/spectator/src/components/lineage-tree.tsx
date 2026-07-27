import Link from "next/link";
import type { Lineage } from "@/lib/world-types";
import { formatSimTime, generationColour } from "@/lib/format";

/**
 * Family tree across generations (claude.md §20).
 *
 * Deceased inhabitants keep their place in the tree. Death marks an inhabitant
 * inactive; it never removes them from history (§8).
 */
export function LineageTree({ lineage }: { lineage: Lineage }) {
  const generations: Lineage["nodes"][] = [];
  for (const node of lineage.nodes) {
    const bucket = (generations[node.generation] ??= []);
    bucket.push(node);
  }
  for (const bucket of generations) {
    bucket?.sort((a, b) => a.birthSimTime - b.birthSimTime);
  }

  const rows = generations.length;
  const position = new Map<string, { x: number; y: number }>();
  generations.forEach((bucket, g) => {
    const list = bucket ?? [];
    list.forEach((node, i) => {
      position.set(node.id, {
        x: ((i + 1) / (list.length + 1)) * 100,
        y: ((g + 0.5) / rows) * 100,
      });
    });
  });

  const edges = lineage.nodes.flatMap((node) =>
    node.parentIds.flatMap((parentId) => {
      const from = position.get(parentId);
      const to = position.get(node.id);
      if (!from || !to) return [];
      return [{ key: `${parentId}-${node.id}`, from, to }];
    }),
  );

  return (
    <div className="overflow-x-auto">
      <div
        className="relative mx-auto"
        style={{ minWidth: "56rem", height: `${rows * 11}rem` }}
      >
        <svg
          className="absolute inset-0 h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          aria-hidden
        >
          {edges.map(({ key, from, to }) => (
            <path
              key={key}
              d={`M ${from.x} ${from.y + 3} C ${from.x} ${(from.y + to.y) / 2}, ${to.x} ${
                (from.y + to.y) / 2
              }, ${to.x} ${to.y - 3}`}
              fill="none"
              stroke="var(--color-line)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>

        {generations.map((bucket, g) => (
          <div key={g}>
            <p
              className="eyebrow absolute left-0 -translate-y-1/2"
              style={{ top: `${((g + 0.5) / rows) * 100}%` }}
            >
              Gen {g}
            </p>
            {(bucket ?? []).map((node) => {
              const pos = position.get(node.id)!;
              const deceased = node.status === "deceased";
              return (
                <Link
                  key={node.id}
                  href={`/inhabitants/${node.id}`}
                  className="absolute w-36 -translate-x-1/2 -translate-y-1/2 rounded-sm border bg-panel px-2.5 py-2 text-center transition-colors hover:border-amber-dim"
                  style={{
                    left: `${pos.x}%`,
                    top: `${pos.y}%`,
                    borderColor: deceased ? "var(--color-line)" : generationColour(g) + "55",
                  }}
                >
                  <span className="flex items-center justify-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block size-2 rounded-full"
                      style={{
                        background: deceased ? "transparent" : generationColour(g),
                        border: deceased ? "1px dashed var(--color-gone)" : undefined,
                      }}
                    />
                    <span className={`text-sm ${deceased ? "text-gone" : "text-ink"}`}>
                      {node.name}
                    </span>
                  </span>
                  <span className="mono mt-0.5 block text-[0.62rem] text-dim">{node.id}</span>
                  <span className="mono mt-0.5 block text-[0.62rem] text-dim">
                    b. {formatSimTime(node.birthSimTime).replace(" ", " · ")}
                  </span>
                  {node.deathSimTime !== undefined && (
                    <span className="mono mt-0.5 block text-[0.62rem] text-gone">
                      d. {formatSimTime(node.deathSimTime).replace(" ", " · ")}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
