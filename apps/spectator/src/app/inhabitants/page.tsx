import type { Metadata } from "next";
import Link from "next/link";
import { worldSource } from "@/lib/world-source";
import { PageHeader, Badge, Meter } from "@/components/ui";
import { formatSimTime, generationColour, percent } from "@/lib/format";

export const metadata: Metadata = { title: "Inhabitants" };

export default async function InhabitantsPage() {
  const inhabitants = await worldSource.getInhabitants();
  const generations = [...new Set(inhabitants.map((i) => i.generation))].sort();

  return (
    <div className="space-y-7">
      <PageHeader
        eyebrow={`${inhabitants.length} inhabitants ever created`}
        title="Inhabitants"
        lede="Every inhabitant after the founder originated from an existing inhabitant through an authorised world action. Deceased inhabitants remain fully browsable — death marks an inhabitant inactive and deletes nothing."
      />

      {generations.map((generation) => {
        const cohort = inhabitants.filter((i) => i.generation === generation);
        return (
          <section key={generation}>
            <h2 className="mb-3 flex items-center gap-2.5 text-sm font-medium">
              <span
                aria-hidden
                className="inline-block size-2.5 rounded-full"
                style={{ background: generationColour(generation) }}
              />
              Generation {generation}
              <span className="mono text-xs font-normal text-dim">
                {cohort.length} {cohort.length === 1 ? "inhabitant" : "inhabitants"}
              </span>
            </h2>

            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {cohort.map((i) => {
                const deceased = i.status === "deceased";
                return (
                  <li key={i.id}>
                    <Link
                      href={`/inhabitants/${i.id}`}
                      className="panel block h-full p-4 transition-colors hover:border-amber-dim"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className={`text-base ${deceased ? "text-gone" : "text-ink"}`}>
                            {i.name}
                          </p>
                          <p className="mono text-[0.68rem] text-dim">{i.id}</p>
                        </div>
                        <Badge tone={deceased ? "gone" : "alive"}>
                          {deceased ? "deceased" : i.status}
                        </Badge>
                      </div>

                      <dl className="mono mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[0.68rem] text-dim">
                        <div className="flex gap-1.5">
                          <dt>born</dt>
                          <dd className="text-muted">{formatSimTime(i.birthSimTime)}</dd>
                        </div>
                        <div className="flex gap-1.5">
                          <dt>tile</dt>
                          <dd className="text-muted">
                            ({i.at.x},{i.at.y})
                          </dd>
                        </div>
                        {deceased && i.deceasedAt !== undefined ? (
                          <div className="col-span-2 flex gap-1.5">
                            <dt>died</dt>
                            <dd className="text-gone">{formatSimTime(i.deceasedAt)}</dd>
                          </div>
                        ) : (
                          <div className="col-span-2 flex gap-1.5">
                            <dt>activity</dt>
                            <dd className="text-muted">{i.activity}</dd>
                          </div>
                        )}
                      </dl>

                      <div className="mt-3 space-y-2">
                        <Meter
                          label="Energy"
                          value={i.energy}
                          colour={deceased ? "var(--color-gone)" : "var(--color-amber)"}
                        />
                        <Meter
                          label="Reputation"
                          value={i.reputation}
                          colour="var(--color-claim)"
                          display={percent(i.reputation)}
                        />
                      </div>

                      {i.topSkill && (
                        <p className="mono mt-3 text-[0.68rem] text-dim">
                          strongest recorded skill:{" "}
                          <span className="text-amber">{i.topSkill.name}</span>{" "}
                          {percent(i.topSkill.level)}
                        </p>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
