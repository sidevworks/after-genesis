import type { Metadata } from "next";
import Link from "next/link";
import { worldSource } from "@/lib/world-source";
import { Badge, PageHeader, Panel } from "@/components/ui";
import { formatSimTime, titleCase } from "@/lib/format";

export const metadata: Metadata = { title: "Organisations" };

export default async function OrganisationsPage() {
  const [organisations, inhabitants] = await Promise.all([
    worldSource.getOrganisations(),
    worldSource.getInhabitants(),
  ]);

  const nameOf = (id: string) => inhabitants.find((i) => i.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`${organisations.length} registered organisations`}
        title="Organisations"
        lede="Inhabitants may declare an organisation, its membership and its rules. Declaring a rule does not modify any world rule, and registering an organisation grants no authority. A rule applies only to the extent that other inhabitants recognise it, agree to it, or can be compelled to follow it."
      />

      {organisations.map((org) => (
        <Panel
          key={org.id}
          id={org.id}
          eyebrow={`${org.id} · founded ${formatSimTime(org.foundedAt)}`}
          title={org.name}
          aside={
            <span className="flex items-center gap-2">
              <Badge>{titleCase(org.kind)}</Badge>
              <Badge tone={org.status === "active" ? "alive" : "gone"}>{org.status}</Badge>
            </span>
          }
          className="scroll-mt-24"
        >
          <div className="px-4 py-3.5">
            <p className="eyebrow mb-1.5 text-claim-dim">
              Self-description — the organisation&rsquo;s own words, not a canonical fact
            </p>
            <blockquote className="claim rounded-r-sm py-2 pr-3 pl-3 text-sm leading-relaxed italic">
              &ldquo;{org.selfDescription}&rdquo;
            </blockquote>
          </div>

          <div className="hairline grid gap-px bg-line-soft lg:grid-cols-2">
            <div className="bg-panel px-4 py-3.5">
              <p className="eyebrow mb-2">Declared members</p>
              <ul className="space-y-1.5">
                {org.members.map((member) => (
                  <li key={member.id} className="text-sm">
                    <Link href={`/inhabitants/${member.id}`} className="text-ink hover:text-amber">
                      {member.name}
                    </Link>
                    <span className="mono ml-2 text-xs text-dim">
                      {member.role} · since {formatSimTime(member.since)}
                    </span>
                  </li>
                ))}
              </ul>
              {org.formerMembers.length > 0 && (
                <>
                  <p className="eyebrow mt-3 mb-1.5">Former members</p>
                  <ul className="space-y-1">
                    {org.formerMembers.map((member) => (
                      <li key={member.id} className="mono text-xs text-dim">
                        <Link href={`/inhabitants/${member.id}`} className="hover:text-amber">
                          {member.name}
                        </Link>{" "}
                        left {formatSimTime(member.leftAt)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            <div className="bg-panel px-4 py-3.5">
              <p className="eyebrow mb-2">Property and treasury</p>
              <p className="mono text-sm text-muted">
                {org.propertyStructureIds.length > 0
                  ? org.propertyStructureIds.join(", ")
                  : "No structure recorded as organisation property."}
              </p>
              <p className="mono mt-1.5 text-sm text-muted">
                {org.treasury.length > 0
                  ? org.treasury.map((t) => `${t.amount} ${t.currencySymbol}`).join(" · ")
                  : "No unit of account held."}
              </p>

              <p className="eyebrow mt-4 mb-2">
                Recognition — derived only from recorded actions
              </p>
              <dl className="space-y-1.5 text-xs">
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-alive">Acted as legitimate</dt>
                  <dd className="mono text-muted">
                    {org.recognition.recognisedByIds.map(nameOf).join(", ") || "none"}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-warn">Acted against</dt>
                  <dd className="mono text-muted">
                    {org.recognition.rejectedByIds.map(nameOf).join(", ") || "none"}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="w-28 shrink-0 text-dim">Neither</dt>
                  <dd className="mono text-dim">
                    {org.recognition.unengagedIds.map(nameOf).join(", ") || "none"}
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="hairline px-4 py-3.5">
            <p className="eyebrow mb-2 text-claim-dim">
              Declared rules — claims about what ought to happen, not world rules
            </p>
            <ol className="space-y-3">
              {org.declaredRules.map((rule) => (
                <li key={rule.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="claim">{rule.id}</Badge>
                    <span className="mono text-[0.65rem] text-dim">
                      declared {formatSimTime(rule.declaredAt)}
                    </span>
                  </div>
                  <blockquote className="claim mt-1.5 rounded-r-sm py-2 pr-3 pl-3 text-sm italic">
                    &ldquo;{rule.text}&rdquo;
                  </blockquote>
                  <p className="mono mt-1 text-[0.65rem] text-dim">
                    {rule.recognisedBy.length} recorded acceptances
                    {rule.recognisedBy.length > 0 && ` (${rule.recognisedBy.map(nameOf).join(", ")})`}
                    {" · "}
                    {rule.rejectedBy.length} recorded refusals
                    {rule.rejectedBy.length > 0 && ` (${rule.rejectedBy.map(nameOf).join(", ")})`}
                  </p>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs leading-relaxed text-dim">
              The engine stores this text verbatim and enforces none of it. Refusing to recognise a
              rule, or refusing to accept an organisation&rsquo;s currency, carries no penalty in
              the world ruleset.
            </p>
          </div>
        </Panel>
      ))}
    </div>
  );
}
