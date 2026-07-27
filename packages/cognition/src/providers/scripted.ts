/**
 * Scripted provider — deterministic, free, offline cognition.
 *
 * This is what makes §24's mechanical simulation phase possible: "Run large
 * numbers of turns using deterministic fake inhabitants." Hundreds of thousands
 * of turns can be driven through the real engine, the real prompt builder and
 * the real parser at zero inference cost, with an outcome that is identical on
 * every machine and every run.
 *
 * It is also the adversarial harness. §24 requires attempting "malformed model
 * responses" against the live turn lifecycle; a scripted provider lets a test
 * hand the pipeline a truncated JSON object, a 10MB string or a forged action
 * type at an exact turn and assert that the world survives it — which is not
 * something a real model can be asked to do on demand.
 *
 * Two design choices are deliberate:
 *
 *  - **Exhaustion throws.** A run that scripts fifty turns and executes fifty-one
 *    has a bug in the test, not in the world. Returning a default would let that
 *    bug produce plausible-looking history, and "the simulation quietly invented
 *    a response" is the exact failure mode this provider exists to rule out.
 *  - **No randomness, no clock.** The response for call N depends only on N and
 *    the script, so a mechanical run replays byte-identically.
 */
import type { ModelProvider, ModelRequest, ModelResponse } from "@after-genesis/core";
import { ScriptedProviderExhaustedError } from "./errors.js";

/** One scripted response. A bare string is shorthand for `{ rawText }`. */
export type ScriptedResponse =
  | string
  | {
      readonly rawText: string;
      /** Defaults to the requested model id, so audit records stay coherent. */
      readonly modelId?: string;
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly finishReason?: string;
      /**
       * Throw instead of responding, to simulate provider unavailability. §14
       * requires that path to reschedule the turn rather than change state, and
       * this is how a test exercises it.
       */
      readonly throws?: Error;
    };

export interface ScriptedProviderOptions {
  /**
   * What to do once the script runs out.
   *
   * `throw` is the default and the right choice for tests. `repeat_last` exists
   * for long mechanical soak runs where the point is to execute a million turns
   * of a single scripted behaviour, not to enumerate a million responses.
   */
  readonly onExhausted?: "throw" | "repeat_last";
}

export class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";

  readonly #script: readonly ScriptedResponse[];
  readonly #onExhausted: "throw" | "repeat_last";
  #calls: ModelRequest[] = [];

  constructor(script: readonly ScriptedResponse[], options: ScriptedProviderOptions = {}) {
    this.#script = [...script];
    this.#onExhausted = options.onExhausted ?? "throw";
  }

  /** Every request received, in order. Lets a test assert on the prompt actually sent. */
  get calls(): readonly ModelRequest[] {
    return [...this.#calls];
  }

  get callCount(): number {
    return this.#calls.length;
  }

  /** Reset the cursor. Present for test ergonomics; never used by the runtime. */
  reset(): void {
    this.#calls = [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async
  async generate(request: ModelRequest): Promise<ModelResponse> {
    const index = this.#calls.length;
    this.#calls.push(request);

    const entry = this.#entryFor(index);
    if (typeof entry === "string") {
      return {
        rawText: entry,
        modelId: request.modelId,
        inputTokens: 0,
        outputTokens: 0,
        finishReason: "stop",
      };
    }

    if (entry.throws !== undefined) throw entry.throws;

    return {
      rawText: entry.rawText,
      modelId: entry.modelId ?? request.modelId,
      inputTokens: entry.inputTokens ?? 0,
      outputTokens: entry.outputTokens ?? 0,
      finishReason: entry.finishReason ?? "stop",
    };
  }

  #entryFor(index: number): ScriptedResponse {
    const entry = this.#script[index];
    if (entry !== undefined) return entry;

    if (this.#onExhausted === "repeat_last") {
      const last = this.#script[this.#script.length - 1];
      if (last !== undefined) return last;
    }
    throw new ScriptedProviderExhaustedError(index);
  }
}

/** Convenience: a well-formed action response, for scripting a happy path. */
export function scriptAction(
  type: string,
  payload: Record<string, unknown> = {},
  rationale?: string,
): string {
  const body: Record<string, unknown> =
    rationale === undefined ? { type, payload } : { type, payload, rationale };
  return JSON.stringify(body);
}
