import type { Metadata } from "next";
import { worldSource } from "@/lib/world-source";
import { Badge, KeyValue, PageHeader, Panel, Stat } from "@/components/ui";
import { formatRealTime, shortHash } from "@/lib/format";

export const metadata: Metadata = { title: "Audit" };

export default async function AuditPage() {
  const [audit, summary] = await Promise.all([
    worldSource.getAuditStatus(),
    worldSource.getWorldSummary(),
  ]);

  const ok = audit.chain.verified;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Transparency"
        title="Audit and verification"
        lede="Nothing on this page asks you to trust it. The chain status below was recomputed from the exported log when this page was built, and you can run the same computation yourself with the command further down."
        aside={
          <Badge tone={ok ? "alive" : "warn"}>
            {ok ? "chain verified" : "chain verification failed"}
          </Badge>
        }
      />

      <div className="panel grid grid-cols-2 divide-x divide-y divide-line-soft lg:grid-cols-4">
        <Stat
          label="Event chain"
          value={ok ? "verified" : "broken"}
          tone={ok ? "alive" : "warn"}
          sub={
            ok
              ? `all ${audit.chain.eventCount} events, sequence 0 → ${audit.chain.verifiedThroughSequence}`
              : `${audit.chain.brokenReason} at sequence ${audit.chain.brokenAtSequence}`
          }
        />
        <Stat
          label="Chain head"
          value={shortHash(audit.chain.head, 14)}
          sub={audit.chain.head}
        />
        <Stat
          label="State checksum"
          value={shortHash(audit.stateChecksum, 14)}
          sub="post-state of the most recent canonical event"
        />
        <Stat
          label="Source commit"
          value={shortHash(audit.sourceCommit, 12)}
          sub={`image ${shortHash(audit.imageDigest, 12)}`}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel eyebrow="Reproduce it" title="Run the public verifier">
          <div className="px-4 py-4">
            <p className="text-sm leading-relaxed text-muted">
              The verifier requires no credentials and has no write path of any kind. It reads an
              exported log and recomputes it.
            </p>
            <pre className="mono mt-3 overflow-x-auto rounded-sm border border-line bg-abyss px-3 py-2.5 text-xs text-amber">
              <code>{audit.verifier.command}</code>
            </pre>
            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex gap-2">
                <dt className="eyebrow w-20 shrink-0">Repository</dt>
                <dd className="mono break-all text-muted">{audit.verifier.repository}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="eyebrow w-20 shrink-0">Export</dt>
                <dd className="mono break-all text-muted">{audit.verifier.exportUrl}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="eyebrow w-20 shrink-0">Seed</dt>
                <dd className="mono break-all text-muted">{audit.genesisSeed}</dd>
              </div>
            </dl>
            <ul className="mt-4 space-y-2">
              {audit.verifier.notes.map((note) => (
                <li key={note} className="flex gap-2 text-xs leading-relaxed text-dim">
                  <span aria-hidden className="text-amber-dim">
                    ▸
                  </span>
                  {note}
                </li>
              ))}
            </ul>
          </div>
        </Panel>

        <Panel eyebrow="Replay" title="Most recent full reconstruction">
          <KeyValue
            rows={[
              // A world with no history has never been replayed. Saying so is
              // the honest reading; a zeroed row would imply a run that happened.
              ...(audit.lastReplay === null
                ? [{ key: "Replayed", value: "never — this world has no history yet", mono: false }]
                : [
                    { key: "Started", value: formatRealTime(audit.lastReplay.startedAt), mono: true },
                    { key: "Finished", value: formatRealTime(audit.lastReplay.finishedAt), mono: true },
                    { key: "Events replayed", value: audit.lastReplay.eventsReplayed, mono: true },
                    {
                      key: "Reconstructed checksum",
                      value: audit.lastReplay.reconstructedChecksum,
                      mono: true,
                    },
                    {
                      key: "Matches production",
                      value: (
                        <Badge tone={audit.lastReplay.matchesProduction ? "alive" : "warn"}>
                          {audit.lastReplay.matchesProduction ? "match" : "divergence"}
                        </Badge>
                      ),
                    },
                  ]),
              { key: "Schema version", value: audit.schemaVersion, mono: true },
              { key: "Chain recomputed at", value: formatRealTime(audit.chain.computedAt), mono: true },
            ]}
          />
          <p className="hairline px-4 py-3 text-xs leading-relaxed text-dim">
            A replay reconstructs the world from Genesis using the stored model responses and
            compares the resulting checksum with the one production reports. A divergence is
            reported at the sequence number where it appears; it is never quietly repaired.
          </p>
        </Panel>
      </div>

      <Panel eyebrow="External anchors" title="Chain hashes published outside the database">
        {audit.anchors.length === 0 ? (
          <p className="px-4 py-6 text-sm text-dim">No anchor has been published yet.</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {audit.anchors.map((anchor) => (
              <li key={anchor.sequence} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-2.5">
                <span className="mono text-xs text-amber">
                  #{String(anchor.sequence).padStart(5, "0")}
                </span>
                <span className="mono text-xs break-all text-muted">{anchor.hash}</span>
                <span className="mono ml-auto text-[0.65rem] text-dim">
                  {formatRealTime(anchor.publishedAt)} · {anchor.location}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="hairline px-4 py-3 text-xs leading-relaxed text-dim">
          Anchoring the chain head outside the primary database is what makes silent rewriting
          detectable. A technical fault may pause the world; it cannot quietly rewrite its history.
        </p>
      </Panel>

      <Panel eyebrow="Honesty" title="What this export deliberately withholds">
        <ul className="divide-y divide-line-soft">
          {audit.withheld.map((item, index) => {
            const category = item.category ?? item.kind ?? `withheld-${index}`;
            return (
            <li key={`${category}-${index}`} className="px-4 py-3">
              <p className="text-sm text-ink">{category}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">{item.reason}</p>
              {item.releaseCondition && (
                <p className="mono mt-1 text-[0.65rem] text-dim">
                  Release: {item.releaseCondition}
                </p>
              )}
            </li>
          );
          })}
        </ul>
      </Panel>

      <Panel eyebrow="Guarantee" title="Why this application cannot change what it displays">
        <div className="space-y-3 px-4 py-4 text-sm leading-relaxed text-muted">
          <p>
            The spectator application is compiled to static files. It runs no server, exposes no
            route handler, defines no server action, and holds no credential. Its entire data
            interface is a set of read queries — there is no method on it that writes, and a test
            in this repository fails the build if one is added.
          </p>
          <p>
            The simulation runtime alone may propose canonical writes, and those writes pass
            through the rules engine. Freezing the world is the single emergency control that
            exists, it lives outside this application, and using it creates a permanent public
            audit event. There is no tool anywhere that edits an inhabitant, a balance, a
            relationship or a historical event.
          </p>
          <p className="mono text-xs text-dim">
            world {summary.worldId} · schema {summary.schemaVersion} · commit{" "}
            {shortHash(summary.sourceCommit, 12)} · image {shortHash(summary.imageDigest, 12)}
          </p>
        </div>
      </Panel>
    </div>
  );
}
