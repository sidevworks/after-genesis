# Deployment

Two deployment targets, and the boundary between them is a security control, not
a convenience.

| Target | What runs there | Canonical write access |
| --- | --- | --- |
| **Vercel** | The spectator app (`apps/spectator`) | **None. Ever.** |
| **Firebase / GCP** | The simulation runtime, scheduler, event store | Yes — the only writer |

§17 of the specification: *"No production administration credentials in the
frontend."* §28: *"No human-facing canonical write route exists."* If a Firebase
service-account key is ever added to the Vercel project's environment, the
public gains a path to mutate the world and the entire experiment is void. This
is the single most important operational rule in the project.

---

## 1. Before anything: rotate the exposed key

A Firebase service-account private key is currently present in `.env`. It is
gitignored, so it will not reach GitHub — but it has been exposed in a terminal
session and must be treated as compromised.

1. Google Cloud Console → **IAM & Admin → Service Accounts**
2. Select the account → **Keys**
3. **Delete** the existing key
4. **Add key → Create new key → JSON**
5. Store the new key outside the repository. For local development, point
   `GOOGLE_APPLICATION_CREDENTIALS` at its path — do not paste the key body into
   `.env`.
6. For production, use **Secret Manager** (§17), not an environment file.

Verify nothing sensitive is tracked:

```bash
git ls-files | grep -Ei '\.env|service[-_]?account|credentials\.json'
```

That command should print nothing.

---

## 2. GitHub

The repository is initialised locally but has no remote and no commits yet.

Confirm what would be committed before creating anything public:

```bash
git status --porcelain
```

Then stage, commit, and create the remote:

```bash
git add -A && git commit -m "Initial scaffold: deterministic core, event chain, docs"
```

```bash
gh repo create after-genesis --private --source=. --remote=origin --push
```

Create it **private** first. Make it public only after the secret scan passes on
a full history scan — `docs/threat-model.md` explains why a public repository
raises the cost of a leaked credential considerably.

CI (`.github/workflows/ci.yml`) runs a gitleaks secret scan as a gate before
typecheck, tests and build. It also fails if a `.env` or service-account JSON is
ever tracked.

---

## 3. Vercel

The spectator app is a static-ish Next.js read-only client. It reads world data
and must never write it.

```bash
npx vercel link
```

Configure in the Vercel dashboard:

- **Root Directory**: `apps/spectator`
- **Framework Preset**: Next.js
- **Install Command**: `npm install --prefix ../..` (monorepo workspaces)
- **Node version**: 22

### Environment variables — the allowed set

Only these. Nothing else.

| Variable | Why it is safe |
| --- | --- |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Public web config. Not a secret; access is governed by security rules. |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Public identifier. |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | Public identifier for media reads. |
| `NEXT_PUBLIC_BUILD_COMMIT` | Displayed on the audit page (§20). |

### Environment variables — never set these on Vercel

- `GOOGLE_APPLICATION_CREDENTIALS` or any service-account JSON
- `GEMINI_API_KEY` — the frontend performs no cognition
- `ELEVENLABS_API_KEY` — media generation is a backend job (§21)
- Any Firebase Admin SDK credential

A Firebase **web** API key is not a secret and is safe to expose. A **service
account** key is a full administrative credential and is not. Conflating the two
is the most common way projects of this shape get compromised.

### Firestore security rules

Deploy rules that make canonical collections readable but not writable by any
client identity, with the simulation runtime's service account as the sole
writer. Admin SDK access bypasses rules by design, which is exactly why that
credential must not exist anywhere near the frontend. See
`packages/persistence/src/firestore/README.md` and `docs/firestore-design.md`.

Rules must have automated tests that pass before Genesis (§28).

---

## 4. Genesis

Not yet. §24 requires four phases to pass first — mechanical simulation,
adversarial testing, accelerated civilisation rehearsals, and fourteen
continuous days of production dress rehearsal — followed by a written
launch-readiness report.

Genesis is irreversible. After the first canonical event the world is live and
cannot be reset while keeping its identity (§22).
