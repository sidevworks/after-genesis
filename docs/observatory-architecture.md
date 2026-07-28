# Universal Observatory architecture

Status: implementation baseline  
Date: 2026-07-28  
Boundary: read-only projection around the canonical simulation

> The world exists independently. The Observatory only provides ways to witness it.

## 1. Current architecture assessment

The canonical engine already provides the essential scientific substrate:
stable entity identifiers, deterministic state transitions, append-only
hash-chained events, replay, checksums, visibility classes, and neutral action
outcomes. None of these should move into the Observatory.

The current spectator is a static Next.js export backed by a deterministic
fixture through a query-only `WorldSource`. Its strongest property is structural:
it contains no route handler, server action, write-capable connector, or
non-GET network path. Its main limitation is that pages and navigation are
organised around anticipated nouns such as inhabitants, organisations,
artifacts, and economy. The SVG map also knows those categories directly.

The Observatory is therefore an additive projection layer. It replaces neither
the engine nor the existing audit interface. It introduces universal identity,
provenance, capabilities, scene primitives, temporal resolution, and fallback
presentation above the read model.

## 2. Proposed data flow

```text
Canonical state + canonical event log
                |
                v
Deterministic Reference Registry projection
                |
                v
Observatory Index
  - reference lookup
  - provenance and relation graph
  - temporal event index
  - spatial index
  - derived capabilities
                |
                v
Renderer-neutral Scene Adapter
                |
        +-------+--------+
        |                |
        v                v
Camera Director       Media Resolver
        |                |
        +-------+--------+
                v
Read-only Spectator UI
```

Only the top arrow reads canonical data. Every layer below it is disposable and
rebuildable. No lower layer receives a canonical writer.

## 3. Reference ID allocation strategy

Format:

`AG:<WORLD_CODE>:<REFERENCE_CLASS>:<12_DIGIT_MONOTONIC_ID>`

Reference classes are broad technical classes: `ENT`, `OBJ`, `LOC`, `ENV`,
`EVT`, `ACT`, `SEQ`, `REC`, `REL`, `ASM`, `PRC`, `UNK`, and `ABS`.

The registry is not an authority and does not replace canonical identifiers.
Every record stores its canonical source key. Allocation is a deterministic
projection:

1. Read the complete canonical prefix in ascending event sequence.
2. Discover references from each event and materialised state.
3. Order items within the same event by canonical source key using UTF-16 code
   unit order.
4. Allocate the next integer within the selected reference class.
5. Persist the mapping in the Observatory index for fast lookup.
6. On a clean rebuild, assert that the resulting mapping is byte-identical.

Existing entities without an explicit creation event are ordered by their
creation sequence, then canonical identifier. Locations use row-major
coordinates. Events use their canonical sequence. Actions are paired to their
event but have an independent `ACT` counter. Classification never changes a
Reference ID: an item first indexed as `UNK` keeps that ID and gains a new
classification relation later.

Allocation must be atomic in a persistent deployment. A uniqueness constraint
on `(world_id, reference_class, monotonic_id)` and another on
`(world_id, canonical_namespace, canonical_key)` prevent collisions. The static
implementation rebuilds the same result in memory and tests determinism.

## 4. Database schemas and indexes

The logical persistent schema is storage-provider neutral.

### `observatory_references`

- `ref_id` primary key
- `world_id`
- `reference_class`
- `monotonic_id`
- `canonical_namespace`
- `canonical_key`
- `canonical_type`
- `created_by_event_ref`
- `first_observed_tick`
- `status`
- `current_state_json`
- `canonical_metadata_json`
- `observatory_metadata_json`
- `schema_version`

Indexes:

- unique `(world_id, reference_class, monotonic_id)`
- unique `(world_id, canonical_namespace, canonical_key)`
- `(world_id, canonical_type, status)`
- `(world_id, first_observed_tick)`

### `observatory_relations`

- `relation_id` primary key
- `world_id`
- `from_ref`
- `relation_type`
- `to_ref`
- `event_ref`
- `valid_from_tick`
- `valid_to_tick`
- `canonical`

Indexes:

- `(from_ref, relation_type, valid_from_tick)`
- `(to_ref, relation_type, valid_from_tick)`
- unique `(from_ref, relation_type, to_ref, event_ref)`

### `observatory_spatial`

- `ref_id`
- `world_tick`
- `x`, `y`, nullable `z`
- nullable bounds
- spatial chunk key

Indexes:

- `(world_id, chunk_key, world_tick)`
- `(ref_id, world_tick)`

### `observatory_snapshots`

- `world_id`
- `world_tick`
- `canonical_event_hash`
- `canonical_state_checksum`
- `projection_digest`
- compressed scene/index projection

Index: unique `(world_id, world_tick)`.

Canonical and Observatory metadata are stored in different columns and never
merged.

## 5. Capability Manifest schema

Each reference exposes a calculated, read-only manifest:

```ts
type CapabilityName =
  | "inspect" | "locate" | "view" | "orbit" | "track" | "follow"
  | "enter" | "listen" | "replay" | "read" | "inspect_components"
  | "inspect_provenance" | "inspect_history" | "inspect_relationships"
  | "compare" | "view_creator" | "view_creation_process"
  | "view_current_state" | "view_last_known_state" | "view_site"
  | "view_route" | "hear_conversation" | "hear_available_thought_record"
  | "watch_action" | "watch_sequence";

interface Capability {
  available: boolean;
  reason?: string;
  targetRef?: RefId;
  modes?: readonly CameraMode[];
  sources?: readonly MediaSource[];
}
```

A capability is derived from evidence:

- spatial coordinates enable `locate`;
- bounds enable `inspect` and `orbit`;
- a time-varying path enables `track` and `replay`;
- canonical text enables `read`;
- relations enable provenance/component/history inspection;
- canonical or explicitly rendered speech enables labelled listening;
- valid interior geometry alone enables `enter`.

Unavailable capabilities are omitted from primary controls. When relevant to
understanding a limitation, the panel may show the reason as explanatory text.

## 6. Scene Description Protocol

The renderer receives no engine entities. It receives:

```ts
interface SceneDescription {
  sceneVersion: 1;
  worldId: string;
  worldTick: number;
  terrain: TerrainPrimitive[];
  references: SceneReference[];
}

interface SceneReference {
  refId: RefId;
  transform: Transform;
  representation: Representation;
  activity: SceneActivity | null;
  cameraAnchors: CameraAnchor[];
  capabilities: CapabilityManifest;
  epistemicLabel: "canonical" | "claim" | "derived" | "unknown";
}
```

Representation kinds are physical/informational primitives: point, marker,
path, surface, volume, assembly, articulated entity, information surface, and
unknown bounds. Renderer-specific models, shaders, and meshes are selected
after this boundary.

Canonical 2D coordinates do not acquire invented height. The scene adapter may
map the canonical plane into renderer coordinates and mark generated visual
height as derived presentation metadata.

## 7. Camera API

```ts
openCamera({
  targetRef,
  mode,
  worldTick: null,
  relatedEventRef: null,
});
```

Modes: `WORLD`, `LOCATE`, `INSPECT`, `ORBIT`, `THIRD_PERSON_FOLLOW`,
`WIDE_FOLLOW`, `OVERHEAD_FOLLOW`, `PATH_REPLAY`, `SITE_VIEW`,
`CREATION_REPLAY`, `INTERIOR_VIEW`, `CONVERSATION_VIEW`, and
`FALLBACK_REFERENCE_VIEW`.

The Camera Director consumes anchors and scene primitives only. It has no
navigation, collision, cognition, event, or state mutation dependency. Fallback
order is third-person to wide to overhead to reference view.

## 8. Universal Reference Panel

Every selectable reference uses one panel:

- Header: display label, Reference ID, class, status, time and location.
- Capability controls: only supported read operations.
- Overview: canonical facts first; derived metadata labelled.
- Current state.
- History.
- Provenance.
- Components.
- Relationships.
- Statements and interpretations, visually separated from facts.
- Associated events.
- Available media with provenance labels.
- Technical record with canonical source key and projection version.

Panel sections remain present only when supported by data. Unknown references
use exactly the same shell.

## 9. Unknown-reference fallback

Fallback hierarchy:

1. Exact canonical geometry and materials.
2. Procedural assembly of known components.
3. Canonical bounds in neutral material.
4. Non-semantic reference marker at the canonical position.
5. Index-only record when no spatial evidence exists.

Fallback labels use “Unclassified reference” and the permanent Reference ID.
They never substitute a culturally familiar noun.

## 10. Migration plan

Migration is additive and non-destructive:

1. Freeze a canonical event-log prefix for the projection job.
2. Build a fresh Observatory index beside the existing system.
3. Allocate deterministic references for events, actions, inhabitants,
   locations, structures, artifacts, records, organisations-as-recorded
   associations, and unknown source keys.
4. Derive relations from explicit canonical fields and event subjects.
5. Compare two clean rebuilds byte-for-byte.
6. Verify every current spectator deep link maps to one Reference ID.
7. Publish new `/world/<world>/ref/<ref>` routes while retaining old routes.
8. Switch map selection and search to Reference IDs.
9. Keep the prior spectator available until parity and security tests pass.

No canonical identifier, event, state document, or checksum is edited.

## 11. Read-only security proof

The static Observatory contains:

- no route handlers;
- no server actions;
- no form submissions;
- no non-GET network calls;
- no WebSocket writer;
- no canonical SDK with mutation methods;
- no canonical credentials;
- no camera or renderer dependency visible to the engine.

CI scans source and rendered HTML for write paths. A production reader uses a
separate read-only projection credential and database. Firestore rules deny all
client writes and deny reads of restricted canonical data. Projection workers
may write only Observatory collections, never canonical collections.

## 12. Performance plan

- Partition spatial references by deterministic chunk.
- Store current projections separately from immutable history.
- Page events and relations by `(tick, ref_id)`.
- Cache capability manifests by projection digest.
- Use instancing for repeated primitive representations.
- Apply scene-level and mesh-level detail tiers.
- Stream chunks around the camera without exposing camera state to the world.
- Snapshot historical projections at bounded intervals and replay only the
  remaining event suffix.
- Load media asynchronously and never block canonical inspection on media.
- Keep search indexes denormalised and disposable.
- Validate million-record behaviour with generated read-only fixtures before
  production scale.

## 13. Test plan

Required suites:

- Reference determinism, uniqueness, monotonicity, collision resistance and
  stable renaming/destruction behaviour.
- Provenance preservation through creation, modification, division and
  combination.
- Unknown-class indexing, selection, fallback rendering and deep links.
- Capability presence/absence based strictly on evidence.
- Temporal resolution at current, historical, event, creation and last-known
  ticks.
- Scene protocol validation independent of renderer.
- Camera fallback and absence of engine dependencies.
- Canonical fact, claim, derived summary and unknown-state visual separation.
- Media provenance labels.
- Static-export and source scans proving no write path.
- Clean rebuild digest equality.
- Large-index pagination, chunking and search benchmarks.

## 14. Phased implementation roadmap

### Phase O1 — reference foundation

Typed contracts, deterministic registry, relation graph, capability derivation,
scene adapter, tests, and architecture specification.

### Phase O2 — universal Observatory interface

Reference search, permanent deep links, universal panel, fallback scene,
world/locate/inspect camera modes, and real export adapter.

### Phase O3 — temporal and provenance viewing

Historical state resolver, event view, path replay, creation replay, provenance
graph and claim/fact comparison.

### Phase O4 — living diorama

Progressive 2.5D/3D terrain, deterministic identities, movement animation,
follow cameras, level of detail and spatial streaming.

### Phase O5 — labelled media

Canonical audio, deterministic voice rendering, narrated summaries, versioned
voice references and explicit provenance labels.

### Phase O6 — scale and production projection

Persistent index store, incremental projection worker, read-only live stream,
snapshots, million-reference load tests and production security review.
