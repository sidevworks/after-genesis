// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Where the development world publishes, and where the spectator reads it.
 *
 * The dev controller drives a throwaway world: resetting it erases every event,
 * every state snapshot and the whole model audit, which is the point — a run
 * started after a rule change must not inherit anything the previous run knew.
 *
 * That erasure must not reach the committed fixtures. `src/fixtures/world.json`
 * and `src/fixtures/observatory-run.json` are published demo data: the public
 * pages render them and the test suite asserts against them. A dev reset that
 * overwrote them replaced a 338-event demo with a 1-event world and broke CI,
 * twice. So the dev world writes to an untracked directory instead.
 *
 * The resolvers below prefer that directory when it exists and fall back to the
 * committed fixture when it does not, so a fresh checkout with no dev world
 * still renders the demo.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Untracked. See .gitignore — nothing here is canonical or committed. */
export const DEV_WORLD_DIR = ".dev-world";

const COMMITTED_WORLD = "src/fixtures/pre-genesis.json";
const COMMITTED_OBSERVATORY = "src/fixtures/pre-genesis-run.json";

/**
 * Next, Vitest and the dev controller run from different working directories,
 * so every path is tried from the app root and from the repository root.
 */
function candidates(...segments: string[]): string[] {
  return [
    resolve(process.cwd(), ...segments),
    resolve(process.cwd(), "apps", "spectator", ...segments),
  ];
}

function firstExisting(paths: string[]): string | null {
  return paths.find((path) => existsSync(path)) ?? null;
}

function preferDevWorld(devFile: string, committedFile: string): string {
  const live = firstExisting(candidates(DEV_WORLD_DIR, devFile));
  if (live !== null) return live;

  const committed = firstExisting(candidates(committedFile));
  if (committed !== null) return committed;

  // Nothing on disk yet. Name the committed location so the caller's read
  // fails against the path a reader would expect, not against a temp dir.
  return resolve(process.cwd(), "apps", "spectator", committedFile);
}

/** The world snapshot the Events, Inhabitants and Economy views read. */
export function liveWorldPath(): string {
  return preferDevWorld("world.json", COMMITTED_WORLD);
}

/** The camera-tracked run the Watch and Observatory views read. */
export function liveObservatoryPath(): string {
  return preferDevWorld("observatory-run.json", COMMITTED_OBSERVATORY);
}
