# Firestore adapter — design

**Status: design only. There is no implementation in this directory and there is
no `firebase-admin` dependency in `package.json`.** Nothing here has been run
against a real project; no credentials exist in this repository and none should
be added to it. This document is the specification an implementer follows, and
the thing a reviewer checks that implementation against.

The file stores in this package (`FileEventStore`, `FileStateStore`,
`FileModelAuditStore`) are what the vertical slice actually runs on. They are
single-writer by design. Firestore is the production path, and the entire reason
to move to it is one property the filesystem cannot give us: **a compare-and-set
on the world's head sequence that holds across processes.**

---

## 1. Collections

```
worlds/{worldId}                                  — world head pointer, one doc
worlds/{worldId}/events/{sequence}                — canonical events, append-only
worlds/{worldId}/state/current                    — materialised snapshot (a cache)
worlds/{worldId}/anchors/{anchorId}               — published chain anchors (§16)
idempotency/{idempotencyKey}                      — turn claims, TTL-swept
```

### `worlds/{worldId}`

```
{
  worldId:        string,
  headSequence:   number,   // -1 before Genesis
  headHash:       string,   // GENESIS_PREV_HASH before Genesis
  headSimTime:    number,
  schemaVersion:  number,
  frozen:         boolean,  // emergency freeze (§17)
  frozenAtSequence: number | null,
  updatedAt:      timestamp
}
```

One document per world, and it is written once per canonical event. That makes
it the system's hottest document and the subject of §5 below.

### `worlds/{worldId}/events/{sequence}`

The document **id is the zero-padded sequence number** — `"000000000042"` —
never an auto-id. Two consequences, both load-bearing:

1. `create()` on that path is a uniqueness constraint enforced by the database.
   Two writers racing at sequence 42 cannot both succeed no matter what the
   application logic does, because the second `create()` fails with
   `ALREADY_EXISTS`.
2. Document-id ordering is sequence ordering, so reading a contiguous range is
   an ordered scan with no index and no `orderBy`.

Padding to 12 digits keeps lexicographic id order equal to numeric order up to
10^12 events, which is past any plausible world.

The document body is the `CanonicalEvent` verbatim, with one carve-out described
in §6: raw prompts and responses live in Cloud Storage, and the event carries
only their hashes.

---

## 2. `append(event, expectedSequence)` as a transaction

The contract is the one in `EventStore`: atomic, and it must reject if an event
already exists at that sequence.

```
function append(event, expectedSequence):

  worldRef = doc("worlds/" + event.worldId)
  eventRef = doc("worlds/" + event.worldId + "/events/" + pad(expectedSequence))

  runTransaction(tx => {

    # ---- ALL READS FIRST -------------------------------------------------
    # Firestore requires every read in a transaction to precede every write.
    # Both documents read here are placed under the transaction's watch: if
    # either changes before commit, the commit is rejected and the whole
    # closure is re-run against fresh data.

    worldSnap = tx.get(worldRef)
    existing  = tx.get(eventRef)

    # ---- GUARDS ----------------------------------------------------------

    if existing.exists:
        throw SequenceConflictError(worldId, expectedSequence,
                                    worldSnap.headSequence)

    head     = worldSnap.exists ? worldSnap.data.headSequence : -1
    headHash = worldSnap.exists ? worldSnap.data.headHash : GENESIS_PREV_HASH

    if expectedSequence != head + 1:
        # Covers both "already taken" and "would leave a hole".
        throw SequenceConflictError(worldId, expectedSequence, head)

    if event.sequence != expectedSequence:
        throw SequenceConflictError(worldId, expectedSequence, head)

    if event.prevHash != headHash:
        throw ChainIntegrityError(worldId, "does not chain from the head")

    if worldSnap.exists and worldSnap.data.frozen:
        throw WorldFrozenError(worldId, worldSnap.data.frozenAtSequence)

    if worldSnap.exists and event.simTime < worldSnap.data.headSimTime:
        throw ChainIntegrityError(worldId, "world time cannot move backwards")

    # ---- WRITES ----------------------------------------------------------
    # create(), not set(): set() would overwrite, and no caller in this system
    # is ever permitted to overwrite an event.

    tx.create(eventRef, event)

    tx.set(worldRef, {
        worldId:        event.worldId,
        headSequence:   expectedSequence,
        headHash:       event.hash,
        headSimTime:    event.simTime,
        schemaVersion:  event.schemaVersion,
        frozen:         worldSnap.exists ? worldSnap.data.frozen : false,
        frozenAtSequence: worldSnap.exists ? worldSnap.data.frozenAtSequence : null,
        updatedAt:      SERVER_TIMESTAMP
    }, { merge: true })
  })
```

### Why there are two independent guards

The `existing.exists` check and the `headSequence` check would each catch the
common case alone. Keeping both is deliberate:

- The **head pointer** is what makes contention *detectable*. Every appender
  reads `worlds/{worldId}`, so two concurrent appends conflict on that document
  and Firestore serialises them, rather than both proceeding on stale reads.
- The **event document id** is what makes the guarantee *unconditional*. If the
  head pointer were ever wrong — restored from a backup, repaired by hand, lost
  — `create()` still refuses to overwrite an existing event. The head pointer is
  a cache of a fact that the events collection already knows.

Losing this append is not an error condition to retry. A `SequenceConflictError`
means another worker committed that turn, which is exactly what §15's "each task
can commit at most once" is asking for: the caller abandons the turn.

### What must never appear inside that closure

Per §18, no call to Gemini, ElevenLabs, or any other side-effecting service may
happen inside a Firestore transaction. This is not a style rule. **The closure is
re-executed on contention**, so anything with an external effect would happen
more than once per logical append — duplicate charges, duplicate audio, duplicate
prompts. The turn lifecycle therefore does all cognition first (§14.6–14.11),
writes the audit record (§6 below), and only then opens a transaction containing
nothing but reads, comparisons and writes.

### Batch appends

A turn that resolves into several events (an action plus the conditions it
triggers) appends them in **one** transaction: N `create()` calls at
`head+1 … head+N` plus a single head update. Firestore's limit of 500 writes per
transaction caps a turn at 499 events, which is far beyond anything a single
action produces. Splitting a turn across transactions would let a crash leave
half a turn committed, which §15's "failed transactions cannot partially alter
state" forbids.

---

## 3. The other operations

| Port method | Firestore shape |
| --- | --- |
| `headSequence(worldId)` | single `get` on `worlds/{worldId}`; `-1` if absent |
| `head(worldId)` | `get` the world doc, then `get` `events/{pad(headSequence)}` |
| `read(worldId, from, to)` | `collection("worlds/{w}/events").orderBy(documentId()).startAt(pad(from)).endAt(pad(to))`, streamed with a page size of ~500 and no `orderBy` index required |

`read` must return an `AsyncIterable` backed by Firestore's streaming cursor, not
a materialised array — the same constraint as the file store, for the same
reason. A replay of a mature world reads millions of documents and must do so in
flat memory.

`StateStore` maps to `worlds/{worldId}/state/current`, holding `{ state,
sequence, checksum }` and validated on load exactly as `FileStateStore` validates
it: recompute the checksum from the stored state, then prove it against
`events/{pad(sequence)}.postStateChecksum`. A snapshot is a cache and is
discarded on any disagreement.

`IdempotencyStore.claim` is a `create()` on `idempotency/{key}` with an
`expiresAt` field; `ALREADY_EXISTS` means the claim was lost and the turn is
abandoned. A **Firestore TTL policy on `expiresAt`** does the sweeping, so no
scheduled job is needed. Note that TTL deletion is best-effort and can lag by
hours — which is fine, because the claim is only an optimisation. The guarantee
lives in the append transaction.

---

## 4. Indexes

### Composite indexes

Defined in `firestore.indexes.json` and deployed with the rules. Every one of
these is on the `events` collection (collection **group** scope where noted, so
cross-world queries are possible for the verifier and for ops).

| # | Fields | Scope | Serves |
| --- | --- | --- | --- |
| 1 | `actor ASC, sequence ASC` | collection | An inhabitant's own timeline: memory retrieval (§19) and the spectator's inhabitant view |
| 2 | `visibility.kind ASC, sequence DESC` | collection | The spectator's public feed — the only query an untrusted client is allowed to run |
| 3 | `visibility.kind ASC, visibility.x ASC, visibility.y ASC, sequence DESC` | collection | Everything that happened at a tile, for local-visibility resolution (§11E) |
| 4 | `visibility.kind ASC, visibility.organisationId ASC, sequence DESC` | collection | An organisation's internal record |
| 5 | `visibility.kind ASC, visibility.owner ASC, sequence DESC` | collection | One inhabitant's private events |
| 6 | `type ASC, sequence DESC` | collection | Operational queries: all deaths, all births, all freezes |
| 7 | `actor ASC, type ASC, sequence DESC` | collection | "What did this inhabitant do of this kind" — skill and career derivation (§9) |
| 8 | `simTime ASC, sequence ASC` | collection | Replay and audit windows expressed in world time |
| 9 | `worldId ASC, sequence ASC` | **group** | The verifier and nightly replay reading across worlds |

Index 2 is the one the security rules depend on; see §5.

Ordering a range scan by `sequence` alone needs no composite index, because the
document id *is* the sequence and `documentId()` ordering is always available.
That is worth the padding scheme on its own.

### Single-field index exemptions

These matter more than the composite indexes, and are easy to forget.

Automatic single-field indexing must be **disabled** for:

- `inputs`
- `resolution`
- `provenance`

They are arbitrary, deeply nested maps. Firestore indexes every field of every
map by default, which here would mean:

- **write amplification** — an event with a 40-field resolution costs dozens of
  index writes on top of the document write, on the hot path of every turn;
- **the 40,000 index entries per document limit**, which a large `resolution` can
  genuinely approach, at which point the write fails and the world stops;
- **an information leak**, because index entries are queryable and a private
  event's `inputs` would become searchable by anyone permitted to run a range
  query.

Nothing queries on the contents of these fields. They are payload, read only by
sequence, and must be exempted.

---

## 5. Security rules

The requirement from §17 is unambiguous: *the public client must have no
canonical write path*, and there are to be *no manual editing tools connected to
the canonical database*.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Nothing is writable by any client, ever. Not events, not world state,
    // not idempotency claims, not anchors. The simulation runtime writes
    // through the Admin SDK, which does not evaluate these rules at all — so
    // a blanket denial here costs the runtime nothing and closes the client
    // path completely.
    match /{document=**} {
      allow write: if false;
    }

    match /worlds/{worldId} {

      // The head pointer is public: it is what a spectator's UI polls, and it
      // is what an external verifier compares against a published anchor.
      allow get: if request.auth != null;
      allow list: if false;

      match /events/{sequence} {

        // A single event is readable only if it is public. Firestore evaluates
        // this per returned document on `get`.
        allow get: if request.auth != null
                   && resource.data.visibility.kind == 'public';

        // For `list`, Firestore does NOT filter — it rejects any query it
        // cannot prove will only return permitted documents. The client must
        // therefore constrain the query itself:
        //
        //     where('visibility.kind', '==', 'public')
        //           .orderBy('sequence', 'desc')
        //
        // which is served by composite index 2. Any broader query fails
        // closed. A client cannot widen its way into private cognition,
        // organisation records or local events, because the rule makes the
        // query itself invalid rather than trimming its results.
        allow list: if request.auth != null
                    && resource.data.visibility.kind == 'public';
      }

      // Materialised state is a cache with no visibility field on it; it is
      // reachable only through the runtime's read models, never directly.
      match /state/{document=**} {
        allow read: if false;
      }

      // Chain anchors are deliberately public: they are the artifact an
      // outside party uses to check that history has not been rewritten.
      match /anchors/{anchorId} {
        allow get, list: if true;
      }
    }

    // Turn claims are pure infrastructure and are never client-visible.
    match /idempotency/{key} {
      allow read: if false;
    }
  }
}
```

Supporting controls, all of which are part of the design and none of which the
rules alone provide:

- **App Check enforced** on Firestore, Cloud Storage and every callable, so the
  read paths above are reachable only from the genuine spectator app.
- **Least privilege service accounts.** The simulation runtime holds the only
  identity with write access to the events collection. The spectator app has no
  service account. The media service (§4G) and the replay service (§4I) hold
  read-only identities — they are structurally incapable of mutating the world,
  which is what §15's "media services cannot mutate world state" demands.
- **Separate projects** for development, staging, rehearsal and production, with
  no credential shared between them.
- **No admin console access to production data as a routine operation.** There is
  no tool to edit an inhabitant, a balance, a relationship or an event, because
  the ability to do it undetectably is the thing being designed against.
- **Emergency freeze** is the single permitted intervention (§17). It sets
  `frozen: true` on the world document *and* appends a canonical `world.frozen`
  event, so the freeze is itself part of the permanent public record. The
  transaction in §2 refuses to append to a frozen world. There is no
  corresponding "edit" switch.

### Why `allow write: if false` is sufficient rather than lax

The Admin SDK bypasses security rules entirely. So rules govern exactly one
population — untrusted clients — and for that population the correct answer to
every write is "no". Writing more nuanced write rules would imply some client
write path exists, and none does. The runtime's own correctness is enforced by
the transaction, by the schema validation in front of it, and by the hash chain
that makes any deviation detectable after the fact.

---

## 6. What does not go in Firestore

**Raw model prompts and responses.** §16 requires them stored securely for audit,
and they are large, unindexed, and sometimes permanently restricted. They belong
in Cloud Storage under `gs://{bucket}/audit/{worldId}/{pad(sequence)}.json`, with:

- a bucket policy denying all client access — the spectator never reads this
  bucket at any tier;
- object versioning and a retention policy, so the write-once property is
  enforced by the storage layer rather than by application code, mirroring what
  `FileModelAuditStore` achieves with `O_EXCL`;
- the same three-way classification the spec asks for: public, private until an
  inhabitant's death, permanently restricted.

The canonical event carries only `provenance.modelRequestHash` and
`provenance.modelResponseHash`. This keeps events comfortably inside Firestore's
1 MiB document limit and means a leak of the events collection does not leak
prompts.

**Point-in-time recovery must be enabled** on the production database, with daily
scheduled backups (§18). PITR is a floor, not a substitute for the chain: it
restores bytes, whereas `verifyChain` proves those bytes were never altered.

---

## 7. Known limits of this design

Stated plainly, because they constrain the world's pacing and someone will need
these numbers.

- **~1 sustained write per second per document.** Every append writes
  `worlds/{worldId}`, so that is the ceiling on canonical events per second for
  a single world. Turns are paced in simulated minutes and gated on a model round
  trip measured in seconds, so the real rate is orders of magnitude below this —
  but a world that ever wanted burst throughput would need the head pointer
  sharded, and sharding a compare-and-set target is not a small change. Design
  around the limit rather than into it.
- **Transaction contention under high concurrency degrades throughput.** Firestore
  retries a contended transaction with backoff. Twenty workers racing on one
  world's head will mostly retry and lose. The scheduler should therefore hand
  each world's turns to one worker at a time; the transaction is the safety net,
  not the scheduling strategy.
- **TTL deletion is best-effort and can lag by 24 hours.** Acceptable only
  because idempotency claims are an optimisation.
- **`create()` returns `ALREADY_EXISTS`, not a typed error.** The adapter must map
  it, and the head-mismatch case, onto `SequenceConflictError` so callers can
  treat the file store and Firestore identically. Any adapter that lets a raw
  Firestore error escape has broken the port abstraction that makes the engine
  testable.
- **Firestore's `serverTimestamp()` must never touch a canonical event.** Event
  fields are computed by the engine and hashed before the write; a
  server-assigned value would differ between the original run and replay, and
  every hash after it would break. `updatedAt` on the world pointer is not part
  of any hash and is the only place a server timestamp is permitted.
