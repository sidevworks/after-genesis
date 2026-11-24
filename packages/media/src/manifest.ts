// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * The rendered-audio manifest — the contract between the offline renderer and
 * the spectator player.
 *
 * The spectator app is a static export. It cannot call a provider, cannot hold
 * a key and cannot decide at runtime what a line should sound like. Everything
 * it needs is decided here, ahead of time, and published as one JSON file
 * alongside the audio.
 *
 * §12: "Generated media must be clearly distinguishable from canonical world
 * actions." Every clip therefore carries its `kind` and the exact `text` that
 * was spoken, so the UI can label narration as narration and never present a
 * derived caption as an inhabitant's own words.
 */

/**
 * This module deliberately imports nothing.
 *
 * It is the one part of the media package the browser loads, via the
 * `@after-genesis/media/manifest` subpath. The package's main entry re-exports
 * modules using explicit `.js` specifiers — correct for Node's `nodenext`
 * resolution, and unresolvable by the app bundler, which reads TypeScript
 * sources directly. Keeping this file import-free means the player shares the
 * exact contract the renderer writes, with no bundler configuration and no
 * risk of pulling the ElevenLabs client (and its API-key handling) into a
 * client bundle.
 */

/** How a line of audio is to be spoken. */
export type VoiceKind =
  /** The world narrator. Derived caption text, not an inhabitant's words. */
  | "narration"
  /** An inhabitant's own canonical speech, in its assigned voice. */
  | "dialogue";

export const VOICE_MANIFEST_VERSION = 1;

export interface VoiceClip {
  /** The chronicle segment this clip voices. Deterministic across rebuilds. */
  readonly segmentId: string;
  /** Path relative to the manifest. Content-addressed, so identical text shares a file. */
  readonly file: string;
  readonly kind: VoiceKind;
  /** Null for narration. */
  readonly speakerId: string | null;
  readonly speakerName: string;
  /** Canonical handle (`voice_f04`). Null for narration. */
  readonly voiceHandle: string | null;
  /** The provider voice actually used. Published so the audio is auditable. */
  readonly providerVoiceId: string;
  /** Exactly what was spoken. The UI shows this rather than re-deriving it. */
  readonly text: string;
  /**
   * The canonical chronicle caption this clip came from.
   *
   * Equal to `text` unless `styled` is true. Always present, so the record's
   * own words are one field away from whatever was spoken over the footage —
   * §12 requires generated media to stay distinguishable from canonical
   * action, and a UI cannot show the difference it was never given.
   */
  readonly canonicalText: string;
  /**
   * Whether `text` is a model-written dramatisation of `canonicalText` rather
   * than the caption itself. Drives the "Dramatised narration" label.
   */
  readonly styled: boolean;
  /** The model that wrote the dramatisation, or null. Recorded per §3. */
  readonly styleModelId: string | null;
  readonly bytes: number;
}

export interface VoiceManifest {
  readonly version: number;
  readonly worldId: string;
  /** ISO 8601. Real time, not sim time: this is a build artifact, not history. */
  readonly generatedAt: string;
  readonly providerModelId: string;
  /** Keyed by `segmentId`. */
  readonly clips: Readonly<Record<string, VoiceClip>>;
  /** Segments the renderer deliberately did not voice, and why. */
  readonly skipped: Readonly<Record<string, string>>;
}

export const EMPTY_MANIFEST: VoiceManifest = Object.freeze({
  version: VOICE_MANIFEST_VERSION,
  worldId: "",
  generatedAt: "1970-01-01T00:00:00.000Z",
  providerModelId: "",
  clips: Object.freeze({}),
  skipped: Object.freeze({}),
});

/**
 * Whether a parsed object is a manifest this build can play.
 *
 * The player runs this on fetched JSON. A stale manifest from an older render
 * must degrade to silence with a visible notice, never to a crash or — worse —
 * to a fallback that fabricates audio.
 */
export function isPlayableManifest(value: unknown): value is VoiceManifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<VoiceManifest>;
  return (
    candidate.version === VOICE_MANIFEST_VERSION &&
    typeof candidate.clips === "object" &&
    candidate.clips !== null
  );
}
