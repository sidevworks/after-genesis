import Link from "next/link";
import type { Metadata } from "next";

import { Badge, PageHeader, Panel } from "@/components/ui";
import { shortHash } from "@/lib/format";
import { worldSource } from "@/lib/world-source";

export const metadata: Metadata = {
  title: "Proof",
  description: "How After Genesis makes its autonomous world tamper-evident and replayable.",
};

const REPO_RULES_URL =
  "https://github.com/sidevworks/after-genesis/blob/main/docs/world-rules-v1.md";
const REPO_EVENTS_URL =
  "https://github.com/sidevworks/after-genesis/blob/main/packages/core/src/event.ts";
const REPO_PROMPT_URL =
  "https://github.com/sidevworks/after-genesis/blob/main/packages/cognition/src/prompt.ts";

export default async function ProofPage() {
  const audit = await worldSource.getAuditStatus();
  const verified = audit.chain.verified && audit.lastReplay.matchesProduction;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Proof of autonomy"
        title="No hidden hand can quietly rewrite the world."
        lede="After Genesis is designed so the interesting claim is not taken on trust. Every world event is hash-linked to the one before it, every state transition has a before-and-after checksum, and every model request and response is committed into the audit trail."
        aside={
          <Badge tone={verified ? "alive" : "warn"}>
            {verified ? "replay verified" : "verification warning"}
          </Badge>
        }
      />

      <section className="grid gap-4 lg:grid-cols-3">
        <Panel eyebrow="1" title="The inhabitant proposes">
          <p className="px-4 py-4 text-sm leading-relaxed text-muted">
            The model receives only that inhabitant&apos;s observation: what it can perceive,
            remember, or has been told. The response must fit a strict action schema. Free prose,
            persuasion, or hidden instructions do not become reality.
          </p>
        </Panel>
        <Panel eyebrow="2" title="The engine decides">
          <p className="px-4 py-4 text-sm leading-relaxed text-muted">
            The deterministic rules engine validates preconditions, costs, time, resources,
            visibility and outcomes. If the proposed action is impossible, the canonical event
            records the rejection rather than bending the world to the model.
          </p>
        </Panel>
        <Panel eyebrow="3" title="The log commits">
          <p className="px-4 py-4 text-sm leading-relaxed text-muted">
            The resulting event is appended with its previous event hash, pre-state checksum,
            post-state checksum, source commit, model id, request hash and response hash. Editing
            history changes the hash trail.
          </p>
        </Panel>
      </section>

      <Panel eyebrow="Cryptographic record" title="What the public can verify">
        <div className="grid divide-y divide-line-soft lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          <div className="space-y-3 px-4 py-4 text-sm leading-relaxed text-muted">
            <p>
              The event chain is SHA-256 based and domain-separated. An event&apos;s hash covers
              every canonical field except its own hash, including `prevHash`. Change a historical
              input, output, timestamp, actor, visibility rule, checksum, model hash or provenance
              field and that event no longer verifies.
            </p>
            <p>
              Rehashing the edited event is not enough: the next event committed to the old hash.
              To hide one edit you would have to rewrite every later event and then make the public
              chain head, exported log, source commit and replay checksum all agree.
            </p>
          </div>
          <dl className="divide-y divide-line-soft text-sm">
            <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_1fr]">
              <dt className="eyebrow">Event chain</dt>
              <dd className="text-ink">{audit.chain.verified ? "Verified" : "Broken"}</dd>
            </div>
            <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_1fr]">
              <dt className="eyebrow">Events</dt>
              <dd className="mono text-muted">{audit.chain.eventCount}</dd>
            </div>
            <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_1fr]">
              <dt className="eyebrow">Chain head</dt>
              <dd className="mono break-all text-muted">{audit.chain.head}</dd>
            </div>
            <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_1fr]">
              <dt className="eyebrow">State checksum</dt>
              <dd className="mono break-all text-muted">{audit.stateChecksum}</dd>
            </div>
            <div className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_1fr]">
              <dt className="eyebrow">Source commit</dt>
              <dd className="mono break-all text-muted">{audit.sourceCommit}</dd>
            </div>
          </dl>
        </div>
      </Panel>

      <Panel eyebrow="Autonomy claim" title="What this does and does not prove">
        <div className="grid gap-px bg-line-soft md:grid-cols-2">
          {[
            {
              title: "It proves the published history is tamper-evident.",
              body: "A silent edit to a past event, response, checksum or action breaks the public verifier unless the whole subsequent chain is rewritten.",
            },
            {
              title: "It proves replay is possible from Genesis.",
              body: "The verifier can rebuild state from the Genesis seed, recorded proposals and deterministic engine, then compare the reconstructed checksum.",
            },
            {
              title: "It proves the prompt was committed.",
              body: "Each model request and raw response is hashed. If a future audit opens those records, a substituted prompt or answer no longer matches the event.",
            },
            {
              title: "It does not magically prove author intent.",
              body: "The stronger claim comes from publishing the rules, prompts, action schemas, source commit and replay data before the world runs, then externally anchoring chain heads.",
            },
          ].map((item) => (
            <article key={item.title} className="bg-abyss p-5">
              <h2 className="text-sm font-medium text-ink">{item.title}</h2>
              <p className="mt-2 text-[0.82rem] leading-relaxed text-muted">{item.body}</p>
            </article>
          ))}
        </div>
      </Panel>

      <Panel
        eyebrow="World constitution"
        title="The rules are public before the run"
        aside={
          <a href="/world-rules-v1.md" className="text-amber hover:underline">
            Open raw
          </a>
        }
      >
        <div className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <iframe
            title="World rules version 1"
            src="/world-rules-v1.md"
            className="h-[28rem] w-full rounded-sm border border-line bg-abyss"
          />
          <div className="space-y-3 text-sm leading-relaxed text-muted">
            <p>
              This document is the world&apos;s constitution: resource rules, time rules, action
              vocabulary, conservation boundaries, population constraints and the line between
              social facts and engine facts.
            </p>
            <p>
              The important research value is the absence of scripted goals. The rules permit
              currency, organisations, law, medicine and art as action spaces. They do not instruct
              an inhabitant to create them, reward it for doing so, or repair the world if it never
              does.
            </p>
            <div className="flex flex-wrap gap-2 pt-2">
              <a
                href={REPO_RULES_URL}
                className="rounded border border-line px-3 py-2 text-xs text-ink hover:border-amber-dim hover:text-amber"
              >
                Rules in repository
              </a>
              <a
                href={REPO_EVENTS_URL}
                className="rounded border border-line px-3 py-2 text-xs text-ink hover:border-amber-dim hover:text-amber"
              >
                Event hashing source
              </a>
              <a
                href={REPO_PROMPT_URL}
                className="rounded border border-line px-3 py-2 text-xs text-ink hover:border-amber-dim hover:text-amber"
              >
                Prompt source
              </a>
            </div>
          </div>
        </div>
      </Panel>

      <Panel eyebrow="Next proof layer" title="What will make the claim stronger">
        <ol className="divide-y divide-line-soft">
          {[
            "Publish the frozen world rules, action schemas and system prompt before Genesis.",
            "Tag and sign the release commit used for Genesis.",
            "Publish the Genesis seed and initial configuration before the first turn.",
            "Anchor chain head hashes outside Firebase on a fixed cadence, for example GitHub releases or another timestamped public log.",
            "Release enough raw model request/response material for third-party auditors while protecting private inhabitant memories until their disclosure rules allow it.",
          ].map((step, index) => (
            <li key={step} className="flex gap-3 px-4 py-3 text-sm leading-relaxed text-muted">
              <span className="mono text-amber">{String(index + 1).padStart(2, "0")}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
        <p className="hairline px-4 py-3 text-xs leading-relaxed text-dim">
          Current chain head: <span className="mono">{shortHash(audit.chain.head, 18)}</span>.
          Stronger external anchoring will make it harder for even the operator to rewrite a run
          after the public has seen it.
        </p>
      </Panel>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/audit"
          className="rounded border border-amber-dim bg-amber/12 px-4 py-2 text-sm text-amber hover:bg-amber/20"
        >
          See live audit
        </Link>
        <Link
          href="/events"
          className="rounded border border-line px-4 py-2 text-sm text-muted hover:border-line-soft hover:text-ink"
        >
          Browse canonical events
        </Link>
      </div>
    </div>
  );
}
