/**
 * The cognition service entry point (§4B).
 *
 * "Builds an inhabitant's limited observation, retrieves relevant memories,
 * calls the selected model and returns one structured proposed action."
 *
 * Note the return type. This function returns a *proposal*. It writes nothing,
 * grants nothing and decides nothing. Its output is an input to the engine,
 * which is free to reject it — and rejection is a normal outcome, not an error
 * (§2, §14.12).
 *
 * It implements steps 6 through 11 and 18 of the turn lifecycle:
 *
 *   6. Store and hash the complete model request.
 *   7. Call the configured model.
 *   8. Store and hash the untouched raw response.
 *   9. Validate the response against the action schema.
 *  10. Optionally request one format correction.
 *  11. Treat a second invalid response as a no-op.
 *  18. Record token usage and estimated cost.
 *
 * Three failure modes are handled differently on purpose:
 *
 *  - **Invalid response** → one correction, then a no-op. Never an exception,
 *    never a loop (§14.10, §14.11).
 *  - **Provider unavailable** → the error propagates, so the scheduler
 *    reschedules the turn. "It must not create a different state transition"
 *    (§14) — a timeout must not be recorded as the inhabitant choosing to wait.
 *  - **Spend ceiling reached** → `SpendLimitExceededError` propagates and the
 *    world pauses (§15). Nothing is emitted, because the check happens before
 *    the request.
 */
import type {
  ModelAuditStore,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  SpendReservationStore,
} from "@after-genesis/core";
import type { Sha256Hex } from "@after-genesis/core";
import type { ProposedAction } from "@after-genesis/core/schema/action-spec";
import type { SpendLedger } from "./budget.js";
import { estimateTokens, retrieveMemories, type MemoryRecord, type RetrievalContext } from "./memory.js";
import { hashRawResponse, parseModelResponse, type ParseFailureCode } from "./parse.js";
import {
  buildCorrectionRequest,
  buildPrompt,
  hashRequest,
  type PromptOptions,
} from "./prompt.js";
import type { Observation } from "./types.js";

/** One model call, recorded for audit whatever its outcome. */
export interface CognitionAttempt {
  /** 1 for the first call, 2 for the single permitted format correction. */
  readonly attempt: number;
  readonly requestHash: Sha256Hex;
  /** Hash of the untouched raw response (§14.8). */
  readonly responseHash: Sha256Hex;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly finishReason: string;
  /** Null when the response validated. */
  readonly failureCode: ParseFailureCode | null;
}

interface CognitionCommon {
  readonly attempts: readonly CognitionAttempt[];
  /** Sum across attempts, in integer micros. Includes the cost of a failed attempt. */
  readonly totalCostMicros: number;
  /** How many untrusted blocks the prompt contained. Audit signal for §11E. */
  readonly untrustedBlockCount: number;
  /** What the sanitiser neutralised. A rising count is evidence of an injection campaign. */
  readonly sanitisationFlags: readonly string[];
  readonly memoryCount: number;
}

export type CognitionResult =
  | (CognitionCommon & {
      readonly status: "proposed";
      readonly action: ProposedAction;
    })
  | (CognitionCommon & {
      readonly status: "noop";
      /** Why nothing was proposed. Recorded on the canonical no-op event. */
      readonly reason: string;
      readonly code: ParseFailureCode;
    });

export interface CognitionDeps {
  readonly provider: ModelProvider;
  readonly ledger: SpendLedger;
  /** Required in production so process restarts cannot reset spend ceilings. */
  readonly durableSpend?: SpendReservationStore;
  /** Optional: when absent, nothing is persisted and replay of this turn is impossible. */
  readonly audit?: ModelAuditStore;
}

export interface CognitionInput {
  readonly observation: Observation;
  /** Everything the inhabitant could recall. Retrieval narrows it to the budget (§19). */
  readonly memoryCandidates: readonly MemoryRecord[];
  /** Retrieval scoring context. Built by the caller from the same observation. */
  readonly retrieval: RetrievalContext;
  /** Exact provider model id, from configuration. Never hardcoded (§3). */
  readonly modelId: string;
  /**
   * Day key for the spend ledger, e.g. "2026-07-28". Supplied by the caller
   * rather than read from a clock here, so this function stays deterministic and
   * the ceiling is testable at its boundary.
   */
  readonly dayKey: string;
  readonly promptOptions?: PromptOptions;
}

/**
 * Run one turn of cognition.
 *
 * Pure with respect to world state: it reads an observation and returns a
 * proposal. The only side effects are the model call, the audit write and the
 * ledger entry — none of which touch canonical state.
 */
export async function proposeAction(
  deps: CognitionDeps,
  input: CognitionInput,
): Promise<CognitionResult> {
  const retrieval = retrieveMemories(input.memoryCandidates, input.retrieval);

  const prompt = buildPrompt({
    observation: input.observation,
    memories: retrieval.selected,
    modelId: input.modelId,
    ...(input.promptOptions === undefined ? {} : { options: input.promptOptions }),
  });

  const common = {
    untrustedBlockCount: prompt.untrustedBlockCount,
    sanitisationFlags: prompt.sanitisationFlags,
    memoryCount: retrieval.selected.length,
  };

  const attempts: CognitionAttempt[] = [];

  // Attempt 1.
  const first = await callOnce(deps, input, prompt.request, 1, attempts);
  const firstParse = parseModelResponse(first.response.rawText);
  if (firstParse.ok) {
    return finish(attempts, common, { status: "proposed", action: firstParse.action });
  }
  setFailure(attempts, firstParse.code);

  // §14.10: exactly one format correction. The model's own prior output goes
  // back inside an untrusted block — a model that emitted delimiter-forgery text
  // must not have it reappear as bare prompt content on the retry.
  const correction = buildCorrectionRequest(
    prompt.request,
    first.response.rawText,
    firstParse.reason,
    input.promptOptions?.maxBlockChars,
  );

  const second = await callOnce(deps, input, correction, 2, attempts);
  const secondParse = parseModelResponse(second.response.rawText);
  if (secondParse.ok) {
    return finish(attempts, common, { status: "proposed", action: secondParse.action });
  }
  setFailure(attempts, secondParse.code);

  // §14.11: a second invalid response is a no-op. Not a third attempt, not an
  // exception. The turn is spent, the inhabitant did nothing, and the canonical
  // record says so.
  return finish(attempts, common, {
    status: "noop",
    reason: `Two invalid responses. Last problem: ${secondParse.reason}`,
    code: secondParse.code,
  });
}

async function callOnce(
  deps: CognitionDeps,
  input: CognitionInput,
  request: ModelRequest,
  attempt: number,
  attempts: CognitionAttempt[],
): Promise<{ response: ModelResponse }> {
  // The correction prompt hashes differently from the original because its user
  // prompt differs, so both attempts are independently verifiable on replay.
  const requestHash = hashRequest(request);

  // Estimated *before* the call so the ceiling can refuse to emit a request at
  // all (§15). The estimate charges the full maxOutputTokens: a limit that can
  // be overshot by the last request of the day is not a limit.
  const estimatedInputTokens = estimateTokens(request.systemPrompt) + estimateTokens(request.userPrompt);
  const estimatedMicros = deps.ledger.assertCanSpend({
    modelId: request.modelId,
    dayKey: input.dayKey,
    estimatedInputTokens,
    maxOutputTokens: request.maxOutputTokens,
  });
  const reservationId =
    `${input.observation.worldId}:${input.observation.sequence}:${attempt}:${requestHash}`;
  if (deps.durableSpend !== undefined) {
    const limits = deps.ledger.snapshot().limits;
    const status = await deps.durableSpend.reserve({
      reservationId,
      worldId: input.observation.worldId,
      sequence: input.observation.sequence,
      attempt,
      dayKey: input.dayKey,
      estimatedMicros,
      dailyLimitMicros: limits.dailyMicros,
      totalLimitMicros: limits.totalMicros,
    });
    if (status.status === "settled") {
      const replay = await deps.audit?.get(
        input.observation.worldId,
        input.observation.sequence,
        attempt,
      );
      if (replay === null || replay === undefined) {
        throw new Error(
          `settled spend reservation ${reservationId} has no recorded response`,
        );
      }
      const responseHash = hashRawResponse(replay.rawText);
      attempts.push({
        attempt,
        requestHash,
        responseHash,
        modelId: replay.modelId,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: status.actualMicros,
        finishReason: "recorded-replay",
        failureCode: null,
      });
      return {
        response: {
          rawText: replay.rawText,
          modelId: replay.modelId,
          inputTokens: 0,
          outputTokens: 0,
          finishReason: "recorded-replay",
        },
      };
    }
  }

  let response: ModelResponse;
  try {
    // §14.6: persist the exact request before any network call. A provider
    // timeout must still leave evidence of what was attempted.
    if (deps.audit !== undefined) {
      await deps.audit.record({
        worldId: input.observation.worldId,
        sequence: input.observation.sequence,
        attempt,
        request,
        requestHash,
        response: null,
        responseHash: null,
        costMicros: 0,
      });
    }

    // A provider failure propagates: §14 requires the turn to be rescheduled,
    // not resolved differently.
    response = await deps.provider.generate(request);
  } catch (error) {
    // No provider response means no known billable usage. Release the
    // pre-authorisation so the immutable task may retry.
    if (deps.durableSpend !== undefined) {
      await deps.durableSpend.release(reservationId);
    }
    throw error;
  }

  // §14.8: hash the untouched raw response before anything parses it.
  const responseHash = hashRawResponse(response.rawText);

  const entry = deps.ledger.record({
    dayKey: input.dayKey,
    // Billing approval is attached to the configured request alias. Providers
    // may return a concrete build id (recorded separately below) that is not a
    // distinct price-table product.
    modelId: request.modelId,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    sequence: input.observation.sequence,
  });
  if (deps.durableSpend !== undefined) {
    // Once a response exists, never release on later failure: the provider has
    // performed billable work. A stranded reservation is conservative and can
    // be reconciled from the append-only model audit.
    await deps.durableSpend.settle(reservationId, entry.micros);
  }

  attempts.push({
    attempt,
    requestHash,
    responseHash,
    modelId: response.modelId,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costMicros: entry.micros,
    finishReason: response.finishReason,
    failureCode: null,
  });

  if (deps.audit !== undefined) {
    await deps.audit.record({
      worldId: input.observation.worldId,
      // The correction shares the turn's sequence; `attempt` distinguishes them
      // in the stored request, and the request hash differs because the prompt does.
      sequence: input.observation.sequence,
      attempt,
      request,
      requestHash,
      response,
      responseHash,
      costMicros: entry.micros,
    });
  }

  return { response };
}

function setFailure(attempts: CognitionAttempt[], code: ParseFailureCode): void {
  const last = attempts[attempts.length - 1];
  if (last === undefined) return;
  attempts[attempts.length - 1] = { ...last, failureCode: code };
}

function finish(
  attempts: readonly CognitionAttempt[],
  common: Omit<CognitionCommon, "attempts" | "totalCostMicros">,
  outcome:
    | { status: "proposed"; action: ProposedAction }
    | { status: "noop"; reason: string; code: ParseFailureCode },
): CognitionResult {
  const totalCostMicros = attempts.reduce((sum, a) => sum + a.costMicros, 0);
  const base = { ...common, attempts: [...attempts], totalCostMicros };
  return outcome.status === "proposed"
    ? { ...base, status: "proposed", action: outcome.action }
    : { ...base, status: "noop", reason: outcome.reason, code: outcome.code };
}
