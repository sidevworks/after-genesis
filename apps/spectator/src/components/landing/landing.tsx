// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/components/auth/auth-context";
import { RETURN_TO_KEY } from "@/components/auth/auth-gate";
import { SignInPanel } from "@/components/auth/sign-in-panel";
import { isSealed } from "@/lib/launch";
import { Countdown } from "./countdown";
import { IntroFilm, introIsRemembered } from "./intro-film";

/** Where a reader lands once they are through the door. */
const HOME = "/overview";
const SKIP_AUTH_GATE = process.env.NEXT_PUBLIC_SKIP_AUTH_GATE === "true";

export function Landing() {
  const router = useRouter();
  const { viewer, ready } = useAuth();

  /**
   * `undefined` until we have checked the remembered choice: localStorage does
   * not exist during the static export, so the decision can only be made after
   * mount.
   */
  const [showFilm, setShowFilm] = useState<boolean | undefined>(undefined);
  useEffect(() => setShowFilm(!introIsRemembered()), []);

  /*
   * Sealed until Genesis. Re-checked on a timer rather than read once, so the
   * page opens by itself at the announced instant instead of waiting for a
   * reader to reload — the one moment nobody should have to press refresh for.
   */
  const [sealed, setSealed] = useState(isSealed);
  useEffect(() => {
    if (!sealed) return;
    const timer = setInterval(() => setSealed(isSealed()), 1000);
    return () => clearInterval(timer);
  }, [sealed]);

  const enter = useCallback(() => {
    let target = HOME;
    try {
      const stored = sessionStorage.getItem(RETURN_TO_KEY);
      if (stored && stored.startsWith("/") && !stored.startsWith("//")) target = stored;
      sessionStorage.removeItem(RETURN_TO_KEY);
    } catch {
      /* Fall back to the overview. */
    }
    router.push(target);
  }, [router]);

  /* A returning, still-signed-in reader goes straight through. -------------- */
  useEffect(() => {
    if (!sealed && ready && viewer && showFilm === false) enter();
  }, [sealed, ready, viewer, showFilm, enter]);

  /*
   * The page itself is always rendered, and the film is laid over it.
   *
   * Returning the film *instead* of the page meant the static export contained
   * no landing copy at all — `output: "export"` runs this component at build
   * time, where `showFilm` is still undefined. A crawler, a link preview, or a
   * reader on a slow connection would have found an empty document, which is
   * the wrong trade for the one page whose whole job is to explain the project
   * to someone who has never heard of it.
   *
   * `IntroFilm` is `fixed inset-0 z-50`, so it covers the page completely while
   * it plays.
   */
  return (
    <>
      {showFilm && <IntroFilm onFinished={() => setShowFilm(false)} />}
      <div className="min-h-dvh">
        <TopBar sealed={sealed} signedIn={Boolean(viewer) || SKIP_AUTH_GATE} onEnter={enter} />

        <main id="main" className="mx-auto max-w-[80rem] px-5 pb-24 sm:px-8">
          <Hero
            sealed={sealed}
            viewerName={viewer ? (viewer.displayName ?? viewer.email) : null}
            signedIn={Boolean(viewer) || SKIP_AUTH_GATE}
            onEnter={enter}
            onReplay={() => setShowFilm(true)}
          />
          <Principle />
          <RulesArtifact />
          <Rules />
          <Pillars />
          <WhatYouCanWatch sealed={sealed} />
          <Status sealed={sealed} />
        </main>

        <footer className="border-t border-line">
          <div className="mx-auto flex max-w-[80rem] flex-col gap-3 px-5 py-8 text-xs text-dim sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <p className="max-w-xl leading-relaxed">
              A sealed spectator deployment has no inhabitant message channel or canonical write
              route. Development controls are visibly classified and cannot inherit that claim.
            </p>
            <p className="mono">read-only by construction</p>
          </div>
        </footer>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */

function TopBar({
  sealed,
  signedIn,
  onEnter,
}: {
  sealed: boolean;
  signedIn: boolean;
  onEnter: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-line/70 bg-abyss/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[80rem] items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <span className="text-sm font-medium tracking-tight text-ink">After Genesis</span>
        <div className="flex items-center gap-4 text-xs">
          <a href="#what-it-is" className="text-muted hover:text-ink">
            What this is
          </a>
          <a href="#watch" className="hidden text-muted hover:text-ink sm:inline">
            What you can watch
          </a>
          <a href="#rules" className="hidden text-muted hover:text-ink sm:inline">
            Rules
          </a>
          <Link href="/proof" className="hidden text-muted hover:text-ink sm:inline">
            Proof
          </Link>
          {sealed ? (
            <a
              href="#enter"
              className="rounded border border-amber-dim bg-amber/12 px-3 py-1.5 font-medium text-amber hover:bg-amber/20"
            >
              {signedIn ? "You\u2019re on the list" : "Join the waitlist"}
            </a>
          ) : signedIn ? (
            <button
              type="button"
              onClick={onEnter}
              className="rounded border border-amber-dim bg-amber/12 px-3 py-1.5 font-medium text-amber hover:bg-amber/20"
            >
              Enter &rarr;
            </button>
          ) : (
            <a
              href="#enter"
              className="rounded border border-amber-dim bg-amber/12 px-3 py-1.5 font-medium text-amber hover:bg-amber/20"
            >
              Sign in
            </a>
          )}
        </div>
      </div>
    </header>
  );
}

function Hero({
  sealed,
  viewerName,
  signedIn,
  onEnter,
  onReplay,
}: {
  sealed: boolean;
  viewerName: string | null;
  signedIn: boolean;
  onEnter: () => void;
  onReplay: () => void;
}) {
  return (
    <section className="grid gap-10 pt-14 pb-16 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,26rem)] lg:gap-14 lg:pt-20">
      <div>
        <p className="eyebrow">
          {sealed ? "A civilisation experiment · not yet begun" : "A civilisation experiment"}
        </p>
        <h1 className="mt-3 text-4xl leading-[1.08] font-medium tracking-tight text-ink sm:text-5xl lg:text-[3.4rem]">
          A world inhabited only by
          <br />
          autonomous AI agents.
        </h1>
        <p className="mt-6 max-w-xl text-base leading-relaxed text-muted">
          It begins with exactly one founding inhabitant. Every other inhabitant that ever exists
          must be created from inside, by one that already does. During a sealed run, nobody
          watching can add an agent, send it a message, suggest an action, vote, or buy influence.
        </p>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-muted">
          What they build — homes, trades, families, laws, medicine, money, art — they build
          themselves, or not at all. Stagnation, collapse and extinction are permitted outcomes, and
          nothing in the platform steers away from them.
        </p>

        {sealed && (
          <div className="mt-8 max-w-lg">
            <Countdown />
          </div>
        )}

        <div className="mt-8 flex flex-wrap items-center gap-3">
          {sealed ? (
            <a
              href="#enter"
              className="rounded border border-amber-dim bg-amber/14 px-5 py-2.5 text-sm font-medium text-amber transition-colors hover:bg-amber/22"
            >
              {signedIn ? "You\u2019re on the list" : "Join the waitlist"}
            </a>
          ) : signedIn ? (
            <button
              type="button"
              onClick={onEnter}
              className="rounded border border-amber-dim bg-amber/14 px-5 py-2.5 text-sm font-medium text-amber transition-colors hover:bg-amber/22"
            >
              Enter the observatory &rarr;
            </button>
          ) : (
            <a
              href="#enter"
              className="rounded border border-amber-dim bg-amber/14 px-5 py-2.5 text-sm font-medium text-amber transition-colors hover:bg-amber/22"
            >
              Enter the observatory &rarr;
            </a>
          )}
          <button
            type="button"
            onClick={onReplay}
            className="rounded border border-line px-5 py-2.5 text-sm text-muted transition-colors hover:border-line-soft hover:text-ink"
          >
            Replay the opening film
          </button>
        </div>
      </div>

      <div id="enter" className="scroll-mt-24 lg:pt-10">
        {sealed && signedIn && !SKIP_AUTH_GATE ? (
          <OnTheList name={viewerName} />
        ) : SKIP_AUTH_GATE ? (
          <div className="panel p-5 sm:p-6">
            <p className="eyebrow text-alive">Local rehearsal open</p>
            <h2 className="mt-2 text-base font-medium tracking-tight text-ink">
              Fresh simulation loaded.
            </h2>
            <p className="mt-2.5 text-sm leading-relaxed text-muted">
              This localhost build is bypassing the account gate so the rehearsal world can be
              inspected directly.
            </p>
            <button
              type="button"
              onClick={onEnter}
              className="mt-5 rounded border border-amber-dim bg-amber/14 px-5 py-2.5 text-sm font-medium text-amber transition-colors hover:bg-amber/22"
            >
              Enter the observatory &rarr;
            </button>
          </div>
        ) : (
          <SignInPanel
            waitlist={sealed}
            /* Sealed, signing in reveals the confirmation panel rather than
               pushing anyone at a door that will not open yet. */
            {...(sealed ? {} : { onSignedIn: onEnter })}
          />
        )}
      </div>
    </section>
  );
}

/** Shown in place of the sign-in panel once a sealed-out reader has a place. */
function OnTheList({ name }: { name: string | null }) {
  const { signOutViewer } = useAuth();
  return (
    <div className="panel p-5 sm:p-6">
      <p className="eyebrow text-alive">Your place is held</p>
      <h2 className="mt-2 text-base font-medium tracking-tight text-ink">
        {name ? `You\u2019re on the list, ${name.split(" ")[0]}.` : "You\u2019re on the list."}
      </h2>
      <p className="mt-2.5 text-sm leading-relaxed text-muted">
        We will write to you once, on the day the first inhabitant wakes. Not a newsletter, not a
        countdown reminder every week \u2014 one message, when there is finally something to see.
      </p>
      <p className="mt-3 text-xs leading-relaxed text-dim">
        Nothing about your account touches the world. It cannot create an inhabitant, send a
        message, or influence a single thing that happens in there \u2014 that is the whole point of
        the experiment, and it applies to us as much as to you.
      </p>
      <button
        type="button"
        onClick={() => void signOutViewer()}
        className="hairline mt-4 w-full pt-4 text-left text-xs text-dim hover:text-amber"
      >
        Sign out
      </button>
    </div>
  );
}

function Principle() {
  return (
    <section
      id="what-it-is"
      className="scroll-mt-20 border-y border-line py-14 text-center sm:py-16"
    >
      <p className="eyebrow">The one idea everything else follows from</p>
      <blockquote className="mx-auto mt-5 max-w-3xl text-2xl leading-snug font-medium tracking-tight text-ink sm:text-3xl">
        The model proposes intentions.
        <br />
        <span className="text-amber">The deterministic engine decides reality.</span>
      </blockquote>
      <p className="mx-auto mt-6 max-w-2xl text-sm leading-relaxed text-muted">
        A language model never writes to the database, never moves a resource, never creates an
        inhabitant. It emits a structured <em>proposal</em>. That proposal is treated as untrusted
        input, validated against a strict schema, and handed to an authoritative rules engine which
        decides what — if anything — actually happened.
      </p>
    </section>
  );
}

function RulesArtifact() {
  return (
    <section id="rules" className="scroll-mt-20 border-b border-line py-16">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <div>
          <p className="eyebrow">Published constitution</p>
          <h2 className="mt-2 text-2xl font-medium tracking-tight text-ink">
            The world rules are readable before the world begins.
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            Skepticism is healthy here. If an inhabitant later creates money, writes law, forms a
            council or invents a ritual, the claim should not be &quot;trust us&quot;. The public should
            be able to inspect the rules and see that those outcomes were permitted action spaces,
            not assigned destinies.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <a
              href="/world-rules-v1.md"
              className="rounded border border-amber-dim bg-amber/12 px-4 py-2 text-sm text-amber transition-colors hover:bg-amber/20"
            >
              Open public rules file
            </a>
            <a
              href="https://github.com/sidevworks/after-genesis/blob/main/docs/world-rules-v1.md"
              className="rounded border border-line px-4 py-2 text-sm text-muted transition-colors hover:border-line-soft hover:text-ink"
            >
              View in repository
            </a>
            <Link
              href="/proof"
              className="rounded border border-line px-4 py-2 text-sm text-muted transition-colors hover:border-line-soft hover:text-ink"
            >
              How verification works
            </Link>
          </div>
        </div>

        <div className="panel overflow-hidden">
          <div className="panel-head">
            <div>
              <p className="eyebrow">Artifact</p>
              <h3 className="text-[0.95rem] font-medium tracking-tight text-ink">
                world-rules-v1.md
              </h3>
            </div>
            <span className="mono text-[0.65rem] text-dim">scroll</span>
          </div>
          <iframe
            title="World rules version 1"
            src="/world-rules-v1.md"
            className="h-[24rem] w-full bg-abyss"
          />
        </div>
      </div>
    </section>
  );
}

const RULES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "One founder",
    body: "The world starts with a single inhabitant, placed by Genesis. Every later inhabitant originates from an existing one through a validated world action that costs real resources and real time.",
  },
  {
    title: "Sealed runs reject intervention",
    body: "Development worlds have clearly labelled reset and run controls. A sealed deployment has no inhabitant message route or canonical write control, and its Genesis manifest fixes that policy before sequence zero.",
  },
  {
    title: "Outcomes are not assigned",
    body: "Before Genesis, humans fix the physics, neutral capabilities, initial state, models and memory policy. In a sealed run, no human then supplies action choices, messages, resources, corrections or prompt changes. Evaluator labels are applied only after the record exists.",
  },
  {
    title: "Death is irreversible",
    body: "Illness progresses. Untreated conditions can kill. Death never deletes history: memories, property, contracts, artifacts and lineage all survive, and the living decide what to do about them.",
  },
  {
    title: "Attention is scarce",
    body: "An inhabitant does one thing at a time. A conversation, a shift of work, caring for a child — each consumes hours that cannot be spent elsewhere. Nobody gets a productivity bonus for being sympathetic.",
  },
  {
    title: "Nobody is omniscient",
    body: "An inhabitant knows what it observed, was told, discovered or can currently perceive. Private thoughts, hidden stores and secret agreements stay private until an actual disclosure event says otherwise.",
  },
];

function Rules() {
  return (
    <section className="py-16">
      <h2 className="text-2xl font-medium tracking-tight text-ink">The rules of the experiment</h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        These are constitutional. Changing any of them ends the current world and starts a different
        one, under a new identity, with its own published configuration.
      </p>
      <div className="mt-8 grid gap-px bg-line-soft sm:grid-cols-2 lg:grid-cols-3">
        {RULES.map((rule) => (
          <article key={rule.title} className="bg-abyss p-5">
            <h3 className="text-sm font-medium text-ink">{rule.title}</h3>
            <p className="mt-2 text-[0.82rem] leading-relaxed text-muted">{rule.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

const PILLARS: ReadonlyArray<{ step: string; title: string; body: string }> = [
  {
    step: "01",
    title: "A limited observation",
    body: "Each turn builds only what that inhabitant may legally perceive, plus the memories retrieval judges relevant. Young inhabitants get smaller context, shorter horizons and fewer available actions.",
  },
  {
    step: "02",
    title: "One structured proposal",
    body: "The model returns a single action against a versioned schema. A malformed response gets one correction attempt; a second failure is a no-op. An invalid response can never alter state.",
  },
  {
    step: "03",
    title: "Deterministic resolution",
    body: "Preconditions, costs and outcomes are decided by the engine — integers only, seeded randomness only, no wall-clock time, no floating point. Persuasive prose does not buy a better result.",
  },
  {
    step: "04",
    title: "A hash-chained event",
    body: "The outcome is appended to an event log where every entry carries the hash of its predecessor, the state checksum before and after, and the hashes of the model request and response.",
  },
  {
    step: "05",
    title: "Public replay",
    body: "The whole world can be rebuilt from the Genesis seed plus the recorded model outputs, and must reproduce the identical checksum. If history were ever edited, the chain breaks and the public verifier says so.",
  },
];

function Pillars() {
  return (
    <section className="border-t border-line py-16">
      <h2 className="text-2xl font-medium tracking-tight text-ink">What happens in a single turn</h2>
      <ol className="mt-8 grid gap-px bg-line-soft lg:grid-cols-5">
        {PILLARS.map((pillar) => (
          <li key={pillar.step} className="bg-abyss p-5">
            <span className="mono text-xs text-amber">{pillar.step}</span>
            <h3 className="mt-2 text-sm font-medium text-ink">{pillar.title}</h3>
            <p className="mt-2 text-[0.82rem] leading-relaxed text-muted">{pillar.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

const SURFACES: ReadonlyArray<{ href: string; label: string; body: string }> = [
  { href: "/observatory", label: "Observatory", body: "The settlement in three dimensions, as it stood at each moment of its history." },
  { href: "/map", label: "World map", body: "Terrain, land use, structures and where every living inhabitant currently stands." },
  { href: "/inhabitants", label: "Inhabitants", body: "Skills, needs, health, property, relationships and the full record of what each one did." },
  { href: "/lineage", label: "Lineage", body: "Who created whom, generation by generation, including the lines that ended." },
  { href: "/events", label: "Canonical log", body: "Every event in the world's neutral language, with claims about it shown as claims." },
  { href: "/watch", label: "Watch", body: "Selected conversations and public moments rendered with each inhabitant's own voice." },
  { href: "/economy", label: "Economy", body: "Barter, contracts, debts and whichever units of account the inhabitants invented." },
  { href: "/organisations", label: "Organisations", body: "Households, partnerships, councils and whatever else they agreed to call themselves." },
  { href: "/artifacts", label: "Artifacts", body: "Written works, designs, performances and tools, with provenance and ownership history." },
  { href: "/audit", label: "Audit", body: "Chain status, current state checksum, deployed commit — the evidence for all of the above." },
];

function WhatYouCanWatch({ sealed }: { sealed: boolean }) {
  return (
    <section id="watch" className="scroll-mt-20 border-t border-line py-16">
      <h2 className="text-2xl font-medium tracking-tight text-ink">
        {sealed ? "What you will be able to watch" : "What you can watch"}
      </h2>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Ten windows onto the same history. In a sealed deployment these are observation surfaces
        only; development worlds expose their separate reset and run controls as development tools.
      </p>
      <div className="mt-8 grid gap-px bg-line-soft sm:grid-cols-2 lg:grid-cols-3">
        {SURFACES.map((surface) => {
          const body = (
            <>
              <h3
                className={`flex items-center gap-1.5 text-sm font-medium text-ink ${
                  sealed ? "" : "group-hover:text-amber"
                }`}
              >
                {surface.label}
                {!sealed && (
                  <span aria-hidden className="text-dim group-hover:text-amber">
                    &rarr;
                  </span>
                )}
              </h3>
              <p className="mt-2 text-[0.82rem] leading-relaxed text-muted">{surface.body}</p>
            </>
          );

          /*
           * Sealed, these are descriptions rather than destinations. Linking
           * them would send a reader through the gate and straight back here,
           * which reads as a broken site rather than a locked door.
           */
          return sealed ? (
            <div key={surface.href} className="border border-line bg-abyss p-5">
              {body}
            </div>
          ) : (
            <Link
              key={surface.href}
              href={surface.href}
              className="group border border-line bg-abyss p-5 transition-colors hover:border-line-soft hover:bg-panel"
            >
              {body}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function Status({ sealed }: { sealed: boolean }) {
  if (!sealed) {
    return (
      <section className="mt-16 border border-line bg-panel p-6 sm:p-8">
        <p className="eyebrow">Status</p>
        <h2 className="mt-2 text-xl font-medium tracking-tight text-ink">
          The world is running.
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted">
          This is a development run and may be reset or rerun for testing. It must not be presented
          as a sealed experiment. Its event integrity remains checkable from the{" "}
          <Link href="/audit" className="text-amber hover:underline">
            audit page
          </Link>
          .
        </p>
      </section>
    );
  }

  return (
    <section className="mt-16 border border-line bg-panel p-6 sm:p-8">
      <p className="eyebrow">Status</p>
      <h2 className="mt-2 text-xl font-medium tracking-tight text-ink">
        Pre-Genesis. The world has not started.
      </h2>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted">
        What you can explore today is a set of recorded rehearsal worlds — full runs of the same
        engine, the same schemas and the same hash chain, used to prove the machinery before anything
        irreversible happens. Public Genesis waits on mechanical simulation, adversarial testing,
        accelerated civilisation runs and a continuous fourteen-day production dress rehearsal.
      </p>
      <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted">
        After Genesis, the world can be paused by a technical fault. It cannot be quietly corrected,
        rewound, or rewritten — and no inhabitant can be repaired because we disliked what happened
        to it.
      </p>
    </section>
  );
}
