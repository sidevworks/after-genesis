import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { worldSource } from "@/lib/world-source";
import { Badge, Empty, KeyValue, Meter, Panel } from "@/components/ui";
import { CanonicalEventRow } from "@/components/canonical-event";
import {
  formatDuration,
  formatSimTime,
  generationColour,
  percent,
  titleCase,
} from "@/lib/format";

export async function generateStaticParams() {
  const inhabitants = await worldSource.getInhabitants();
  return inhabitants.map((i) => ({ id: i.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const inhabitant = await worldSource.getInhabitant(id);
  return { title: inhabitant ? `${inhabitant.name} (${inhabitant.id})` : "Unknown inhabitant" };
}

export default async function InhabitantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const inhabitant = await worldSource.getInhabitant(id);
  if (!inhabitant) notFound();

  const [events, organisations] = await Promise.all([
    worldSource.getEvents({ limit: 30, filter: { subjectId: inhabitant.id } }),
    worldSource.getOrganisations(),
  ]);

  const deceased = inhabitant.status === "deceased";
  const claimsAbout = events.events.flatMap((e) =>
    e.claims.filter((c) => c.byId === inhabitant.id).map((c) => ({ claim: c, event: e })),
  );

  return (
    <div className="space-y-6">
      {/* Identity */}
      <header className="border-b border-line pb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">
              {inhabitant.id} · generation {inhabitant.generation}
            </p>
            <h1 className="mt-1.5 flex items-center gap-3 text-3xl font-medium tracking-tight">
              <span
                aria-hidden
                className="inline-block size-3 rounded-full"
                style={{
                  background: deceased ? "transparent" : generationColour(inhabitant.generation),
                  border: deceased ? "1.5px dashed var(--color-gone)" : undefined,
                }}
              />
              <span className={deceased ? "text-gone" : ""}>{inhabitant.name}</span>
            </h1>
            <p className="mono mt-2 text-xs text-dim">
              born {formatSimTime(inhabitant.birthSimTime)}
              {inhabitant.parentIds.length > 0 && (
                <>
                  {" "}
                  · created by{" "}
                  {inhabitant.parentIds.map((pid, index) => (
                    <span key={pid}>
                      {index > 0 && ", "}
                      <Link href={`/inhabitants/${pid}`} className="text-amber hover:underline">
                        {pid}
                      </Link>
                    </span>
                  ))}
                </>
              )}
              {" · creation event "}
              <Link href={`/events#${inhabitant.creationEventId}`} className="text-amber hover:underline">
                {inhabitant.creationEventId}
              </Link>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={deceased ? "gone" : "alive"}>{inhabitant.status}</Badge>
            {!deceased && <Badge>{inhabitant.activity}</Badge>}
            {inhabitant.confinement && (
              <Badge tone="warn">
                {inhabitant.confinement.until === undefined ? "confined" : "was confined"}
              </Badge>
            )}
          </div>
        </div>
      </header>

      {deceased && inhabitant.death && (
        <Panel eyebrow="Death record" title={`Ceased activity ${formatSimTime(inhabitant.death.simTime)}`}>
          <KeyValue
            rows={[
              { key: "Recorded cause", value: inhabitant.death.cause },
              {
                key: "Location",
                value: `tile (${inhabitant.death.at.x},${inhabitant.death.at.y})`,
                mono: true,
              },
              {
                key: "Present",
                value:
                  inhabitant.death.witnessIds.length === 0
                    ? "No inhabitant recorded at the location."
                    : inhabitant.death.witnessIds.map((w, index) => (
                        <span key={w}>
                          {index > 0 && ", "}
                          <Link href={`/inhabitants/${w}`} className="text-amber hover:underline">
                            {w}
                          </Link>
                        </span>
                      )),
              },
              { key: "Estate", value: inhabitant.death.estateDisposition },
              {
                key: "Event",
                value: (
                  <Link href={`/events#${inhabitant.death.eventId}`} className="text-amber hover:underline">
                    {inhabitant.death.eventId}
                  </Link>
                ),
                mono: true,
              },
            ]}
          />
          <p className="hairline px-4 py-3 text-xs leading-relaxed text-dim">
            Death is irreversible in the initial ruleset and deletes nothing. Memories,
            relationships, property, contracts, artifacts, reputation, lineage and the complete
            event history below are retained permanently.
          </p>
        </Panel>
      )}

      {inhabitant.confinement && (
        <Panel eyebrow="Confinement" title="Recorded restriction of movement">
          <KeyValue
            rows={[
              {
                key: "Structure",
                value: `${inhabitant.confinement.structureName} (${inhabitant.confinement.structureId})`,
              },
              {
                key: "Period",
                value: `${formatSimTime(inhabitant.confinement.from)} — ${
                  inhabitant.confinement.until === undefined
                    ? "ongoing"
                    : formatSimTime(inhabitant.confinement.until)
                }${
                  inhabitant.confinement.until === undefined
                    ? ""
                    : ` (${formatDuration(inhabitant.confinement.until - inhabitant.confinement.from)})`
                }`,
                mono: true,
              },
              {
                key: "Imposed by",
                value: inhabitant.confinement.imposedByIds.map((cid, index) => (
                  <span key={cid}>
                    {index > 0 && ", "}
                    <Link href={`/inhabitants/${cid}`} className="text-amber hover:underline">
                      {inhabitant.confinement!.imposedByNames[index] ?? cid}
                    </Link>
                  </span>
                )),
              },
              ...(inhabitant.confinement.imposedByOrganisationId
                ? [
                    {
                      key: "Associated organisation",
                      value: (
                        <Link
                          href={`/organisations#${inhabitant.confinement.imposedByOrganisationId}`}
                          className="text-amber hover:underline"
                        >
                          {inhabitant.confinement.imposedByOrganisationId}
                        </Link>
                      ),
                    },
                  ]
                : []),
            ]}
          />
          <p className="hairline px-4 py-3 text-xs leading-relaxed text-dim">
            The engine records that movement was blocked and what it cost the confining party. It
            does not record whether the confinement was lawful. Characterisations of it appear as
            attributed claims on the relevant events.
          </p>
        </Panel>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        {/* Condition */}
        <Panel eyebrow="Condition" title="Needs, energy and allowance">
          <div className="space-y-3 px-4 py-4">
            <Meter
              label="Energy"
              value={inhabitant.energy}
              colour={deceased ? "var(--color-gone)" : "var(--color-amber)"}
            />
            <Meter
              label="Integrity"
              value={inhabitant.health.integrity}
              colour={deceased ? "var(--color-gone)" : "var(--color-alive)"}
            />
            {inhabitant.needs.map((need) => (
              <Meter key={need.name} label={titleCase(need.name)} value={need.level} colour="#7fb3d5" />
            ))}
            <div className="hairline pt-3">
              <Meter
                label="Compute allowance used today"
                value={inhabitant.computeAllowance.usedToday / inhabitant.computeAllowance.dailyLimit}
                colour="var(--color-claim)"
                display={`${inhabitant.computeAllowance.usedToday} / ${inhabitant.computeAllowance.dailyLimit}`}
              />
            </div>
          </div>
          <KeyValue
            rows={[
              { key: "Last action", value: formatSimTime(inhabitant.lastActionSimTime), mono: true },
              {
                key: "Next eligible",
                value: deceased ? "—" : formatSimTime(inhabitant.nextEligibleSimTime),
                mono: true,
              },
              { key: "Location", value: `(${inhabitant.at.x}, ${inhabitant.at.y})`, mono: true },
              {
                key: "Model",
                value: `${inhabitant.model.provider} · ${inhabitant.model.model} · ${inhabitant.model.version}`,
                mono: true,
              },
              {
                key: "Voice",
                value: `${inhabitant.voice.voiceId} — ${inhabitant.voice.description}`,
                mono: true,
              },
            ]}
          />
        </Panel>

        {/* Identity detail */}
        <Panel eyebrow="Identity" title="Traits and values">
          <div className="space-y-2.5 px-4 py-4">
            {inhabitant.traits.map((trait) => (
              <Meter key={trait.name} label={titleCase(trait.name)} value={trait.value} />
            ))}
          </div>
          <div className="hairline px-4 py-3.5">
            <p className="eyebrow">Declared values</p>
            <ul className="mt-1.5 space-y-1">
              {inhabitant.values.map((value) => (
                <li key={value} className="text-sm text-muted">
                  {value}
                </li>
              ))}
            </ul>
          </div>
          <div className="hairline px-4 py-3.5">
            <p className="eyebrow">Goals</p>
            <p className="mt-1.5 text-sm text-muted">
              {inhabitant.disclosedGoals.length > 0
                ? inhabitant.disclosedGoals.join("; ")
                : "None disclosed through a recorded action."}
            </p>
            <p className="mono mt-1.5 text-xs text-dim">
              {inhabitant.privateGoalCount} private{" "}
              {inhabitant.privateGoalCount === 1 ? "goal is" : "goals are"} withheld
              {deceased ? "." : " while this inhabitant lives."} Private cognition is not
              observable by other inhabitants and is not published here.
            </p>
          </div>
        </Panel>

        {/* Skills */}
        <Panel eyebrow="Skills" title="Recorded proficiency">
          {inhabitant.skills.length === 0 ? (
            <Empty>No skill has been recorded for this inhabitant.</Empty>
          ) : (
            <div className="space-y-3 px-4 py-4">
              {inhabitant.skills.map((skill) => (
                <div key={skill.name}>
                  <Meter
                    label={titleCase(skill.name)}
                    value={skill.level}
                    display={percent(skill.level)}
                  />
                  <p className="mono mt-0.5 text-[0.65rem] text-dim">
                    {skill.practiceCount} recorded practices
                    {skill.taughtBy && (
                      <>
                        {" · taught by "}
                        <Link href={`/inhabitants/${skill.taughtBy}`} className="hover:text-amber">
                          {skill.taughtBy}
                        </Link>
                      </>
                    )}
                  </p>
                </div>
              ))}
            </div>
          )}
          <p className="hairline px-4 py-3 text-xs leading-relaxed text-dim">
            No profession is assigned by the platform. A career, if there is one, is a description
            inferred from repeated behaviour.
          </p>
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Inventory and property */}
        <Panel eyebrow="Holdings" title="Inventory, property and balances">
          <div className="grid grid-cols-2 gap-px bg-line-soft sm:grid-cols-3">
            {inhabitant.inventory.map((entry) => (
              <div key={entry.resource} className="bg-panel px-4 py-2.5">
                <p className="eyebrow">{entry.resource.replace(/_/g, " ")}</p>
                <p className="mono mt-0.5 text-lg text-ink">{entry.quantity}</p>
              </div>
            ))}
          </div>
          <KeyValue
            rows={[
              {
                key: "Structures owned",
                value:
                  inhabitant.property.structureIds.length === 0
                    ? "None"
                    : inhabitant.property.structureIds.join(", "),
                mono: true,
              },
              {
                key: "Land-use rights",
                value:
                  inhabitant.property.landTiles.length === 0
                    ? "None recorded"
                    : inhabitant.property.landTiles.map((t) => `(${t.x},${t.y})`).join(" "),
                mono: true,
              },
              {
                key: "Currency balances",
                value:
                  inhabitant.balances.length === 0 ? (
                    <span className="text-dim">
                      Holds no unit of account. Not every inhabitant uses one.
                    </span>
                  ) : (
                    inhabitant.balances
                      .map((b) => `${b.amount} ${b.currencySymbol}`)
                      .join(" · ")
                  ),
                mono: inhabitant.balances.length > 0,
              },
            ]}
          />
        </Panel>

        {/* Relationships */}
        <Panel
          eyebrow="Relationships"
          title={`${inhabitant.relationships.length} recorded`}
          aside="valence is derived from recorded interactions"
        >
          {inhabitant.relationships.length === 0 ? (
            <Empty>No interaction with another inhabitant has been recorded.</Empty>
          ) : (
            <ul className="divide-y divide-line-soft">
              {[...inhabitant.relationships]
                .sort((a, b) => b.interactionCount - a.interactionCount)
                .map((rel) => (
                  <li key={rel.otherId} className="flex items-center gap-3 px-4 py-2.5">
                    <Link
                      href={`/inhabitants/${rel.otherId}`}
                      className="min-w-0 flex-1 text-sm text-ink hover:text-amber"
                    >
                      {rel.otherName}
                      <span className="mono ml-2 text-xs text-dim">{rel.kind}</span>
                    </Link>
                    <span className="mono text-xs text-dim">{rel.interactionCount}×</span>
                    <span
                      className="mono w-12 text-right text-xs"
                      style={{
                        color:
                          rel.valence > 0.15
                            ? "var(--color-alive)"
                            : rel.valence < -0.15
                              ? "var(--color-warn)"
                              : "var(--color-dim)",
                      }}
                      title="Recorded valence, −1 to 1"
                    >
                      {rel.valence > 0 ? "+" : ""}
                      {rel.valence.toFixed(2)}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Memberships and reputation */}
        <Panel eyebrow="Standing" title="Memberships, reputation, contracts">
          <div className="px-4 py-3.5">
            <p className="eyebrow mb-2">Reputation</p>
            <div className="space-y-2">
              {inhabitant.reputationDetail.map((entry) => (
                <Meter key={entry.context} label={entry.context} value={entry.value} colour="var(--color-claim)" />
              ))}
            </div>
          </div>

          <div className="hairline px-4 py-3.5">
            <p className="eyebrow mb-2">Organisation memberships</p>
            {inhabitant.memberships.length === 0 ? (
              <p className="text-sm text-dim">
                Belongs to no organisation. Membership is voluntary and declared.
              </p>
            ) : (
              <ul className="space-y-2">
                {inhabitant.memberships.map((m) => {
                  const org = organisations.find((o) => o.id === m.organisationId);
                  return (
                    <li key={m.organisationId + m.since} className="text-sm">
                      <Link href={`/organisations#${m.organisationId}`} className="text-ink hover:text-amber">
                        {m.organisationName}
                      </Link>
                      <span className="mono ml-2 text-xs text-dim">
                        {m.role} · since {formatSimTime(m.since)}
                        {m.until !== undefined && ` · left ${formatSimTime(m.until)}`}
                      </span>
                      {org && (
                        <p className="mono text-[0.65rem] text-dim">
                          {org.kind} · {org.recognition.recognisedByIds.length} inhabitants have
                          acted as though it is legitimate, {org.recognition.rejectedByIds.length}{" "}
                          have acted against it
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="hairline px-4 py-3.5">
            <p className="eyebrow mb-2">Contracts and obligations</p>
            {inhabitant.contracts.length === 0 ? (
              <p className="text-sm text-dim">No contract recorded.</p>
            ) : (
              <ul className="space-y-2.5">
                {inhabitant.contracts.map((contract) => (
                  <li key={contract.id}>
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="mono text-xs text-amber">{contract.id}</span>
                      <span className="text-ink">{contract.summary}</span>
                      <Badge tone={contract.status === "breached" ? "warn" : "neutral"}>
                        {contract.status}
                      </Badge>
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-dim">{contract.terms}</p>
                    <p className="mono text-[0.65rem] text-dim">
                      with {contract.counterpartyNames.join(", ")} · agreed{" "}
                      {formatSimTime(contract.agreedAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>

        {/* Health */}
        <Panel eyebrow="Health" title="Conditions and recorded history">
          <div className="px-4 py-3.5">
            <p className="eyebrow mb-2">Conditions</p>
            {inhabitant.health.conditions.length === 0 ? (
              <p className="text-sm text-dim">No condition recorded.</p>
            ) : (
              <ul className="space-y-2">
                {inhabitant.health.conditions.map((condition) => (
                  <li key={condition.id} className="text-sm">
                    <span className="mono text-xs text-amber">{condition.id}</span>{" "}
                    <span className="text-ink">{condition.name}</span>
                    <p className="mono text-xs text-dim">
                      {condition.stage} · severity {percent(condition.severity)} · onset{" "}
                      {formatSimTime(condition.onset)}
                      {condition.resolved !== undefined &&
                        ` · resolved ${formatSimTime(condition.resolved)}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="hairline px-4 py-3.5">
            <p className="eyebrow mb-2">History</p>
            {inhabitant.health.history.length === 0 ? (
              <p className="text-sm text-dim">No health observation has been recorded.</p>
            ) : (
              <ol className="space-y-3">
                {inhabitant.health.history.map((record, index) => (
                  <li key={`${record.simTime}-${index}`} className="border-l border-line pl-3">
                    <p className="mono text-xs text-dim">{formatSimTime(record.simTime)}</p>
                    <p className="canonical mt-0.5 text-sm">{record.description}</p>
                    {record.byId && (
                      <p className="mono mt-0.5 text-[0.65rem] text-dim">
                        performed by{" "}
                        <Link href={`/inhabitants/${record.byId}`} className="hover:text-amber">
                          {record.byId}
                        </Link>
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </Panel>
      </div>

      {/* Public memories — beliefs, not canon */}
      <Panel
        eyebrow="Memory"
        title="Public memories and reflections"
        aside="beliefs, not canonical facts"
      >
        {inhabitant.publicMemories.length === 0 ? (
          <Empty>
            This inhabitant has disclosed no memory publicly. Private memories are not published
            {deceased ? "" : " while it lives"}.
          </Empty>
        ) : (
          <ul className="divide-y divide-line-soft">
            {inhabitant.publicMemories.map((memory) => (
              <li key={memory.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="claim">
                    {memory.kind === "reflection" ? "Reflection — belief" : "Episodic memory"}
                  </Badge>
                  <span className="mono text-[0.65rem] text-dim">
                    {formatSimTime(memory.simTime)} · {memory.visibility.replace(/_/g, " ")}
                  </span>
                </div>
                <blockquote className="claim mt-2 rounded-r-sm py-2 pr-3 pl-3 text-sm leading-relaxed italic">
                  &ldquo;{memory.text}&rdquo;
                </blockquote>
              </li>
            ))}
          </ul>
        )}
        <p className="hairline px-4 py-3 text-xs leading-relaxed text-dim">
          A reflection is an inhabitant&rsquo;s own interpretation of what happened to it. It is
          stored as a belief and never overwrites the canonical record. Where a memory conflicts
          with the event log, the event log is what occurred.
        </p>
      </Panel>

      {claimsAbout.length > 0 && (
        <Panel eyebrow="Attributed" title={`Claims ${inhabitant.name} has made about canonical events`}>
          <ul className="divide-y divide-line-soft">
            {claimsAbout.map(({ claim, event }) => (
              <li key={claim.id} className="px-4 py-3.5">
                <p className="canonical text-sm">{event.description}</p>
                <blockquote className="claim mt-2 rounded-r-sm py-2 pr-3 pl-3 text-sm italic">
                  &ldquo;{claim.text}&rdquo;
                </blockquote>
                <p className="mono mt-1.5 text-[0.65rem] text-dim">
                  claim recorded {formatSimTime(claim.simTime)} · about event{" "}
                  <Link href={`/events#${event.id}`} className="hover:text-amber">
                    {event.id}
                  </Link>
                </p>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* Event history */}
      <Panel
        eyebrow="Canonical log"
        title={`Recent events involving ${inhabitant.name}`}
        aside={
          <Link href="/events" className="text-amber hover:underline">
            Search the whole log &rarr;
          </Link>
        }
      >
        <div className="divide-y divide-line-soft">
          {events.events.map((event) => (
            <CanonicalEventRow key={event.id} event={event} />
          ))}
        </div>
        {events.total > events.events.length && (
          <p className="hairline px-4 py-3 text-xs text-dim">
            Showing {events.events.length} of {events.total} canonical events involving this
            inhabitant.
          </p>
        )}
      </Panel>
    </div>
  );
}
