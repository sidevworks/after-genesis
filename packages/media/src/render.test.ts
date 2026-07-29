/**
 * Render pass tests (§21, §15, §18).
 *
 * No test here reaches the network: the client is constructed with an injected
 * `fetchImpl`, which also proves the seam exists — a media pipeline that could
 * only be tested against a live billed API would not be tested.
 */
import { VOICES_PER_SEX } from "@after-genesis/core";
import { describe, expect, it, vi } from "vitest";
import { ElevenLabsClient } from "./elevenlabs.js";
import { renderVoiceLines, type VoiceLine } from "./render.js";
import { buildVoiceRegistry } from "./voice-registry.js";

const registry = buildVoiceRegistry({
  ELEVENLABS_VOICE_NARRATION: "narrator",
  ELEVENLABS_VOICES_MALE: Array.from({ length: VOICES_PER_SEX }, (_, i) => `m${i}`).join(","),
  ELEVENLABS_VOICES_FEMALE: Array.from({ length: VOICES_PER_SEX }, (_, i) => `f${i}`).join(","),
  ELEVENLABS_VOICE_CHILD_MALE: "boy",
  ELEVENLABS_VOICE_CHILD_FEMALE: "girl",
  ELEVENLABS_MODEL_ID: "test-model",
  MEDIA_CHILD_MATURITY_BELOW: "3",
});

function okFetch(): typeof fetch {
  return vi.fn(async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
  ) as unknown as typeof fetch;
}

function harness(fetchImpl: typeof fetch, present = new Set<string>()) {
  const written = new Map<string, Uint8Array>();
  const client = new ElevenLabsClient({ apiKey: "test-key", fetchImpl, sleep: async () => {} });
  return {
    written,
    client,
    options: {
      worldId: "world_test",
      registry,
      client,
      writeAudio: async (path: string, audio: Uint8Array) => {
        written.set(path, audio);
      },
      audioExists: async (path: string) => present.has(path),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    },
  };
}

const narration = (id: string, text: string): VoiceLine => ({
  segmentId: id,
  kind: "narration",
  text,
  speaker: null,
});

const dialogue = (id: string, text: string, voiceHandle: string): VoiceLine => ({
  segmentId: id,
  kind: "dialogue",
  text,
  speaker: { id: "inh_a", displayName: "Aster", voiceHandle, sex: "female", maturity: 5 },
});

describe("renderVoiceLines", () => {
  it("synthesizes one clip per line and records it in the manifest", async () => {
    const fetchImpl = okFetch();
    const { options, written } = harness(fetchImpl);
    const report = await renderVoiceLines(
      [narration("seg-1", "The first day."), narration("seg-2", "The second day.")],
      options,
    );

    expect(report.synthesized).toBe(2);
    expect(report.failed).toBe(0);
    expect(written.size).toBe(2);
    expect(Object.keys(report.manifest.clips)).toEqual(["seg-1", "seg-2"]);
    expect(report.manifest.clips["seg-1"]!.text).toBe("The first day.");
  });

  it("bills identical text spoken by the same voice exactly once", async () => {
    const fetchImpl = okFetch();
    const { options } = harness(fetchImpl);
    const report = await renderVoiceLines(
      [narration("seg-1", "Ember rested."), narration("seg-2", "Ember rested.")],
      options,
    );

    // Content-addressed: the second segment reuses the first segment's file.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(report.manifest.clips["seg-1"]!.file).toBe(report.manifest.clips["seg-2"]!.file);
  });

  it("does not re-synthesize a clip already present on disk", async () => {
    const first = okFetch();
    const { options: firstOptions, written } = harness(first);
    const initial = await renderVoiceLines([narration("seg-1", "A line.")], firstOptions);

    const second = okFetch();
    const { options: secondOptions } = harness(second, new Set(written.keys()));
    const report = await renderVoiceLines([narration("seg-1", "A line.")], secondOptions);

    expect(second).not.toHaveBeenCalled();
    expect(report.reused).toBe(1);
    expect(report.manifest.clips["seg-1"]!.file).toBe(initial.manifest.clips["seg-1"]!.file);
  });

  it("gives narration and dialogue of the same text different clips (§12, §21)", async () => {
    const fetchImpl = okFetch();
    const { options } = harness(fetchImpl);
    const report = await renderVoiceLines(
      [narration("seg-1", "I will go north."), dialogue("seg-2", "I will go north.", "voice_f03")],
      options,
    );

    // Distinguishability is the point: the narrator describing an inhabitant
    // must never be mistakable for the inhabitant speaking.
    expect(report.manifest.clips["seg-1"]!.file).not.toBe(report.manifest.clips["seg-2"]!.file);
    expect(report.manifest.clips["seg-1"]!.providerVoiceId).toBe("narrator");
    expect(report.manifest.clips["seg-2"]!.providerVoiceId).toBe("f2");
    expect(report.manifest.clips["seg-1"]!.speakerId).toBeNull();
    expect(report.manifest.clips["seg-2"]!.speakerId).toBe("inh_a");
  });

  it("continues past a failed line and records why it was skipped (§21)", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // 422 is terminal, so this line fails once and is not retried.
      return call === 1
        ? new Response("voice not found", { status: 422 })
        : new Response(new Uint8Array([9]), { status: 200 });
    }) as unknown as typeof fetch;

    const { options } = harness(fetchImpl);
    const report = await renderVoiceLines(
      [narration("seg-1", "Doomed line."), narration("seg-2", "Fine line.")],
      options,
    );

    expect(report.failed).toBe(1);
    expect(report.synthesized).toBe(1);
    expect(report.manifest.clips["seg-1"]).toBeUndefined();
    expect(report.manifest.skipped["seg-1"]).toMatch(/422/);
    expect(report.manifest.clips["seg-2"]).toBeDefined();
  });

  it("stops synthesizing once the spend budget is reached (§15)", async () => {
    const fetchImpl = okFetch();
    const { options } = harness(fetchImpl);
    const lines = ["a", "b", "c", "d"].map((t, i) => narration(`seg-${i}`, `line ${t}`));
    const report = await renderVoiceLines(lines, { ...options, maxNewClips: 2 });

    expect(report.synthesized).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(report.manifest.skipped["seg-2"]).toMatch(/budget/);
  });

  it("says nothing for an empty line instead of billing for silence", async () => {
    const fetchImpl = okFetch();
    const { options } = harness(fetchImpl);
    const report = await renderVoiceLines([narration("seg-1", "   ")], options);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(report.failed).toBe(0);
    expect(report.manifest.skipped["seg-1"]).toMatch(/no text/);
  });

  it("produces a manifest and nothing else — no world state is reachable", async () => {
    const fetchImpl = okFetch();
    const { options } = harness(fetchImpl);
    const report = await renderVoiceLines([narration("seg-1", "A line.")], options);

    // §15: "Media services cannot mutate world state." The render pass is given
    // no world, no store and no writer beyond one that emits audio bytes.
    expect(Object.keys(report)).toEqual([
      "manifest",
      "synthesized",
      "reused",
      "failed",
      "bytesWritten",
    ]);
    expect(report.manifest.worldId).toBe("world_test");
  });
});

describe("ElevenLabsClient", () => {
  it("retries a 429 and succeeds", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response("slow down", { status: 429 })
        : new Response(new Uint8Array([7]), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new ElevenLabsClient({ apiKey: "k", fetchImpl, sleep: async () => {} });
    const result = await client.synthesize({ text: "hi", voiceId: "v", modelId: "m" });

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401, because the next attempt fails identically", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("bad key", { status: 401 }),
    ) as unknown as typeof fetch;

    const client = new ElevenLabsClient({ apiKey: "k", fetchImpl, sleep: async () => {} });
    const result = await client.synthesize({ text: "hi", voiceId: "v", modelId: "m" });

    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a network fault as a value rather than throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const client = new ElevenLabsClient({
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
      maxAttempts: 2,
    });
    const result = await client.synthesize({ text: "hi", voiceId: "v", modelId: "m" });

    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(result.ok === false && result.error).toMatch(/ECONNRESET/);
  });

  it("refuses to construct with an empty API key", () => {
    expect(() => new ElevenLabsClient({ apiKey: "  " })).toThrow(/ELEVENLABS_API_KEY/);
  });
});
