import type { Metadata } from "next";
import Link from "next/link";
import { worldSource } from "@/lib/world-source";
import { CHARACTER_PROFILES, profileForInhabitant } from "@/lib/character-profiles";
import { assetUrl } from "@/lib/asset-url";

export const metadata: Metadata = { title: "Inhabitants" };

export default async function InhabitantsPage() {
  const inhabitants = await worldSource.getInhabitants();

  return (
    <div className="character-directory flex min-h-0 flex-col gap-3 lg:h-full">
      <section className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-baseline justify-between gap-3 border-b border-line pb-3">
          <div>
            <p className="eyebrow">Genesis character profiles</p>
            <h1 className="mt-1 text-lg font-medium tracking-tight">Meet the original ten</h1>
          </div>
          <p className="mono text-xs text-dim">click a card for recorded stats</p>
        </div>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:min-h-0 lg:flex-1 lg:grid-cols-5 lg:grid-rows-2">
          {CHARACTER_PROFILES.map((profile) => {
            const inhabitant = inhabitants.find((candidate) => profileForInhabitant(candidate)?.id === profile.id);
            const card = (
              <>
                <div className="relative aspect-[4/5] overflow-hidden bg-[#090d10] lg:h-full lg:aspect-auto">
                  <video
                    className="pointer-events-none size-full object-cover"
                    src={assetUrl(`/character-profile/${profile.file}`)}
                    autoPlay
                    loop
                    muted
                    playsInline
                    disablePictureInPicture
                    controlsList="nofullscreen nodownload noremoteplayback"
                    preload="metadata"
                    aria-label={`${profile.name} character profile video`}
                  />
                  <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 to-transparent px-3 pb-8 pt-3">
                    <h3 className="mono text-sm font-medium tracking-[0.12em] text-white">{profile.name}</h3>
                  </div>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-3 pb-3 pt-10">
                    <p className="mono text-[0.68rem] text-amber">View stats ↗</p>
                  </div>
                </div>
              </>
            );
            return (
              <li key={profile.id} className="min-h-0 overflow-hidden rounded-sm border border-line bg-panel transition-colors hover:border-amber-dim">
                <Link
                  href={`/inhabitants/${inhabitant?.id ?? profile.id}`}
                  className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber lg:h-full"
                  aria-label={`View ${profile.name} stats`}
                >
                  {card}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
