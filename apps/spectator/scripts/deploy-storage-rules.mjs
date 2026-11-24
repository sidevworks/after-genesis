#!/usr/bin/env node
// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Deploy `storage.rules` to Firebase Storage.
 *
 * ## Why this exists rather than `firebase deploy --only storage`
 *
 * The Firebase CLI authenticates through its own interactive OAuth flow and
 * does not accept the credentials this project already has available. Rules
 * deployment is two ordinary REST calls against `firebaserules.googleapis.com`,
 * so it is done directly with a gcloud access token: create an immutable
 * ruleset, then repoint the bucket's release at it.
 *
 * ## Why rules and not IAM
 *
 * The obvious way to serve public assets — granting `allUsers` the object
 * viewer role — is unavailable. This organisation enforces Domain Restricted
 * Sharing (`constraints/iam.allowedPolicyMemberDomains`), which rejects that
 * member in any IAM policy, in any bucket, in any project it owns.
 *
 * Security Rules are not IAM and are not constrained by that policy. They are
 * also a better fit: rules scope by path prefix, so `spectator/**` can be
 * public while everything else in the same bucket stays denied. A bucket-level
 * IAM grant has no such scoping — it would have made every future object
 * public the moment it landed, including anything the media service writes.
 *
 * Rules govern `firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>?alt=media`.
 * They do not govern `storage.googleapis.com/<bucket>/<path>`, which remains
 * IAM-controlled and therefore remains private. That asymmetry is deliberate
 * and is why `assetUrl` emits the Firebase form.
 *
 * Usage:
 *   node apps/spectator/scripts/deploy-storage-rules.mjs [--project <id>] [--dry-run]
 *
 * Requires an active gcloud credential with `firebaserules.admin` on the
 * project. Reads the bucket from $FIREBASE_STORAGE_BUCKET_ID.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RULES_FILE = resolve(REPO_ROOT, "storage.rules");

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const projectFlag = argv.indexOf("--project");

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function gcloud(args) {
  const result = spawnSync("gcloud", args, { encoding: "utf8" });
  if (result.status !== 0) fail(`gcloud ${args.join(" ")} failed: ${result.stderr?.trim()}`);
  return result.stdout.trim();
}

const project =
  projectFlag === -1 ? gcloud(["config", "get-value", "project"]) : argv[projectFlag + 1];
if (!project) fail("no project — pass --project <id> or set one with gcloud config");

const bucket = process.env.FIREBASE_STORAGE_BUCKET_ID?.trim()
  .replace(/^gs:\/\//, "")
  .replace(/\/+$/, "");
if (!bucket) fail("no bucket — set FIREBASE_STORAGE_BUCKET_ID");

// The bucket names its own project. Deploying rules for a bucket in a
// different project than the active credential is always a mistake, and a
// quiet one: the call succeeds against whichever project was configured.
const bucketProject = bucket.split(".")[0];
if (bucketProject !== project) {
  fail(
    `gcloud is on project "${project}" but the bucket belongs to "${bucketProject}".\n` +
      `       Run: gcloud config set project ${bucketProject}`,
  );
}

const content = readFileSync(RULES_FILE, "utf8");
const token = gcloud(["auth", "print-access-token"]);
// The release id contains a literal `/`. It is a path separator in the REST
// route, not an opaque identifier, so it must not be percent-encoded.
const releaseId = `firebase.storage/${bucket}`;

async function api(path, body, method = "GET") {
  const response = await fetch(`https://firebaserules.googleapis.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      // Application Default Credentials carry no quota project of their own;
      // without this header the API rejects the call as unattributable.
      "x-goog-user-project": project,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) fail(`${method} ${path} → ${response.status}: ${await response.text()}`);
  return response.json();
}

console.log(`Deploying ${RULES_FILE}\n  project: ${project}\n  bucket:  ${bucket}\n`);
if (dryRun) {
  const current = await api(`projects/${project}/releases/${releaseId}`);
  console.log(`  would replace ruleset: ${current.rulesetName}`);
  console.log(`\n${content}`);
  process.exit(0);
}

// Rulesets are immutable; publishing is repointing the release at a new one.
// The old ruleset stays retrievable, so a rules change is itself auditable.
const ruleset = await api(
  `projects/${project}/rulesets`,
  { source: { files: [{ name: "storage.rules", content }] } },
  "POST",
);
console.log(`  created ruleset: ${ruleset.name}`);

const release = await api(
  `projects/${project}/releases/${releaseId}`,
  {
    release: {
      name: `projects/${project}/releases/${releaseId}`,
      rulesetName: ruleset.name,
    },
  },
  "PATCH",
);
console.log(`  release now serves: ${release.rulesetName}\n`);
console.log("Live. Verify the boundary holds in both directions:\n");
console.log(
  `  curl -o /dev/null -w '%{http_code}\\n' \\\n` +
    `    'https://firebasestorage.googleapis.com/v0/b/${bucket}/o/spectator%2Fcharacter-models%2FAlpha.glb?alt=media'\n` +
    `  # expect 200, and 403 for any path outside spectator/\n`,
);
