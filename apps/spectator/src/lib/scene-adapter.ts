import type {
  CameraAnchor,
  ObservatoryRun,
  ReferenceRecord,
  SceneDescription,
  SceneReference,
} from "./observatory-types";
import type { ReferenceRegistry } from "./reference-registry";

const ZERO_ROTATION = { x: 0, y: 0, z: 0, w: 1 } as const;

function anchorFor(record: ReferenceRecord): CameraAnchor[] {
  const position = record.spatial.position;
  if (!position) return [];
  return [
    {
      anchorId: "primary",
      targetRef: record.refId,
      anchorType: record.spatial.bounds ? "bounds" : "point",
      position,
      orientation: record.spatial.orientation ?? ZERO_ROTATION,
      bounds: record.spatial.bounds,
      preferredDistance: record.referenceClass === "LOC" ? 8 : 4.5,
      preferredHeight: record.referenceClass === "ENT" ? 1.8 : 3,
      occlusionPolicy: "avoid",
      generated: true,
    },
  ];
}

function representationFor(record: ReferenceRecord): SceneReference["representation"] {
  const terrain =
    typeof record.canonicalMetadata.terrain === "string"
      ? record.canonicalMetadata.terrain
      : null;
  if (record.referenceClass === "LOC") {
    return {
      kind: "surface",
      visualSeed: record.observatoryMetadata.visualSeed,
      componentRefs: [],
      material: terrain,
    };
  }
  if (record.referenceClass === "ENT") {
    return {
      kind: "articulated_entity",
      visualSeed: record.observatoryMetadata.visualSeed,
      componentRefs: record.composition.componentRefs,
      material: null,
    };
  }
  if (record.referenceClass === "OBJ") {
    return {
      kind: "constructed_structure",
      visualSeed: record.observatoryMetadata.visualSeed,
      componentRefs: record.composition.componentRefs,
      material: String(record.canonicalMetadata.kind ?? "structure"),
    };
  }
  if (record.referenceClass === "ASM") {
    return {
      kind: "reference_marker",
      visualSeed: record.observatoryMetadata.visualSeed,
      componentRefs: record.composition.componentRefs,
      material: String(record.canonicalMetadata.kind ?? "artifact"),
    };
  }
  return {
    kind: "reference_marker",
    visualSeed: record.observatoryMetadata.visualSeed,
    componentRefs: record.composition.componentRefs,
    material: null,
  };
}

export function buildSceneDescription(
  run: ObservatoryRun,
  registry: ReferenceRegistry,
  worldTick = run.world.simTime,
): SceneDescription {
  const spatialClasses = new Set(["LOC", "ENT", "OBJ", "ASM", "ENV", "UNK"]);
  const references = registry.records
    .filter(
      (record) =>
        spatialClasses.has(record.referenceClass) &&
        record.spatial.position !== null &&
        record.firstObservedAt.worldTick <= worldTick,
    )
    .map((record): SceneReference => {
      const currentAction = record.canonicalMetadata.currentActionRef;
      return {
        refId: record.refId,
        transform: {
          position: record.spatial.position ?? { x: 0, y: 0, z: 0 },
          rotation: record.spatial.orientation ?? ZERO_ROTATION,
        },
        representation: representationFor(record),
        activity:
          typeof currentAction === "string"
            ? {
                actionRef: currentAction as SceneReference["refId"],
                primitive: String(record.canonicalMetadata.activityState ?? "unknown"),
                targetRefs: [],
                progress: null,
              }
            : null,
        cameraAnchors: anchorFor(record),
        capabilities: record.capabilityManifest,
        epistemicLabel: "CANONICAL_FACT",
      };
    });

  return {
    sceneVersion: 1,
    rendererVersion: "observatory-web-v1",
    worldId: registry.worldId,
    worldTick,
    bounds: { width: run.map.width, height: run.map.height },
    references,
  };
}
