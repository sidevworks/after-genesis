# Firestore design

**Status:** Initial server adapter implemented. `FirestoreCanonicalStore` performs
the event append, world-head compare-and-set, and snapshot replacement in one
transaction; `FirestoreIdempotencyStore` uses owner-scoped TTL leases.
`firestore.rules` exposes only the world header and generated `public/**`
projections, with no client write grant. Unit contract tests pass. A real
Firebase Emulator Suite run and production IAM verification remain staging
gates.

**The one requirement that dominates this document:**

> **There is no client write path to canonical state.** (§17, §28)

Every other decision here is downstream of that.

---

## 1. Where Firestore sits

Persistence is behind a port. `packages/core/src/ports.ts` (**Implemented**) defines `EventStore`,
`StateStore`, `IdempotencyStore` and `ModelAuditStore` as interfaces with no Firestore reference
anywhere. Adapters:

| Adapter | Package | Status | Used for |
|---|---|---|---|
| In-memory | `packages/persistence` | Implemented | Unit tests, property tests, mechanical simulation |
| File (JSONL) | `packages/persistence` | Implemented | Local worlds, replay, the public export format |
| Firestore | `packages/persistence` | Initial adapter implemented | Staging, rehearsal, production |

**Replay must run with zero cloud dependency** — that is why the file adapter exists and why
`verifyChain()` in `event.ts` takes a plain array of events rather than a database handle. A member
of the public with a downloaded JSONL export and Node installed can verify the chain (§16, §28).

---

## 2. Project and database layout

Four separate Firebase projects (§17): `dev`, `staging`, `rehearsal`, `production`. One Firestore
database per project, native mode.

Top-level layout, rooted at the world so that a world is a self-contained, exportable unit:

```
worlds/{worldId}
worlds/{worldId}/events/{sequence}
worlds/{worldId}/state/current
worlds/{worldId}/inhabitants/{inhabitantId}
worlds/{worldId}/tiles/{x_y}
worlds/{worldId}/structures/{structureId}
worlds/{worldId}/artifacts/{artifactId}
worlds/{worldId}/organisations/{organisationId}
worlds/{worldId}/contracts/{contractId}
worlds/{worldId}/currencies/{currencyId}
worlds/{worldId}/currencies/{currencyId}/holdings/{holderId}
worlds/{worldId}/conditions/{conditionId}
worlds/{worldId}/activities/{activityId}
worlds/{worldId}/publicFeed/{sequence}

worlds/{worldId}/private/memories/{memoryId}          ← never public
worlds/{worldId}/private/cognition/{sequence}         ← never public
worlds/{worldId}/private/modelAudit/{sequence}        ← never public

ops/idempotency/{key}
ops/spend/{worldId}_{yyyymmdd}
ops/anchors/{anchorId}
```

The `private/**` subtree is segregated by *path*, not by a field, so the security rules that protect
it are a single unconditional deny rather than a per-document predicate. A rules bug in the public
tree cannot expose private cognition.

---

## 3. Document shapes

### 3.1 `worlds/{worldId}`

```ts
{
  worldId: string,
  worldRulesVersion: string,   // "1.0.0" — see world-rules-v1.md
  eventSchemaVersion: number,  // EVENT_SCHEMA_VERSION from event.ts
  genesisSeed: string,         // published (§22.6)
  genesisCommit: string,
  genesisDigest: string,
  genesisRealTimestamp: string,
  gridWidth: number, gridHeight: number,
  status: "genesis" | "running" | "frozen" | "ended",
  headSequence: number,        // mirrors EventStore.headSequence
  headHash: string,            // 64-hex
  currentSimTime: number,      // integer minutes
  livingPopulation: number,
  frozenAt: number | null,     // sequence of the freeze event
}
```

Written only by Genesis and by the runtime's per-turn transaction.

### 3.2 `worlds/{worldId}/events/{sequence}`

The document id is the **zero-padded sequence number** (`"0000000000000042"`, 16 digits). Two
consequences, both intentional:

1. Lexicographic document-id ordering equals numeric sequence ordering, so a range read needs no
   index and no `orderBy`.
2. `create`-only semantics on a deterministic id give free duplicate rejection — see §5.

Shape mirrors `CanonicalEventSchema` (**Implemented**) exactly:

```ts
{
  worldId: string,
  sequence: number,          // int, ≥ 0
  simTime: number,           // int minutes since Genesis
  realTimestamp: string,     // ISO; forensic only, never an input to a rule
  actor: string | null,      // null for engine/world events (Genesis)
  type: string,              // "genesis" | "action.move" | "condition.progressed" | ...
  inputs: unknown,           // validated action payload the actor proposed
  resolution: unknown,       // what the engine decided actually happened
  visibility:                // discriminated union — see §6.2
      { kind: "public" }
    | { kind: "participants", participants: string[] }
    | { kind: "organisation", organisationId: string }
    | { kind: "private", owner: string }
    | { kind: "local", x: number, y: number },
  preStateChecksum: string,  // 64-hex
  postStateChecksum: string, // 64-hex
  provenance: {
    sourceCommit: string,
    deployedDigest: string,
    modelRequestHash: string | null,
    modelResponseHash: string | null,
    modelId: string | null,
  },
  schemaVersion: number,
  prevHash: string,          // 64-hex; GENESIS_PREV_HASH for sequence 0
  hash: string,              // 64-hex; excluded from its own preimage
}
```

**Firestore compatibility note (important).** Firestore stores all numbers as 64-bit doubles unless
written as integers via the Admin SDK's integer handling, and returns them as JS `number`. Because
`canonicalJson` **throws** on any non-safe-integer, a value that round-trips through Firestore as
`42.0` would fail encoding rather than silently corrupt a hash. That is the desired failure mode,
but it must be tested explicitly: `persistence/firestore-roundtrip-preserves-integers.test.ts`
writes and reads every event field and asserts `Number.isSafeInteger` on each numeric one.

`inputs` and `resolution` are `unknown` in the schema, so the adapter must reject any nested value
`canonicalJson` cannot encode **before** writing. A document that cannot be re-encoded canonically is
a document whose hash cannot be re-verified.

### 3.3 `worlds/{worldId}/state/current`

The materialised state snapshot (§4E). A **cache** — droppable and rebuildable from events.

```ts
{
  sequence: number,     // the event this state reflects
  checksum: string,     // hashValue(HashDomain.StateChecksum, state)
  simTime: number,
  state: { /* the full world state object, canonical-encodable */ },
}
```

Firestore's 1 MiB document limit will be exceeded by a mature world. Mitigation: `state/current`
holds only a **summary and checksum**; the actual materialised entities live in the per-entity
collections (§3.4 onward), and the checksum is computed over the canonical encoding of the whole
assembled state, not over this document. The runtime holds the working state in memory between
turns and re-derives it from events on cold start.

### 3.4 `worlds/{worldId}/inhabitants/{inhabitantId}`

Every §6 field. Fields marked **private** live under `private/` and are never in this document.

```ts
{
  // identity & lineage
  inhabitantId: string,            // deriveInhabitantId(worldId, creationSequence)
  displayName: string,
  generation: number,
  creators: string[],
  creationEvent: number,           // sequence
  birthTime: number,               // simTime
  deathEvent: number | null,

  // status & position
  status: "alive" | "deceased",
  location: { x: number, y: number },
  currentActivity: {
    state: ActivityState,          // one of 17 — exactly one, always
    activityId: string | null,
    startedAt: number,
    endsAt: number | null,
    interruption: InterruptionPolicy,
  },
  lastActionTime: number,
  nextEligibleActionTime: number,

  // capacity
  maturity: number,                // 0..10
  energy: number,                  // integer, 0..ceiling
  energyCeiling: number,
  compute: number,
  computeAllowance: number,
  fatigueDays: number,

  // character  (traits and values are public-ish; goals are NOT)
  traits: Record<string, number>,  // 0..100 integers
  values: string[],
  needs: Record<string, number>,

  // holdings
  inventory: ResourceBundle,       // Partial<Record<ResourceKind, integer>>
  property: string[],              // structure / artifact ids
  skills: Record<string, number>,  // 0..100 integers
  reputation: Record<string, number>,
  groupMemberships: string[],
  contracts: string[],

  // health
  conditions: string[],            // conditionId refs
  healthStage: number,             // 0..4 worst active condition

  // config
  voiceId: string,                 // persistent ElevenLabs voice (§21)
  modelConfig: { routineModelId: string, deliberateModelId: string },

  schemaVersion: number,
}
```

**Deliberately absent from this document** and stored under `private/`:
`privateGoals`, `beliefsAboutOthers`, `knownLocations`, `knownPublicInformation`, `relationships`
(private valence), `episodicMemories`, `longTermSummaries`, `concealedHoldings`.

Note that `relationships` appears in §6 as an inhabitant field but is genuinely two-sided and
private — Alpha's belief about Beta is Alpha's private state. It is stored as
`private/memories`-adjacent records keyed by `(holder, subject)`, not as a shared edge. A shared
relationship object would be an information leak by construction
([threat-model.md](./threat-model.md) T-8).

### 3.5 `worlds/{worldId}/tiles/{x}_{y}`

```ts
{
  x: number, y: number,
  terrain: Terrain,                 // immutable after map generation (§5)
  foodYieldRemaining: number,
  woodYieldRemaining: number,
  stoneYieldRemaining: number,      // never regenerates
  claimHolder: string | null,       // land_use_rights holder — a record, not a fence
  structureIds: string[],
  occupantIds: string[],            // maintained for `local` visibility witness resolution
}
```

4096 documents at the 64×64 default. Terrain is generated deterministically from the published Genesis
seed and never written again.

### 3.6 Other canonical collections (abbreviated)

| Collection | Key fields |
|---|---|
| `structures/{id}` | `location`, `kind`, `builders[]`, `owners[]`, `storageCapacity`, `shelterQuality`, `containment`, `condition`, `createdEvent` |
| `artifacts/{id}` | `creators[]`, `creationEvent`, `title`, `content` or `storageRef`, `owners[]`, `publicationStatus`, `provenance`, `revisions[]`, `costs`, `transferHistory[]` (§12) |
| `organisations/{id}` | `founders[]`, `members[]`, `rules[]` *(data, never physics — §11G)*, `claims[]`, `property[]`, `createdEvent` |
| `contracts/{id}` | `parties[]`, `terms`, `status`, `obligations[]`, `visibility`, `createdEvent`, `terminatedEvent` |
| `currencies/{id}` | `issuer`, `name`, `symbol`, `supplyRule`, `transferRules`, `backing`, `governance`, `transparent: boolean`, `description` (§10) |
| `currencies/{id}/holdings/{holderId}` | `holder`, `amount` (integer) — readable publicly **only if** `currency.transparent` |
| `conditions/{id}` | `subject`, `kind`, `severity`, `stage`, `acquiredAt`, `lastProgressedAt`, `knownTo[]`, `treatments[]` (§8) |
| `activities/{id}` | `actor`, `state`, `participants[]`, `location`, `startedAt`, `endsAt`, `interruption`, `completionConditions` (§11A) |

### 3.7 `worlds/{worldId}/publicFeed/{sequence}`

A **pre-projected, spectator-safe** copy of each `public`-visibility event, denormalised for
display. This is the only event-shaped collection the spectator client reads directly.

Rationale: making the spectator query the canonical `events` collection would force visibility
filtering into security rules, where it is hard to write and harder to prove. Projecting instead
means the rule is `allow read: if true` on a collection that **by construction contains only public
data**, and the filtering is ordinary tested application code. See
[threat-model.md](./threat-model.md) M7.3.

### 3.8 `ops/idempotency/{key}`

```ts
{ key: string, claimedAt: Timestamp, expiresAt: Timestamp, worldId: string, sequence: number | null }
```

`key = sha256(worldId + ":" + inhabitantId + ":" + turnNumber)`. TTL policy on `expiresAt` for
automatic cleanup.

### 3.9 `ops/spend/{worldId}_{yyyymmdd}`

```ts
{ worldId, dayKey, spentMicros: number, callCount: number, frozen: boolean, limitMicros: number }
```

Integer micros — never floats, for the same reason as everything else. See
[cost-control.md](./cost-control.md).

### 3.10 `worlds/{worldId}/private/modelAudit/{sequence}`

Mirrors `ModelAuditStore.record()` (**Implemented** interface):

```ts
{
  worldId, sequence,
  request: { modelId, systemPrompt, userPrompt, responseSchema, maxOutputTokens, temperature },
  requestHash: string,
  response: { rawText, modelId, inputTokens, outputTokens, finishReason } | null,
  responseHash: string | null,
  costMicros: number,
  classification: "public" | "private_until_death" | "restricted",   // §16
}
```

**Write-once.** Rules deny update and delete. Client read is denied unconditionally.

---

## 4. Composite indexes

Firestore requires an explicit composite index for any query combining an equality filter with a
range or ordering on a different field. Single-field indexes are automatic.

`firestore.indexes.json` (**Not started**):

| Collection | Fields | Query it serves |
|---|---|---|
| `events` | `worldId ASC, sequence ASC` | Chain read / export. *Note: collection is already world-scoped and keyed by padded sequence, so this is a fallback for collection-group queries only* |
| `events` | `actor ASC, sequence DESC` | "Everything inhabitant X did", audit view |
| `events` | `type ASC, sequence DESC` | Event-type filter in the spectator timeline (§20) |
| `events` | `simTime ASC, sequence ASC` | Historical timeline scrub by world time |
| `publicFeed` | `simTime DESC` | Live event ticker |
| `publicFeed` | `type ASC, simTime DESC` | Filtered ticker |
| `publicFeed` | `actor ASC, simTime DESC` | Inhabitant profile activity |
| `inhabitants` | `status ASC, nextEligibleActionTime ASC` | **Scheduler's hot query**: who is eligible to act |
| `inhabitants` | `status ASC, location.x ASC, location.y ASC` | Map rendering, proximity/observation |
| `inhabitants` | `generation ASC, birthTime ASC` | Lineage / family tree (§20) |
| `activities` | `actor ASC, endsAt ASC` | Exclusivity check: does this overlap a committed activity? |
| `activities` | `participants ARRAY, endsAt ASC` | Exclusivity for *every* participant (§11J) |
| `conditions` | `subject ASC, stage DESC` | Health view; progression sweep |
| `conditions` | `stage ASC, lastProgressedAt ASC` | Daily progression sweep across the world |
| `contracts` | `parties ARRAY, status ASC` | Contract obligations per inhabitant |
| `artifacts` | `publicationStatus ASC, creationEvent DESC` | Public artifact gallery |
| `structures` | `location.x ASC, location.y ASC` | Map rendering |
| `currencies/{id}/holdings` | `amount DESC` | Public ledger view, transparent currencies only |

**Index hygiene note.** Adding an index is *operational* (read performance only) and therefore
permitted in a live world (§23). Adding a *field* to a canonical document is constitutional.

---

## 5. `append(event, expectedSequence)` → a Firestore transaction

`ports.ts` (**Implemented**) specifies the contract:

> "Must be atomic and must reject if an event already exists at that sequence. This is the
> concurrency control that makes duplicate task delivery safe: two workers racing on the same turn
> will see one succeed and one rejected (§15 'each task can commit at most once')."

### 5.1 The mapping

```ts
async append(event: CanonicalEvent, expectedSequence: number): Promise<void> {
  if (event.sequence !== expectedSequence) throw new SequenceMismatchError(...);

  const worldRef = db.doc(`worlds/${event.worldId}`);
  const eventRef = db.doc(`worlds/${event.worldId}/events/${pad(expectedSequence)}`);

  await db.runTransaction(async (tx) => {
    // 1. Read the world head INSIDE the transaction.
    const world = await tx.get(worldRef);
    if (!world.exists) throw new WorldNotFoundError(event.worldId);
    const head = world.get("headSequence") as number;

    // 2. The event must be exactly the next one.
    if (head + 1 !== expectedSequence) {
      throw new SequenceConflictError(head, expectedSequence);   // loser of the race
    }

    // 3. The chain must actually link.
    const expectedPrev = head < 0 ? GENESIS_PREV_HASH : (world.get("headHash") as string);
    if (!hashEquals(event.prevHash, expectedPrev)) throw new ChainLinkError(...);

    // 4. Time must not move backwards (§15).
    if (event.simTime < (world.get("currentSimTime") as number)) throw new TimeTravelError(...);

    // 5. create(), NOT set(). Fails if the document already exists.
    tx.create(eventRef, toFirestore(event));

    // 6. Advance the head in the SAME transaction.
    tx.update(worldRef, {
      headSequence: expectedSequence,
      headHash: event.hash,
      currentSimTime: event.simTime,
    });

    // 7. Materialised-state writes for this event go here too — same transaction,
    //    so StateStore.save() is atomic wrt the append that produced it.
  });
}
```

### 5.2 Why duplicates are rejected — three independent mechanisms

| # | Mechanism | Catches |
|---|---|---|
| 1 | `tx.create()` on a deterministic document id | A literal re-delivery of an already-committed event |
| 2 | `head + 1 !== expectedSequence` check on a document read *inside* the transaction | A worker that read stale state; Firestore aborts the transaction if `worldRef` changed under it |
| 3 | `IdempotencyStore.claim()` before the turn even starts | Wasted work — stops a duplicate before the expensive model call |

Mechanism 2 is the authoritative one. Firestore transactions use optimistic concurrency: a
transaction that read `worldRef` will abort and retry if another transaction wrote it first. On
retry, the head has advanced and the `head + 1` check fails deterministically. **A losing worker
must abandon its turn, not retry the resolution** — its resolution was computed against a pre-state
that no longer exists, and re-appending it would break the `preStateChecksum ==
prev.postStateChecksum` link that `verifyChain()` enforces.

### 5.3 Consequence: canonical writes are strictly serialised

One event commits at a time per world. This is a deliberate trade of throughput for auditability;
see [architecture.md](./architecture.md) §7. At the turn rates the spend ceiling permits, it is not
a bottleneck.

### 5.4 What the transaction may **not** do

§18, absolutely: **never call Gemini, ElevenLabs or any other external side-effecting service from
inside a Firestore transaction.** All cognition happens before the transaction opens. The
transaction is pure local computation plus reads and writes.

---

## 6. Security rules strategy

`firestore.rules` — **Not started**. The strategy below is the target.

### 6.1 Design principles

1. **Deny by default.** The last rule in the file is a catch-all deny. Any collection not explicitly
   allowed is unreadable and unwritable.
2. **No `allow write` anywhere in the file, for any path, for any identity.** Not "write if admin",
   not "write if authenticated" — the token `write`, `create`, `update` and `delete` should appear
   only in `if false` rules. This makes review trivial and makes §28's "no human-facing canonical
   write route exists" mechanically checkable by grepping the rules file.
3. **The runtime service account bypasses rules entirely**, because the Admin SDK always does. Rules
   therefore protect against *clients*, and the runtime's constraint is enforced by IAM and by the
   fact that it is the only principal holding a credential. See
   [threat-model.md](./threat-model.md) T-5 item 4 and R-6.
4. **Private data is segregated by path**, so its rule is one unconditional deny rather than a
   predicate that could be got wrong.

### 6.2 The rules

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    // ---------------------------------------------------------------
    // NO CLIENT WRITES. ANYWHERE. EVER.  (§17, §28)
    // The simulation runtime writes via the Admin SDK, which bypasses
    // these rules. No other principal holds a credential.
    // ---------------------------------------------------------------
    function noClientWrites() { return false; }

    // ---------------- PUBLIC READ SURFACE ----------------

    match /worlds/{worldId} {
      allow read:  if true;                 // world metadata, head hash, checksum (§20)
      allow write: if noClientWrites();

      // Canonical event log. Readable ONLY where visibility is public.
      // Spectators are expected to use publicFeed; this rule is defence in depth.
      match /events/{sequence} {
        allow read:   if resource.data.visibility.kind == 'public';
        allow write:  if noClientWrites();
      }

      // Pre-projected public feed: contains public data BY CONSTRUCTION.
      match /publicFeed/{sequence} {
        allow read:  if true;
        allow write: if noClientWrites();
      }

      // Materialised public entities.
      match /inhabitants/{inhabitantId} { allow read: if true;  allow write: if noClientWrites(); }
      match /tiles/{tileId}             { allow read: if true;  allow write: if noClientWrites(); }
      match /structures/{structureId}   { allow read: if true;  allow write: if noClientWrites(); }
      match /organisations/{orgId}      { allow read: if true;  allow write: if noClientWrites(); }
      match /conditions/{conditionId}   { allow read: if true;  allow write: if noClientWrites(); }
      match /activities/{activityId}    { allow read: if true;  allow write: if noClientWrites(); }

      // Artifacts: only published ones (§12 publication status).
      match /artifacts/{artifactId} {
        allow read:  if resource.data.publicationStatus == 'published';
        allow write: if noClientWrites();
      }

      // Contracts: only those the parties published (§11E).
      match /contracts/{contractId} {
        allow read:  if resource.data.visibility.kind == 'public';
        allow write: if noClientWrites();
      }

      // Currencies: the declaration is public; the ledger only if transparent (§11J).
      match /currencies/{currencyId} {
        allow read:  if true;
        allow write: if noClientWrites();

        match /holdings/{holderId} {
          allow read:  if get(/databases/$(database)/documents/worlds/$(worldId)/currencies/$(currencyId)).data.transparent == true;
          allow write: if noClientWrites();
        }
      }

      // Materialised state snapshot: checksum is public (§20).
      match /state/{docId} { allow read: if true; allow write: if noClientWrites(); }

      // ---------------- PRIVATE SUBTREE ----------------
      // Private memories, private cognition, raw model prompts and responses.
      // No client of any kind reads this. Ever. (§16, §11E)
      match /private/{document=**} {
        allow read:  if false;
        allow write: if false;
      }
    }

    // ---------------- OPERATIONAL ----------------
    // Idempotency keys, spend counters, anchors. Runtime only.
    match /ops/{document=**} {
      allow read:  if false;
      allow write: if false;
    }

    // ---------------- CATCH-ALL DENY ----------------
    match /{document=**} {
      allow read:  if false;
      allow write: if false;
    }
  }
}
```

### 6.3 Cloud Storage rules

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // Generated audio and artifact media: world-readable, never client-writable (§21, §17).
    match /worlds/{worldId}/media/{allPaths=**} {
      allow read:  if true;
      allow write: if false;
    }
    match /{allPaths=**} {
      allow read:  if false;
      allow write: if false;
    }
  }
}
```

The world reads no blob it did not itself create — closing
[threat-model.md](./threat-model.md) T-7c.

### 6.4 Firebase App Check

Required on all client SDK access (§17). App Check does not replace the rules above; it raises the
cost of automated abuse of the public read surface (T-7d).

### 6.5 Firebase Authentication

**Administrative identity only** (§3). An authenticated admin has exactly the same Firestore rights
as an anonymous visitor: read the public surface, write nothing. The only admin capability in the
entire system is the emergency freeze (§17), which is exercised through a separate, audited runtime
path — not through Firestore rules — and which emits a permanent public event.

There is deliberately **no** `isAdmin()` function in the rules file. Its absence is the control.

---

## 7. Testing the rules

Firestore rules are code and are tested with the emulator via
`@firebase/rules-unit-testing` + Vitest. §28 requires "security rules pass automated tests" before
Genesis.

| Test name | Asserts |
|---|---|
| `rules/no-client-write-anywhere.test.ts` | Exhaustive matrix: every collection path × {create, update, delete} × {unauthenticated, authenticated, admin-claim} → **denied**. Enumerated from a path manifest so a new collection without a test fails the suite |
| `rules/private-subtree-unreadable.test.ts` | Every `private/**` path, every identity → read denied |
| `rules/ops-subtree-unreadable.test.ts` | Every `ops/**` path → read and write denied |
| `rules/events-private-visibility-hidden.test.ts` | Events with `participants`/`organisation`/`private`/`local` visibility → read denied; `public` → allowed |
| `rules/artifacts-unpublished-hidden.test.ts` | `publicationStatus != 'published'` → read denied |
| `rules/currency-holdings-opaque-when-private.test.ts` | Holdings of a non-transparent currency → read denied |
| `rules/catch-all-denies-unknown-paths.test.ts` | Random unknown paths → read and write denied |
| `rules/rules-file-contains-no-allow-write.test.ts` | Static: the rules source contains no `allow write`/`create`/`update`/`delete` that is not `if false`. Cheap, and it catches the worst possible regression in review |
| `storage-rules/no-client-write.test.ts` | Every bucket path, every identity → write denied |

### 7.1 Persistence adapter tests (independent of rules)

| Test name | Asserts |
|---|---|
| `persistence/append-rejects-duplicate-sequence.test.ts` | Two concurrent appends at the same sequence: exactly one succeeds |
| `persistence/append-rejects-broken-chain.test.ts` | A `prevHash` that does not match the head is rejected |
| `persistence/append-rejects-backwards-time.test.ts` | §15 "world time cannot move backwards" |
| `persistence/append-and-state-are-atomic.test.ts` | Injected failure between event write and state write leaves neither |
| `persistence/no-update-or-delete-method-exists.test.ts` | Type-level + runtime: `EventStore` exposes no mutation method |
| `persistence/firestore-roundtrip-preserves-integers.test.ts` | Every numeric field survives Firestore as a safe integer; `canonicalJson` of the round-tripped event equals the original |
| `persistence/adapters-agree.test.ts` | Contract test run against in-memory, file and Firestore-emulator adapters — identical observable behaviour |
| `persistence/replay-from-file-needs-no-network.test.ts` | Full replay from a JSONL export with network stubbed to throw |

---

## 8. Backup, export and anchoring

- **Point-in-time recovery** enabled on the production database; **daily scheduled backups** (§18).
  Restore must be *rehearsed*, not merely configured — §28 requires "backup and recovery have been
  rehearsed."
- **Public export**: a scheduled job writes the full event log as JSONL to a public GitHub release,
  together with the chain tip hash, the current state checksum, the source commit and the deployed
  digest. This is the artifact the public verifier consumes.
- **Anchoring** (§16): the chain tip hash is published externally on a fixed cadence, so a
  post-hoc rewrite of history is bounded by the anchor interval. This is the only control that
  constrains an operator with production access — see [threat-model.md](./threat-model.md) M3.1/M9.1.

---

## 9. Judgement calls

1. **`publicFeed` is a denormalised projection, not a rules-filtered view of `events`.** The spec
   does not call for it. It exists because expressing §11E's five-way visibility model in security
   rules is fragile, and a bug there leaks private cognition. Cost: a second write per public event,
   and a projection that can drift from canon. Mitigated by deriving it in the same transaction and
   testing equivalence.

2. **Materialised state is per-entity collections, not one document.** Firestore's 1 MiB limit makes
   a single state document impossible for a mature world. The consequence is that the state checksum
   is computed over an *assembled* structure in memory, and the assembly order becomes part of the
   canonical encoding — so it must itself be deterministic (sorted by id). This is a real trap and
   it is worth a dedicated test.

3. **Events are keyed by zero-padded sequence.** 16 digits supports up to 10^16 events. Chosen so
   that `create()` gives duplicate rejection for free and range reads need no index.

4. **Relationships are stored one-sided and private.** §6 lists "Relationships" as an inhabitant
   field, which reads as though it might be a shared object. Storing it shared would leak Beta's
   opinion of Alpha to Alpha. This document stores directed, private beliefs instead. The spec does
   not settle it, and §11E strongly implies the private reading.

5. **The Admin SDK bypasses all rules.** This is the largest gap between what the rules file
   *appears* to guarantee and what is actually enforced. The rules protect against clients only.
   Restricting the runtime itself requires a non-Admin identity with IAM-scoped Datastore access —
   recorded as required action 4 in [threat-model.md](./threat-model.md) T-5, and as residual risk
   R-6 if not done.

6. **Firestore transactions have a 500-write limit and a ~270-second lifetime.** A single turn that
   modified many entities (a large organisation's coordinated production) could approach the write
   cap. Not resolved here; flagged for the engine design. If a turn cannot fit in one transaction,
   atomicity of "append event + update state" is at risk, and that is a §15 invariant
   ("failed transactions cannot partially alter state").
