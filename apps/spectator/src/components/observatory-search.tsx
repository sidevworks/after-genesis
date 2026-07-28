"use client";

import { useMemo, useState } from "react";

interface SearchEntry {
  refId: string;
  displayName: string;
  referenceClass: string;
  canonicalType: string;
}

export function ObservatorySearch({
  worldId,
  entries,
}: {
  worldId: string;
  entries: SearchEntry[];
}) {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return entries.filter((entry) => entry.referenceClass === "ENT");
    const exact = entries.find((entry) => entry.refId.toLowerCase() === needle);
    if (exact) return [exact];
    return entries
      .filter((entry) =>
        `${entry.displayName} ${entry.refId} ${entry.referenceClass} ${entry.canonicalType}`
          .toLowerCase()
          .includes(needle),
      )
      .slice(0, 12);
  }, [entries, query]);

  return (
    <div className="relative">
      <label htmlFor="observatory-search" className="eyebrow">
        Find any reference
      </label>
      <input
        id="observatory-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Name, type, or AG:W001:…"
        className="mt-2 w-full rounded-sm border border-line bg-abyss/85 px-3 py-2.5 text-sm text-ink placeholder:text-dim focus:border-amber"
      />
      <ul className="mt-2 divide-y divide-line-soft rounded-sm border border-line bg-panel/95">
        {results.map((entry) => (
          <li key={entry.refId}>
            <a
              href={`/world/${worldId}/ref/${encodeURIComponent(entry.refId)}`}
              className="grid gap-0.5 px-3 py-2.5 hover:bg-panel-2 sm:grid-cols-[1fr_auto] sm:items-center"
            >
              <span className="text-sm text-ink">{entry.displayName}</span>
              <span className="mono text-[0.62rem] text-dim">{entry.refId}</span>
              <span className="mono text-[0.62rem] tracking-wider text-muted uppercase">
                {entry.referenceClass} · {entry.canonicalType.replaceAll("_", " ")}
              </span>
            </a>
          </li>
        ))}
        {results.length === 0 && (
          <li className="px-3 py-4 text-sm text-dim">No reference matches this index.</li>
        )}
      </ul>
    </div>
  );
}
