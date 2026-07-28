import type {
  CapabilityManifest,
  ObservatoryRun,
  ReferenceClass,
  ReferenceId,
  ReferenceRecord,
  ReferenceRelation,
  RelationKind,
} from "./observatory-types";

const OBSERVATORY_WORLD_ID = "W001";
const RENDERER_VERSION = "observatory-web-v1";

export interface AdditionalReference {
  canonicalKey: string;
  canonicalType: string;
  displayName?: string;
  firstObservedSequence: number;
  firstObservedAt: number;
  location?: { x: number; y: number };
}

export interface ReferenceRegistry {
  worldId: string;
  canonicalWorldId: string;
  records: ReferenceRecord[];
  relations: ReferenceRelation[];
  byRefId: ReadonlyMap<ReferenceId, ReferenceRecord>;
  byCanonicalKey: ReadonlyMap<string, ReferenceId>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatReferenceId(referenceClass: ReferenceClass, numericId: number): ReferenceId {
  return `AG:${OBSERVATORY_WORLD_ID}:${referenceClass}:${String(numericId).padStart(12, "0")}`;
}

function stableVisualSeed(refId: ReferenceId): string {
  const input = `${OBSERVATORY_WORLD_ID}:${refId}:${RENDERER_VERSION}`;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function worldDay(simTime: number): number {
  return Math.floor(simTime / 1440) + 1;
}

function capabilitiesFor(
  referenceClass: ReferenceClass,
  hasLocation: boolean,
  isMoving: boolean,
  isWithheld: boolean,
): CapabilityManifest {
  const capabilities: CapabilityManifest = {
    inspect: { available: true },
    inspect_history: { available: true },
  };

  if (hasLocation) {
    capabilities.locate = { available: true };
    capabilities.view = { available: true, modes: ["LOCATE", "INSPECT", "SITE_VIEW"] };
    capabilities.view_site = { available: true };
  }

  if (referenceClass === "ENT") {
    capabilities.view = {
      available: true,
      modes: ["INSPECT", "THIRD_PERSON_FOLLOW", "WIDE_FOLLOW", "OVERHEAD_FOLLOW"],
    };
    capabilities.track = {
      available: true,
      modes: ["THIRD_PERSON_FOLLOW", "WIDE_FOLLOW", "OVERHEAD_FOLLOW"],
    };
    capabilities.follow = {
      available: true,
      modes: isMoving
        ? ["THIRD_PERSON_FOLLOW", "WIDE_FOLLOW", "OVERHEAD_FOLLOW"]
        : ["WIDE_FOLLOW", "OVERHEAD_FOLLOW"],
    };
    capabilities.inspect_relationships = { available: true };
    capabilities.view_current_state = { available: true };
  }

  if (referenceClass === "EVT") {
    capabilities.replay = isWithheld
      ? { available: false, reason: "Canonical visibility withholds this event's contents." }
      : { available: true, modes: ["PATH_REPLAY", "SITE_VIEW"] };
  }

  if (referenceClass === "ACT") {
    capabilities.watch_action = isWithheld
      ? { available: false, reason: "Canonical visibility withholds this action's contents." }
      : { available: true, modes: ["PATH_REPLAY", "SITE_VIEW"] };
    capabilities.replay = capabilities.watch_action;
  }

  if (referenceClass === "OBJ" || referenceClass === "ASM") {
    capabilities.orbit = { available: true, modes: ["ORBIT"] };
    capabilities.inspect_components = { available: true };
    capabilities.inspect_provenance = { available: true };
  }

  if (referenceClass === "UNK") {
    capabilities.view = {
      available: true,
      modes: hasLocation ? ["FALLBACK_REFERENCE_VIEW", "LOCATE"] : ["FALLBACK_REFERENCE_VIEW"],
    };
  }

  return capabilities;
}

function baseRecord(options: {
  refId: ReferenceId;
  referenceClass: ReferenceClass;
  canonicalType: string;
  displayName: string;
  simTime: number;
  canonicalTimestamp?: string | null;
  createdByEventRef?: ReferenceId | null;
  position?: { x: number; y: number } | null;
  locationRef?: ReferenceId | null;
  status?: ReferenceRecord["status"];
  canonicalMetadata?: Record<string, unknown>;
  fallbackLevel?: 1 | 2 | 3 | 4 | 5;
  isMoving?: boolean;
  isWithheld?: boolean;
}): ReferenceRecord {
  const position = options.position
    ? { x: options.position.x, y: 0, z: options.position.y }
    : null;
  return {
    refId: options.refId,
    worldId: OBSERVATORY_WORLD_ID,
    referenceClass: options.referenceClass,
    canonicalType: options.canonicalType,
    displayName: options.displayName,
    createdByEventRef: options.createdByEventRef ?? null,
    firstObservedAt: {
      worldTick: options.simTime,
      worldDay: worldDay(options.simTime),
      canonicalTimestamp: options.canonicalTimestamp ?? null,
    },
    currentStateRef: null,
    status: options.status ?? "active",
    spatial: {
      position,
      orientation: position ? { x: 0, y: 0, z: 0, w: 1 } : null,
      bounds: null,
      locationRef: options.locationRef ?? null,
    },
    composition: { componentRefs: [], materialRefs: [] },
    provenance: { creatorRefs: [], contributorRefs: [], sourceRefs: [], parentRefs: [] },
    relatedRefs: [],
    capabilityManifest: capabilitiesFor(
      options.referenceClass,
      position !== null,
      options.isMoving ?? false,
      options.isWithheld ?? false,
    ),
    canonicalMetadata: options.canonicalMetadata ?? {},
    observatoryMetadata: {
      visualSeed: stableVisualSeed(options.refId),
      rendererVersion: RENDERER_VERSION,
      searchTerms: [options.displayName, options.canonicalType, options.refId],
      fallbackLevel: options.fallbackLevel ?? (position ? 4 : 5),
    },
    schemaVersion: 1,
  };
}

export function buildReferenceRegistry(
  run: ObservatoryRun,
  additionalReferences: AdditionalReference[] = [],
): ReferenceRegistry {
  const records: ReferenceRecord[] = [];
  const relations: ReferenceRelation[] = [];
  const byCanonicalKey = new Map<string, ReferenceId>();
  const locationByCoordinate = new Map<string, ReferenceId>();
  const entityByCanonicalId = new Map<string, ReferenceId>();
  const eventBySequence = new Map<number, ReferenceId>();
  const actionBySequence = new Map<number, ReferenceId>();

  for (let y = 0; y < run.map.height; y += 1) {
    for (let x = 0; x < run.map.width; x += 1) {
      const numericId = y * run.map.width + x + 1;
      const refId = formatReferenceId("LOC", numericId);
      const terrain = run.map.terrain[numericId - 1] ?? "unknown";
      const key = `location:${x},${y}`;
      locationByCoordinate.set(`${x},${y}`, refId);
      byCanonicalKey.set(key, refId);
      records.push(
        baseRecord({
          refId,
          referenceClass: "LOC",
          canonicalType: "spatial_tile",
          displayName: `Location ${x}, ${y}`,
          simTime: 0,
          position: { x, y },
          canonicalMetadata: { x, y, terrain },
          fallbackLevel: 1,
        }),
      );
    }
  }

  const sortedEvents = [...run.events].sort((left, right) => left.sequence - right.sequence);
  for (const event of sortedEvents) {
    const eventRef = formatReferenceId("EVT", event.sequence + 1);
    const eventLocation = event.location
      ? locationByCoordinate.get(`${event.location.x},${event.location.y}`) ?? null
      : null;
    const withheld = event.canonicalType === "withheld_event";
    eventBySequence.set(event.sequence, eventRef);
    byCanonicalKey.set(`event:${event.sequence}`, eventRef);
    records.push(
      baseRecord({
        refId: eventRef,
        referenceClass: "EVT",
        canonicalType: event.canonicalType,
        displayName: withheld ? `Withheld event ${event.sequence}` : event.canonicalType,
        simTime: event.simTime,
        canonicalTimestamp: event.realTimestamp,
        position: event.location,
        locationRef: eventLocation,
        canonicalMetadata: {
          sequence: event.sequence,
          visibility: event.visibility,
          outcomeStatus: event.outcomeStatus,
          detail: event.detail,
          hash: event.hash,
          prevHash: event.prevHash,
          disclosure: withheld ? "Contents withheld by canonical visibility." : "Canonical record.",
        },
        isWithheld: withheld,
      }),
    );

    if (event.sequence > 0) {
      const actionRef = formatReferenceId("ACT", event.sequence);
      actionBySequence.set(event.sequence, actionRef);
      byCanonicalKey.set(`action:${event.sequence}`, actionRef);
      records.push(
        baseRecord({
          refId: actionRef,
          referenceClass: "ACT",
          canonicalType: withheld ? "withheld_action" : event.canonicalType.replace(/^action\./, ""),
          displayName: withheld
            ? `Withheld action ${event.sequence}`
            : `${event.canonicalType.replace(/^action\./, "")} · action ${event.sequence}`,
          simTime: event.simTime,
          canonicalTimestamp: event.realTimestamp,
          createdByEventRef: eventRef,
          position: event.location,
          locationRef: eventLocation,
          canonicalMetadata: {
            sequence: event.sequence,
            visibility: event.visibility,
            outcomeStatus: event.outcomeStatus,
            detail: event.detail,
            disclosure: withheld ? "Contents withheld by canonical visibility." : "Canonical record.",
          },
          isWithheld: withheld,
        }),
      );
    }
  }

  const sortedInhabitants = [...run.inhabitants].sort(
    (left, right) =>
      left.creationSequence - right.creationSequence || compareText(left.id, right.id),
  );
  for (const [index, inhabitant] of sortedInhabitants.entries()) {
    const refId = formatReferenceId("ENT", index + 1);
    const locationRef =
      locationByCoordinate.get(`${inhabitant.location.x},${inhabitant.location.y}`) ?? null;
    const createdByEventRef = eventBySequence.get(inhabitant.creationSequence) ?? null;
    entityByCanonicalId.set(inhabitant.id, refId);
    byCanonicalKey.set(`inhabitant:${inhabitant.id}`, refId);
    records.push(
      baseRecord({
        refId,
        referenceClass: "ENT",
        canonicalType: "autonomous_inhabitant",
        displayName: inhabitant.displayName,
        simTime: inhabitant.birthTime,
        createdByEventRef,
        position: inhabitant.location,
        locationRef,
        status: inhabitant.status === "alive" ? "active" : "inactive",
        canonicalMetadata: {
          canonicalId: inhabitant.id,
          generation: inhabitant.generation,
          status: inhabitant.status,
          activityState: inhabitant.activity.state,
          currentActionRef:
            inhabitant.activity.activityId === null
              ? null
              : actionBySequence.get(run.world.sequence) ?? null,
          voiceReference: {
            source: "DETERMINISTIC_VOICE_RENDER",
            canonicalVoiceId: inhabitant.voiceId,
            live: false,
          },
        },
        isMoving: inhabitant.activity.state === "travelling",
        fallbackLevel: 2,
      }),
    );
  }

  const sortedUnknowns = [...additionalReferences].sort(
    (left, right) =>
      left.firstObservedSequence - right.firstObservedSequence ||
      compareText(left.canonicalKey, right.canonicalKey),
  );
  for (const [index, unknown] of sortedUnknowns.entries()) {
    const refId = formatReferenceId("UNK", index + 1);
    const locationRef = unknown.location
      ? locationByCoordinate.get(`${unknown.location.x},${unknown.location.y}`) ?? null
      : null;
    byCanonicalKey.set(`unknown:${unknown.canonicalKey}`, refId);
    records.push(
      baseRecord({
        refId,
        referenceClass: "UNK",
        canonicalType: unknown.canonicalType,
        displayName: unknown.displayName ?? `Unclassified creation · ${refId}`,
        simTime: unknown.firstObservedAt,
        createdByEventRef: eventBySequence.get(unknown.firstObservedSequence) ?? null,
        position: unknown.location ?? null,
        locationRef,
        canonicalMetadata: { canonicalKey: unknown.canonicalKey },
        fallbackLevel: unknown.location ? 4 : 5,
      }),
    );
  }

  let relationCounter = 0;
  const addRelation = (
    kind: RelationKind,
    fromRef: ReferenceId,
    toRef: ReferenceId,
    eventRef: ReferenceId | null,
  ) => {
    relationCounter += 1;
    const refId = formatReferenceId("REL", relationCounter);
    const relation: ReferenceRelation = {
      refId,
      kind,
      fromRef,
      toRef,
      eventRef,
      canonical: true,
    };
    relations.push(relation);
    byCanonicalKey.set(`relation:${relationCounter}`, refId);
    records.push(
      baseRecord({
        refId,
        referenceClass: "REL",
        canonicalType: kind.toLowerCase(),
        displayName: kind.replaceAll("_", " ").toLowerCase(),
        simTime: 0,
        canonicalMetadata: relation as unknown as Record<string, unknown>,
      }),
    );
  };

  for (const inhabitant of sortedInhabitants) {
    const entityRef = entityByCanonicalId.get(inhabitant.id);
    const locationRef = locationByCoordinate.get(
      `${inhabitant.location.x},${inhabitant.location.y}`,
    );
    if (entityRef && locationRef) addRelation("LOCATED_AT", entityRef, locationRef, null);
  }

  for (const event of sortedEvents) {
    if (event.actorId === null) continue;
    const actorRef = entityByCanonicalId.get(event.actorId);
    const actionRef = actionBySequence.get(event.sequence);
    const eventRef = eventBySequence.get(event.sequence) ?? null;
    if (actorRef && actionRef) addRelation("ACTED_BY", actionRef, actorRef, eventRef);
  }

  const byRefId = new Map(records.map((record) => [record.refId, record] as const));
  for (const relation of relations) {
    const from = byRefId.get(relation.fromRef);
    const to = byRefId.get(relation.toRef);
    if (from && !from.relatedRefs.includes(relation.toRef)) from.relatedRefs.push(relation.toRef);
    if (to && !to.relatedRefs.includes(relation.fromRef)) to.relatedRefs.push(relation.fromRef);
  }

  return {
    worldId: OBSERVATORY_WORLD_ID,
    canonicalWorldId: run.world.id,
    records,
    relations,
    byRefId,
    byCanonicalKey,
  };
}

export function resolveReference(
  registry: ReferenceRegistry,
  refId: string,
): ReferenceRecord | null {
  return registry.byRefId.get(refId as ReferenceId) ?? null;
}

export function findReferenceByCanonicalKey(
  registry: ReferenceRegistry,
  canonicalKey: string,
): ReferenceRecord | null {
  const refId = registry.byCanonicalKey.get(canonicalKey);
  return refId ? registry.byRefId.get(refId) ?? null : null;
}

export function searchReferences(
  registry: ReferenceRegistry,
  query: string,
  limit = 30,
): ReferenceRecord[] {
  const exact = resolveReference(registry, query);
  if (exact) return [exact];
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return registry.records.slice(0, limit);
  return registry.records
    .filter((record) =>
      record.observatoryMetadata.searchTerms.some((term) =>
        term.toLowerCase().includes(needle),
      ),
    )
    .slice(0, limit);
}

export { OBSERVATORY_WORLD_ID, RENDERER_VERSION, formatReferenceId };
