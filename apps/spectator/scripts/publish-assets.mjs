#!/usr/bin/env node
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
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPECTATOR_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(SPECTATOR_ROOT, "public");
/** Optimised output. Regenerable from the masters, so it is never committed. */
const STAGE_DIR = join(SPECTATOR_ROOT, ".assets-dist");

/**
 * What gets published, and how each kind is cached.
 *
 * Every asset here is content-addressed by hand: a model or a film is replaced
 * by publishing a new name, never by mutating one in place. That makes a long
 * immutable cache correct rather than merely convenient.
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

function upload() {
  if (!bucket) {
    fail("no bucket — pass --bucket <name> or set FIREBASE_STORAGE_BUCKET_ID");
  }
  console.log(`Uploading to gs://${bucket}/spectator/\n`);
  for (const set of ASSET_SETS) {
    // Optimised sets publish from the staging tree; everything else publishes
    // the file as it sits in public/, which is already web-encoded.
    const source = set.optimize ? join(STAGE_DIR, set.dir) : join(PUBLIC_DIR, set.dir);
    const isLooseFiles = Array.isArray(set.files);
    if (isLooseFiles) {
      for (const file of set.files) {
        const input = join(PUBLIC_DIR, file);
        if (!existsSync(input)) {
          console.log(`  skip ${file} — not present in public/`);
          continue;
        }
        const ok = run("gcloud", [
          "storage",
          "cp",
          input,
          `gs://${bucket}/spectator/${file}`,
          "--cache-control",
          CACHE_CONTROL,
        ]);
        if (!ok) fail(`could not upload ${file}`);
      }
      continue;
    }
    if (!existsSync(source)) {
      console.log(`  skip ${set.dir} — nothing staged (run --optimize first?)`);
      continue;
    }
    console.log(`  ${set.dir} (${megabytes(directorySize(source))})`);
    const ok = run("gcloud", [
      "storage",
      "rsync",
      source,
      `gs://${bucket}/spectator/${set.dir}`,
      "--recursive",
      "--cache-control",
      CACHE_CONTROL,
    ]);
    if (!ok) fail(`could not upload ${set.dir}`);
  }
  console.log(
    `\nPublished. Point the spectator at it by setting, in the deployment environment:\n` +
      `\n  NEXT_PUBLIC_ASSET_BASE_URL=https://storage.googleapis.com/${bucket}/spectator\n` +
      `\nLeft unset, the app keeps loading these paths from public/, which is what a\n` +
      `local checkout with the masters in place already does.\n`,
  );
}

if (wantOptimize) optimize();
if (wantUpload) upload();
