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
  `a514d3f2541e23e5abc36bfde86d33ebbb0e83d2`
- Staging infrastructure-hardening commits pushed to `main`:
  - `b4bde8a` — explicit Cloud Build upload exclusions
  - `5f2a58c` — use the Cloud Run origin as the task OIDC audience
  - `f589ff2` — install only worker production dependencies in the image
- Earlier CI-verified staging-worker commit: `ce9d706`
- Current pushed repository head at handover: `a514d3f`

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
- Current deployed revision at handover: `after-genesis-worker-00004-4zq`
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
  `worker@sha256:e05a8906a0305e01bb54757af2d66a027b098f5fc2e4e168b6acfcc53c041f44`
- Build ID: `095a5005-65d7-4e0d-800b-79a32b83ea56`
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

The deployed revision atomically reserves worst-case spend in Firestore before
inference, settles actual usage afterward, releases unanswered calls, and
replays a settled recorded response after a crash. Daily and total ceilings
therefore survive restarts and concurrent workers.

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

GitHub Actions run for durable spend commit `a514d3f`:

`https://github.com/sidevworks/after-genesis/actions/runs/30317076091`

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

Post-deployment durable-budget smoke test:

- Revision `after-genesis-worker-00004-4zq` received an authenticated
  Cloud Tasks `POST /turn` and returned HTTP 200.
- Firestore queries returned `{}` for both `worlds` and `spend` afterward.
- No model call, reservation, canonical event, or Genesis state was created.

## Remaining work, in order

1. Add a staging-only, reversible fixture/bootstrap path. Do not reuse the
   irreversible production Genesis command for integration testing.
2. Run a real staging world fixture through:
   Cloud Tasks → OIDC → worker → Gemini → audit store → atomic Firestore commit.
3. Test duplicate delivery, worker crash after commit, provider outage,
   Firestore contention, queue outage, and replay from recorded responses.
4. Connect and deploy the read-only spectator against public projections only.
5. Resolve or formally accept the remaining production dependency advisories.
   The slim worker image currently reports five high advisories in the Google
   client dependency chain.
6. Complete accelerated civilization testing and the required continuous
   fourteen-day dress rehearsal.
7. Produce a written launch-readiness report before considering Genesis.

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
