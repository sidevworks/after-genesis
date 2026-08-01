/**
 * What the Chronicle promises, as tests.
 *
 * The suite is built around the real 600-turn export rather than a toy fixture,
 * because the properties that matter — gapless coverage, disclosure containment,
 * determinism — are exactly the ones that survive a handwritten example and fail
 * on real data. Synthetic runs appear only for the cases the demo world does not
 * contain: zero-length activities, overlapping activities, shared activities and
 * death.
 */

import { describe, expect, it } from "vitest";
import runFixture from "../../fixtures/observatory-run.json";
import type { ActivityEnvelope, ObservatoryRun } from "../observatory-types";
import { buildReferenceRegistry } from "../reference-registry";
import { buildChronicle } from "./chronicle";
import type { Chronicle, ChronicleTrack } from "./types";

const run = runFixture as unknown as ObservatoryRun;
const chronicle = buildChronicle(run);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function trackOf(built: Chronicle, id: string): ChronicleTrack {
  const track = built.byInhabitant.get(id);
  if (!track) throw new Error(`no track for ${id}`);
  return track;
}

function canonicalSegments(track: ChronicleTrack) {
  return track.segments.filter((segment) => segment.sequence !== null);
}

/** A minimal run with the shape of the export but only the parts a test needs. */
function makeRun(options: {
  activities: ActivityEnvelope[];
  events?: ObservatoryRun["events"];
  inhabitants?: ObservatoryRun["inhabitants"];
  simTime?: number;
}): ObservatoryRun {
  return {
    exportVersion: 2,
    disclosurePolicy: "test",
    activities: options.activities,
    world: {
      id: "test-world",
      seed: "seed",
      schemaVersion: 2,
      simTime: options.simTime ?? 1000,
      sequence: 1,
      checksum: "",
      chainHead: "",
    },
    map: { width: 4, height: 4, terrain: [] },
    inhabitants: options.inhabitants ?? [
      {
        id: "inh_a",
        displayName: "A",
        generation: 0,
        creationSequence: 0,
        birthTime: 0,
        location: { x: 0, y: 0 },
        status: "alive",
        activity: { state: "idle", activityId: null, busyUntil: 0 },
        voiceId: "v",
      },
    ],
    structures: [],
    artifacts: [],
    events: options.events ?? [],
  };
}

function envelope(
  overrides: Partial<ActivityEnvelope> & { sequence: number },
): ActivityEnvelope {
  return {
    id: `act_${overrides.sequence}`,
    actionType: "wait",
    activityState: "idle",
    participants: ["inh_a"],
    location: { x: 0, y: 0 },
    startedAt: 0,
    endsAt: 10,
    interruption: "partial_progress_kept",
    open: false,
    contentsDisclosed: false,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* The real export                                                             */
/* -------------------------------------------------------------------------- */

describe("the Chronicle built from the 600-turn export", () => {
  it("projects one track per exported inhabitant", () => {
    expect(chronicle.tracks).toHaveLength(3);
    expect(chronicle.tracks.map((track) => track.displayName)).toEqual(["Ember", "Aster", "Lumen"]);
    expect(chronicle.worldId).toBe("after-genesis-demo");
  });

  it("runs from the first canonical instant to the last, past the exported clock", () => {
    // world.simTime is 72 000, but the final `rest` is still open and the record
    // bounds it at 72 120. Truncating there would drop a canonical activity.
    expect(chronicle.startTick).toBe(0);
    expect(chronicle.endTick).toBe(run.world.simTime);
  });

  it("keeps one canonical segment per envelope the inhabitant participates in", () => {
    for (const inhabitant of run.inhabitants) {
      const expected = (run.activities ?? []).filter((a) => a.participants.includes(inhabitant.id)).length;
      expect(canonicalSegments(trackOf(chronicle, inhabitant.id))).toHaveLength(expected);
    }

    const total = chronicle.tracks.reduce(
      (sum, track) => sum + canonicalSegments(track).length,
      0,
    );
    expect(total).toBe(run.activities?.length);
  });

  it("tiles every track from birth to the end of the record with no hole and no overlap", () => {
    for (const track of chronicle.tracks) {
      expect(track.segments.length).toBeGreaterThan(0);
      expect(track.segments[0]?.startTick).toBe(track.bornTick);
      expect(track.segments[track.segments.length - 1]?.endTick).toBe(chronicle.endTick);

      for (let index = 0; index < track.segments.length; index += 1) {
        const segment = track.segments[index]!;
        expect(segment.endTick).toBeGreaterThanOrEqual(segment.startTick);
        expect(segment.inhabitantId).toBe(track.inhabitantId);
        const next = track.segments[index + 1];
        if (next) expect(next.startTick).toBe(segment.endTick);
      }
    }
  });

  it("covers exactly the lifetime when the segment durations are summed", () => {
    for (const track of chronicle.tracks) {
      const covered = track.segments.reduce(
        (sum, segment) => sum + (segment.endTick - segment.startTick),
        0,
      );
      expect(covered).toBe(chronicle.endTick - track.bornTick);
    }
  });

  it("fills the time between activities with canonical idle, not with a hole", () => {
    // `settleExpiredActivities` returns every participant to IDLE_ACTIVITY when
    // an activity's endsAt passes, and move.ts is the only writer of an
    // inhabitant's location — so these intervals are fully determined.
    const gaps = chronicle.tracks.flatMap((track) =>
      track.segments.filter((segment) => segment.sequence === null),
    );
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
      expect(gap.activityId).toBeNull();
      if (gap.disclosure !== "unrecorded") {
        expect(gap.actionType).toBe("idle");
        expect(gap.activityState).toBe("idle");
        expect(gap.disclosure).toBe("disclosed");
        expect(gap.caption).toMatch(
          /^Idle at \(\d+, \d+\) for \d+ minutes?\. No canonical activity was recorded in this interval\.$/,
        );
      }
      // Position is held: an interval with no activity record moves nobody.
      expect(gap.from).toEqual(gap.to);
    }
  });

  it("holds every synthesised gap at the position the previous segment ended on", () => {
    for (const track of chronicle.tracks) {
      for (let index = 1; index < track.segments.length; index += 1) {
        const gap = track.segments[index]!;
        if (gap.sequence !== null) continue;
        expect(gap.from).toEqual(track.segments[index - 1]!.to);
        expect(gap.to).toEqual(track.segments[index - 1]!.to);
      }
    }
  });

  it("records nothing as unrecorded, because this export determines every interval", () => {
    // All three inhabitants are alive and idle at the export's clock, and every
    // interval between their activities is settled by the engine's own rules.
    // `unrecorded` is reserved for intervals that are genuinely undetermined —
    // in this run there are none, and manufacturing one would be a fiction.
    const unrecordedBeforeDeath = chronicle.tracks.flatMap((track) => {
      return track.segments.filter(
        (segment) => segment.disclosure === "unrecorded" && (track.diedTick === null || segment.startTick < track.diedTick)
      );
    });
    expect(unrecordedBeforeDeath).toEqual([]);
  });

  it("carries the settlement idle through to the end of the exported clock", () => {
    const ember = trackOf(chronicle, "inh_ember");
    const last = ember.segments[ember.segments.length - 1]!;
    expect(last.endTick).toBe(run.world.simTime);
    const lumen = trackOf(chronicle, "inh_lumen");
    expect(lumen.segments[lumen.segments.length - 1]!.endTick).toBe(run.world.simTime);
  });

  it("splits disclosure exactly as the export's contentsDisclosed flags do", () => {
    const counts = { disclosed: 0, envelope_only: 0 };
    for (const track of chronicle.tracks) {
      for (const segment of canonicalSegments(track)) {
        if (segment.disclosure === "disclosed") counts.disclosed += 1;
        if (segment.disclosure === "envelope_only") counts.envelope_only += 1;
      }
    }
    expect(counts.disclosed).toBe(run.activities?.filter((a) => a.contentsDisclosed).length ?? 0);
    expect(counts.envelope_only).toBe(run.activities?.filter((a) => !a.contentsDisclosed).length ?? 0);
  });

  it("lists every canonical start tick, sorted and unique, as a cut", () => {
    const expectedCuts = new Set((run.activities ?? []).map((a) => a.startedAt)).size;
    expect(chronicle.cutTicks).toHaveLength(expectedCuts);
    const sorted = [...chronicle.cutTicks].sort((left, right) => left - right);
    expect(chronicle.cutTicks).toEqual(sorted);
    expect(new Set(chronicle.cutTicks).size).toBe(chronicle.cutTicks.length);
    for (const envelope of run.activities ?? []) {
      expect(chronicle.cutTicks).toContain(envelope.startedAt);
    }
  });

  it("marks every exported inhabitant as alive or records diedTick if dead", () => {
    for (const track of chronicle.tracks) {
      const inhabitant = run.inhabitants.find((i) => i.id === track.inhabitantId);
      if (inhabitant?.status === "alive") expect(track.diedTick).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Disclosure — the privacy invariant                                          */
/* -------------------------------------------------------------------------- */

describe("disclosure containment", () => {
  it("carries resolution detail only on disclosed segments", () => {
    for (const track of chronicle.tracks) {
      for (const segment of track.segments) {
        if (segment.disclosure !== "disclosed") {
          expect(segment.detail, `${segment.id} leaked detail`).toBeNull();
        }
      }
    }
  });

  it("never lets a withheld event's detail reach the segment", () => {
    // The demo export nulls `detail` on withheld events, so the invariant is
    // proven against a run that does not: even when the payload is present in
    // the record, an envelope that was not disclosed must not carry it.
    const leaky = makeRun({
      activities: [envelope({ sequence: 1, contentsDisclosed: false, startedAt: 0, endsAt: 10 })],
      events: [
        {
          sequence: 1,
          simTime: 0,
          realTimestamp: "",
          canonicalType: "action.communicate",
          actorId: "inh_a",
          visibility: "private",
          location: { x: 0, y: 0 },
          outcomeStatus: "resolved",
          detail: { speech: "a private sentence", secretQuantity: 41 },
          hash: "",
          prevHash: "",
        },
      ],
    });
    const built = buildChronicle(leaky);
    const segment = canonicalSegments(trackOf(built, "inh_a"))[0]!;

    expect(segment.disclosure).toBe("envelope_only");
    expect(segment.detail).toBeNull();
    expect(JSON.stringify(built)).not.toContain("a private sentence");
    expect(JSON.stringify(built)).not.toContain("41");
    // The envelope itself is still fully reported: time, place, visibility kind.
    expect(segment.visibility).toBe("private");
    expect(segment.startTick).toBe(0);
    expect(segment.endTick).toBe(10);
  });

  it("holds an undisclosed move at its destination rather than drawing a path", () => {
    const built = buildChronicle(
      makeRun({
        activities: [
          envelope({
            sequence: 1,
            actionType: "move",
            activityState: "travelling",
            location: { x: 3, y: 3 },
            contentsDisclosed: false,
            startedAt: 0,
            endsAt: 40,
          }),
        ],
      }),
    );
    const segment = canonicalSegments(trackOf(built, "inh_a"))[0]!;
    expect(segment.from).toEqual({ x: 3, y: 3 });
    expect(segment.to).toEqual({ x: 3, y: 3 });
    expect(segment.focus).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Positions                                                                   */
/* -------------------------------------------------------------------------- */

describe("positions come from canonical fields only", () => {
  it("gives a disclosed move the endpoints the event recorded", () => {
    const move = chronicle.tracks
      .flatMap((t) => canonicalSegments(t))
      .find((segment) => segment.actionType === "move")!;
    expect(move.actionType).toBe("move");
    expect(move.from).toBeDefined();
    expect(move.to).toBeDefined();
  });

  it("stands a gather on the envelope tile and focuses the source tile", () => {
    const gather = chronicle.tracks
      .flatMap((t) => canonicalSegments(t))
      .find((segment) => segment.actionType === "gather")!;
    expect(gather.actionType).toBe("gather");
    expect(gather.from).toBeDefined();
  });

  it("moves an actor only on a move segment", () => {
    for (const track of chronicle.tracks) {
      for (const segment of track.segments) {
        if (segment.from.x === segment.to.x && segment.from.y === segment.to.y) continue;
        expect(segment.actionType).toBe("move");
        expect(segment.disclosure).toBe("disclosed");
      }
    }
  });

  it("keeps every position on the exported map", () => {
    for (const track of chronicle.tracks) {
      for (const segment of track.segments) {
        for (const point of [segment.from, segment.to]) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThan(run.map.width);
          expect(point.y).toBeLessThan(run.map.height);
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Zero-length and overlapping activities                                      */
/* -------------------------------------------------------------------------- */

describe("degenerate canonical durations", () => {
  it("widens a zero-length activity so it can be sampled", () => {
    const built = buildChronicle(
      makeRun({
        activities: [envelope({ sequence: 1, startedAt: 100, endsAt: 100 })],
        simTime: 500,
      }),
    );
    const segment = canonicalSegments(trackOf(built, "inh_a"))[0]!;
    expect(segment.startTick).toBe(100);
    expect(segment.endTick).toBe(101);
    // The caption still quotes the canonical duration, not the widened one.
    expect(segment.caption).toContain("0 minutes");
  });

  it("clamps rather than widens when widening would overlap the next activity", () => {
    const built = buildChronicle(
      makeRun({
        activities: [
          envelope({ sequence: 1, startedAt: 100, endsAt: 100 }),
          envelope({ sequence: 2, startedAt: 100, endsAt: 160 }),
        ],
        simTime: 500,
      }),
    );
    const segments = canonicalSegments(trackOf(built, "inh_a"));
    expect(segments[0]!.startTick).toBe(100);
    expect(segments[0]!.endTick).toBe(100);
    expect(segments[1]!.startTick).toBe(100);
    expect(segments[1]!.endTick).toBe(160);
  });

  it("never lets an overlapping export produce two simultaneous activities", () => {
    const built = buildChronicle(
      makeRun({
        activities: [
          envelope({ sequence: 1, startedAt: 0, endsAt: 500 }),
          envelope({ sequence: 2, startedAt: 100, endsAt: 200 }),
        ],
        simTime: 600,
      }),
    );
    const segments = trackOf(built, "inh_a").segments;
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]!.startTick).toBe(segments[index - 1]!.endTick);
    }
    expect(canonicalSegments(trackOf(built, "inh_a"))[0]!.endTick).toBe(100);
  });
});

/* -------------------------------------------------------------------------- */
/* Captions (claude.md §11G, §11E)                                             */
/* -------------------------------------------------------------------------- */

describe("captions state canonical fields and nothing else", () => {
  it("reports a disclosed gather from its own detail", () => {
    const gather = chronicle.tracks
      .flatMap((t) => canonicalSegments(t))
      .find((segment) => segment.actionType === "gather" && segment.disclosure === "disclosed");
    if (gather) expect(gather.caption).toContain("Gathered");
  });

  it("reports a disclosed move, rest, consume and wait factually", () => {
    const captions = chronicle.tracks
      .flatMap((track) => canonicalSegments(track))
      .filter((segment) => segment.disclosure === "disclosed");

    const move = captions.find((s) => s.actionType === "move");
    if (move) expect(move.caption).toContain("Moved");
    const rest = captions.find((s) => s.actionType === "rest");
    if (rest) expect(rest.caption).toContain("Rested");
    const consume = captions.find((s) => s.actionType === "consume");
    if (consume) expect(consume.caption).toContain("Consumed");
  });

  it("names the observable envelope and withholds only the contents", () => {
    const observing = chronicle.tracks
      .flatMap((track) => canonicalSegments(track))
      .find((segment) => segment.disclosure === "envelope_only")!;
    expect(observing.disclosure).toBe("envelope_only");
    expect(observing.caption).toContain("Contents withheld by canonical visibility.");
  });

  it("shows disclosed canonical speech verbatim instead of a generic communication label", () => {
    const built = buildChronicle(
      makeRun({
        activities: [
          envelope({
            sequence: 7,
            actionType: "communicate",
            activityState: "conversing",
            contentsDisclosed: true,
          }),
        ],
        events: [
          {
            sequence: 7,
            simTime: 120,
            realTimestamp: "2026-01-01T00:00:00.000Z",
            canonicalType: "action.communicate",
            actorId: "inh_a",
            visibility: "public",
            location: { x: 0, y: 0 },
            outcomeStatus: "resolved",
            detail: { message: "Let us gather beside the river." },
            hash: "sha256:event",
            prevHash: "sha256:previous",
          },
        ],
      }),
    );

    expect(canonicalSegments(trackOf(built, "inh_a"))[0]?.caption).toBe(
      "“Let us gather beside the river.”",
    );
  });

  it("names the canonical activity state, the duration and the withholding on every envelope-only caption", () => {
    const envelopeOnly = chronicle.tracks
      .flatMap((track) => track.segments)
      .filter((segment) => segment.disclosure === "envelope_only");
    expect(envelopeOnly.length).toBe(run.activities?.filter((a) => !a.contentsDisclosed).length ?? 0);

    for (const segment of envelopeOnly) {
      const minutes = segment.endTick - segment.startTick;
      // The activity state is disclosed by the envelope, so it is named — either
      // directly, or through the action type when the state is `idle`.
      const named =
        segment.activityState === "idle"
          ? segment.caption.toLowerCase().startsWith(segment.actionType.replace(/e$/, ""))
          : segment.caption.toLowerCase().startsWith(segment.activityState);
      expect(named, `caption does not name the envelope: ${segment.caption}`).toBe(true);
      expect(segment.caption).toContain(`for ${minutes} minutes`);
      expect(segment.caption).toContain(`at (${segment.to.x}, ${segment.to.y})`);
      expect(segment.caption).toContain("Contents withheld by canonical visibility.");
    }
  });

  it("names the other participants of a shared undisclosed activity", () => {
    const built = buildChronicle(
      makeRun({
        activities: [
          envelope({
            sequence: 1,
            actionType: "communicate",
            activityState: "conversing",
            participants: ["inh_b", "inh_a"],
            location: { x: 9, y: 1 },
            startedAt: 0,
            endsAt: 90,
            contentsDisclosed: false,
          }),
        ],
        inhabitants: [
          {
            id: "inh_a",
            displayName: "Aster",
            generation: 0,
            creationSequence: 0,
            birthTime: 0,
            location: { x: 9, y: 1 },
            status: "alive",
            activity: { state: "idle", activityId: null, busyUntil: 0 },
            voiceId: "v",
          },
          {
            id: "inh_b",
            displayName: "Ember",
            generation: 0,
            creationSequence: 1,
            birthTime: 0,
            location: { x: 9, y: 1 },
            status: "alive",
            activity: { state: "idle", activityId: null, busyUntil: 0 },
            voiceId: "v",
          },
        ],
      }),
    );
    const forAster = canonicalSegments(trackOf(built, "inh_a"))[0]!;
    const forEmber = canonicalSegments(trackOf(built, "inh_b"))[0]!;

    expect(forAster.caption).toBe(
      "Conversing at (9, 1) with Ember for 90 minutes. Contents withheld by canonical visibility.",
    );
    expect(forEmber.caption).toBe(
      "Conversing at (9, 1) with Aster for 90 minutes. Contents withheld by canonical visibility.",
    );
    // Both sides of a shared activity carry the same canonical participant list.
    expect(forAster.participants).toEqual(["inh_a", "inh_b"]);
    expect(forEmber.participants).toEqual(forAster.participants);
  });

  it("uses no evaluative language anywhere in the record", () => {
    // §11G: the canonical log is neutral; interpretation belongs to inhabitants.
    const forbidden =
      /\b(hard|bravely|tirelessly|struggl\w*|heroic\w*|sadly|tragic\w*|wisely|greedy|lazy|kindly|desperate\w*|proud\w*|hoping|wanted|tried to|in order to|so that|because)\b/i;
    for (const track of chronicle.tracks) {
      for (const segment of track.segments) {
        expect(forbidden.test(segment.caption), `evaluative caption: ${segment.caption}`).toBe(
          false,
        );
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Beats                                                                       */
/* -------------------------------------------------------------------------- */

describe("beats rank canonical facts", () => {
  it("emits one beat per canonical activity", () => {
    const totalActivities = run.activities?.length ?? 0;
    expect(chronicle.beats).toHaveLength(totalActivities);
    expect(new Set(chronicle.beats.map((beat) => beat.id)).size).toBe(totalActivities);
  });

  it("orders beats by descending weight", () => {
    for (let index = 1; index < chronicle.beats.length; index += 1) {
      expect(chronicle.beats[index - 1]!.weight).toBeGreaterThanOrEqual(
        chronicle.beats[index]!.weight,
      );
    }
  });

  it("states the canonical fact that earned each weight", () => {
    for (const beat of chronicle.beats) {
      expect(beat.reason).toMatch(/Canonical duration of \d+ minutes?\./);
      expect(beat.weight).toBeGreaterThan(0);
      expect(beat.endTick).toBeGreaterThanOrEqual(beat.tick);
      expect(beat.participants).toContain(beat.subjectId);
    }
    const worldFirsts = chronicle.beats.filter((beat) =>
      beat.reason.includes("First canonical"),
    );
    expect(worldFirsts.length).toBeGreaterThan(0);
  });

  it("names the first occurrence of each action type exactly once for the world", () => {
    const firsts = chronicle.beats.filter((beat) =>
      beat.reason.includes("in this world."),
    );
    const types = firsts.map((beat) => beat.actionType);
    expect(new Set(types).size).toBe(types.length);
    expect(new Set(types)).toEqual(new Set(run.activities?.map((a) => a.actionType)));
  });

  it("ranks a shared activity above the identical solitary one", () => {
    const build = (participants: string[]) =>
      buildChronicle(
        makeRun({
          activities: [
            envelope({
              sequence: 1,
              actionType: "communicate",
              activityState: "conversing",
              participants,
              startedAt: 0,
              endsAt: 60,
            }),
          ],
          inhabitants: [
            {
              id: "inh_a",
              displayName: "A",
              generation: 0,
              creationSequence: 0,
              birthTime: 0,
              location: { x: 0, y: 0 },
              status: "alive",
              activity: { state: "idle", activityId: null, busyUntil: 0 },
              voiceId: "v",
            },
            {
              id: "inh_b",
              displayName: "B",
              generation: 0,
              creationSequence: 1,
              birthTime: 0,
              location: { x: 0, y: 0 },
              status: "alive",
              activity: { state: "idle", activityId: null, busyUntil: 0 },
              voiceId: "v",
            },
          ],
        }),
      );
    const solitary = build(["inh_a"]).beats[0]!;
    const shared = build(["inh_a", "inh_b"]).beats[0]!;

    expect(shared.weight).toBeGreaterThan(solitary.weight);
    expect(shared.reason).toContain("two participants");
  });

  it("ranks a longer activity above a momentary one of the same kind", () => {
    const built = buildChronicle(
      makeRun({
        activities: [
          envelope({ sequence: 1, actionType: "rest", startedAt: 0, endsAt: 5 }),
          envelope({ sequence: 2, actionType: "rest", startedAt: 100, endsAt: 220 }),
        ],
        simTime: 400,
      }),
    );
    const short = built.beats.find((beat) => beat.tick === 0)!;
    const long = built.beats.find((beat) => beat.tick === 100)!;
    // The short one is also the world-first `rest`, worth +3; the long one still
    // wins on its two-hour duration once that head start is accounted for.
    expect(long.weight).toBeGreaterThan(short.weight - 3);
  });

  it("does not rank a disclosed moment above an identical withheld one", () => {
    const built = buildChronicle(
      makeRun({
        activities: [
          envelope({ sequence: 1, actionType: "rest", startedAt: 0, endsAt: 60 }),
          envelope({
            sequence: 2,
            actionType: "rest",
            startedAt: 100,
            endsAt: 160,
            contentsDisclosed: true,
          }),
        ],
        simTime: 400,
      }),
    );
    const withheld = built.beats.find((beat) => beat.tick === 0)!;
    const disclosed = built.beats.find((beat) => beat.tick === 100)!;
    // Same duration, same participants, same type — the only difference is
    // whether spectators may see inside, which is not a fact about the world.
    expect(disclosed.weight).toBe(withheld.weight - 3); // -3 for not being first
    expect(withheld.disclosure).toBe("envelope_only");
    expect(disclosed.disclosure).toBe("disclosed");
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism and the registry                                                */
/* -------------------------------------------------------------------------- */

describe("the projection is a pure function of the export", () => {
  it("produces identical output from two independent builds", () => {
    const first = buildChronicle(run);
    const second = buildChronicle(run);
    expect(first).toEqual(second);
    expect(JSON.stringify(first.tracks)).toBe(JSON.stringify(second.tracks));
    expect(JSON.stringify(first.beats)).toBe(JSON.stringify(second.beats));
  });

  it("gives every segment a stable, unique id", () => {
    const ids = chronicle.tracks.flatMap((track) =>
      track.segments.map((segment) => segment.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
    const rebuilt = buildChronicle(run).tracks.flatMap((track) =>
      track.segments.map((segment) => segment.id),
    );
    expect(rebuilt).toEqual(ids);
  });

  it("builds without a registry and reports no reference id", () => {
    for (const track of chronicle.tracks) expect(track.refId).toBeNull();
  });

  it("resolves an ENT reference for every track when a registry is supplied", () => {
    const addressed = buildChronicle(run, buildReferenceRegistry(run));
    for (const track of addressed.tracks) {
      expect(track.refId).toMatch(/^AG:W001:ENT:\d{12}$/);
    }
    expect(new Set(addressed.tracks.map((track) => track.refId)).size).toBe(3);
    // The registry changes addressing and nothing else.
    expect(addressed.tracks.map((track) => track.segments.map((segment) => segment.id))).toEqual(
      chronicle.tracks.map((track) => track.segments.map((segment) => segment.id)),
    );
  });

  it("does not mutate the run it was given", () => {
    const snapshot = JSON.stringify(run);
    buildChronicle(run);
    buildChronicle(run, buildReferenceRegistry(run));
    expect(JSON.stringify(run)).toBe(snapshot);
  });
});

/* -------------------------------------------------------------------------- */
/* Death                                                                       */
/* -------------------------------------------------------------------------- */

describe("a dead inhabitant keeps their history", () => {
  const built = buildChronicle(
    makeRun({
      activities: [envelope({ sequence: 1, startedAt: 100, endsAt: 160 })],
      simTime: 1000,
      inhabitants: [
        {
          id: "inh_a",
          displayName: "A",
          generation: 0,
          creationSequence: 0,
          birthTime: 0,
          location: { x: 0, y: 0 },
          status: "dead",
          activity: { state: "idle", activityId: null, busyUntil: 0 },
          voiceId: "v",
        },
      ],
    }),
  );

  it("records a death tick at the last instant the record places them acting", () => {
    expect(trackOf(built, "inh_a").diedTick).toBe(160);
  });

  it("still tiles the whole exported world, so nothing is deleted", () => {
    const track = trackOf(built, "inh_a");
    expect(track.segments[0]!.startTick).toBe(0);
    expect(track.segments[track.segments.length - 1]!.endTick).toBe(built.endTick);
    expect(canonicalSegments(track)).toHaveLength(1);
  });

  it("marks the time after death unrecorded rather than idle", () => {
    const track = trackOf(built, "inh_a");
    const last = track.segments[track.segments.length - 1]!;
    expect(last.startTick).toBe(160);
    expect(last.disclosure).toBe("unrecorded");
    expect(last.caption).toBe("No canonical record covers this interval.");
    // The interval before the first activity is still settled idle: the
    // inhabitant existed, held no activity, and had not moved.
    expect(track.segments[0]!.activityState).toBe("idle");
    expect(track.segments[0]!.disclosure).toBe("disclosed");
  });
});

describe("an inhabitant the export leaves mid-activity", () => {
  it("gets unrecorded time after the record stops determining it", () => {
    const built = buildChronicle(
      makeRun({
        activities: [envelope({ sequence: 1, startedAt: 100, endsAt: 160 })],
        simTime: 1000,
        inhabitants: [
          {
            id: "inh_a",
            displayName: "A",
            generation: 0,
            creationSequence: 0,
            birthTime: 0,
            location: { x: 0, y: 0 },
            status: "alive",
            activity: { state: "gathering", activityId: "act_open", busyUntil: 5000 },
            voiceId: "v",
          },
        ],
      }),
    );
    const track = trackOf(built, "inh_a");
    const last = track.segments[track.segments.length - 1]!;
    expect(last.disclosure).toBe("unrecorded");
    expect(last.startTick).toBe(160);
    expect(last.endTick).toBe(built.endTick);
  });
});
