// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import Link from "next/link";
import type { EventClaim, WorldEvent } from "@/lib/world-types";
import { formatSimTime, shortHash, titleCase } from "@/lib/format";
import { Badge } from "./ui";

/**
 * The product's central distinction, in one component (claude.md §11G, §11J).
 *
 * The canonical description is rendered verbatim, in the document's primary
 * voice, with no paraphrase and no editorial styling.
 *
 * A claim is something an inhabitant or organisation said *about* an event. It
 * is rendered underneath, attributed by name, dashed-ruled, tinted, and
 * prefixed with the word CLAIM. Organisational descriptions cannot overwrite
 * canonical descriptions, and here they cannot even sit in the same block.
 */

export function ClaimBlock({ claim }: { claim: EventClaim }) {
  const href =
    claim.byKind === "inhabitant" ? `/inhabitants/${claim.byId}` : `/organisations#${claim.byId}`;
  return (
    <figure className="claim my-2 rounded-r-sm py-2 pr-3 pl-3">
      <figcaption className="flex flex-wrap items-center gap-2">
        <Badge tone="claim" title="Not canonical. An inhabitant's or organisation's own words.">
          Claim
        </Badge>
        <Link
          href={href}
          className="text-xs text-claim underline decoration-claim-dim underline-offset-2 hover:decoration-claim"
        >
          {claim.byName}
        </Link>
        <span className="mono text-[0.65rem] text-dim">
          {claim.byKind === "organisation" ? "organisation" : "inhabitant"} ·{" "}
          {formatSimTime(claim.simTime)}
        </span>
      </figcaption>
      <blockquote className="mt-1.5 text-sm leading-relaxed text-[#e2d3f0] italic">
        &ldquo;{claim.text}&rdquo;
      </blockquote>
    </figure>
  );
}

export function ClaimList({ claims }: { claims: EventClaim[] }) {
  if (claims.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="eyebrow mb-1 text-claim-dim">
        {claims.length} attributed {claims.length === 1 ? "claim" : "claims"} — not canonical
      </p>
      {claims.map((claim) => (
        <ClaimBlock key={claim.id} claim={claim} />
      ))}
    </div>
  );
}

function ResolutionBadge({ event }: { event: WorldEvent }) {
  if (event.resolution === "applied") return null;
  return (
    <Badge tone={event.resolution === "rejected" ? "warn" : "amber"}>{event.resolution}</Badge>
  );
}

function EventPayload({ event }: { event: WorldEvent }) {
  if (Object.keys(event.inputs).length === 0) return null;
  return (
    <details className="mt-3 rounded-sm border border-line bg-abyss/70">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted hover:text-ink">
        Show canonical payload
      </summary>
      <pre className="max-h-80 overflow-auto border-t border-line p-3 text-[0.68rem] leading-relaxed text-muted">
        {JSON.stringify(event.inputs, null, 2)}
      </pre>
    </details>
  );
}

export function CanonicalEventRow({
  event,
  showHash = true,
  compact = false,
}: {
  event: WorldEvent;
  showHash?: boolean;
  compact?: boolean;
}) {
  return (
    <article
      id={event.id}
      className="scroll-mt-24 px-4 py-3.5"
      aria-labelledby={`${event.id}-desc`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="mono text-xs text-amber" title="Sequence number in the append-only log">
          #{String(event.sequence).padStart(5, "0")}
        </span>
        <time className="mono text-xs text-muted" dateTime={event.realTime}>
          {formatSimTime(event.simTime)}
        </time>
        <Badge>{titleCase(event.type)}</Badge>
        {event.actor && event.actorName ? (
          <Link
            href={`/inhabitants/${event.actor}`}
            className="text-xs text-ink underline decoration-line underline-offset-2 hover:decoration-amber"
          >
            {event.actorName}
          </Link>
        ) : (
          <span className="mono text-xs text-dim">world engine</span>
        )}
        <ResolutionBadge event={event} />
        {event.visibility !== "public" && (
          <Badge tone="amber" title="This record is not fully public.">
            {event.visibility.replace(/_/g, " ")}
          </Badge>
        )}
      </div>

      {/* Canonical description — verbatim, never paraphrased (§11G). */}
      <p id={`${event.id}-desc`} className="canonical mt-2 text-sm">
        {event.description}
      </p>

      {event.resolutionNote && (
        <p className="mt-1.5 text-xs text-dim">
          <span className="eyebrow mr-1.5">Resolution</span>
          {event.resolutionNote}
        </p>
      )}

      {!compact && <ClaimList claims={event.claims} />}
      {!compact && <EventPayload event={event} />}
      {compact && event.claims.length > 0 && (
        <p className="mt-1.5 text-xs text-claim">
          {event.claims.length} attributed {event.claims.length === 1 ? "claim" : "claims"} on this
          event
        </p>
      )}

      {showHash && (
        <dl className="mono mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[0.68rem] text-dim">
          <div className="flex gap-1.5">
            <dt className="text-line">hash</dt>
            <dd title={event.hash}>{shortHash(event.hash, 16)}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-line">prev</dt>
            <dd title={event.prevHash}>{shortHash(event.prevHash, 16)}</dd>
          </div>
          {event.location && (
            <div className="flex gap-1.5">
              <dt className="text-line">tile</dt>
              <dd>
                ({event.location.x},{event.location.y})
              </dd>
            </div>
          )}
          {event.modelResponseHash && (
            <div className="flex gap-1.5">
              <dt className="text-line">model response</dt>
              <dd title={event.modelResponseHash}>{shortHash(event.modelResponseHash, 12)}</dd>
            </div>
          )}
        </dl>
      )}
    </article>
  );
}
