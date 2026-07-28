# After Genesis — Handover

**Updated:** 2026-07-28  
**State:** Private staging infrastructure deployed; no Genesis has occurred.

## Non-negotiable status

- The canonical `worlds` collection in staging is empty.
- Do not run Genesis. The project remains in pre-Genesis testing.
- Do not place a service-account key, Gemini key, or Firebase Admin credential
  in Vercel or any browser-facing environment.
- The previously exposed key for
  `firebase-adminsdk-fbsvc@after-genesis.iam.gserviceaccount.com` in the
  separate `after-genesis` project has been rotated and removed.

Key rotation verification on 2026-07-28:

- The exposed key `888f9fb3b11ba1741ee413f509ee1f6c528d430a` is absent from
  the service account.
- The only listed user-managed key is replacement key
  `91e03b4260f8568bc9f8b638594ace794100e361`.
- The local credential file references that replacement, remains outside the
  repository, and matches the intended project and service account.

## Source

- Repository: `sidevworks/after-genesis` (private)
- Branch: `main`
- Last source commit deployed to staging:
  `f589ff255f955bfbbc220228180299e7919404b4`
- Staging infrastructure-hardening commits pushed to `main`:
  - `b4bde8a` — explicit Cloud Build upload exclusions
  - `5f2a58c` — use the Cloud Run origin as the task OIDC audience
  - `f589ff2` — install only worker production dependencies in the image
- Earlier CI-verified staging-worker commit: `ce9d706`
- Current pushed repository head at handover: `10de338`

## Staging project

| Resource | Value |
| --- | --- |
| Google Cloud project | `after-genesis-staging` |
| Project number | `1010409904803` |
| Organization | `sienterpriselabs.com` (`165303645416`) |
| Billing | Same billing account as `after-genesis` |
| Region | `me-central1` (Doha) |
| Firebase | Registered |
| Firestore | Native mode, `(default)`, Standard edition |

Enabled APIs:

- Firestore
- Cloud Run
- Cloud Tasks
- Artifact Registry
- Cloud Build
- Secret Manager
- IAM Credentials

The tested `firestore.rules` and `firestore.indexes.json` are deployed.

## Runtime resources

### Cloud Run

- Service: `after-genesis-worker`
- Private URL:
  `https://after-genesis-worker-1010409904803.me-central1.run.app`
- Turn endpoint: `/turn`
- Current deployed revision at handover: `after-genesis-worker-00003-5v8`
- Runtime identity:
  `after-genesis-runtime@after-genesis-staging.iam.gserviceaccount.com`
- Unauthenticated access: disabled
- Concurrency: 1
- Service maximum instances: 1
- Minimum instances: 0
- Timeout: 300 seconds
- Memory: 512 MiB

### Container

- Repository:
  `me-central1-docker.pkg.dev/after-genesis-staging/after-genesis`
- Image:
  `worker@sha256:eb6b3af72dc421ab27685b75e29de94df424e0edc1e7ef35596f5a4c78cce45b`
- Build ID: `18f28ce3-b490-441a-a0a0-c1bc0a1a6fa2`
- The build used the explicit `.gcloudignore`; `.env`, Git history, local
  worlds, old Claude worktrees, credentials, and build outputs were excluded.

### Cloud Tasks

- Queue: `after-genesis-turns`
- Region: `me-central1`
- Maximum dispatch rate: 1 per second
- Maximum concurrent dispatches: 1
- OIDC identity:
  `after-genesis-tasks@after-genesis-staging.iam.gserviceaccount.com`
- Only this task identity has `roles/run.invoker` on the worker service.

### Secret Manager

- Secret: `gemini-api-key`
- Active version: `1`
- The value was copied directly from local `.env` without displaying it or
  writing another credential file.
- Only the runtime identity has `roles/secretmanager.secretAccessor`.

### Runtime cost limits

- `AG_SPEND_LIMIT_DAILY_USD=1`
- `AG_SPEND_LIMIT_TOTAL_USD=5`
- Cloud Run maximum instances is one for staging.

The currently deployed revision still uses process-local limits. Durable
Firestore reservation/settlement code is implemented locally and must pass the
CI emulator contention gate and be deployed before paid staging inference.

## IAM boundary

Runtime identity:

- `roles/datastore.user`
- `roles/cloudtasks.enqueuer`
- Secret accessor on `gemini-api-key` only
- `roles/iam.serviceAccountUser` on the task OIDC identity only

Task identity:

- `roles/run.invoker` on `after-genesis-worker` only

Cloud Build execution identity:

- Read-only access to the staging Cloud Build source bucket
- Writer access to the `after-genesis` Artifact Registry repository
- Log writer at project level

No downloaded staging service-account key was created.

## Verification evidence

GitHub Actions run for `ce9d706`:

`https://github.com/sidevworks/after-genesis/actions/runs/30314774669`

GitHub Actions run for the final staging handover head `e17b9ef`:

`https://github.com/sidevworks/after-genesis/actions/runs/30316373918`

Passed:

- Secret scan
- 859 unit/integration tests
- Typecheck
- Deterministic replay
- Spectator production build
- Real Firestore emulator rules and atomic-contention contracts

Live staging smoke test:

- Sent one Cloud Task named
  `turn-5b2527d8522202542d84e7848d00b1381bdc5e5b`.
- It targeted a deliberately nonexistent world:
  `staging-smoke-no-genesis`.
- Cloud Run revision `after-genesis-worker-00003-5v8` received an authenticated
  `POST /turn` and returned HTTP 200.
- The task completed and was removed by Cloud Tasks.
- Firestore REST query of `worlds` returned `{}` afterward.
- No model call, canonical event, or Genesis state was created.

## Remaining work, in order

1. Push, pass CI, and deploy the durable Firestore spend-reservation change.
2. Add a staging-only, reversible fixture/bootstrap path. Do not reuse the
   irreversible production Genesis command for integration testing.
3. Run a real staging world fixture through:
   Cloud Tasks → OIDC → worker → Gemini → audit store → atomic Firestore commit.
4. Test duplicate delivery, worker crash after commit, provider outage,
   Firestore contention, queue outage, and replay from recorded responses.
5. Connect and deploy the read-only spectator against public projections only.
6. Resolve or formally accept the remaining production dependency advisories.
   The slim worker image currently reports five high advisories in the Google
   client dependency chain.
7. Complete accelerated civilization testing and the required continuous
   fourteen-day dress rehearsal.
8. Produce a written launch-readiness report before considering Genesis.

## Useful inspection commands

```bash
gcloud config set project after-genesis-staging
gcloud run services describe after-genesis-worker --region=me-central1
gcloud tasks queues describe after-genesis-turns --location=me-central1
gcloud firestore databases describe --database='(default)'
gcloud artifacts docker images list \
  me-central1-docker.pkg.dev/after-genesis-staging/after-genesis
```

Never print Secret Manager payloads or `.env` values into logs.
