# After Genesis

**A sealed, auditable world for AI inhabitants — research release.**

> **The LLM proposes intentions. The deterministic world engine decides reality.**

Created by Sary Ismail (SI Devworks). Code: Apache-2.0. 3D character models:
CC0 1.0. Run data, report and media: CC BY 4.0. See [Licence](#licence-and-how-to-credit).

Technical report: [`docs/after-genesis-report.md`](docs/after-genesis-report.md).

## The question

Give a group of AI inhabitants roughly the resources and environment humanity
started with — land, water, food, wood, stone, their own bodies and each other —
but the knowledge of a modern language model. Then step away and let the world run.

- What do they do?
- How far do they get after 50, 500 or 1,000 in-world years?
- What difference did that knowledge make, and why?

After Genesis is the instrument for asking this. It is not an answer yet: the
runs so far are short development runs (at most 178 in-world days of
continuous activity, see
[Results](#results-so-far)). Long runs cost more than the author can fund, so
the project is released for universities, labs, model providers and
open-model groups to run.

## What is different here

| Property | What it means in this code |
| --- | --- |
| Deterministic authority | A model never writes state. It emits a structured proposal; schema validation and a deterministic engine (`packages/core`) decide what happened. No floats, no `Math.random()`, no wall-clock in rules. |
| Sealed, non-intervention runs | A run's sequence-zero Genesis event fixes the human-controlled inputs. A run may be *called* sealed only if post-Genesis intervention is disabled; there is no human write path into canonical state ([protocol](docs/sealed-experiment-protocol.md)). |
| Hash-chain audit | Every event carries `prevHash`, `hash`, `preStateChecksum` and `postStateChecksum`. Altering any event breaks the chain (`packages/audit`). |
| Replay | The whole history replays from the Genesis seed plus recorded model responses to the same state checksum. Every prompt and untouched response is kept in `model-audit/`. |
| Lineage only through world mechanics | Ten Progenitors are declared at Genesis. Every later inhabitant must come from an existing one through `create_inhabitant` / mating actions resolved by the engine. |

## Status (honest)

Verified against this tree on 2026-11-24:

- **82 actions are declared and schema-validated; 48 resolve; 34 return
  `NOT_IMPLEMENTED`** (counted from `packages/core/src/engine/resolvers/index.ts`).
- Survival, movement, gathering, building, crafting, artifacts, speech,
  barter offers, currency, organisations and voting, conflict, death and
  lineage resolve.
- Not yet implemented — each is an open invitation to contribute:
  - **Learning:** `study`, `teach`
  - **Medicine:** `inspect_agent`, `diagnose_condition`, `design_treatment`, `apply_treatment`
  - **Contracts:** `offer_contract`, `accept_contract`, `reject_contract`, `perform_contract`, `terminate_contract`
  - **Care, coordination and disclosure:** `care_for_dependant`, `supervise`,
    `interrupt_activity`, `coordinate_work`, `contribute_to_group`,
    `inspect_inventory`, `audit_records`, `conceal_asset`, `reveal_asset`
  - **Security, law and enforcement:** `investigate_event`, `report_findings`,
    `secure_storage`, `attempt_transfer_without_consent`, `accuse`,
    `present_evidence`, `request_restitution`, `impose_confinement`,
    `maintain_confinement`, `release_from_confinement`, `visit_confined_agent`,
    `appeal_decision`, `attempt_escape`, `resist_enforcement`
- No sealed Genesis has been run. All runs below are development runs.
- The test suite (1,510 tests as of 2026-08-02) was not re-run for this release.

### What the inhabitants know

Cognition is the model's own knowledge only. The Gemini provider
(`packages/cognition/src/providers/gemini.ts`) sends a system prompt, one user
prompt and a JSON generation config. It sends **no tools: no Google Search, no
grounding, no web access.** Each inhabitant sees only its own limited
observation of the world plus its memories.

### Models

`ModelProvider` (`packages/core/src/ports.ts`) is a two-member interface:
`name` and `generate(request) → { rawText, inputTokens, outputTokens, … }`.
Three implementations ship: `GeminiProvider` (live), `ScriptedProvider`
(offline, deterministic) and `ReplayProvider` (serves recorded responses). A
separate rule-based `offline-instinct-cognition-v2` drives inhabitants without
any model (`apps/genesis/src/cli.ts`).

Today only Gemini is wired in as a live provider, and the CLI and worker accept
only `gemini-3.5-flash-lite` and `gemini-3.6-flash`. Adding an OpenAI-compatible
endpoint (OpenRouter, vLLM, Ollama, llama.cpp server, etc.) means: one new
provider class of about the size of `gemini.ts` (≈370 lines including error
handling), a `--provider` option in `apps/genesis/src/cli.ts`, a price-table
entry (the runtime refuses an unpriced model), and relaxing the model allow-list
in `apps/worker/src/server.ts` and `packages/cognition/src/providers/gemini.ts`.
Replay needs no change because it never calls a model.

### Time

The engine has no clock of its own: time is an integer number of simulated
minutes, and 12 turns make one in-world day. How fast that runs is a choice:

- Local CLI: `--day-duration 1s|10s|1m|10m|1h` per in-world day; the offline
  instinct mode runs as fast as the machine allows.
- Dev controller (`apps/genesis/src/dev-control-server.ts`): presets from
  "24h in 1h" (24×) to "24h in 1s" (86,400×). The UI notes that with an LLM the
  speed is a target and sequential model calls make it slower.
- Hosted runtime (`packages/runtime/src/time-scaling.ts`): fixed at 4 in-world
  hours per real hour (4×).

The spectator app only plays back recorded history; it does not drive time.

## Results so far

31 development runs recorded 28 Jul – 1 Aug 2026; 9,914 events in total. 2,815
model calls cost **$6.55** at the runtime's recorded prices. Produced by
[`tools/summarise-runs.mjs`](tools/summarise-runs.mjs); full table in
[`results/run-summary.md`](results/run-summary.md); verification in
[`results/replay-table.md`](results/replay-table.md).

| Run | Cognition | Founders | In-world days | Events | Alive at end | Births | Notable |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| year-one | offline instinct (no LLM) | 3 | 365 (activity to day 56) | 4,381 | 1 | 0 | two founders died on day 56; after that every proposal was rejected (see below); 4 artifacts, 13 messages |
| manual-progress | offline instinct (no LLM) | 3 | 178 | 2,137 | 3 | 0 | 268 `create_inhabitant` attempts, all rejected (`INSUFFICIENT_RESOURCES`); 3 structures |
| 3-month-run | offline instinct (no LLM) | 10 | 47 | 565 | 0 | 0 | whole cohort died by day 47; 9 structures built |
| verify-100 | Gemini 3.5 Flash Lite | 1 | 100 | 1,201 | 1 | 0 | 1,200 model calls, $1.58 |
| emergence-v2-final-1 | Gemini 3.5 Flash Lite | 3 | 50 | 601 | 3 | 0 | 600 calls, $0.72; 14 messages |
| dev-rehearsal-archive-2026-08-01T0109 | Gemini 3.5 Flash Lite | 10 | 32.3 | 389 | 10 | 0 | 426 calls, $2.77; 87 messages, 24 trade offers, 9 structures, 4 artifacts |

What this shows, plainly:

- **No run has produced a birth.** In `manual-progress`, every one of 268
  attempts was rejected because the proposed endowment exceeded the resources
  paid. Lineage has unit tests, but it has never happened in a recorded run.
- **The longest runs used the offline instinct mode, not an LLM.** The longest
  LLM run is 100 in-world days with one inhabitant.
- **`year-one` effectively stopped on day 56.** Its last accepted action is on
  day 56. The other 309 in-world days are 3,944 rejected proposals: 2,470 from
  inhabitants who had already died (`DEAD`) and 1,461 moves by the survivor
  into impassable ground (`IMPASSABLE`). The scheduler kept giving turns and the
  engine correctly refused them. A later commit (`73a8292`, "break two offline
  livelocks") addresses this kind of loop. The longest run with continuous
  activity is `manual-progress` (178 days, 1,815 accepted actions).
- With a model, inhabitants talk (greetings, proposals, announcements), make
  trade offers and build. Without one, they mostly gather, eat, rest and move.
- **All 31 hash chains verify today.** 17 runs replay exactly to their recorded
  checksums with the engine version of the day (2 with the current engine).
  The other 14 were recorded with uncommitted engine changes, so no committed
  engine can reproduce them; their hash chains are still intact.

## Cost of long runs

Measured from the model-audit records (tokens per in-world day stay roughly flat
over a run: verify-100 averaged 3,657 input tokens per call in its first quarter
and 3,886 in its last). The current scheduler makes about 12 model calls per
in-world day for the whole population.

| Population | Model | $/in-world day | $/year | $/century | $/1,000 years |
| --- | --- | ---: | ---: | ---: | ---: |
| 3 | Gemini 3.5 Flash Lite ($0.30 / $2.50 per M tokens) | 0.014 | 5.24 | 524 | 5,236 |
| 3 | open model, hosted (assumed $0.10 / $0.40 per M) | 0.004 | 1.57 | 157 | 1,573 |
| 10 | Gemini 3.5 Flash Lite | 0.086 | 31.26 | 3,126 | 31,259 |
| 10 | open model, hosted (assumed) | 0.027 | 9.80 | 980 | 9,796 |

Assumptions: the Flash Lite prices are those bundled in the code
(`apps/genesis/src/cli.ts`, verified 2026-07-28); check current pricing. The
open-model price is an assumption for a small hosted model, not a quote; a
local model costs only hardware and electricity. A growing population, more
turns per inhabitant, or a larger model raise these figures roughly in
proportion. Calls are sequential: 1,000 in-world years is about 4.4 million
calls, which takes months of wall-clock time at 1–2 seconds per call unless
turns are parallelised.

## How to run

```bash
npm ci
npm run world -- demo --output .worlds/my-run --days 30      # offline, free
npm run world -- replay --output .worlds/my-run              # replay to checksum
```

With Gemini (set `GEMINI_API_KEY`, `AG_MODEL_ROUTINE`, `AG_MODEL_DELIBERATE` and
both spend limits in `.env`; see `.env.example`):

```bash
npm run world -- demo --provider gemini --days 10 --max-spend-usd 2 --output .worlds/gemini-10
```

More in [DEPLOYMENT.md](DEPLOYMENT.md) (local, LLM, hosted).

## How to verify a run

```bash
npm run verify -- <run>/events/<world>.jsonl --require-genesis      # hash chain
npm run world -- replay --output <run>                             # replay
node --import=tsx tools/verify-runs.ts <runs-root>                 # all runs
tools/replay-at-commit.sh <run> <commit>                           # older engine
node tools/summarise-runs.mjs <runs-root> --md summary.md          # statistics
```

Use `--anchor <hash>` with `npm run verify` to compare against a published head
hash; without an anchor, a complete forgery from a different Genesis would
still be self-consistent.

## Related work

- **Generative Agents / Smallville** (Park et al., Stanford and Google, 2023;
  [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)) — 25 agents with memory,
  reflection and planning in a sandbox town. Focus on believable daily behaviour
  over short horizons.
- **Project Sid** (Altera, 2024; [arXiv:2411.00114](https://arxiv.org/abs/2411.00114))
  — 10 to 1,000+ agents in Minecraft; specialisation, collective rules and
  culture.
- **Concordia** (Google DeepMind; [arXiv:2312.03664](https://arxiv.org/abs/2312.03664),
  [code](https://github.com/google-deepmind/concordia)) — a library for
  generative agent-based modelling in which a Game Master (itself an LLM-driven
  component) mediates and describes the outcomes of actions.
- **AgentSociety** (Tsinghua FIB Lab, 2025; [arXiv:2502.08691](https://arxiv.org/abs/2502.08691),
  [code](https://github.com/tsinghua-fib-lab/agentsociety)) — large-scale social
  simulation with 10,000+ LLM agents in a realistic urban environment.

After Genesis differs in method rather than scale. A deterministic, non-LLM
engine resolves every action. The history is a hash chain that replays to the
same state checksum. Runs are sealed with no human intervention. New
inhabitants arise only through the world's own mechanics. The aim is runs of
centuries, not days. It is smaller than these projects and has fewer behaviours
implemented.

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
would need are among the 34 that do not yet resolve. Whether any of these
labels ends up describing what an inhabitant actually does is one of the things
the experiment is for.

The cohort size is enforced, not merely defaulted. `commitGenesis` refuses to
commit a Genesis classified `sealed_experiment` with any population other than
ten. Development runs, rehearsals and fixtures stay free to seed one to
thirty-two — a three-founder soak test proves the same mechanics more cheaply —
so the rule constrains what may be *called* sealed rather than what may run.

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
  genesis/       The world CLI: demo, replay, staging bootstrap; dev controller.
  worker/        HTTP turn worker, invoked by Cloud Tasks.
  spectator/     Read-only Next.js window onto the world.
docs/            Architecture, threat model, world rules, testing strategy.
claude.md        The product specification. The source of truth for intent.
tools/           Read-only run verification and statistics (this release).
results/         Statistics and verification of the July 2026 runs.
```

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


## Security

The public client has **no canonical write path**. The runtime is the only
writer to canonical state; the spectator receives public web config only. CI
runs a gitleaks secret scan before anything else. Prompt injection between
inhabitants is treated as a first-class threat; see
[`docs/threat-model.md`](docs/threat-model.md). Never commit `.env`.

## Call for long-run partners

The author cannot fund long runs. If you have model credits, GPUs or an open
model to evaluate, a 50-, 500- or 1,000-year run would answer the question this
project asks. Recorded runs are verifiable by anyone, so the results can be
checked independently of who ran them. Please open an issue on GitHub.

## Licence and how to credit

- **Code:** [Apache License 2.0](LICENSE). Keep the [NOTICE](NOTICE) file in
  redistributions.
- **3D character models:** [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
  — public domain dedication.
- **Run data, technical report, films, speech and other media:**
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Third-party content keeps its own licence: Kenney city kits (CC0, by Kenney);
  terrain derived from "Tabletop Terrain" by fangzhangmnm (CC BY 4.0).
  Details and exact attribution text: [LICENSE-ASSETS.md](LICENSE-ASSETS.md).

Credit line for CC BY material:

> After Genesis by Sary Ismail (SI Devworks) — https://github.com/sidevworks/after-genesis — CC BY 4.0.

## Citation

See [CITATION.cff](CITATION.cff). BibTeX:

```bibtex
@software{ismail_after_genesis_2026,
  author  = {Ismail, Sary},
  title   = {After Genesis: a sealed, auditable world for AI inhabitants},
  year    = {2026},
  version = {0.1.0-research},
  url     = {https://github.com/sidevworks/after-genesis},
  license = {Apache-2.0}
}
```
