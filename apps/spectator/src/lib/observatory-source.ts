// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import runFixture from "../fixtures/observatory-run.json";
import { buildReferenceRegistry, resolveReference, searchReferences } from "./reference-registry";
import { buildSceneDescription } from "./scene-adapter";
import type {
  ObservatoryRun,
  ReferenceClass,
  ReferenceRecord,
  SceneDescription,
} from "./observatory-types";
import type { ReferenceRegistry } from "./reference-registry";

const committedRun = runFixture as unknown as ObservatoryRun;
let cachedRun: ObservatoryRun | null = null;

function resolveNodeRuntime(): {
  readFileSync: (path: string, encoding: "utf8") => string;
  existsSync: (path: string) => boolean;
  resolve: (...segments: string[]) => string;
} | null {
  if (typeof window !== "undefined") return null;
  if (typeof globalThis === "undefined") return null;
  if (typeof (globalThis as Record<string, unknown>).process === "undefined") return null;
  const nodeProcess = (globalThis as Record<string, unknown>).process as { versions?: Record<string, string> };
  if (!nodeProcess?.versions?.node) return null;

  try {
    const nodeRequire = Function(
      "return typeof require === 'function' ? require : undefined",
    )() as ((moduleId: string) => unknown) | undefined;
    if (typeof nodeRequire !== "function") return null;

    const fs = nodeRequire("node:fs") as {
      existsSync: (path: string) => boolean;
      readFileSync: (path: string, encoding: "utf8") => string;
    };
    const pathMod = nodeRequire("node:path") as { resolve: (...segments: string[]) => string };
    if (!fs || !pathMod) return null;

    return {
      readFileSync: fs.readFileSync,
      existsSync: fs.existsSync,
      resolve: pathMod.resolve,
    };
  } catch {
    return null;
  }
}

function liveObservatoryPath(runtime: ReturnType<typeof resolveNodeRuntime>): string | null {
  const cwd =
    typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : null;
  if (runtime === null || cwd === null) return null;

  const candidates = [
    runtime.resolve(cwd, ".dev-world", "observatory-run.json"),
    runtime.resolve(cwd, "apps", "spectator", ".dev-world", "observatory-run.json"),
    runtime.resolve(cwd, "apps", "spectator", "src", "fixtures", "observatory-run.json"),
    runtime.resolve(cwd, "src", "fixtures", "observatory-run.json"),
  ];

  if (process.env.NEXT_PUBLIC_DEV_WORLD_CONTROLS === "true") {
    const liveCandidate = candidates.find((candidate) => runtime.existsSync(candidate));
    return liveCandidate ?? null;
  }

  return candidates.slice(2).find((candidate) => runtime.existsSync(candidate)) ?? null;
}

function loadRun(): ObservatoryRun {
  const runtime = resolveNodeRuntime();
  if (runtime === null) {
    return committedRun;
  }

  const worldPath = liveObservatoryPath(runtime);
  if (worldPath === null) return committedRun;

  try {
    const contents = runtime.readFileSync(worldPath, "utf8");
    return JSON.parse(contents) as ObservatoryRun;
  } catch {
    return cachedRun ?? committedRun;
  }
}

function getRunSnapshot(): ObservatoryRun {
  const current = loadRun();
  if (cachedRun !== null && cachedRun.world.chainHead === current.world.chainHead) {
    return cachedRun;
  }
  cachedRun = current;
  return cachedRun;
}

function getRegistry(run: ObservatoryRun): ReferenceRegistry {
  return buildReferenceRegistry(run);
}

function getSceneForRun(run: ObservatoryRun, worldTick?: number): SceneDescription {
  const registry = getRegistry(run);
  return worldTick === undefined
    ? buildSceneDescription(run, registry, run.world.simTime)
    : buildSceneDescription(run, registry, worldTick);
}

export interface ObservatorySource {
  getRun(): ObservatoryRun;
  getScene(worldTick?: number): SceneDescription;
  getReference(refId: string): ReferenceRecord | null;
  getReferences(referenceClass?: ReferenceClass): ReferenceRecord[];
  searchReferences(query: string, limit?: number): ReferenceRecord[];
}

class FixtureObservatorySource implements ObservatorySource {
  getRun(): ObservatoryRun {
    return getRunSnapshot();
  }

  getScene(worldTick?: number): SceneDescription {
    const run = getRunSnapshot();
    return getSceneForRun(run, worldTick);
  }

  getReference(refId: string): ReferenceRecord | null {
    return resolveReference(buildReferenceRegistry(getRunSnapshot()), refId);
  }

  getReferences(referenceClass?: ReferenceClass): ReferenceRecord[] {
    const registry = buildReferenceRegistry(getRunSnapshot());
    return referenceClass === undefined
      ? registry.records
      : registry.records.filter((record) => record.referenceClass === referenceClass);
  }

  searchReferences(query: string, limit?: number): ReferenceRecord[] {
    return searchReferences(getRegistry(getRunSnapshot()), query, limit);
  }
}

export const observatorySource: ObservatorySource = new FixtureObservatorySource();
