// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Typed provider failures.
 *
 * The distinction that matters to the turn scheduler is `retryable`. §14 says
 * "Model unavailability must reschedule the unresolved turn. It must not create
 * a different state transition." A timeout is not a decision the inhabitant
 * made, so it must never become a no-op — the turn is put back on the queue and
 * the world state is untouched. A malformed response, by contrast, *is* a thing
 * the model did, and is handled by parse.ts as a no-op after one correction.
 *
 * None of these errors ever carry an API key, a request body or a response body.
 * Provider errors are logged, and logs are the easiest place in a system to
 * leak a credential (§17: "Never commit API keys" extends to never printing
 * them).
 */

export type ProviderErrorKind =
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "client_error"
  | "transport"
  | "blocked"
  | "malformed_provider_response"
  | "misconfigured";

export class ModelProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly detail: {
      /** Provider name, never the endpoint URL (which could carry a key). */
      readonly provider: string;
      readonly modelId: string;
      readonly httpStatus?: number;
      readonly attempts: number;
    },
  ) {
    super(message);
    this.name = "ModelProviderError";
  }

  /** Whether the scheduler should reschedule the turn rather than resolve it (§14). */
  get retryable(): boolean {
    return (
      this.kind === "timeout" ||
      this.kind === "rate_limited" ||
      this.kind === "server_error" ||
      this.kind === "transport"
    );
  }
}

/** Raised when a scripted provider runs out of pre-programmed responses. */
export class ScriptedProviderExhaustedError extends Error {
  constructor(readonly callCount: number) {
    super(
      `ScriptedProvider has no response for call ${callCount + 1}. ` +
        `A mechanical simulation must script every turn it runs; falling back to ` +
        `a default would make the run non-deterministic (§24).`,
    );
    this.name = "ScriptedProviderExhaustedError";
  }
}

/**
 * Raised when replay asks for a response that was never recorded.
 *
 * This error exists to be thrown rather than handled. Falling back to a live
 * model during replay would mint a response that was never part of history and
 * present it as though it were — forging the record the audit exists to verify
 * (§16). Replay either reproduces recorded history exactly or it fails loudly.
 */
export class MissingRecordedResponseError extends Error {
  constructor(
    readonly worldId: string,
    readonly sequence: number,
  ) {
    super(
      `No recorded model response for world "${worldId}" at sequence ${sequence}. ` +
        `Replay refuses to call a live model: doing so would fabricate history ` +
        `that the audit chain would then attest to (§16).`,
    );
    this.name = "MissingRecordedResponseError";
  }
}

/** Raised when replay is asked to generate without a sequence cursor set. */
export class ReplayCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayCursorError";
  }
}
