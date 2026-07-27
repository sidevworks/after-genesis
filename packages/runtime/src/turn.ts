/**
 * The canonical turn lifecycle (§14).
 *
 * This is where the three halves of the system meet: cognition proposes, the
 * engine decides, persistence records. The ordering below is not incidental —
 * several steps exist specifically to make failure safe.
 *
 * Two constraints shape the whole design:
 *
 * 1. **No external call inside a transaction (§18).** The model round trip
 *    happens strictly *before* anything is appended. A Gemini call that takes
 *    nine seconds must never be holding a write lock on the event log.
 *
 * 2. **A turn is exactly one state transition.** Every canonical event carries
 *    `preStateChecksum` and `postStateChecksum`, and `verifyChain` requires each
 *    event's pre-checksum to equal its predecessor's post-checksum. A turn that
 *    emitted several events would therefore need several intermediate states —
 *    but the engine resolves a turn atomically and returns one. So a turn
 *    produces one canonical event, and any additional facts the resolver derived
 *    travel inside its `resolution`. This keeps §15's "failed transactions
 *    cannot partially alter state" true by construction.
 */
import {
  computeStateChecksum,
  runAction,
  sealEvent,
  type CanonicalEvent,
  type AtomicCanonicalStore,
  type Clock,
  type EventStore,
  type IdempotencyStore,
  type ProposedAction,
  type Sha256Hex,
  type SimTime,
  type StateStore,
  type Visibility,
  type WorldState,
} from "@after-genesis/core";

/** Raised when the model could not be reached. Reschedules; never mutates. */
export class ModelUnavailableError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

/** What cognition returns. Deliberately narrow: a proposal and its provenance. */
export interface CognitionOutcome {
  /**
   * The proposed action, or null for a no-op.
   *
   * Null is the correct result after two invalid model responses (§14.11) — not
   * an exception, and not a retry loop. An inhabitant that produced unusable
   * output simply did nothing this turn, which is a real thing that happened
   * and is recorded as such.
   */
  readonly action: ProposedAction | null;
  readonly modelId: string | null;
  readonly requestHash: Sha256Hex | null;
  readonly responseHash: Sha256Hex | null;
  /** Estimated cost in integer micros. Recorded for §15 spend ceilings. */
  readonly costMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Why the turn was a no-op, when `action` is null. */
  readonly noopReason?: string;
}

export interface CognitionInput {
  readonly state: WorldState;
  readonly actorId: string;
  readonly simTime: SimTime;
  readonly sequence: number;
}

/**
 * Cognition, as the turn pipeline sees it.
 *
 * Injected rather than imported so the runtime depends on no model provider,
 * and so mechanical simulation (§24) can drive turns with a scripted proposer
 * at zero cost.
 */
export interface CognitionService {
  propose(input: CognitionInput): Promise<CognitionOutcome>;
}

export interface TurnDependencies {
  readonly eventStore: EventStore;
  readonly stateStore: StateStore<WorldState>;
  readonly atomicStore?: AtomicCanonicalStore<WorldState>;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
  readonly cognition: CognitionService;
  /** Exactly which code produced this turn. Recorded on the event (§16). */
  readonly provenance: {
    readonly sourceCommit: string;
    readonly deployedDigest: string;
  };
  /** How long an idempotency claim is held. Longer than the slowest turn. */
  readonly claimTtlSeconds?: number;
}

export interface TurnRequest {
  readonly worldId: string;
  readonly actorId: string;
  /** When this turn occurs. Must not precede the world's current time. */
  readonly simTime: SimTime;
  /**
   * Stable identity for this turn, so a duplicated queue delivery is recognised
   * as the same work rather than run twice (§14.2, §18).
   */
  readonly taskId: string;
}

export type TurnResult =
  | {
      readonly status: "committed";
      readonly event: CanonicalEvent;
      readonly state: WorldState;
      readonly costMicros: number;
    }
  /** Another worker already ran this turn. Not an error (§15). */
  | { readonly status: "duplicate"; readonly reason: string }
  /** The model was unreachable. Reschedule; the world is unchanged (§14). */
  | { readonly status: "deferred"; readonly reason: string };

const DEFAULT_CLAIM_TTL_SECONDS = 300;

/** Map a resolver's default visibility onto the event envelope. */
function visibilityFor(
  raw: unknown,
  actorId: string,
): Visibility {
  const candidate = raw as Visibility | undefined;
  if (
    candidate !== undefined &&
    typeof candidate === "object" &&
    candidate !== null &&
    "kind" in candidate
  ) {
    return candidate;
  }
  // A resolver that forgot to state visibility gets the most restrictive
  // option, never the most permissive. Defaulting to public here would turn a
  // forgotten field into an information leak (§11E).
  return { kind: "private", owner: actorId };
}

/**
 * Execute one canonical turn.
 *
 * Returns rather than throws for the two expected non-success paths — duplicate
 * delivery and model unavailability — because both are routine in a queued
 * system and neither should page anyone.
 */
export async function executeTurn(
  deps: TurnDependencies,
  request: TurnRequest,
): Promise<TurnResult> {
  const { worldId, actorId, simTime, taskId } = request;

  // ---- §14.1–2: reserve the turn and claim it idempotently -----------------
  // The event log is the durable idempotency record. Claims have a TTL and may
  // be lost on restart, so they can only prevent concurrent duplicate work;
  // they cannot prove a task never committed in the past.
  if (await taskAlreadyCommitted(deps.eventStore, worldId, taskId)) {
    return { status: "duplicate", reason: `task ${taskId} already committed` };
  }

  const headSequence = await deps.eventStore.headSequence(worldId);
  const sequence = headSequence + 1;

  // Never include the current sequence in this key. The head advances after a
  // successful delivery; including it would turn a retry of the same task into
  // a fresh key and allow the action to run twice.
  const idempotencyKey = `${worldId}:${taskId}`;
  const claimed = await deps.idempotency.claim(
    idempotencyKey,
    deps.claimTtlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS,
  );
  if (!claimed) {
    return {
      status: "duplicate",
      reason: `task ${taskId} is already being processed at sequence ${sequence}`,
    };
  }

  try {
    // ---- load the world -----------------------------------------------------
    const snapshot = await deps.stateStore.load(worldId);
    if (snapshot === null) {
      throw new Error(`world ${worldId} has no state; run Genesis first`);
    }
    const state = snapshot.state;

    // A snapshot behind the log means a previous turn committed its event but
    // not its state. Rebuilding by replay is the correct repair, and it is not
    // this function's job — proceeding would silently resolve against stale
    // state and produce a divergent checksum.
    if (snapshot.sequence !== headSequence) {
      throw new Error(
        `state snapshot is at sequence ${snapshot.sequence} but the log head is ` +
          `${headSequence}; replay to rebuild before running further turns`,
      );
    }

    // ---- §14.3: capture the pre-turn checksum -------------------------------
    const preStateChecksum = computeStateChecksum(state);

    const previous = await deps.eventStore.head(worldId);
    const prevHash =
      previous?.hash ??
      ("0000000000000000000000000000000000000000000000000000000000000000" as Sha256Hex);

    // Continuity check before we do anything expensive. If the snapshot does not
    // hash to what the last event recorded, the world has drifted and every
    // subsequent event would inherit the discrepancy.
    if (previous !== null && previous.postStateChecksum !== preStateChecksum) {
      throw new Error(
        `state checksum ${preStateChecksum.slice(0, 12)}… does not match the last ` +
          `event's postStateChecksum ${previous.postStateChecksum.slice(0, 12)}…; ` +
          `the materialised state has diverged from the log`,
      );
    }

    // ---- §14.4–11: cognition, entirely outside any transaction (§18) --------
    let cognition: CognitionOutcome;
    try {
      cognition = await deps.cognition.propose({ state, actorId, simTime, sequence });
    } catch (error) {
      if (error instanceof ModelUnavailableError) {
        // §14: "Model unavailability must reschedule the unresolved turn. It
        // must not create a different state transition." Nothing is appended.
        await deps.idempotency.release(idempotencyKey);
        return { status: "deferred", reason: error.message };
      }
      throw error;
    }

    // ---- §14.12–13: validate preconditions and resolve deterministically ----
    // A no-op still consumes the sequence number and still advances time: the
    // inhabitant spent the turn, it simply achieved nothing.
    const action: ProposedAction = cognition.action ?? {
      type: "wait",
      payload: {},
    };

    const resolution = runAction({ state, actorId, action, simTime, sequence });

    // ---- §14.14–16: seal, append, persist -----------------------------------
    const postStateChecksum = computeStateChecksum(resolution.state);
    const primary = resolution.events[0];

    const event = sealEvent({
      worldId,
      sequence,
      simTime,
      realTimestamp: deps.clock.nowIso(),
      actor: actorId,
      type: primary?.type ?? `action.${action.type}`,
      inputs: {
        taskId,
        action,
        ...(cognition.action === null
          ? { noop: cognition.noopReason ?? "cognition produced no valid action" }
          : {}),
      },
      resolution: {
        outcome: resolution.outcome,
        // Additional facts the resolver derived. See the module comment for why
        // these travel inside one event rather than becoming events themselves.
        derived: resolution.events.map((e) => ({
          type: e.type,
          actor: e.actor,
          simTime: e.simTime,
          resolution: e.resolution,
          visibility: e.visibility,
        })),
      },
      visibility: visibilityFor(primary?.visibility, actorId),
      preStateChecksum,
      postStateChecksum,
      provenance: {
        sourceCommit: deps.provenance.sourceCommit,
        deployedDigest: deps.provenance.deployedDigest,
        modelRequestHash: cognition.requestHash,
        modelResponseHash: cognition.responseHash,
        modelId: cognition.modelId,
      },
      schemaVersion: 1,
      prevHash,
    });

    try {
      // Optimistic concurrency: if another worker beat us to this sequence the
      // append fails and we discard our work rather than overwrite theirs.
      if (deps.atomicStore !== undefined) {
        await deps.atomicStore.commit(
          event,
          resolution.state,
          sequence,
          postStateChecksum,
        );
      } else {
        await deps.eventStore.append(event, sequence);
      }
    } catch (error) {
      return {
        status: "duplicate",
        reason: `sequence ${sequence} was taken by another worker: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    // The event is the source of truth and is now durable. If this save fails,
    // the world is recoverable by replay — which is precisely why the event is
    // written first and the snapshot second.
    if (deps.atomicStore === undefined) {
      await deps.stateStore.save(worldId, resolution.state, sequence, postStateChecksum);
    }

    return {
      status: "committed",
      event,
      state: resolution.state,
      costMicros: cognition.costMicros,
    };
  } finally {
    // The claim exists to stop concurrent duplicates, not to be a permanent
    // record — the appended event is that. Releasing lets a legitimate retry
    // after a crash proceed.
    await deps.idempotency.release(idempotencyKey).catch(() => undefined);
  }
}

async function taskAlreadyCommitted(
  eventStore: EventStore,
  worldId: string,
  taskId: string,
): Promise<boolean> {
  for await (const event of eventStore.read(worldId, 0)) {
    const inputs = event.inputs;
    if (
      typeof inputs === "object" &&
      inputs !== null &&
      "taskId" in inputs &&
      inputs.taskId === taskId
    ) {
      return true;
    }
  }
  return false;
}
