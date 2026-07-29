/**
 * Voice line selection tests (§21, §12, §11G).
 *
 * The rules under test are editorial boundaries, not formatting: what may be
 * spoken in an inhabitant's own voice, what may only be narrated, and what must
 * stay silent. Getting these wrong produces a plausible-sounding world that
 * asserts things the record never contained.
 */
import { describe, expect, it } from "vitest";
import { buildChronicle } from "./chronicle";
import { speakerLookupFor } from "./speakers";
import { canonicalSpeech, selectVoiceLines, type SpeakerRef } from "./voice-lines";
import type { ObservatoryRun } from "../observatory-types";

function run(overrides: Partial<ObservatoryRun> = {}): ObservatoryRun {
  return {
    exportVersion: 3,
    disclosurePolicy: "test",
    world: {
      id: "world_test",
      seed: "seed",
      schemaVersion: 1,
      simTime: 2000,
      sequence: 10,
      checksum: "sha256:x",
      chainHead: "sha256:y",
    },
    map: { width: 4, height: 4, terrain: ["plains", "plains", "plains", "plains"] },
    inhabitants: [
      {
        id: "inh_a",
        displayName: "Aster",
        generation: 0,
        creationSequence: 0,
        birthTime: 0,
        location: { x: 0, y: 0 },
        status: "alive",
        activity: { state: "idle", activityId: null, busyUntil: 0 },
        voiceId: "voice_f04",
        sex: "female",
        maturity: 5,
      },
      {
        id: "inh_b",
        displayName: "Berrun",
        generation: 1,
        creationSequence: 2,
        birthTime: 100,
        location: { x: 1, y: 0 },
        status: "alive",
        activity: { state: "idle", activityId: null, busyUntil: 0 },
        voiceId: "voice_m02",
        sex: "male",
        maturity: 0,
      },
    ],
    structures: [],
    artifacts: [],
    events: [],
    activities: [],
    ...overrides,
  } as ObservatoryRun;
}

function activity(over: Record<string, unknown>) {
  return {
    id: "act_1",
    sequence: 1,
    actionType: "communicate",
    activityState: "conversing",
    participants: ["inh_a"],
    location: { x: 0, y: 0 },
    startedAt: 100,
    endsAt: 160,
    interruption: "partial_progress_kept",
    open: false,
    contentsDisclosed: true,
    ...over,
  };
}

function linesFor(activities: readonly Record<string, unknown>[]) {
  const source = run({ activities: activities as never });
  const chronicle = buildChronicle(source);
  return selectVoiceLines(chronicle, speakerLookupFor(source), { notableOnly: false });
}

describe("canonicalSpeech", () => {
  it("returns nothing when the contents were withheld (§11E)", () => {
    const chronicle = buildChronicle(
      run({ activities: [activity({ contentsDisclosed: false })] as never }),
    );
    const segment = chronicle.tracks
      .flatMap((track) => track.segments)
      .find((candidate) => candidate.actionType === "communicate");
    expect(segment).toBeDefined();
    expect(canonicalSpeech(segment!)).toBeNull();
  });

  it("returns nothing for an action that is not speech", () => {
    const chronicle = buildChronicle(
      run({ activities: [activity({ actionType: "gather", activityState: "gathering" })] as never }),
    );
    const segment = chronicle.tracks
      .flatMap((track) => track.segments)
      .find((candidate) => candidate.actionType === "gather");
    expect(canonicalSpeech(segment!)).toBeNull();
  });
});

describe("selectVoiceLines", () => {
  it("never voices withheld time, in any voice (§11E, §11G)", () => {
    const lines = linesFor([activity({ contentsDisclosed: false })]);
    expect(lines).toHaveLength(0);
  });

  it("narrates a disclosed activity in the narrator's voice, not the actor's", () => {
    const lines = linesFor([activity({ actionType: "gather", activityState: "gathering" })]);
    const line = lines.find((candidate) => candidate.text.length > 0);
    expect(line?.kind).toBe("narration");
    expect(line?.speaker).toBeNull();
  });

  it("does not turn a two-participant caption into dialogue (§11G)", () => {
    // The envelope records that they conversed, not exact words. Picking one
    // and voicing the caption as their line would invent a canonical quote.
    const lines = linesFor([activity({ participants: ["inh_a", "inh_b"] })]);
    expect(lines.every((line) => line.kind === "narration")).toBe(true);
  });

  it("assigns each inhabitant the voice handle from the canonical record", () => {
    const source = run();
    const lookup = speakerLookupFor(source);
    expect(lookup("inh_a")).toMatchObject<Partial<SpeakerRef>>({
      voiceHandle: "voice_f04",
      sex: "female",
    });
    expect(lookup("inh_b")).toMatchObject<Partial<SpeakerRef>>({
      voiceHandle: "voice_m02",
      sex: "male",
      maturity: 0,
    });
  });

  it("voices disclosed canonical speech verbatim in the speaker's assigned voice", () => {
    const source = run({
      activities: [
        activity({
          participants: ["inh_a", "inh_b"],
          contentsDisclosed: true,
        }),
      ] as never,
      events: [
        {
          sequence: 1,
          simTime: 100,
          realTimestamp: "2026-01-01T00:00:00.000Z",
          canonicalType: "action.communicate",
          actorId: "inh_a",
          visibility: "public",
          location: { x: 0, y: 0 },
          outcomeStatus: "resolved",
          detail: { message: "I found water beyond the ridge." },
          hash: "sha256:event",
          prevHash: "sha256:genesis",
        },
      ],
    });

    const dialogue = selectVoiceLines(
      buildChronicle(source),
      speakerLookupFor(source),
      { notableOnly: true },
    ).find((line) => line.kind === "dialogue");

    expect(dialogue).toMatchObject({
      text: "I found water beyond the ridge.",
      speaker: {
        id: "inh_a",
        displayName: "Aster",
        voiceHandle: "voice_f04",
      },
    });
  });

  it("returns lines in a stable order across repeated selection", () => {
    // The renderer's budget truncates this list. An unstable order would
    // render a different subset on every build.
    const activities = [
      activity({ id: "act_1", sequence: 1, actionType: "gather", activityState: "gathering" }),
      activity({
        id: "act_2",
        sequence: 2,
        actionType: "build",
        activityState: "building",
        startedAt: 300,
        endsAt: 400,
      }),
    ];
    const first = linesFor(activities).map((line) => line.segmentId);
    const second = linesFor(activities).map((line) => line.segmentId);
    expect(first).toEqual(second);
    expect([...first].sort()).toEqual(first);
  });

  it("emits at most one line per chronicle segment", () => {
    const lines = linesFor([activity({ participants: ["inh_a", "inh_b"] })]);
    expect(new Set(lines.map((line) => line.segmentId)).size).toBe(lines.length);
  });
});

describe("speakerLookupFor", () => {
  it("gives legacy fixtures without a canonical sex a stable derived voice", () => {
    const legacy = run({
      inhabitants: [
        {
          id: "INH-001",
          displayName: "Aleth",
          generation: 0,
          creationSequence: 0,
          birthTime: 0,
          location: { x: 0, y: 0 },
          status: "alive",
          activity: { state: "idle", activityId: null, busyUntil: 0 },
          voiceId: "elv-inh-001-22b3",
        },
      ] as never,
    });

    const first = speakerLookupFor(legacy)("INH-001");
    const second = speakerLookupFor(legacy)("INH-001");
    expect(first).toEqual(second);
    expect(first?.voiceHandle).toMatch(/^voice_[mf]\d\d$/);
  });

  it("treats a legacy inhabitant as an adult rather than a child", () => {
    // Defaulting maturity to 0 would render every historical figure with the
    // child voice.
    const legacy = run({
      inhabitants: [
        {
          id: "INH-002",
          displayName: "Berrun",
          generation: 0,
          creationSequence: 0,
          birthTime: 0,
          location: { x: 0, y: 0 },
          status: "alive",
          activity: { state: "idle", activityId: null, busyUntil: 0 },
          voiceId: "elv-inh-002",
        },
      ] as never,
    });
    expect(speakerLookupFor(legacy)("INH-002")?.maturity).toBeGreaterThanOrEqual(3);
  });

  it("returns null for an inhabitant the run does not contain", () => {
    expect(speakerLookupFor(run())("inh_nobody")).toBeNull();
  });
});

describe("duration reported to the narrator matches the caption", () => {
  it("uses the envelope's declared duration, not the truncated tick span", () => {
    // A build declaring 320 minutes, cut short on the track by the next
    // activity. Taking the tick span would have the narrator say "briefly"
    // over a caption reading "over 320 minutes".
    const source = run({
      activities: [
        activity({
          id: "act_long",
          sequence: 1,
          actionType: "build",
          activityState: "building",
          startedAt: 100,
          endsAt: 420,
        }),
        activity({
          id: "act_next",
          sequence: 2,
          actionType: "rest",
          activityState: "sleeping",
          startedAt: 130,
          endsAt: 200,
        }),
      ] as never,
    });

    const lines = selectVoiceLines(buildChronicle(source), speakerLookupFor(source), {
      notableOnly: false,
    });
    const build = lines.find((line) => line.actionType === "build");
    expect(build).toBeDefined();
    expect(build!.minutes).toBe(320);
  });

  it("reports the minute of the world day the activity began", () => {
    const source = run({
      activities: [
        activity({ actionType: "gather", activityState: "gathering", startedAt: 1500, endsAt: 1560 }),
      ] as never,
    });
    const lines = selectVoiceLines(buildChronicle(source), speakerLookupFor(source), {
      notableOnly: false,
    });
    const line = lines.find((candidate) => candidate.actionType === "gather");
    // 1500 is day 2, minute 60 — an hour past midnight, not minute 1500.
    expect(line!.minuteOfDay).toBe(60);
  });
});
