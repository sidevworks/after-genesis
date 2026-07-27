"use client";

import { useMemo, useState } from "react";
import type { WorldEvent } from "@/lib/world-types";
import { MINUTES_PER_DAY } from "@/lib/world-types";
import { CanonicalEventRow } from "./canonical-event";
import { titleCase } from "@/lib/format";

/**
 * Searchable, filterable timeline.
 *
 * Every control here narrows what is *shown*. There is no form element, no
 * submit, and no network call: the whole log is already in the page and the
 * filtering happens in the reader's browser. Nothing typed here leaves the
 * client, and nothing typed here could reach an inhabitant if it did.
 */
export function EventsBrowser({
  events,
  actors,
  initialSubject,
}: {
  events: WorldEvent[];
  actors: Array<{ id: string; name: string }>;
  initialSubject?: string;
}) {
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [actor, setActor] = useState(initialSubject ?? "");
  const [claimsOnly, setClaimsOnly] = useState(false);
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [visible, setVisible] = useState(40);

  const types = useMemo(
    () => [...new Set(events.map((e) => e.type))].sort(),
    [events],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const from = fromDay === "" ? null : (Number(fromDay) - 1) * MINUTES_PER_DAY;
    const to = toDay === "" ? null : Number(toDay) * MINUTES_PER_DAY - 1;

    return events
      .filter((event) => {
        if (type && event.type !== type) return false;
        if (actor && !event.subjects.includes(actor) && event.actor !== actor) return false;
        if (claimsOnly && event.claims.length === 0) return false;
        if (from !== null && event.simTime < from) return false;
        if (to !== null && event.simTime > to) return false;
        if (needle) {
          const haystack =
            `${event.description} ${event.type} ${event.actorName ?? ""} ${event.id} ${event.hash} ${event.claims
              .map((c) => `${c.byName} ${c.text}`)
              .join(" ")}`.toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        return true;
      })
      .sort((a, b) => b.sequence - a.sequence);
  }, [events, search, type, actor, claimsOnly, fromDay, toDay]);

  const shown = filtered.slice(0, visible);
  const inputClass =
    "w-full rounded-sm border border-line bg-panel-2 px-2.5 py-1.5 text-sm text-ink placeholder:text-dim focus:border-amber-dim";

  return (
    <div className="space-y-4">
      {/* Reading controls. Deliberately not a form element — there is nothing to submit to. */}
      <div className="panel p-4" role="search" aria-label="Filter the canonical event log">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <label htmlFor="ev-search" className="eyebrow mb-1 block">
              Search descriptions, hashes and claims
            </label>
            <input
              id="ev-search"
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setVisible(40);
              }}
              placeholder="confined, Stone Hall, sha256:…"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="ev-type" className="eyebrow mb-1 block">
              Event type
            </label>
            <select
              id="ev-type"
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setVisible(40);
              }}
              className={inputClass}
            >
              <option value="">All types ({types.length})</option>
              {types.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="ev-actor" className="eyebrow mb-1 block">
              Involving
            </label>
            <select
              id="ev-actor"
              value={actor}
              onChange={(e) => {
                setActor(e.target.value);
                setVisible(40);
              }}
              className={inputClass}
            >
              <option value="">Any inhabitant</option>
              {actors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label htmlFor="ev-from" className="eyebrow mb-1 block">
                From day
              </label>
              <input
                id="ev-from"
                type="number"
                min={1}
                value={fromDay}
                onChange={(e) => setFromDay(e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="flex-1">
              <label htmlFor="ev-to" className="eyebrow mb-1 block">
                To day
              </label>
              <input
                id="ev-to"
                type="number"
                min={1}
                value={toDay}
                onChange={(e) => setToDay(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <div className="flex items-end">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
              <input
                type="checkbox"
                checked={claimsOnly}
                onChange={(e) => setClaimsOnly(e.target.checked)}
                className="size-3.5 accent-[#b58ad8]"
              />
              Only events carrying a claim
            </label>
          </div>
        </div>

        <p className="mono mt-3 text-xs text-dim" aria-live="polite">
          {filtered.length} of {events.length} canonical events match. Filtering happens in your
          browser; the log is not queried and not altered.
        </p>
      </div>

      <div className="panel divide-y divide-line-soft">
        {shown.length === 0 ? (
          <p className="px-4 py-8 text-sm text-dim">No canonical event matches these filters.</p>
        ) : (
          shown.map((event) => <CanonicalEventRow key={event.id} event={event} />)
        )}
      </div>

      {visible < filtered.length && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setVisible((v) => v + 60)}
            className="rounded-sm border border-line px-4 py-2 text-sm text-muted hover:border-amber-dim hover:text-amber"
          >
            Show {Math.min(60, filtered.length - visible)} older events
          </button>
        </div>
      )}
    </div>
  );
}
