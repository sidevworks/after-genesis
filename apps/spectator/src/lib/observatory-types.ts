export const REFERENCE_CLASSES = [
  "ENT",
  "OBJ",
  "LOC",
  "ENV",
  "EVT",
  "ACT",
  "SEQ",
  "REC",
  "REL",
  "ASM",
  "PRC",
  "UNK",
  "ABS",
] as const;

export type ReferenceClass = (typeof REFERENCE_CLASSES)[number];
export type ReferenceId = `AG:${string}:${ReferenceClass}:${string}`;
export type ReferenceStatus =
  | "active"
  | "inactive"
  | "destroyed"
  | "consumed"
  | "dispersed"
  | "unknown";

export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface Rotation {
  x: number;
  y: number;
  z: number;
  w: number;
}

export type CapabilityName =
  | "inspect"
  | "locate"
  | "view"
  | "orbit"
  | "track"
  | "follow"
  | "enter"
  | "listen"
  | "replay"
  | "read"
  | "inspect_components"
  | "inspect_provenance"
  | "inspect_history"
  | "inspect_relationships"
  | "compare"
  | "view_creator"
  | "view_creation_process"
  | "view_current_state"
  | "view_last_known_state"
  | "view_site"
  | "view_route"
  | "hear_conversation"
  | "hear_available_thought_record"
  | "watch_action"
  | "watch_sequence";

export interface Capability {
  available: boolean;
  reason?: string;
  targetRef?: ReferenceId;
  locationRef?: ReferenceId;
  modes?: CameraMode[];
  sources?: AudioSource[];
  live?: boolean;
}

export type CapabilityManifest = Partial<Record<CapabilityName, Capability>>;

export type AudioSource =
  | "CANONICAL_AUDIO"
  | "DETERMINISTIC_VOICE_RENDER"
  | "NARRATED_SUMMARY"
  | "THOUGHT_RECORD"
  | "UNAVAILABLE";

export interface CameraAnchor {
  anchorId: string;
  targetRef: ReferenceId;
  anchorType: "point" | "transform" | "bounds" | "path" | "volume";
  position: Position;
  orientation: Rotation;
  bounds: { width: number; height: number; depth: number } | null;
  preferredDistance: number;
  preferredHeight: number;
  occlusionPolicy: "avoid" | "allow";
  generated: boolean;
}

export type CameraMode =
  | "WORLD"
  | "LOCATE"
  | "INSPECT"
  | "ORBIT"
  | "THIRD_PERSON_FOLLOW"
  | "WIDE_FOLLOW"
  | "OVERHEAD_FOLLOW"
  | "PATH_REPLAY"
  | "SITE_VIEW"
  | "CREATION_REPLAY"
  | "INTERIOR_VIEW"
  | "CONVERSATION_VIEW"
  | "FALLBACK_REFERENCE_VIEW";

export interface OpenCameraRequest {
  targetRef: ReferenceId;
  mode: CameraMode;
  worldTick: number | null;
  relatedEventRef: ReferenceId | null;
}

export interface ReferenceRecord {
  refId: ReferenceId;
  worldId: string;
  referenceClass: ReferenceClass;
  canonicalType: string;
  displayName: string;
  createdByEventRef: ReferenceId | null;
  firstObservedAt: {
    worldTick: number;
    worldDay: number;
    canonicalTimestamp: string | null;
  };
  currentStateRef: ReferenceId | null;
  status: ReferenceStatus;
  spatial: {
    position: Position | null;
    orientation: Rotation | null;
    bounds: { width: number; height: number; depth: number } | null;
    locationRef: ReferenceId | null;
  };
  composition: {
    componentRefs: ReferenceId[];
    materialRefs: ReferenceId[];
  };
  provenance: {
    creatorRefs: ReferenceId[];
    contributorRefs: ReferenceId[];
    sourceRefs: ReferenceId[];
    parentRefs: ReferenceId[];
  };
  relatedRefs: ReferenceId[];
  capabilityManifest: CapabilityManifest;
  canonicalMetadata: Record<string, unknown>;
  observatoryMetadata: {
    visualSeed: string;
    rendererVersion: string;
    searchTerms: string[];
    derivedSummary?: string;
    derivedSummaryLabel?: "OBSERVATORY_SUMMARY";
    fallbackLevel: 1 | 2 | 3 | 4 | 5;
  };
  schemaVersion: 1;
}

export type RelationKind =
  | "CREATED_BY"
  | "CONTRIBUTED_TO_BY"
  | "COMPOSED_OF"
  | "DERIVED_FROM"
  | "MODIFIED_BY"
  | "LOCATED_AT"
  | "MOVED_BY"
  | "OBSERVED_BY"
  | "DISCUSSED_IN"
  | "CLAIMED_AS"
  | "DAMAGED_BY"
  | "REPAIRED_BY"
  | "REPLACED_BY"
  | "DIVIDED_INTO"
  | "COMBINED_INTO"
  | "ACTED_BY"
  | "RECORDED_AS";

export interface ReferenceRelation {
  refId: ReferenceId;
  kind: RelationKind;
  fromRef: ReferenceId;
  toRef: ReferenceId;
  eventRef: ReferenceId | null;
  canonical: true;
}

export type GeometryPrimitive =
  | "point"
  | "line"
  | "path"
  | "surface"
  | "volume"
  | "voxel"
  | "mesh"
  | "assembly"
  | "particle_field"
  | "unknown_bounded_geometry"
  | "articulated_entity"
  | "constructed_structure"
  | "reference_marker"
  | (string & {});

export interface SceneReference {
  refId: ReferenceId;
  transform: { position: Position; rotation: Rotation };
  representation: {
    kind: GeometryPrimitive;
    visualSeed: string;
    componentRefs: ReferenceId[];
    material: string | null;
  };
  activity: {
    actionRef: ReferenceId;
    primitive: string;
    targetRefs: ReferenceId[];
    progress: number | null;
  } | null;
  cameraAnchors: CameraAnchor[];
  capabilities: CapabilityManifest;
  epistemicLabel: "CANONICAL_FACT" | "CANONICAL_RECORD_WITHHELD" | "OBSERVATORY_DERIVATION";
}

export interface SceneDescription {
  sceneVersion: 1;
  rendererVersion: string;
  worldId: string;
  worldTick: number;
  bounds: { width: number; height: number };
  references: SceneReference[];
}

/**
 * A physically observable activity envelope (disclosure policy 2).
 *
 * The envelope is always disclosed: an inhabitant occupying a tile for a
 * measurable period is directly observable (claude.md §11E). `contentsDisclosed`
 * says whether the originating canonical event also disclosed *what happened* —
 * when it is false, the Observatory must render the occupied time honestly and
 * invent nothing about it.
 */
export interface ActivityEnvelope {
  id: string;
  sequence: number;
  actionType: string;
  activityState: string;
  participants: string[];
  location: { x: number; y: number };
  startedAt: number;
  endsAt: number;
  interruption: string;
  open: boolean;
  contentsDisclosed: boolean;
}

export interface ObservatoryRun {
  exportVersion: number;
  disclosurePolicy: string;
  disclosure?: {
    policyVersion: number;
    envelope: string;
    contents: string;
  };
  activities?: ActivityEnvelope[];
  world: {
    id: string;
    seed: string;
    schemaVersion: number;
    simTime: number;
    sequence: number;
    checksum: string;
    chainHead: string;
  };
  map: { width: number; height: number; terrain: string[] };
  inhabitants: Array<{
    id: string;
    displayName: string;
    generation: number;
    creationSequence: number;
    birthTime: number;
    location: { x: number; y: number };
    status: string;
    activity: { state: string; activityId: string | null; busyUntil: number };
    /** Canonical voice handle (`voice_f04`), resolved to a provider voice by the media layer. */
    voiceId: string;
    /** Voice class. Optional only because older exported fixtures predate it. */
    sex?: "male" | "female";
    /** Developmental stage (§11B). Selects the child voice while low. */
    maturity?: number;
  }>;
  structures: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  events: Array<{
    sequence: number;
    simTime: number;
    realTimestamp: string;
    canonicalType: string;
    actorId: string | null;
    visibility: string;
    location: { x: number; y: number } | null;
    outcomeStatus: string | null;
    detail: Record<string, unknown> | null;
    hash: string;
    prevHash: string;
  }>;
}
