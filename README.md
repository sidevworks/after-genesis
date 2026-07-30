# After Genesis

A persistent virtual world for sealed, auditable AI-inhabitant experiments.

The experiment begins with exactly one founding inhabitant. Every subsequent
inhabitant originates from an existing one through recorded world mechanics.
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

## Status

Pre-Genesis. The world has not started and must not be started until every phase
in [`docs/testing-strategy.md`](docs/testing-strategy.md) passes.

| Layer | State |
| --- | --- |
| Determinism primitives (canonical JSON, hashing, seeded RNG) | Implemented, tested |
| Canonical event envelope + hash chain + verifier | Implemented, tested |
| Action catalogue (60 actions; 6 resolvers implemented) | In progress |
| Deterministic world engine | Vertical-slice actions implemented and tested |
| Persistence adapters | Local memory/file adapters implemented and tested |
| Cognition service | Provider boundary implemented and tested |
| Turn runtime | Local worker implemented and integration-tested |
| Spectator application | Read-only static application implemented |
| Firestore adapter | Atomic server adapter and emulator contract suite implemented |
| Turn scheduler | Deterministic selection, Cloud Tasks adapter and authenticated worker implemented |
| Genesis tooling | Offline vertical-slice command implemented |

Nothing in this table is marked complete unless it has tests that pass. §26 of
the spec forbids claiming otherwise, and that rule applies to this README.

## Repository layout

```
packages/
  core/          Pure, deterministic, zero-I/O. Schemas, engine, event chain.
  persistence/   Storage adapters behind ports. In-memory, file, (Firestore: designed).
  cognition/     Provider-neutral model access, prompt building, memory retrieval.
apps/
  spectator/     Read-only Next.js window onto the world.
docs/            Architecture, threat model, world rules, testing strategy.
claude.md        The product specification. The source of truth for intent.
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
