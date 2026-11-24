// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import runFixture from "../fixtures/observatory-run.json";
import { openCamera } from "./camera-director";
import {
  buildReferenceRegistry,
  findReferenceByCanonicalKey,
  resolveReference,
  searchReferences,
} from "./reference-registry";
import { buildSceneDescription } from "./scene-adapter";
import type { ObservatoryRun } from "./observatory-types";

const run = runFixture as unknown as ObservatoryRun;

describe("Observatory reference registry", () => {
  it("allocates deterministic, unique permanent references", () => {
    const first = buildReferenceRegistry(run);
    const second = buildReferenceRegistry(run);
    const firstIds = first.records.map((record) => record.refId);
    const secondIds = second.records.map((record) => record.refId);

    expect(firstIds).toEqual(secondIds);
    expect(new Set(firstIds).size).toBe(firstIds.length);
    expect(firstIds.every((id) => /^AG:W001:[A-Z]{3}:\d{12}$/.test(id))).toBe(true);
  });

  it("keeps identity independent of display names", () => {
    const renamedRun = structuredClone(run);
    renamedRun.inhabitants[0]!.displayName = "A new display name";
    const before = findReferenceByCanonicalKey(
      buildReferenceRegistry(run),
      `inhabitant:${run.inhabitants[0]!.id}`,
    );
    const after = findReferenceByCanonicalKey(
      buildReferenceRegistry(renamedRun),
      `inhabitant:${run.inhabitants[0]!.id}`,
    );

    expect(before?.refId).toBe(after?.refId);
    expect(before?.displayName).not.toBe(after?.displayName);
  });

  it("makes future unknowns inspectable without inventing meaning", () => {
    const registry = buildReferenceRegistry(run, [
      {
        canonicalKey: "future-creation-1",
        canonicalType: "unclassified_canonical_creation",
        firstObservedSequence: 600,
        firstObservedAt: 72000,
        location: { x: 18, y: 1 },
      },
    ]);
    const unknown = findReferenceByCanonicalKey(registry, "unknown:future-creation-1");

    expect(unknown?.referenceClass).toBe("UNK");
    expect(unknown?.displayName).toContain("Unclassified creation");
    expect(unknown?.observatoryMetadata.fallbackLevel).toBe(4);
    expect(unknown?.capabilityManifest.inspect?.available).toBe(true);
  });

  it("resolves exact reference searches to one record", () => {
    const registry = buildReferenceRegistry(run);
    const entity = findReferenceByCanonicalKey(registry, "inhabitant:inh_founder");
    expect(entity).not.toBeNull();
    expect(searchReferences(registry, entity!.refId)).toEqual([entity]);
    expect(resolveReference(registry, entity!.refId)).toEqual(entity);
  });

  it("gives every visible inhabitant a scene reference and read-only camera", () => {
    const registry = buildReferenceRegistry(run);
    const scene = buildSceneDescription(run, registry);
    const entityRecords = registry.records.filter((record) => record.referenceClass === "ENT");
    const visibleIds = new Set(scene.references.map((reference) => reference.refId));
    expect(entityRecords.every((record) => visibleIds.has(record.refId))).toBe(true);

    const target = entityRecords[0]!;
    const sceneTarget = scene.references.find((reference) => reference.refId === target.refId)!;
    const view = openCamera(
      {
        targetRef: target.refId,
        mode: "THIRD_PERSON_FOLLOW",
        worldTick: null,
        relatedEventRef: null,
      },
      target,
      sceneTarget.cameraAnchors,
    );
    expect(view.readOnly).toBe(true);
    expect(view.resolvedMode).toBe("THIRD_PERSON_FOLLOW");
  });

  it("withholds private contents while retaining historical references", () => {
    const registry = buildReferenceRegistry(run);
    const withheld = registry.records.find(
      (record) =>
        record.referenceClass === "EVT" && record.canonicalType === "withheld_event",
    );
    expect(withheld).toBeDefined();
    expect(withheld?.canonicalMetadata.detail).toBeNull();
    expect(withheld?.capabilityManifest.replay?.available).toBe(true);
  });

  it("makes every canonical event playable without violating visibility", () => {
    const registry = buildReferenceRegistry(run);
    const events = registry.records.filter((record) => record.referenceClass === "EVT");
    expect(events).toHaveLength(run.events.length);
    expect(events.every((record) => record.capabilityManifest.replay?.available)).toBe(true);
  });
});
