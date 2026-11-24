// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import type { Metadata } from "next";
import Link from "next/link";
import { worldSource } from "@/lib/world-source";
import { LineageTree } from "@/components/lineage-tree";
import { PageHeader, Panel } from "@/components/ui";
import { formatSimTime } from "@/lib/format";

export const metadata: Metadata = { title: "Lineage" };

export default async function LineagePage() {
  const [lineage, summary] = await Promise.all([
    worldSource.getLineage(),
    worldSource.getWorldSummary(),
  ]);

  const deceased = lineage.nodes.filter((n) => n.status === "deceased");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`${lineage.generationCount} generations · ${lineage.nodes.length} inhabitants`}
        title="Lineage"
        lede="The experiment began with exactly one inhabitant. Every other inhabitant descends from it through an authorised world action that consumed resources and time. Humans cannot add a node to this tree."
      />

      <Panel eyebrow="Descent" title="Family tree">
        <div className="p-4">
          <LineageTree lineage={lineage} />
        </div>
        <p className="hairline px-4 py-3 text-xs leading-relaxed text-dim">
          Deceased inhabitants keep their place. Removing them would remove the descent path of
          everyone below them.
        </p>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel eyebrow="Founder" title="Generation 0">
          <ul className="divide-y divide-line-soft">
            {lineage.rootIds.map((rootId) => {
              const node = lineage.nodes.find((n) => n.id === rootId);
              if (!node) return null;
              return (
                <li key={rootId} className="px-4 py-3">
                  <Link href={`/inhabitants/${node.id}`} className="text-sm text-ink hover:text-amber">
                    {node.name}
                  </Link>
                  <p className="mono text-xs text-dim">
                    {node.id} · instantiated at Genesis · {node.childIds?.length ?? 0} direct descendants
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-dim">
                    Instantiated by the Genesis procedure, not by an inhabitant. Every later
                    inhabitant required an existing one.
                  </p>
                </li>
              );
            })}
          </ul>
        </Panel>

        <Panel eyebrow="Mortality" title="Deceased inhabitants">
          {deceased.length === 0 ? (
            <p className="px-4 py-6 text-sm text-dim">No inhabitant has died.</p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {deceased.map((node) => (
                <li key={node.id} className="px-4 py-3">
                  <Link href={`/inhabitants/${node.id}`} className="text-sm text-gone hover:text-amber">
                    {node.name}
                  </Link>
                  <p className="mono text-xs text-dim">
                    {node.id} · born {formatSimTime(node.birthSimTime)}
                    {node.deathSimTime !== undefined && ` · died ${formatSimTime(node.deathSimTime)}`}
                    {node.deathSimTime !== undefined &&
                      ` · lived ${Math.floor((node.deathSimTime - node.birthSimTime) / 1440)} days`}
                  </p>
                  <p className="mono text-xs text-dim">
                    {node.childIds?.length ?? 0} descendants, all of whom remain
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="hairline px-4 py-3 text-xs leading-relaxed text-dim">
            {summary.population.deceased} of {summary.population.total} inhabitants ever created
            have died. Their profiles, property, artifacts and complete event history remain
            browsable.
          </p>
        </Panel>
      </div>
    </div>
  );
}
