import runFixture from "../fixtures/observatory-run.json";
import { buildReferenceRegistry, resolveReference, searchReferences } from "./reference-registry";
import { buildSceneDescription } from "./scene-adapter";
import type {
  ObservatoryRun,
  ReferenceClass,
  ReferenceRecord,
  SceneDescription,
} from "./observatory-types";

const run = runFixture as unknown as ObservatoryRun;
const registry = buildReferenceRegistry(run);
const scene = buildSceneDescription(run, registry);

export interface ObservatorySource {
  getRun(): ObservatoryRun;
  getScene(worldTick?: number): SceneDescription;
  getReference(refId: string): ReferenceRecord | null;
  getReferences(referenceClass?: ReferenceClass): ReferenceRecord[];
  searchReferences(query: string, limit?: number): ReferenceRecord[];
}

class FixtureObservatorySource implements ObservatorySource {
  getRun(): ObservatoryRun {
    return run;
  }

  getScene(worldTick?: number): SceneDescription {
    return worldTick === undefined ? scene : buildSceneDescription(run, registry, worldTick);
  }

  getReference(refId: string): ReferenceRecord | null {
    return resolveReference(registry, refId);
  }

  getReferences(referenceClass?: ReferenceClass): ReferenceRecord[] {
    return referenceClass === undefined
      ? registry.records
      : registry.records.filter((record) => record.referenceClass === referenceClass);
  }

  searchReferences(query: string, limit?: number): ReferenceRecord[] {
    return searchReferences(registry, query, limit);
  }
}

export const observatorySource: ObservatorySource = new FixtureObservatorySource();
