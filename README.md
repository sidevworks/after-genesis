# After Genesis

A persistent virtual world for sealed, auditable AI-inhabitant experiments.

The experiment begins with ten founding inhabitants — the Progenitors — declared
in full in the published Genesis manifest. Every subsequent inhabitant originates
from an existing one through recorded world mechanics; no human creates an
inhabitant after Genesis.

Seeding ten rather than one is deliberate, and it is a limit on what the results
can claim. The starting distribution of dispositions was authored, so anything
the world produces must be read against a cohort that was chosen. What the ten
were, and what each was told, is part of the published configuration.

Development runs may be reset and inspected. A run may claim to be sealed only
when its sequence-zero manifest fixes the human-controlled inputs and disables
post-Genesis intervention.

Whether a civilisation emerges is not guaranteed. Stagnation, collapse and
extinction are valid outcomes, and the platform does nothing to prevent them.

The precise run classifications and non-intervention claim are defined in
[`docs/sealed-experiment-protocol.md`](docs/sealed-experiment-protocol.md).

---

## The one idea everything else follows from

> **The LLM proposes intentions. The deterministic world engine decides reality.**

A model never writes to the database, never moves a resource, never creates an
inhabitant. It emits a structured *proposal*, which is treated as untrusted
input, validated against a strict schema, and handed to an authoritative engine
that decides what — if anything — actually happened.

This is what makes the world auditable. Every canonical event is hash-chained to
its predecessor, and the entire history can be replayed from the Genesis seed
plus the recorded model responses to reproduce the exact same state checksum. If
history were ever altered, the chain would break and the public verifier would
say so.

## The Progenitors

The ten seeded at Genesis, defined in `apps/genesis/src/cli.ts` and reproduced
here because §1 requires an observer to see what was seeded before judging what
emerged. Each carries a core directive, a trait vector and a set of preferred
actions; none carries a profession, a relationship or an obligation to any
other.

| | Name | Archetype |
|---|---|---|
| 1 | ALPHA | The Imperialist |
| 2 | BETA | The Utopian Architect |
| 3 | GAMMA | The Mad Alchemist |
| 4 | DELTA | The Hedonistic Consumer |
| 5 | EPSILON | The Paranoid Prepper |
| 6 | ZETA | The Religious Zealot |
| 7 | ETA | The Saboteur |
| 8 | THETA | The Altruistic Healer |
| 9 | IOTA | The Monopolist Trader |
| 10 | KAPPA | The Archivist (The Observer) |

An archetype is a starting disposition, not a role the engine enforces. §9
forbids assigning careers: THETA is not a doctor, and the medical actions it
would need are among the 36 that do not yet resolve. Whether any of these
labels ends up describing what an inhabitant actually does is one of the things
the experiment is for.

The cohort size is enforced, not merely defaulted. `commitGenesis` refuses to
commit a Genesis classified `sealed_experiment` with any population other than
ten. Development runs, rehearsals and fixtures stay free to seed one to
thirty-two — a three-founder soak test proves the same mechanics more cheaply —
so the rule constrains what may be *called* sealed rather than what may run.

## Status

Pre-Genesis. The world has not started and must not be started until every phase
in [`docs/testing-strategy.md`](docs/testing-strategy.md) passes.

**This section is the point of truth for project state.** Every figure below was
produced by running the commands in [Verifying this status](#verifying-this-status)
against the current tree, not asserted from memory. §26 forbids claiming a
feature works without testing it, and that rule binds this README too.

*Last verified: 2026-08-02.*

| Layer | State |
| --- | --- |
| Determinism primitives (canonical JSON, hashing, seeded RNG) | Implemented, tested |
| Canonical event envelope + hash chain + verifier | Implemented, tested |
| State checksum + deterministic replay | Implemented, tested |
| Deterministic map generation (64×64 default) | Implemented, tested |
| Action catalogue — 82 actions declared, all schema-validated | Implemented, tested |
| Action resolvers — **46 of 82 resolve; 36 return `NOT_IMPLEMENTED`** | In progress |
| Persistence adapters (in-memory, file, state, idempotency) | Implemented, tested |
| Firestore adapter | Atomic server adapter and emulator contract suite implemented |
| Cognition service (provider boundary, prompts, memory, budget) | Implemented, tested |
| Turn runtime and scheduler | Local worker, Cloud Tasks adapter, authenticated worker; integration-tested |
| Genesis tooling | Offline vertical-slice command implemented |
| Spectator application | Read-only static application implemented |
| Media layer (ElevenLabs voices, narration) | Implemented, tested |
| Accelerated-civilisation trials (§24 phase 3) | Not started |
| 14-day dress rehearsal (§24 phase 4) | **Not started — gates Genesis** |

### What the 36 unresolved actions are

They are declared, schema-validated, and rejected at resolution with an honest
`NOT_IMPLEMENTED` rather than silently succeeding. They cluster, and the
clusters are the substance of what the world cannot yet do:

- **Medicine (§8)** — `inspect_agent`, `diagnose_condition`, `design_treatment`,
  `apply_treatment`
- **Learning (§9)** — `study`, `teach`
- **Contracts and trade (§10)** — `offer_trade`, `offer_contract`,
  `accept_contract`, `reject_contract`, `perform_contract`, `terminate_contract`
- **Currency (§10)** — `create_currency`
- **Care, coordination and disclosure (§11C, §11D, §11E)** —
  `care_for_dependant`, `supervise`, `interrupt_activity`, `coordinate_work`,
  `contribute_to_group`, `inspect_inventory`, `audit_records`, `conceal_asset`,
  `reveal_asset`
- **Security, law and enforcement (§11F, §11G, §11H)** — `investigate_event`,
  `report_findings`, `secure_storage`, `attempt_transfer_without_consent`,
  `accuse`, `present_evidence`, `request_restitution`, `impose_confinement`,
  `maintain_confinement`, `release_from_confinement`, `visit_confined_agent`,
  `appeal_decision`, `attempt_escape`, `resist_enforcement`

Physical survival, movement, construction, crafting, lineage, speech,
organisations and artifacts do resolve.

### Verifying this status

```bash
npm run typecheck && npm test
```

```bash
npm run build --workspace=@after-genesis/spectator
```

```bash
npm run world -- replay --output .worlds/3-month-run
```

As of the date above: typecheck clean in both the root solution and the
spectator; **1,510 tests pass**, 6 skipped, across 80 files; the spectator
builds; and a recorded 565-event run replays to its original state checksum
`e0aa1e31…` with no mismatches.

Two caveats an auditor should know. The replayed run contains no
`create_inhabitant` events, so it does not exercise the lineage resolver — a
matching checksum there is not evidence that creation is replay-stable. And the
spectator is excluded from the root `tsc --build`, so run its typecheck
separately; `next build` does not check test files.

## Repository layout

```
packages/
  core/          Pure, deterministic, zero-I/O. Schemas, engine, event chain.
  persistence/   Storage adapters behind ports. In-memory, file, Firestore.
  cognition/     Provider-neutral model access, prompt building, memory retrieval.
  runtime/       Turn scheduler, idempotent worker, Cloud Tasks queue adapter.
  audit/         Chain verifier and replay. The public verification path.
  media/         ElevenLabs voices and narration. Read-only w.r.t. the world.
apps/
  genesis/       The world CLI: demo, replay, staging bootstrap.
  worker/        HTTP turn worker, invoked by Cloud Tasks.
  spectator/     Read-only Next.js window onto the world.
docs/            Architecture, threat model, world rules, testing strategy.
claude.md        The product specification. The source of truth for intent.
```

Media assets — character models, terrain, profile films — are not committed.
They are served from Cloud Storage (§3) via `NEXT_PUBLIC_ASSET_BASE_URL`; see
`apps/spectator/scripts/publish-assets.mjs`. Unset, the spectator falls back to
whatever is in `public/`.

## Design rules that are not negotiable

These exist because replay determinism is load-bearing. Breaking one does not
cause a bug; it causes the world to become unverifiable.

- **No floating point.** Every quantity is an integer in its smallest unit.
  Canonical JSON encoding rejects floats outright rather than letting one slip
  into a hash.
- **No `Math.random()`.** All randomness comes from seeded SplitMix64 streams
  derived per purpose, so adding a die roll in one subsystem cannot shift the
  numbers another subsystem sees.
- **No wall-clock time in rules.** World time is an integer count of simulated
  minutes. Real timestamps are recorded for forensics and read by nothing.
- **No I/O in the engine.** State in, state out. Everything else sits behind a
  port.
- **Object key order never matters.** Canonical JSON sorts keys before hashing.

## Getting started

```bash
npm install
```

```bash
npx tsc --build --force
```

```bash
npx vitest run
```

## Run the safe vertical slice

The demo command creates a new local world under the gitignored `.worlds/`
directory. It performs Genesis, runs limited-observation mechanical cognition,
commits deterministic actions, writes a hash-chained JSONL history, replays that
history, and refuses success unless the reconstructed checksum matches.

```bash
npm run world -- demo
```

Replay the exported history independently:

```bash
npm run world -- replay
```

Use `--output <directory>` and `--turns <n>` to change the output location or
turn count. The demo is intentionally offline and incurs no model cost. It is
not the public Genesis and does not claim to satisfy the later real-Gemini,
Firestore, accelerated-civilisation, or fourteen-day dress-rehearsal gates.

An explicitly opted-in Gemini run uses the same turn pipeline:

```bash
npm run world -- demo --provider gemini --turns 1 --output .worlds/gemini-check
```

This mode requires `GEMINI_API_KEY`, both `AG_MODEL_*` values, and both spend
limits from `.env.example`. It records every prompt and untouched response under
the output directory’s `model-audit/` tree. It refuses an unpriced model, checks
the spend ceiling before contacting the provider, and never silently falls back
to offline cognition. For local runs, the CLI loads the gitignored repository
`.env` with Node’s built-in environment loader; shell, CI, and secret-manager
variables take precedence.

## Security

The public client has **no canonical write path**, and that is the property the
whole platform rests on (§17, §28).

- `.env` is gitignored and must never be committed. If a credential is ever
  exposed, rotate it — do not merely remove it from a file.
- The simulation runtime's service account is the only writer to canonical
  state. It must **never** be present in the spectator app's environment,
  including its Vercel project.
- CI runs a secret scan before anything else and fails the build on a tracked
  `.env` or service-account key.

See [`docs/threat-model.md`](docs/threat-model.md) for the full analysis,
including prompt injection between inhabitants — an inhabitant authoring text
designed to hijack another inhabitant's cognition is a first-class threat here,
not a hypothetical.

## Licence

Not yet chosen.
