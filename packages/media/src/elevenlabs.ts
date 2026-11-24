// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * The ElevenLabs text-to-speech client (§21, §4G).
 *
 * ## Where this runs, and where it must not
 *
 * Offline, in the renderer, on a machine that holds `ELEVENLABS_API_KEY`.
 * Never in the browser and never inside a Firestore transaction (§18: "Never
 * call Gemini, ElevenLabs or another external side-effecting service from
 * inside a Firestore transaction").
 *
 * The spectator app is a static export with no server (see
 * `apps/spectator/next.config.mjs`), so there is no route that could proxy a
 * request and no build step that could ship the key to a viewer. Audio is
 * rendered ahead of time into files; the browser only ever fetches a `.mp3`.
 *
 * ## Failure is expected and contained
 *
 * §21: "A failed audio job must never block or change the simulation." Nothing
 * here touches world state, and `synthesize` reports failure as a value rather
 * than throwing, so one refused line cannot abort a render of four hundred.
 */

const ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";

export interface SynthesisRequest {
  readonly text: string;
  readonly voiceId: string;
  readonly modelId: string;
  /** Integer per mille, matching the canonical `VoiceIdentity` schema. */
  readonly stabilityPermille?: number;
  readonly similarityPermille?: number;
}

export type SynthesisResult =
  | { readonly ok: true; readonly audio: Uint8Array; readonly bytes: number }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

export interface ElevenLabsOptions {
  readonly apiKey: string;
  /** Injected so tests never reach the network. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly maxAttempts?: number;
  /** Injected so tests do not actually sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 60_000;

/** 429 and 5xx are worth retrying; 401 and 422 will fail identically forever. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class ElevenLabsClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #maxAttempts: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timeoutMs: number;

  constructor(options: ElevenLabsOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error("ELEVENLABS_API_KEY is empty; refusing to start a render that cannot succeed");
    }
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    let last: SynthesisResult = { ok: false, error: "no attempt was made", retryable: false };

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      last = await this.#attempt(request);
      if (last.ok || !last.retryable) return last;
      if (attempt < this.#maxAttempts) {
        // Exponential backoff. The renderer is offline and unattended; being
        // slow is free, being rate-limited into a partial render is not.
        await this.#sleep(500 * 2 ** (attempt - 1));
      }
    }
    return last;
  }

  async #attempt(request: SynthesisRequest): Promise<SynthesisResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(`${ENDPOINT}/${encodeURIComponent(request.voiceId)}`, {
        method: "POST",
        headers: {
          "xi-api-key": this.#apiKey,
          "content-type": "application/json",
          accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: request.text,
          model_id: request.modelId,
          voice_settings: {
            stability: (request.stabilityPermille ?? 500) / 1000,
            similarity_boost: (request.similarityPermille ?? 750) / 1000,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // The body may carry the provider's reason. Truncated: it is logged,
        // and an unbounded provider string in a log line is a liability.
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        return {
          ok: false,
          error: `ElevenLabs responded ${response.status}${detail ? `: ${detail}` : ""}`,
          retryable: isRetryableStatus(response.status),
        };
      }

      const audio = new Uint8Array(await response.arrayBuffer());
      if (audio.byteLength === 0) {
        return { ok: false, error: "ElevenLabs returned an empty body", retryable: true };
      }
      return { ok: true, audio, bytes: audio.byteLength };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // Network faults and timeouts are transient by nature.
      return { ok: false, error: message, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }
}
