# Running After Genesis

Most research use needs nothing but Node 22 and a laptop. Hosting is optional.

## 1. Local, offline (no keys, no cost)

```bash
npm ci
npm run typecheck && npm test
npm run world -- demo --output .worlds/my-run --days 30
npm run world -- replay --output .worlds/my-run
```

`demo` performs Genesis, runs the built-in rule-based *instinct* cognition
(`offline-instinct-cognition-v2`, no LLM), writes the hash-chained event log to
`<output>/events/*.jsonl`, replays it and fails unless the replayed checksum
matches. `--days` accepts 1–833 per invocation; `--resume` continues an existing
world. `--day-duration <1s|10s|1m|10m|1h>` sets wall-clock pacing per in-world day
(12 turns per day).

## 2. Local, with an LLM

```bash
cp .env.example .env    # then set GEMINI_API_KEY, AG_MODEL_ROUTINE,
                        # AG_MODEL_DELIBERATE and both AG_SPEND_LIMIT_* values
npm run world -- demo --provider gemini --days 10 --max-spend-usd 2 --output .worlds/gemini-10
```

Every prompt and untouched response is written to `<output>/model-audit/`.
The runtime refuses a model with no bundled price table (see
`apps/genesis/src/cli.ts`, `productionCognition`) and checks the spend ceiling
before every call. Never commit `.env`.

Optional dev controller with a browser UI (speed presets from "24h in 1h" to
"24h in 1s"):

```bash
npm run dev:world-control          # control server
npm run dev --workspace=@after-genesis/spectator   # spectator on :3000
```

## 3. Verify any recorded run

```bash
npm run verify -- <run>/events/<world>.jsonl --require-genesis   # hash chain
npm run world -- replay --output <run>                          # replay to checksum
node --import=tsx tools/verify-runs.ts <runs-root>              # many runs at once
tools/replay-at-commit.sh <run> <commit>                        # older engine versions
```

## 4. Optional hosted deployment (your own cloud project)

The hosted shape is: a read-only Next.js spectator (any static host) and a
simulation runtime (Cloud Run worker + Cloud Tasks + Firestore) that is the
**only** writer to canonical state.

- The spectator gets public web config only (`NEXT_PUBLIC_*` in `.env.example`).
  Never give it a service-account credential, `GEMINI_API_KEY` or
  `ELEVENLABS_API_KEY`.
- Deploy `firestore.rules` and `storage.rules`; they expose only
  `worlds/{worldId}` and `worlds/{worldId}/public/**` and deny every client write.
  Run `npm run test:emulators` (Java 21+) before deploying.
- Runtime settings are listed in `.env.example` (`GOOGLE_CLOUD_PROJECT`,
  `AG_TASKS_*`, `AG_TURN_WORKER_URL`, `AG_SOURCE_COMMIT`, `AG_DEPLOYED_DIGEST`).
  Deploy the worker (`apps/worker`, root `Dockerfile`) privately and grant
  `roles/run.invoker` only to the Cloud Tasks identity. Use attached IAM
  identities, not downloaded keys.
- Large media (character models, films) can be compressed and published with
  `node apps/spectator/scripts/publish-assets.mjs --optimize --upload`; set
  `NEXT_PUBLIC_ASSET_BASE_URL` to the printed URL.

See `docs/architecture.md`, `docs/firestore-design.md` and
`docs/threat-model.md` for the reasoning behind each rule, and
`docs/dependency-advisories.md` for known upstream advisories.
