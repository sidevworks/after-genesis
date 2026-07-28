/**
 * Gemini provider (§3).
 *
 * Three constraints shape this file.
 *
 * **The model id is configuration, never code.** §3 names "Gemini 3.5
 * Flash-Lite" and "3.6 Flash" but permits "an equivalent replacement" where
 * availability requires it — which is to say the spec itself treats the id as a
 * substitutable parameter. Hardcoding one would mean a model deprecation
 * required a code change and a redeploy to keep the world alive. So the id
 * arrives on the request, comes from `AG_MODEL_ROUTINE` / `AG_MODEL_DELIBERATE`,
 * and the exact string that was used is recorded on every response so history
 * records what actually thought, not what we intended.
 *
 * **The API key is never logged, never in a URL, never in an error.** It goes in
 * the `x-goog-api-key` header rather than a query parameter specifically because
 * query strings end up in proxy logs, browser histories and error messages that
 * quote the failing URL. This file never puts a URL in an error, either.
 *
 * **Failure must be distinguishable from a decision.** A 503 is not the
 * inhabitant choosing to do nothing. Transport failures raise a retryable
 * `ModelProviderError`, which §14 requires the scheduler to turn into a
 * reschedule rather than a state transition.
 */
import type { ModelProvider, ModelRequest, ModelResponse } from "@after-genesis/core";
import { ModelProviderError } from "./errors.js";

const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";

/** Minimal shape of `globalThis.fetch`, injected so tests never touch the network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GeminiProviderOptions {
  /** Read from `GEMINI_API_KEY`. Never logged, never serialised. */
  readonly apiKey: string;
  /** Overridable for a regional endpoint or a test double. Never contains the key. */
  readonly endpoint?: string;
  /** Per-attempt timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Total attempts including the first. 1 disables retrying. */
  readonly maxAttempts?: number;
  /** Base backoff in milliseconds; doubles per attempt. */
  readonly backoffBaseMs?: number;
  /** Injected for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: FetchLike;
  /** Injected for tests, so retry logic can be exercised without real delays. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  timeoutMs: 20_000,
  maxAttempts: 4,
  backoffBaseMs: 500,
} as const;

interface GeminiCandidate {
  readonly content?: { readonly parts?: ReadonlyArray<{ readonly text?: string }> };
  readonly finishReason?: string;
}

interface GeminiResponseBody {
  readonly candidates?: readonly GeminiCandidate[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
  };
  readonly modelVersion?: string;
  readonly promptFeedback?: { readonly blockReason?: string };
}

export class GeminiProvider implements ModelProvider {
  readonly name = "gemini";

  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #backoffBaseMs: number;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: GeminiProviderOptions) {
    if (options.apiKey.trim() === "") {
      throw new ModelProviderError("misconfigured", "GEMINI_API_KEY is empty.", {
        provider: "gemini",
        modelId: "(none)",
        attempts: 0,
      });
    }
    // Private class fields, so the key is not reachable via `Object.keys`,
    // spread, or `JSON.stringify` on the provider — the three ways a credential
    // most often ends up in a log line by accident.
    this.#apiKey = options.apiKey;
    this.#endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.#timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.#maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.#backoffBaseMs = options.backoffBaseMs ?? DEFAULTS.backoffBaseMs;
    const injected = options.fetchImpl;
    this.#fetch =
      injected ?? ((input, init) => (globalThis.fetch as unknown as FetchLike)(input, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Never expose the key through string coercion or structured logging. */
  toJSON(): Record<string, unknown> {
    return { provider: this.name, endpoint: this.#endpoint };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const url = `${this.#endpoint}/models/${encodeURIComponent(request.modelId)}:generateContent`;
    const body = buildRequestBody(request);

    let lastError: ModelProviderError | null = null;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.#fetchWithTimeout(url, body, request.modelId, attempt);
      } catch (error) {
        if (error instanceof ModelProviderError) {
          lastError = error;
          if (!error.retryable || attempt === this.#maxAttempts) throw error;
          await this.#sleep(this.#backoffFor(attempt));
          continue;
        }
        throw error;
      }

      // 429 and 5xx are the two classes that are safe to retry. `generateContent`
      // has no side effects on the provider's side, so a repeat is idempotent —
      // which is the only reason retrying is acceptable at all. A 4xx other than
      // 429 means the request itself is wrong and would fail identically forever.
      if (response.status === 429 || response.status >= 500) {
        const error = new ModelProviderError(
          response.status === 429 ? "rate_limited" : "server_error",
          `Gemini returned HTTP ${response.status}.`,
          { provider: this.name, modelId: request.modelId, httpStatus: response.status, attempts: attempt },
        );
        lastError = error;
        if (attempt === this.#maxAttempts) throw error;
        await this.#sleep(this.#backoffFor(attempt));
        continue;
      }

      if (!response.ok) {
        throw new ModelProviderError(
          "client_error",
          `Gemini rejected the request with HTTP ${response.status}.`,
          { provider: this.name, modelId: request.modelId, httpStatus: response.status, attempts: attempt },
        );
      }

      return this.#readBody(response, request, attempt);
    }

    // Unreachable: the loop either returns or throws. Kept so a future change to
    // the loop bounds cannot silently fall through to `undefined`.
    throw (
      lastError ??
      new ModelProviderError("transport", "Gemini call failed with no recorded cause.", {
        provider: this.name,
        modelId: request.modelId,
        attempts: this.#maxAttempts,
      })
    );
  }

  #backoffFor(attempt: number): number {
    // Exponential, no jitter. Jitter would need randomness, and this package is
    // required to be deterministic; the scheduler already staggers turns, so
    // synchronised retries across inhabitants are not a realistic concern here.
    return this.#backoffBaseMs * 2 ** (attempt - 1);
  }

  async #fetchWithTimeout(
    url: string,
    body: unknown,
    modelId: string,
    attempt: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Header, not a query parameter: query strings leak into proxy logs.
          "x-goog-api-key": this.#apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      throw new ModelProviderError(
        aborted ? "timeout" : "transport",
        aborted
          ? `Gemini call timed out after ${this.#timeoutMs}ms.`
          : // The cause's message is deliberately not interpolated: fetch errors
            // sometimes quote the request, and the request carries the key header.
            "Gemini call failed at the transport layer.",
        { provider: this.name, modelId, attempts: attempt },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #readBody(
    response: Response,
    request: ModelRequest,
    attempt: number,
  ): Promise<ModelResponse> {
    let parsed: GeminiResponseBody;
    try {
      parsed = (await response.json()) as GeminiResponseBody;
    } catch {
      throw new ModelProviderError("malformed_provider_response", "Gemini returned non-JSON.", {
        provider: this.name,
        modelId: request.modelId,
        httpStatus: response.status,
        attempts: attempt,
      });
    }

    const blockReason = parsed.promptFeedback?.blockReason;
    if (blockReason !== undefined) {
      // A safety block is not an inhabitant's decision and must not become a
      // no-op. It is surfaced so an operator can see that the world's own
      // content tripped a provider filter — which is itself worth knowing.
      throw new ModelProviderError("blocked", `Gemini blocked the prompt: ${blockReason}.`, {
        provider: this.name,
        modelId: request.modelId,
        attempts: attempt,
      });
    }

    const candidate = parsed.candidates?.[0];
    const rawText = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");

    // An empty completion is NOT an error here. It is a response the model gave,
    // and parse.ts will turn it into a no-op after one correction attempt
    // (§14.11). Throwing would reschedule the turn instead, which would let a
    // model that reliably returns nothing spin a turn forever.
    return {
      rawText,
      // §3: "Record the model and version used for every inference." The
      // provider's reported version is preferred over the requested id because
      // an alias like "gemini-flash-latest" resolves to a concrete build, and
      // the concrete build is what actually thought.
      modelId: parsed.modelVersion ?? request.modelId,
      inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0,
      finishReason: candidate?.finishReason ?? "unknown",
    };
  }
}

function buildRequestBody(request: ModelRequest): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: request.maxOutputTokens,
    // Structured output is requested, but it is a hint. parse.ts validates
    // independently and does not trust the provider to have honoured it (§2).
    responseMimeType: "application/json",
  };
  // Gemini 3.5+ deprecates sampling parameters and may reject them. Older
  // configured models still receive the caller's temperature.
  if (!/^gemini-3\.(?:5|6)(?:-|$)/.test(request.modelId)) {
    generationConfig["temperature"] = request.temperature;
  }
  if (request.responseSchema !== undefined) {
    // JSON Schema (rather than the older protobuf/OpenAPI Schema field) is
    // required for discriminated `anyOf` payloads.
    generationConfig["responseJsonSchema"] = request.responseSchema;
  }

  return {
    systemInstruction: { parts: [{ text: request.systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: request.userPrompt }] }],
    generationConfig,
  };
}

/**
 * Which model id serves which cognition level (§11B).
 *
 * Both ids are required. There is no default: a missing `AG_MODEL_ROUTINE`
 * should stop the world at startup, not silently route every turn to whatever
 * string happened to be in the code when it was written.
 */
export interface ModelRouting {
  readonly routine: string;
  readonly deliberate: string;
}

export function resolveModelRouting(env: Readonly<Record<string, string | undefined>>): ModelRouting {
  const routine = env["AG_MODEL_ROUTINE"]?.trim();
  const deliberate = env["AG_MODEL_DELIBERATE"]?.trim();
  if (routine === undefined || routine === "") {
    throw new ModelProviderError("misconfigured", "AG_MODEL_ROUTINE is not set.", {
      provider: "gemini",
      modelId: "(none)",
      attempts: 0,
    });
  }
  if (deliberate === undefined || deliberate === "") {
    throw new ModelProviderError("misconfigured", "AG_MODEL_DELIBERATE is not set.", {
      provider: "gemini",
      modelId: "(none)",
      attempts: 0,
    });
  }
  return { routine, deliberate };
}

/**
 * Construct a provider from the environment.
 *
 * The key is read here and nowhere else, so there is exactly one place to audit
 * for credential handling.
 */
export function geminiFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: Omit<GeminiProviderOptions, "apiKey"> = {},
): GeminiProvider {
  const apiKey = env["GEMINI_API_KEY"]?.trim() ?? "";
  if (apiKey === "") {
    throw new ModelProviderError("misconfigured", "GEMINI_API_KEY is not set.", {
      provider: "gemini",
      modelId: "(none)",
      attempts: 0,
    });
  }
  return new GeminiProvider({ ...options, apiKey });
}
