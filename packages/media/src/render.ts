// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * The offline render pass (§4G, §21).
 *
 * Takes a list of lines the world has already recorded, synthesizes each one
 * and returns a manifest. It performs no world reads and no world writes — the
 * media service is "read-only with respect to the world" (§4G) — and it takes
 * its filesystem as a callback so that the whole pass is testable without
 * touching a disk or a network.
 *
 * Two properties matter more than speed:
 *
 *   - **Idempotence.** Clip filenames are content-addressed over everything
 *     that affects the audio. Re-running a render after adding one line costs
 *     one request, not four hundred. §21 requires audio generation to be
 *     selective; a pipeline that re-billed the whole corpus on every build
 *     would not survive contact with §15's spend limits.
 *
 *   - **Partial success.** A line that fails is recorded in `skipped` and the
 *     pass continues. The alternative — abort on first failure — turns one
 *     rate-limit into an empty release.
 */

import { sha256Hex } from "@after-genesis/core";
import type { ElevenLabsClient } from "./elevenlabs.js";
import {
  VOICE_MANIFEST_VERSION,
  type VoiceClip,
  type VoiceManifest,
} from "./manifest.js";
import {
  resolveVoiceId,
  type SpeakerRef,
  type VoiceKind,
  type VoiceRegistry,
} from "./voice-registry.js";

/** One thing to be said, already decided by the caller. */
export interface VoiceLine {
  readonly segmentId: string;
  readonly kind: VoiceKind;
  /** The line to synthesize. Already dramatised, if it was going to be. */
  readonly text: string;
  /** The canonical caption behind `text`. Equal to it when unstyled. */
  readonly canonicalText?: string;
  readonly styled?: boolean;
  readonly styleModelId?: string | null;
  /** Null for narration. */
  readonly speaker: (SpeakerRef & { readonly id: string; readonly displayName: string }) | null;
}

export interface RenderOptions {
  readonly worldId: string;
  readonly registry: VoiceRegistry;
  readonly client: ElevenLabsClient;
  /** Writes one audio file. Path is relative to the output root. */
  readonly writeAudio: (relativePath: string, audio: Uint8Array) => Promise<void>;
  /** Whether a content-addressed file is already present. Enables the cache. */
  readonly audioExists: (relativePath: string) => Promise<boolean>;
  /** Injected for reproducible manifests in tests. */
  readonly now?: () => Date;
  /** Stop after this many *new* syntheses. A spend guard for exploratory runs. */
  readonly maxNewClips?: number;
  readonly onProgress?: (message: string) => void;
}

export interface RenderReport {
  readonly manifest: VoiceManifest;
  readonly synthesized: number;
  readonly reused: number;
  readonly failed: number;
  readonly bytesWritten: number;
}

/** Empty or whitespace-only text is not a synthesis failure — it is nothing to say. */
function isSpeakable(text: string): boolean {
  return text.trim().length > 0;
}

/**
 * The clip filename.
 *
 * Hashed over every input that changes the resulting audio: the text, the
 * provider voice and the provider model. Two segments with identical captions
 * spoken by the narrator therefore resolve to one file, which is the common
 * case in a record full of repeated activities.
 */
function clipPath(text: string, providerVoiceId: string, modelId: string): string {
  const digest = sha256Hex(`${modelId}\0${providerVoiceId}\0${text}`);
  return `clips/${digest}.mp3`;
}

export async function renderVoiceLines(
  lines: readonly VoiceLine[],
  options: RenderOptions,
): Promise<RenderReport> {
  const clips: Record<string, VoiceClip> = {};
  const skipped: Record<string, string> = {};
  let synthesized = 0;
  let reused = 0;
  let failed = 0;
  let bytesWritten = 0;

  const budget = options.maxNewClips ?? Number.POSITIVE_INFINITY;
  // Paths written during *this* pass. `audioExists` reports the state of the
  // output directory as it was when the pass began, so without this the first
  // repeat of a caption within one run would be billed a second time.
  const writtenThisPass = new Set<string>();

  for (const line of lines) {
    if (!isSpeakable(line.text)) {
      skipped[line.segmentId] = "no text to speak";
      continue;
    }

    let providerVoiceId: string;
    try {
      providerVoiceId = resolveVoiceId(options.registry, line.kind, line.speaker);
    } catch (cause) {
      // A handle with no mapping is a configuration fault, not a world fault.
      // It is reported and skipped so the rest of the render still ships.
      skipped[line.segmentId] = cause instanceof Error ? cause.message : String(cause);
      failed += 1;
      continue;
    }

    const file = clipPath(line.text, providerVoiceId, options.registry.modelId);

    const record = (bytes: number): void => {
      clips[line.segmentId] = {
        segmentId: line.segmentId,
        file,
        kind: line.kind,
        speakerId: line.speaker?.id ?? null,
        speakerName: line.speaker?.displayName ?? "World Narrator",
        voiceHandle: line.kind === "narration" ? null : (line.speaker?.voiceHandle ?? null),
        providerVoiceId,
        text: line.text,
        canonicalText: line.canonicalText ?? line.text,
        styled: line.styled ?? false,
        styleModelId: line.styleModelId ?? null,
        bytes,
      };
    };

    if (writtenThisPass.has(file) || (await options.audioExists(file))) {
      reused += 1;
      record(0);
      continue;
    }

    if (synthesized >= budget) {
      skipped[line.segmentId] = "render budget reached";
      continue;
    }

    const result = await options.client.synthesize({
      text: line.text,
      voiceId: providerVoiceId,
      modelId: options.registry.modelId,
    });

    if (!result.ok) {
      skipped[line.segmentId] = result.error;
      failed += 1;
      options.onProgress?.(`FAIL ${line.segmentId}: ${result.error}`);
      continue;
    }

    await options.writeAudio(file, result.audio);
    writtenThisPass.add(file);
    synthesized += 1;
    bytesWritten += result.bytes;
    record(result.bytes);
    options.onProgress?.(`ok   ${line.segmentId} → ${file} (${result.bytes} bytes)`);
  }

  const manifest: VoiceManifest = {
    version: VOICE_MANIFEST_VERSION,
    worldId: options.worldId,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    providerModelId: options.registry.modelId,
    clips,
    skipped,
  };

  return { manifest, synthesized, reused, failed, bytesWritten };
}
