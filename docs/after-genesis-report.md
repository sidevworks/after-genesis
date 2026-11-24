# After Genesis: a sealed, auditable world for AI inhabitants

**Technical report, version 0.1.0-research (24 November 2026)**
Sary Ismail, SI Devworks — https://github.com/sidevworks/after-genesis
Licence: this report is CC BY 4.0; the code is Apache-2.0.

---

## Abstract

After Genesis is a persistent simulated world inhabited only by AI agents.
Language models propose what an inhabitant intends to do. A deterministic,
non-LLM engine decides what actually happens. Every canonical event is
hash-chained and carries the state checksum before and after it, so the whole
history can be verified and replayed to the same checksum from the Genesis seed
and the recorded model responses. After Genesis no human writes to the world.
New inhabitants can only arise from existing ones through the world's own
mechanics.

This report describes the design and its audit guarantees. It also reports 31
development runs recorded between 28 July and 1 August 2026: 9,914 events, up
to 178 in-world days of continuous activity with rule-based cognition and up to
100 in-world days with Gemini 3.5 Flash Lite, for $6.55 of recorded model spend. All 31 hash chains
verify, and 17 runs replay exactly. No run has yet produced a birth. We project
the cost of century- and millennium-scale runs and invite partners to run them.

## 1. Question

Humanity began with land, water, food, raw materials, bodies and one another,
and built up knowledge slowly. A modern language model carries a large share of
that knowledge already. If inhabitants with that knowledge are placed in a
world with only the early resources, and left alone:

1. What do they do?
2. How advanced are they after 50, 500 or 1,000 in-world years?
3. What difference did the knowledge make, and why?

Answering this needs long runs, so it needs to be cheap. It also needs
outcomes that cannot be quietly steered: by the operator, by a model writing
its own results, or by an editor of the record after the fact. The design
choices below follow from those two requirements.

## 2. Design

### 2.1 Proposals, not writes

Each turn, the runtime builds a limited observation for one inhabitant: its
position, nearby terrain and resources, its body state, inventory and recent
memories. A cognition provider returns a JSON proposal such as
`{"type": "gather", "payload": {"resource": "water"}, "rationale": "…"}`. The
proposal is untrusted input. It is parsed and validated against the action's
schema (`packages/core/src/schema/action-spec.ts`). It then goes to the engine
resolver for that action type (`packages/core/src/engine/resolvers/`), which
checks preconditions against canonical state and returns either an outcome
with derived state changes or a typed rejection (`INSUFFICIENT_RESOURCES`,
`BUSY`, `DEAD`, `INVALID_PAYLOAD`, `NOT_IMPLEMENTED`, …). The model never moves
a resource or creates an entity.

### 2.2 The world

The world is a deterministic tile map (64×64 by default; 32×32 in the recorded
runs) with terrain, water and harvestable resources, generated from a seed.
Time is an integer count of simulated minutes, and 12 turns make one in-world
day. Inhabitants have bodily needs (food, water, rest), carrying capacity,
lifespans and the possibility of death. They can build structures, craft and
refine materials, create, copy, store and read artifacts, speak, announce,
offer and accept barter, create currency, form organisations and vote, fight,
and create new inhabitants. Rules are written down in
[`docs/world-rules-v1.md`](world-rules-v1.md).

### 2.3 Action catalogue

82 actions are declared and schema-validated. At this release 48 have
resolvers and 34 return `NOT_IMPLEMENTED`: learning (`study`, `teach`),
medicine (4), contracts (5), care and coordination (9), and security, law and
enforcement (14). An unimplemented action is rejected honestly rather than
silently succeeding. This matters for interpretation: an inhabitant that
proposes to teach is recorded as having tried, and the world says no.

### 2.4 Genesis and lineage

A sealed experiment begins with ten Progenitors (ALPHA … KAPPA), each with a
starting disposition, trait vector and preferred actions, but no profession or
relationship. The Genesis event (sequence 0) records the seed, map size and
complete founder definitions. `commitGenesis` refuses to classify a run as
`sealed_experiment` with any other population. Development runs may use 1–32
founders. Later inhabitants can only be created by an existing inhabitant
through `create_inhabitant` or the mating actions, and only if the engine
accepts the resources committed.

## 3. Determinism and audit

### 3.1 Rules that keep replay exact

- No floating point in canonical state; canonical JSON rejects floats.
- No `Math.random()`: seeded SplitMix64 streams per purpose.
- No wall-clock time in rules: real timestamps are recorded but never read by
  the engine.
- No I/O in the engine: state in, state out.
- Canonical JSON sorts object keys before hashing.

### 3.2 The event chain

Each event records `sequence`, `simTime`, `actor`, `type`, `inputs` (the
validated proposal), `resolution`, `visibility`, `preStateChecksum`,
`postStateChecksum`, provenance (source commit, deployed digest, model id and
request/response hashes), `prevHash` and `hash`. The verifier
(`packages/audit/src/verify.ts`, `npm run verify`) checks schema, sequence
continuity and every hash link, and can compare the head hash with a published
anchor.

### 3.3 Replay

`replayHistory` (`packages/audit/src/replay.ts`) regenerates the empty world
from the Genesis seed and re-applies every recorded action through the same
resolvers. After each event it compares the recomputed checksums with the
recorded ones. Model responses are not regenerated; they are inputs, kept
verbatim in `model-audit/` with their hashes on the event. Replay therefore
needs no model access and costs nothing.

### 3.4 Sealing and non-intervention

The sealed-experiment protocol ([`docs/sealed-experiment-protocol.md`](sealed-experiment-protocol.md))
defines which runs may be called sealed. There is no human-facing write route
to canonical state. In the hosted design the runtime's service identity is the
only writer, and the public spectator is read-only by security rules.

## 4. Cognition

- **Interface.** `ModelProvider` (`packages/core/src/ports.ts`) has a name and
  `generate(request)`. Implementations: `GeminiProvider` (live HTTP to the
  Gemini API), `ScriptedProvider` (offline, deterministic) and `ReplayProvider`
  (recorded responses only).
- **Rule-based mode.** `offline-instinct-cognition-v2`
  (`apps/genesis/src/cli.ts`) drives inhabitants by simple survival priorities
  with no model. It is useful for testing mechanics and for long, free runs,
  but it is not an LLM and its runs say nothing about model knowledge.
- **No web access.** The Gemini request contains a system instruction, one
  user prompt and a generation config (JSON output, token limit). No tools are
  passed: no Google Search, no grounding. Inhabitants use only what the model
  already knows.
- **Models used.** `gemini-3.5-flash-lite` for all substantial LLM runs;
  `gemini-3.6-flash` in short smoke tests. Both have prices bundled in the
  runtime, which refuses to run an unpriced model and checks a spend ceiling
  before every call.
- **Adding providers.** An OpenAI-compatible provider (OpenRouter, vLLM,
  Ollama, llama.cpp server) needs: one provider class, a CLI option, a price
  entry, and relaxing two model allow-lists. Replay is unaffected.

## 5. Runs and results

### 5.1 Data

Thirty-one development runs were recorded between 28 July and 1 August 2026.
Each contains `events/*.jsonl`, the final `state/`, `model-audit/` for LLM runs,
an `audit-report.json` written at the time, and a `public-snapshot.json`.
Statistics below come from `tools/summarise-runs.mjs`; the full table is in
[`results/run-summary.md`](../results/run-summary.md).

Note on dates: recorded `realTimestamp` values in several runs are synthetic
(starting 2026-01-01) by design. In-world duration is computed from `simTime`.

### 5.2 Main runs

| Run | Cognition | Founders | In-world days | Events | Alive at end | Births |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| year-one | offline instinct | 3 | 365 (active to day 56) | 4,381 | 1 | 0 |
| manual-progress | offline instinct | 3 | 178 | 2,137 | 3 | 0 |
| 3-month-run | offline instinct | 10 | 47 | 565 | 0 | 0 |
| verify-100 | Gemini 3.5 Flash Lite | 1 | 100 | 1,201 | 1 | 0 |
| emergence-v2-final-1 | Gemini 3.5 Flash Lite | 3 | 50 | 601 | 3 | 0 |
| dev-rehearsal-archive-2026-08-01T0109 | Gemini 3.5 Flash Lite | 10 | 32.3 | 389 | 10 | 0 |
| dev-rehearsal | Gemini 3.5 Flash Lite | 10 | 10 | 121 | 10 | 0 |
| emergence-v2-schema-check-2 | Gemini 3.5 Flash Lite | 3 | 17.5 | 211 | 3 | 0 |

The remaining 23 runs are short canaries, schema checks and smoke tests
(1–37 events each).

### 5.3 Observations

1. **Survival is hard under rule-based cognition, and `year-one` stalled.** In
   `year-one`, two of three founders died on day 56, which was also the last
   day any action was accepted. The other 309 in-world days are 3,944 rejected
   proposals: 2,470 from dead inhabitants who were still scheduled (`DEAD`) and
   1,461 moves by the survivor into impassable ground (`IMPASSABLE`). The
   engine behaved correctly; the scheduler and the instinct policy did not. A
   later commit (`73a8292`) fixes two such livelocks. So the "one-year run" is
   really 56 days of activity. In `3-month-run`, all ten founders had died by
   day 47, after building nine structures. The longest run with continuous
   activity is `manual-progress` (178 days, 1,815 accepted actions).
2. **No births.** In `manual-progress`, 268 `create_inhabitant` attempts
   were all rejected with `INSUFFICIENT_RESOURCES` ("endowment exceeds the cost
   paid"). The instinct policy proposed an endowment its resources could not
   cover, so the engine refused. Lineage is unit-tested but has never occurred
   in a recorded run, and no recorded run exercises the lineage resolver under
   replay.
3. **With a model, inhabitants talk and trade.** In the 10-founder Gemini
   rehearsal, 389 events include 87 messages and announcements, 24 trade
   offers, 9 structures and 4 artifacts. All ten were alive after 32 in-world
   days. In the instinct runs, communication is rare (13 messages in a year).
4. **Early LLM behaviour is cautious.** In `verify-100`, the single inhabitant
   spent most turns observing and gathering: 366 observations and 412
   successful gathers out of 1,200 turns. Of all its proposals, 90% were
   accepted.
5. **Proposals outrun the engine.** Inhabitants proposed `study` and `teach`,
   which the engine does not yet resolve. Malformed or out-of-range proposals
   (for example speaking to someone out of earshot) were rejected and recorded.

These are development runs of days to one year, with mostly rule-based
cognition. They show that the instrument works end to end. They do not yet
answer the research question.

### 5.4 Verification

All 31 hash chains verify with the current verifier. Replay was attempted with
the current engine and then with engine versions from the commit history
(`tools/replay-at-commit.sh`). Seventeen runs reproduce every pre- and
post-state checksum: two with the current engine and fifteen with the engine of
the day (for example `year-one` at `c6802a9`, `verify-100` at `177e082`,
`emergence-v2-final-1` at `46b5ad2`). Fourteen runs, including
`manual-progress`, were recorded with uncommitted local engine changes
(provenance `local-uncommitted`). No committed engine reproduces them, though
their chains are intact and their `audit-report.json` files from the time
report a passing replay. Full table:
[`results/replay-table.md`](../results/replay-table.md).

**Lesson.** A sealed run must pin the exact engine commit and build digest in
its provenance. The code already supports this (`AG_SOURCE_COMMIT`,
`AG_DEPLOYED_DIGEST`); the development runs did not use it.

## 6. Cost

Model audit records give tokens per call. Input tokens per call stay roughly
flat across a run (`verify-100`: 3,657 in the first quarter, 3,886 in the
last; the 10-founder rehearsal: 17,879 → 19,742), because observation and
memory windows are bounded. The scheduler makes about 12 calls per in-world day
for the whole population.

| Population | Model | $/in-world day | $/year | $/century | $/1,000 years |
| --- | --- | ---: | ---: | ---: | ---: |
| 3 | Gemini 3.5 Flash Lite ($0.30/$2.50 per M) | 0.014 | 5.24 | 524 | 5,236 |
| 3 | hosted open model (assumed $0.10/$0.40 per M) | 0.004 | 1.57 | 157 | 1,573 |
| 10 | Gemini 3.5 Flash Lite | 0.086 | 31.26 | 3,126 | 31,259 |
| 10 | hosted open model (assumed) | 0.027 | 9.80 | 980 | 9,796 |

Flash Lite prices are the runtime's bundled table (verified 2026-07-28). The
open-model price is an assumption for a small hosted model, and a local model
costs only hardware time. At this turn rate each inhabitant of a ten-person
world acts about 1.2 times per in-world day. A richer run would raise the turn
rate, and cost scales roughly linearly with turns and population. Wall-clock
time is the other constraint: a millennium is about 4.4 million sequential
calls.

## 7. Limitations

- 34 of 82 actions do not resolve. Learning, medicine, contracts and law are
  central to the research question and are missing.
- No recorded birth. Lineage is untested in practice.
- The scheduler keeps giving turns to dead inhabitants, and the instinct
  policy can livelock (`year-one`).
- The longest runs use rule-based cognition, not a model.
- Fourteen runs cannot be replayed with any committed engine.
- One model family (Gemini) has been tried, with no web access. That is
  intended, but it means results speak only to that model's knowledge.
- The ten Progenitors' dispositions were authored, so results must be read
  against a chosen starting cohort.
- The world is small (32×32 in the runs) and its material and technology
  model is simple. "How advanced" is bounded by what the engine can represent.
- The test suite was not re-run for this release.

## 8. How to extend

- **New actions:** add a resolver in `packages/core/src/engine/resolvers/`,
  register it in `index.ts`, add tests and a replay test. Highest value:
  `study`/`teach`, then contracts and medicine.
- **New providers:** implement `ModelProvider`; see section 4.
- **Longer runs:** `npm run world -- demo --days N --resume` continues a world;
  pin `AG_SOURCE_COMMIT` so the run stays replayable.
- **Analysis:** `tools/summarise-runs.mjs` and `tools/verify-runs.ts` read any
  run folder.

## 9. Call for long-run partners

The author built After Genesis alone in about three days in July 2026 and
cannot fund long runs. We are looking for universities, labs, model providers
and open-model groups willing to:

1. run a sealed ten-Progenitor world for 50, 500 or 1,000 in-world years with
   their model;
2. publish the event log and model-audit records so that anyone can verify and
   replay them;
3. compare models on the same seed.

Because every run is verifiable, results from different groups can be checked
against each other without trusting the operator.

## References

- Park, J. S., et al. (2023). Generative Agents: Interactive Simulacra of Human
  Behavior. arXiv:2304.03442.
- Altera.AL (2024). Project Sid: Many-agent simulations toward AI civilization.
  arXiv:2411.00114.
- Vezhnevets, A. S., et al. (2023). Generative agent-based modeling with
  actions grounded in physical, social, or digital space using Concordia.
  arXiv:2312.03664.
- Piao, J., et al. (2025). AgentSociety: Large-Scale Simulation of LLM-Driven
  Generative Agents Advances Understanding of Human Behaviors and Society.
  arXiv:2502.08691.
