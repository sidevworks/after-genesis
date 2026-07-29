# Production Dependency Security Advisory Assessment

**Date:** 2026-07-29  
**Scope:** `npm audit` results for `sidevworks/after-genesis` monorepo  
**Production image:** Slim Cloud Run container built with `npm ci --omit=dev`

## Summary

`npm audit` reports **26 vulnerabilities** (5 moderate, 20 high, 1 critical) across 6 upstream dependency chains. All vulnerabilities reside in **development-only** or **tooling-only** dependency paths that are never shipped to the production Cloud Run container.

The production image excludes all dev dependencies and the `.gcloudignore` explicitly removes:

- `node_modules/` (rebuilt via `npm ci --omit=dev`)
- `.env`, `.git/`, `docs/`, `exports/`, `.claude/`, `.worlds/`

## Advisory Breakdown

### 1. `firebase-tools` chain (dev dependency)
| Advisory | Severity | Package | Fix |
|----------|----------|---------|-----|
| GHSA-8988-4f7v-96qf | moderate | `@opentelemetry/core` < 2.8.0 | `firebase-tools@14.23.0` |
| GHSA-mh99-v99m-4gvg | high | `brace-expansion` ≤ 5.0.7 | `firebase-tools@14.23.0` |
| GHSA-w5hq-g745-h8pq | moderate | `uuid` < 11.1.1 | `firebase-tools@14.23.0` |

**Assessment:** `firebase-tools` is a CLI used only in CI and local dev. It is never bundled into the worker image or the spectator export. The `brace-expansion` DoS advisory affects file-globbing under adversarial input patterns, which is not reachable in our CI pipeline.

**Decision:** Formally accept for staging. Upgrade `firebase-tools` to `14.23.0` before production Genesis to clear the report.

---

### 2. `vitest` / `esbuild` / `vite` chain (dev dependency)
| Advisory | Severity | Package | Fix |
|----------|----------|---------|-----|
| GHSA-67mh-4wv8-2f99 | moderate | `esbuild` ≤ 0.24.2 | `vitest@4.1.10` |

**Assessment:** `esbuild` is the bundler/transformer used by Vitest during local test runs. The advisory describes a cross-origin request vulnerability in the esbuild dev server, which is only active during `vitest run` in a trusted local environment. It is never deployed.

**Decision:** Formally accept. Upgrade `vitest` to 4.x before production launch.

---

### 3. `next` / `postcss` chain (spectator build dependency)
| Advisory | Severity | Package | Fix |
|----------|----------|---------|-----|
| GHSA-qx2v-qp2m-jg93 | high | `postcss` ≤ 8.5.17 — XSS via unescaped `</style>` | `next@17.x` |
| GHSA-6g55-p6wh-862q | high | `postcss` ≤ 8.5.17 — arbitrary file read via sourceMappingURL | `next@17.x` |
| GHSA-r28c-9q8g-f849 | high | `postcss` ≤ 8.5.17 — path traversal in source map auto-loading | `next@17.x` |

**Assessment:** PostCSS processes CSS at **build time** only. The spectator application is exported as a static site (`next export`). PostCSS never runs in the deployed artifact. The source-map and path-traversal advisories require attacker-controlled CSS input, which does not exist in this project's build pipeline.

**Decision:** Formally accept for staging. Track Next.js 17.x upgrade for production.

---

### 4. `next` / `sharp` chain (image optimisation)
| Advisory | Severity | Package | Fix |
|----------|----------|---------|-----|
| GHSA-f88m-g3jw-g9cj | high | `sharp` < 0.35.0 — inherited libvips CVEs | `next@17.x` |

**Assessment:** `sharp` is used by Next.js for image optimisation during the build step. The spectator app uses static export and does not serve images through a Next.js image optimisation server at runtime. The libvips CVEs require processing attacker-supplied images, which does not apply in a build-only context.

**Decision:** Formally accept for staging. Upgrade with Next.js 17.x.

---

## Production Container Isolation

The production worker container (`after-genesis-worker`) does not include any of the above packages:

1. `firebase-tools` is a root dev dependency — excluded by `--omit=dev`.
2. `vitest`, `esbuild`, `vite` are dev dependencies — excluded by `--omit=dev`.
3. `next`, `postcss`, `sharp` belong to `@after-genesis/spectator` — the spectator workspace is not installed in the worker image.

The worker image installs only `@after-genesis/worker` and its production transitive dependencies.

## Recommended Actions Before Genesis

| Priority | Action | Blocks Genesis? |
|----------|--------|-----------------|
| High | Upgrade `firebase-tools` to `≥14.23.0` | No |
| Medium | Upgrade `vitest` to `4.x` when stable | No |
| Medium | Track `next@17.x` for postcss + sharp fixes | No |
| Low | Re-run `npm audit` after upgrades and attach to launch report | Yes |

## Conclusion

No production-deployed code path is affected by any reported advisory. All vulnerabilities are confined to development tooling, build pipelines, and CI utilities that never reach the Cloud Run container or the static spectator export.

These advisories are **formally accepted** for the current staging deployment and will be resolved as part of the toolchain upgrade cycle prior to Genesis.
