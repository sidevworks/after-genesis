import type { Metadata } from "next";
import Link from "next/link";
import { worldSource } from "@/lib/world-source";
import { Badge, PageHeader, Panel } from "@/components/ui";
import { MediaNotice } from "@/components/media-notice";
import { formatSimTime, titleCase } from "@/lib/format";

export const metadata: Metadata = { title: "Artifacts" };

export default async function ArtifactsPage() {
  const artifacts = await worldSource.getArtifacts();
  const generatedCount = artifacts.reduce((total, a) => total + a.generatedMedia.length, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`${artifacts.length} creative works · ${generatedCount} generated media items`}
        title="Artifacts"
        lede="Persistent works made by inhabitants: writing, research notes, designs, songs, reports. Excerpts are the inhabitant's own words and are shown as such. Anything produced by the media service — a summary, a spoken rendering, a dramatisation — is marked and separated, because it is not part of the world."
      />

      <div className="space-y-5">
        {artifacts.map((artifact) => (
          <Panel
            key={artifact.id}
            id={artifact.id}
            eyebrow={`${artifact.id} · ${formatSimTime(artifact.createdAt)}`}
            title={artifact.title}
            aside={
              <span className="flex flex-wrap items-center gap-2">
                <Badge>{titleCase(artifact.kind)}</Badge>
                <Badge tone={artifact.publicationStatus === "published" ? "alive" : "neutral"}>
                  {artifact.publicationStatus}
                </Badge>
              </span>
            }
            className="scroll-mt-24"
          >
            <div className="grid gap-px bg-line-soft lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <div className="bg-panel px-4 py-3.5">
                <p className="eyebrow mb-1.5">
                  Excerpt — the creator&rsquo;s own content, stored verbatim
                </p>
                <blockquote className="border-l-2 border-line pl-3 text-sm leading-relaxed text-ink">
                  {artifact.excerpt}
                </blockquote>

                {artifact.generatedMedia.length > 0 && (
                  <div className="mt-4 space-y-2">
                    {artifact.generatedMedia.map((media) => (
                      <MediaNotice key={media.id} media={media} />
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-panel px-4 py-3.5">
                <dl className="space-y-2 text-sm">
                  <div className="flex gap-3">
                    <dt className="eyebrow w-20 shrink-0 pt-0.5">Creators</dt>
                    <dd>
                      {artifact.creatorIds.map((cid, index) => (
                        <span key={cid}>
                          {index > 0 && ", "}
                          <Link href={`/inhabitants/${cid}`} className="text-ink hover:text-amber">
                            {artifact.creatorNames[index] ?? cid}
                          </Link>
                        </span>
                      ))}
                    </dd>
                  </div>
                  <div className="flex gap-3">
                    <dt className="eyebrow w-20 shrink-0 pt-0.5">Owner</dt>
                    <dd>
                      <Link
                        href={
                          artifact.ownerKind === "inhabitant"
                            ? `/inhabitants/${artifact.ownerId}`
                            : `/organisations#${artifact.ownerId}`
                        }
                        className="text-ink hover:text-amber"
                      >
                        {artifact.ownerName}
                      </Link>
                    </dd>
                  </div>
                  <div className="flex gap-3">
                    <dt className="eyebrow w-20 shrink-0 pt-0.5">Costs</dt>
                    <dd className="mono text-xs text-muted">
                      {artifact.costs.map((c) => `${c.quantity} ${c.resource}`).join(" · ")}
                    </dd>
                  </div>
                  <div className="flex gap-3">
                    <dt className="eyebrow w-20 shrink-0 pt-0.5">Creation</dt>
                    <dd className="mono text-xs">
                      <Link href={`/events#${artifact.creationEventId}`} className="text-amber hover:underline">
                        {artifact.creationEventId}
                      </Link>
                    </dd>
                  </div>
                </dl>

                <p className="eyebrow mt-4 mb-1.5">Provenance</p>
                <ol className="space-y-2">
                  {artifact.provenance.map((step) => (
                    <li key={`${step.eventId}-${step.simTime}`} className="border-l border-line pl-3">
                      <p className="mono text-[0.65rem] text-dim">
                        {formatSimTime(step.simTime)} · {step.kind}
                        {step.eventId && (
                          <>
                            {" · "}
                            <Link href={`/events#${step.eventId}`} className="hover:text-amber">
                              {step.eventId}
                            </Link>
                          </>
                        )}
                      </p>
                      <p className="canonical mt-0.5 text-xs">{step.description}</p>
                    </li>
                  ))}
                </ol>

                <p className="eyebrow mt-4 mb-1.5">Revisions</p>
                <ul className="space-y-1">
                  {artifact.revisions.map((rev) => (
                    <li key={rev.revision} className="mono text-[0.68rem] text-dim">
                      r{rev.revision} · {formatSimTime(rev.simTime)} —{" "}
                      <span className="text-muted">{rev.note}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </Panel>
        ))}
      </div>

      <p className="text-xs leading-relaxed text-dim">
        Media generation is read-only with respect to the world. A failed or fabricated audio job
        cannot alter a single canonical event, and nothing produced by the media service is ever
        perceived by an inhabitant.
      </p>
    </div>
  );
}
