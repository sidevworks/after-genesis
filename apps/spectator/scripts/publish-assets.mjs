#!/usr/bin/env node
// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Publish the spectator's heavy media to Cloud Storage for Firebase.
 *
 * claude.md §3 designates Cloud Storage for "audio, artwork and media
 * artifacts". Character models, terrain, profile films and rendered speech are
 * ~260 MB uncompressed, which is not something a git history or a Vercel
 * deployment should carry: the repository would hold every revision of every
 * binary forever, and every spectator would pull a quarter-gigabyte to look at
 * one page.
 *
 * Two phases, either of which can be run alone:
 *
 *   --optimize   Compress glTF models with meshopt geometry compression and
 *                WebP textures. Measured on this project's assets: 229 MB of
 *                source models become 29 MB, with no visible loss at the sizes
 *                the spectator renders them.
 *   --upload     Sync the optimised tree to gs://$BUCKET/spectator/.
 *
 * Neither phase touches canonical world state. Media is read-only with respect
 * to the world (§21), and uploads run out of band under an operator's own
 * credentials — the published bucket prefix is readable and not writable
 * (storage.rules), so no spectator build can alter what it serves.
 *
 * Usage:
 *   node apps/spectator/scripts/publish-assets.mjs --optimize
 *   node apps/spectator/scripts/publish-assets.mjs --upload --bucket <name>
 *   node apps/spectator/scripts/publish-assets.mjs --optimize --upload --dry-run
 *
 * The bucket defaults to $FIREBASE_STORAGE_BUCKET_ID. Uploading requires the
 * Google Cloud CLI on PATH and an active credential with object-admin rights on
 * the target bucket; this script never reads a key file itself.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPECTATOR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(SPECTATOR_ROOT, "public");
/** Optimised output. Regenerable from the masters, so it is never committed. */
const STAGE_DIR = join(SPECTATOR_ROOT, ".assets-dist");
/** Content-hashed tree, exactly as it will exist under the bucket prefix. */
const PUBLISH_DIR = join(STAGE_DIR, "publish");
/**
 * Logical path → published path. Committed, because the spectator resolves
 * through it at build time: a lockfile for assets rather than a runtime fetch.
 */
const MANIFEST_FILE = join(SPECTATOR_ROOT, "src/lib/asset-manifest.json");

/**
 * What gets published.
 *
 * Published names carry a hash of their own bytes — `Alpha.9f3c1e0a.glb` — so
 * `immutable` is a true statement rather than a hope. Under fixed names it was
 * a trap: a re-exported model would keep its URL, and every returning visitor
 * would hold the stale copy for a year with no way to know. Hashing means a
 * changed file is a different URL and an unchanged file is still a cache hit,
 * so republishing costs nothing for the assets that did not move.
 */
const ASSET_SETS = [
  { dir: "character-models", optimize: true, contentType: "model/gltf-binary" },
  { dir: "terrain", optimize: true, contentType: "model/gltf-binary" },
  { dir: "character-profile", optimize: false, contentType: null },
  { dir: "intro", optimize: false, contentType: null, files: ["intro.mp4", "intro-poster.jpg"] },
];

const CACHE_CONTROL = "public, max-age=31536000, immutable";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const wantOptimize = args.has("--optimize");
const wantUpload = args.has("--upload");
const bucketFlagIndex = process.argv.indexOf("--bucket");
// `FIREBASE_STORAGE_BUCKET_ID` is conventionally written with the gs:// scheme
// on it, and a --bucket flag may be typed either way. Normalise to the bare
// name, because every URL below supplies its own scheme.
const bucket = (
  bucketFlagIndex === -1 ? process.env.FIREBASE_STORAGE_BUCKET_ID : process.argv[bucketFlagIndex + 1]
)
  ?.trim()
  .replace(/^gs:\/\//, "")
  .replace(/\/+$/, "");

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

if (!wantOptimize && !wantUpload) {
  fail("nothing to do — pass --optimize, --upload, or both");
}

function run(command, commandArgs) {
  if (dryRun) {
    console.log(`  would run: ${command} ${commandArgs.join(" ")}`);
    return true;
  }
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  return result.status === 0;
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function directorySize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(full) : statSync(full).size;
  }
  return total;
}

function optimize() {
  console.log("Optimising glTF models\n");
  let before = 0;
  let after = 0;
  for (const set of ASSET_SETS.filter((candidate) => candidate.optimize)) {
    const source = join(PUBLIC_DIR, set.dir);
    if (!existsSync(source)) {
      console.log(`  skip ${set.dir} — not present in public/`);
      continue;
    }
    const target = join(STAGE_DIR, set.dir);
    mkdirSync(target, { recursive: true });
    for (const file of readdirSync(source).filter((name) => name.endsWith(".glb"))) {
      const input = join(source, file);
      const output = join(target, file);
      const ok = run("npx", [
        "--yes",
        "@gltf-transform/cli@4",
        "optimize",
        input,
        output,
        "--compress",
        "meshopt",
        "--texture-compress",
        "webp",
      ]);
      if (!ok) fail(`could not optimise ${file}`);
      if (!dryRun) {
        before += statSync(input).size;
        after += statSync(output).size;
        console.log(`  ${file}: ${megabytes(statSync(input).size)} → ${megabytes(statSync(output).size)}`);
      }
    }
  }
  if (!dryRun && before > 0) {
    console.log(`\n  total: ${megabytes(before)} → ${megabytes(after)}\n`);
  }
}

/**
 * Refuse to upload when gcloud is pointed somewhere other than the bucket's
 * project.
 *
 * `gcloud storage` authenticates with gcloud's own active credential, not with
 * GOOGLE_APPLICATION_CREDENTIALS — so a stale `gcloud config set project` from
 * some earlier task will silently publish to the wrong project, and the URLs
 * the spectator is configured for will 404 while the bytes sit somewhere else
 * entirely. §17 keeps environments separate precisely so that cannot be
 * confused; a wrong guess here is the kind of cross-project mix-up that
 * document calls Genesis-blocking.
 */
function checkActiveProject() {
  const probe = spawnSync("gcloud", ["config", "get-value", "project"], { encoding: "utf8" });
  if (probe.status !== 0) return;
  const active = probe.stdout.trim();
  // Firebase buckets are named `<project>.firebasestorage.app` or the older
  // `<project>.appspot.com`, so the project is the leading label.
  const bucketProject = bucket.split(".")[0];
  if (active && bucketProject && active !== bucketProject) {
    fail(
      `gcloud is on project "${active}" but the bucket belongs to "${bucketProject}".\n` +
        `       Run: gcloud config set project ${bucketProject}\n` +
        `       Or pass --bucket to target "${active}" deliberately.`,
    );
  }
}

/**
 * Build the content-hashed tree and the manifest that names it.
 *
 * Runs before upload and is pure local work, so `--optimize` alone leaves a
 * manifest that can be reviewed in a diff before anything is published.
 */
function stageAndManifest() {
  rmSync(PUBLISH_DIR, { recursive: true, force: true });
  const assets = {};

  const stageOne = (sourceFile, logicalPath) => {
    const bytes = readFileSync(sourceFile);
    // Eight hex characters: 32 bits over a few dozen files. Long enough that a
    // collision is not a practical concern, short enough to read in a URL.
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    const extension = extname(logicalPath);
    const stem = logicalPath.slice(0, logicalPath.length - extension.length);
    const publishedPath = `${stem}.${hash}${extension}`;
    const target = join(PUBLISH_DIR, publishedPath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(sourceFile, target);
    assets[logicalPath] = publishedPath;
  };

  for (const set of ASSET_SETS) {
    if (Array.isArray(set.files)) {
      for (const file of set.files) {
        const input = join(PUBLIC_DIR, file);
        if (!existsSync(input)) {
          console.log(`  skip ${file} — not present in public/`);
          continue;
        }
        stageOne(input, file);
      }
      continue;
    }
    // Optimised sets stage from the compressed tree; everything else from
    // public/, which is already web-encoded.
    const source = set.optimize ? join(STAGE_DIR, set.dir) : join(PUBLIC_DIR, set.dir);
    if (!existsSync(source)) {
      console.log(`  skip ${set.dir} — nothing to stage (run --optimize first?)`);
      continue;
    }
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
        else stageOne(full, `${prefix}${entry.name}`);
      }
    };
    walk(source, `${set.dir}/`);
  }

  const manifest = {
    // Bumped only by a change to the manifest's own shape, never by content.
    manifestVersion: 1,
    assets: Object.fromEntries(Object.entries(assets).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  const previous = existsSync(MANIFEST_FILE) ? JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) : null;
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);

  const changed = Object.entries(manifest.assets).filter(
    ([logical, published]) => previous?.assets?.[logical] !== published,
  );
  console.log(
    `\n  ${Object.keys(manifest.assets).length} assets staged, ` +
      `${changed.length} changed since the committed manifest`,
  );
  for (const [logical] of changed.slice(0, 10)) console.log(`    changed: ${logical}`);
  if (changed.length > 10) console.log(`    ... and ${changed.length - 10} more`);
  console.log(`  manifest: ${MANIFEST_FILE}\n`);
}

function upload() {
  if (!bucket) {
    fail("no bucket — pass --bucket <name> or set FIREBASE_STORAGE_BUCKET_ID");
  }
  checkActiveProject();
  if (!existsSync(PUBLISH_DIR)) {
    fail("nothing staged — run with --optimize first");
  }
  console.log(`Uploading to gs://${bucket}/spectator/ (${megabytes(directorySize(PUBLISH_DIR))})\n`);
  // No --delete-unmatched-destination-objects: superseded hashes stay served,
  // so a client mid-session on the previous build does not start 404ing, and a
  // rollback is a manifest revert rather than a re-upload.
  const ok = run("gcloud", [
    "storage",
    "rsync",
    PUBLISH_DIR,
    `gs://${bucket}/spectator`,
    "--recursive",
    "--cache-control",
    CACHE_CONTROL,
  ]);
  if (!ok) fail("could not upload the staged tree");

  console.log(
    `\nPublished. Point the spectator at it by setting, in the deployment environment:\n` +
      `\n  NEXT_PUBLIC_ASSET_BASE_URL=https://firebasestorage.googleapis.com/v0/b/${bucket}/o/spectator\n` +
      `\nThat is the Firebase download endpoint, not storage.googleapis.com. Serving\n` +
      `from the plain GCS host would need an IAM grant of allUsers, which this\n` +
      `organisation's Domain Restricted Sharing policy forbids in any bucket. The\n` +
      `Firebase endpoint is governed by storage.rules instead, which opens exactly\n` +
      `spectator/** and denies the rest — narrower than the IAM grant would have been.\n` +
      `\nThose rules must be live for the URLs to resolve. Deploy them with:\n` +
      `\n  node apps/spectator/scripts/deploy-storage-rules.mjs\n` +
      `\nCommit the updated asset manifest: the spectator resolves through it at\n` +
      `build time, so an unpublished manifest and a deployed build disagree.\n`,
  );
}

if (wantOptimize) optimize();
if (wantOptimize || wantUpload) stageAndManifest();
if (wantUpload) upload();
