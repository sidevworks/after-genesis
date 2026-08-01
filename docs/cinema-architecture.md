# Cinema architecture — watching the canonical record

Status: implementation baseline
Date: 2026-07-28
Boundary: read-only projection above the Observatory, below nothing

> The world exists independently. The Observatory indexes it. The Cinema layer
> lets you watch it happen, minute by minute, without adding a single fact to it.

## 1. The problem this layer solves

The canonical world is a sequence of discrete resolved events. Each event says
*what changed* at one sim-minute and nothing about the minutes on either side.
That is exactly right for an auditable civilisation and exactly wrong for
watching one.

Before this layer, the spectator had two ways to see an inhabitant:

- a static three.js snapshot of a 15×15 tile patch, rebuilt from scratch on
  every prop change, showing the world at the last canonical tick, labelled
  "archive paused · no live movement";
- a three-phase event replay (`BEFORE` / `DURING` / `AFTER`) that teleported the
  actor between the endpoints of a single move at 1.6 seconds a phase.

Both are honest and neither is watchable. Nothing moved, nothing continued, and
there was no answer at all to "what was Ember doing on the afternoon of day 12".

The Cinema layer answers that question, for every inhabitant, for every minute
of the run, from canonical data alone.

## 2. The central idea: envelopes make time continuous

The canonical engine already records what is needed. Every resolved action calls
`beginActivity` (`packages/core/src/engine/resolvers/effects.ts`), which writes
an `ActivityRecord` into world state:

```ts
interface ActivityRecord {
  id: string;
  state: ActivityState;          // gathering, travelling, conversing, sleeping…
  actionType: ActionType;
  participants: readonly string[];
  location: Coord;
  startedAt: SimTime;
  endsAt: SimTime;               // startedAt + declared duration
  interruption: InterruptionPolicy;
  resourceCost: ResourceBundle;
  open: boolean;
  sequence: number;
}
```

This is a **time interval with a place, an occupant and an occupation**. A run of
them, sorted and gap-filled, is a continuous track of a life. The demonstration
run holds 497 of them across 600 turns and three inhabitants.

Interpolating a position between two canonical endpoints is not invention. The
engine recorded that an inhabitant travelled from (4, 0) to (5, 0) over ten
minutes; showing them halfway at minute five is reading that record, not
embellishing it. Every sampled value is marked `interpolated` so the distinction
survives into the renderer.

## 3. Disclosure policy 2 — a deliberate, reversible widening

**This is the one consequential change this work makes to what spectators can
see, and it deserves scrutiny.**

Policy 1 exported canonical events only. A `private` or `participants`-visibility
event became `withheld_event` with its actor, location, detail and outcome all
stripped to null. That meant a spectator could not learn that anything happened
at all — 230 of 601 events in the demonstration run disclosed nothing, including
every `observe` and every `communicate`.

That is stricter than the world's own information model. claude.md §11E
classifies information into three classes, and puts these in the first:

> ### Directly observable
> - Nearby inhabitants
> - Visible buildings
> - Visible land use
> - **Public activity**
> - Carried or exposed physical items
> - Public performances and announcements

and these in the third:

> ### Private or uncertain
> - Hidden storage
> - **Private conversations**
> - Private contracts
> - …
> - Private memories
> - Intentions

Two inhabitants standing on a tile talking for ninety minutes is a physical fact
that any passer-by could observe. The words are not. Policy 1 withheld both.

Policy 2 therefore splits every activity in two:

| Part | Contents | Disclosed? |
|---|---|---|
| **Envelope** | participants, location, activity state, action type, start tick, end tick, interruption policy | Always. Physically observable. |
| **Contents** | speech, reasoning, quantities, resolution detail | Only when the originating canonical event was `public` or `local` — unchanged from policy 1. |

Every exported activity carries `contentsDisclosed: boolean` saying which régime
applies to it. In the demonstration run 370 activities disclose contents and 127
do not (113 `observe`, 14 `communicate`).

### What this does and does not permit

It permits: showing that a conversation happened, where, between whom, and for
how long — and rendering the participants in a conversational posture, because
`activityState: "conversing"` is an envelope field.

It forbids, everywhere and by construction: reconstructing, summarising,
paraphrasing, inferring or hinting at withheld contents. No speech bubble, no
generated transcript, no "they appeared to be negotiating", no prop that encodes
a subject matter. The caption states plainly that the contents are withheld.

### Reversing it

`INCLUDE_ACTIVITY_ENVELOPES = false` in
`apps/spectator/src/fixtures/generate-observatory-export.mts`, then regenerate.
The export drops to policy 1 and the Cinema layer degrades to event-derived
segments with large `unrecorded` gaps — less watchable, equally honest.

## 4. Layers

```text
canonical event log + canonical world state
                |
                v
Observatory export  (generate-observatory-export.mts, disclosure policy 2)
                |
                v
Chronicle           lib/cinema/chronicle.ts
  discrete record → contiguous, gapless, per-inhabitant tracks
  + neutral factual captions
  + beats ranked by canonical significance
                |
                v
Sampler             lib/cinema/sample.ts
  (track, fractional tick) → ActorSample; binary search, pure, allocation-light
                |
        +-------+--------+
        |                |
        v                v
Director          Performances
lib/cinema/       lib/cinema/
director.ts       performances.ts
shot plan +       activity state → body clip
camera pose
        |                |
        +-------+--------+
                v
Stage               lib/stage/*
  persistent three.js renderer; instanced terrain, pooled articulated rigs,
  day/night sky driven by canonical sim time
                |
                v
React transport     components/cinema/*
  rAF playback clock, scrub, rate, captions, provenance
```

Every layer below the export is disposable and rebuildable. None of them
receives a canonical writer.

## 5. The contract

`apps/spectator/src/lib/cinema/types.ts` is the single contract between four
independently implemented layers. It imports nothing — not React, not three.js,
not Node — so it can be depended on from any of them.

The types that carry the honesty guarantees:

```ts
type Disclosure = "disclosed" | "envelope_only" | "unrecorded";
```

- `ChronicleSegment.detail` is `null` unless `disclosure === "disclosed"`. This
  is asserted by test, not by convention.
- `ActorSample.interpolated` says whether a position was read or computed.
- `PerformanceSpec.derived` is the literal type `true`, so no consumer can
  mistake a body clip for a canonical fact.
- `ChronicleBeat.reason` and `Shot.reason` state the canonical fact that earned
  the selection, and are surfaced in the interface as derived reasoning.

## 6. Rules the renderer must not break

1. **The activity state selects the body clip.** It is an envelope field and is
   always disclosed. `conversing` renders as conversation. Rendering a neutral
   posture there would be *less* accurate than the record, not more.
2. **The action type refines the clip only when contents are disclosed.**
   `consume` → `eat` or `drink` depends on `detail.resource`, which is content.
   With contents withheld, fall back to the activity-state clip rather than
   picking one and implying which it was.
3. **Contents are never depicted by any mechanism.** No text, no glyphs, no
   quantities, no subject-matter props.
4. **`unrecorded` intervals get the neutral `undisclosed` clip and distant
   framing.** The camera must not push in on an interval the record does not
   cover, as though closeness could reveal something.
5. **No shot is selected for being dramatic.** Beat weight comes from canonical
   facts — participant count, duration, first occurrence of an action type —
   never from how a moment would look. claude.md §26: "Do not create fake
   behaviours merely to make the world entertaining."
6. **Neutral captions.** Built from canonical fields only, no motive, no
   adjective, no profession. claude.md §11G.

## 7. Performance architecture

The previous renderer rebuilt the entire three.js scene inside a `useEffect`
keyed on its props — every camera nudge tore down and recreated a thousand
meshes. The Stage replaces that with:

- **mount once, live for the component's lifetime**; `render()` mutates
  transforms, uniforms and materials only, and allocates no geometry;
- **instanced terrain** — one `InstancedMesh` per terrain material covering the
  full map, with per-tile colour jitter and scatter derived from a hash of
  the coordinates, never from `Math.random()`, so the world looks the same on
  every load;
- **pooled actor rigs**, reused by inhabitant id; absent inhabitants are hidden,
  not destroyed;
- **binary-searched segment lookup** in the sampler, because it runs per actor
  per frame;
- **no `setState` in the animation loop.** `requestAnimationFrame` advances a
  tick held in a ref and drives the Stage directly; a 6 Hz interval copies a
  snapshot into React state purely so the caption and clock can be read. The
  picture runs at frame rate; the interface updates at reading rate.

## 8. Security posture, unchanged

The Cinema layer adds no route handler, no server action, no form, no non-GET
network call and no canonical SDK. `apps/spectator/src/lib/read-only.test.ts`
scans every source file and every rendered page in the static export for write
paths, and it covers these files exactly as it covers the rest.

The camera has no navigation, collision, cognition, event or state dependency
(`docs/observatory-architecture.md` §7). It cannot enter canonical space and
canonical space cannot perceive it. Playback controls scrub a finished
recording; the strongest verb available to a spectator is "rewind".

## 9. What the demonstration run can and cannot show

The exported run resolves five disclosed action types — `gather`, `move`,
`rest`, `consume`, `wait` — plus `observe` and `communicate` as envelopes. So
the Cinema layer can be watched doing resource collection, travel, sleep, meals
and conversation.

It cannot yet be watched building, crafting, writing, teaching, treating or
trading, because **no run has produced those events**. That is a property of the
offline mechanical cognition used for the rehearsal worlds, not of this layer:
the performance catalogue covers the entire `ActionTypeSchema` vocabulary, and
those actions will render the first time a world produces them.

Seeing them requires a run with real model cognition, which is gated behind the
pre-Genesis testing programme in `HANDOVER.md`. Nothing here should be taken as
a reason to shorten that programme.

## 10. Testing

- Chronicle: contiguity and gaplessness of every track; `detail === null`
  whenever contents are withheld; determinism across two independent builds;
  concrete assertions against the real 497-activity fixture.
- Sampler: binary-search correctness at segment boundaries; interpolation;
  purity.
- Performances: every action type in `ActionTypeSchema` resolves; the
  contents-withheld rule cannot be bypassed.
- Director: shots are sorted, contiguous, non-overlapping and never shorter than
  the stated minimum; plans are byte-identical across runs.
- Clips: continuity and looping at phase boundaries; joint angles within stated
  limits; determinism.
- Read-only: unchanged, and now covering every file added here.
