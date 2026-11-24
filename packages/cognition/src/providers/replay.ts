// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Replay provider — serves recorded responses, never calls anything (§16).
 *
 * §4I requires an audit service that "reconstructs the complete world from
 * Genesis and recorded model responses, verifies event hashes and compares the
 * reconstructed state checksum with production", and §15 makes the acceptance
 * criterion explicit: "Replayed history produces an identical state checksum."
 *
 * That is only possible because the model is *not* re-consulted. No hosted LLM
 * is bit-reproducible — not at temperature 0, not with a fixed seed, not across
 * a silent server-side model update. The recorded response is the only stable
 * artefact, so replay reads it back and treats it as the input it always was.
 *
 * The single most important line in this file is the one that throws when a
 * response is missing. Falling back to a live call would produce a response that
 * was never part of history, feed it through the engine, and let the resulting
 * event be hash-chained and published as verified history. The audit would then
 * be attesting to a decision no inhabitant ever made. A loud failure is the only
 * acceptable behaviour, so there is no option to disable it and no code path
 * that reaches a network.
 *
 * This class holds no fetch, no API key, no endpoint and no HTTP client. It
 * cannot make a live call even if a future caller asks it to.
 */
import type {
  ModelAuditStore,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "@after-genesis/core";
import { hashEquals } from "@after-genesis/core";
import { hashRequest } from "../prompt.js";
import { MissingRecordedResponseError, ModelProviderError, ReplayCursorError } from "./errors.js";

export interface ReplayProviderOptions {
  readonly audit: ModelAuditStore;
  readonly worldId: string;
  /**
   * Require the recorded model id to match the requested one.
   *
   * On by default. If production ran `gemini-2.5-flash-lite` and replay is
   * configured for a different model, the reconstruction is not a replay of that
   * history — it is a new run wearing the old run's sequence numbers. Better to
   * refuse than to produce a checksum mismatch nobody can explain.
   */
  readonly enforceModelIdMatch?: boolean;
  /**
   * Verify that the prompt being replayed hashes to the recorded request hash.
   *
   * Off by default because it needs the recorded hash, which the port's `get`
   * does not return. When a caller can supply it via `expectRequestHash`, this
   * catches the subtle failure where replay reconstructs a *different* prompt
   * (a prompt-builder change, say) and then feeds it a response recorded for the
   * prompt that no longer exists.
   */
  readonly verifyRequestHash?: boolean;
}

export interface ReplayCursor {
  readonly sequence: number;
  /** Optional: the request hash recorded alongside this response. */
  readonly expectRequestHash?: string;
}

export class ReplayProvider implements ModelProvider {
  readonly name = "replay";

  readonly #audit: ModelAuditStore;
  readonly #worldId: string;
  readonly #enforceModelIdMatch: boolean;
  readonly #verifyRequestHash: boolean;
  #cursor: ReplayCursor | null = null;
  #attempt = 1;
  #served = 0;

  constructor(options: ReplayProviderOptions) {
    this.#audit = options.audit;
    this.#worldId = options.worldId;
    this.#enforceModelIdMatch = options.enforceModelIdMatch ?? true;
    this.#verifyRequestHash = options.verifyRequestHash ?? false;
  }

  /**
   * Point the provider at the sequence about to be replayed.
   *
   * Explicit rather than auto-incrementing. An auto-incrementing cursor drifts
   * silently the moment a turn is skipped or retried, and the failure mode is
   * that sequence N is answered with sequence N-1's response — an off-by-one
   * that produces a plausible, wrong, fully hash-chained history. Making the
   * caller name the sequence turns that into an impossible mistake.
   */
  seek(cursor: ReplayCursor | number): void {
    this.#cursor = typeof cursor === "number" ? { sequence: cursor } : cursor;
    this.#attempt = 1;
  }

  /** How many recorded responses have been served. Used by replay progress reporting. */
  get servedCount(): number {
    return this.#served;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const cursor = this.#cursor;
    if (cursor === null) {
      throw new ReplayCursorError(
        "ReplayProvider.generate() was called without a cursor. Call seek(sequence) " +
          "before each turn so the recorded response is matched to the turn it belongs to.",
      );
    }
    const attempt = this.#attempt++;

    if (this.#verifyRequestHash && cursor.expectRequestHash !== undefined) {
      const actual = hashRequest(request);
      if (!hashEquals(actual, cursor.expectRequestHash)) {
        throw new ModelProviderError(
          "misconfigured",
          `Replayed prompt at sequence ${cursor.sequence} does not match the recorded ` +
            `request hash. The prompt builder or the observation has changed, so the ` +
            `recorded response does not answer the question being asked.`,
          { provider: this.name, modelId: request.modelId, attempts: 1 },
        );
      }
    }

    const recorded = await this.#audit.get(this.#worldId, cursor.sequence, attempt);

    // The line this whole class exists for. No fallback, no live call, no
    // synthesised default — any of those would forge history (§16).
    if (recorded === null) {
      throw new MissingRecordedResponseError(this.#worldId, cursor.sequence);
    }

    if (this.#enforceModelIdMatch && recorded.modelId !== request.modelId) {
      throw new ModelProviderError(
        "misconfigured",
        `Recorded response at sequence ${cursor.sequence} came from model ` +
          `"${recorded.modelId}" but replay requested "${request.modelId}". ` +
          `Replay must reproduce the run that happened, not a similar one.`,
        { provider: this.name, modelId: request.modelId, attempts: 1 },
      );
    }

    this.#served += 1;

    // Token counts are zero: replay spends nothing, and reporting the original
    // counts here would let a replay run double-count against a spend ceiling.
    // The authoritative usage figures live on the original audit entries.
    return {
      rawText: recorded.rawText,
      modelId: recorded.modelId,
      inputTokens: 0,
      outputTokens: 0,
      finishReason: "replayed",
    };
  }
}
