import {
  GenesisConfigSchema,
  ProposedActionSchema,
  buildGenesis,
  computeStateChecksum,
  hashEquals,
  runAction,
  simTime,
  verifyChain,
  type CanonicalEvent,
  type Sha256Hex,
  type WorldState,
} from "@after-genesis/core";

export interface ReplayMismatch {
  readonly sequence: number;
  readonly stage: "genesis" | "pre-state" | "action" | "post-state";
  readonly detail: string;
}

export interface ReplayReport {
  readonly ok: boolean;
  readonly worldId: string | null;
  readonly replayedEvents: number;
  readonly finalChecksum: Sha256Hex | null;
  readonly expectedChecksum: Sha256Hex | null;
  readonly state: WorldState | null;
  readonly mismatches: readonly ReplayMismatch[];
}

/**
 * Reconstruct canonical state without storage, a network, or model calls.
 *
 * Model output is preserved separately for inference audit; replay consumes the
 * validated proposal recorded in each canonical event, then asks the same
 * deterministic engine to resolve it again.
 */
export function replayHistory(events: readonly CanonicalEvent[]): ReplayReport {
  const mismatches: ReplayMismatch[] = [];
  if (events.length === 0) {
    return {
      ok: false,
      worldId: null,
      replayedEvents: 0,
      finalChecksum: null,
      expectedChecksum: null,
      state: null,
      mismatches: [{ sequence: 0, stage: "genesis", detail: "history is empty" }],
    };
  }

  const chainIssues = verifyChain(events);
  if (chainIssues.length > 0) {
    for (const issue of chainIssues) {
      mismatches.push({
        sequence: issue.sequence,
        stage: "pre-state",
        detail: `${issue.kind}: ${issue.detail}`,
      });
    }
  }

  const genesisEvent = events[0]!;
  const rawGenesis =
    typeof genesisEvent.inputs === "object" &&
    genesisEvent.inputs !== null &&
    "genesis" in genesisEvent.inputs
      ? genesisEvent.inputs.genesis
      : null;
  const parsedGenesis = GenesisConfigSchema.safeParse(rawGenesis);
  if (genesisEvent.sequence !== 0 || genesisEvent.type !== "genesis" || !parsedGenesis.success) {
    mismatches.push({
      sequence: genesisEvent.sequence,
      stage: "genesis",
      detail: parsedGenesis.success
        ? "first event must be genesis at sequence 0"
        : `invalid Genesis config: ${parsedGenesis.error.issues[0]?.message ?? "unknown error"}`,
    });
    return {
      ok: false,
      worldId: genesisEvent.worldId,
      replayedEvents: 0,
      finalChecksum: null,
      expectedChecksum: events.at(-1)?.postStateChecksum ?? null,
      state: null,
      mismatches,
    };
  }

  const built = buildGenesis(parsedGenesis.data);
  let state = built.state;
  if (!hashEquals(built.emptyStateChecksum, genesisEvent.preStateChecksum)) {
    mismatches.push({
      sequence: 0,
      stage: "genesis",
      detail: "Genesis pre-state checksum does not match regenerated empty world",
    });
  }
  if (!hashEquals(built.stateChecksum, genesisEvent.postStateChecksum)) {
    mismatches.push({
      sequence: 0,
      stage: "genesis",
      detail: "Genesis post-state checksum does not match regenerated founder world",
    });
  }

  for (const event of events.slice(1)) {
    const pre = computeStateChecksum(state);
    if (!hashEquals(pre, event.preStateChecksum)) {
      mismatches.push({
        sequence: event.sequence,
        stage: "pre-state",
        detail: `replayed checksum ${pre} does not match event pre-state ${event.preStateChecksum}`,
      });
      break;
    }

    const rawAction =
      typeof event.inputs === "object" &&
      event.inputs !== null &&
      "action" in event.inputs
        ? event.inputs.action
        : null;
    const action = ProposedActionSchema.safeParse(rawAction);
    if (!action.success || event.actor === null) {
      mismatches.push({
        sequence: event.sequence,
        stage: "action",
        detail: action.success
          ? "turn event has no acting inhabitant"
          : `recorded action is invalid: ${action.error.issues[0]?.message ?? "unknown error"}`,
      });
      break;
    }

    state = runAction({
      state,
      actorId: event.actor,
      action: action.data,
      simTime: simTime(event.simTime),
      sequence: event.sequence,
    }).state;
    const post = computeStateChecksum(state);
    if (!hashEquals(post, event.postStateChecksum)) {
      mismatches.push({
        sequence: event.sequence,
        stage: "post-state",
        detail: `replayed checksum ${post} does not match event post-state ${event.postStateChecksum}`,
      });
      break;
    }
  }

  const finalChecksum = computeStateChecksum(state);
  const expectedChecksum = events.at(-1)?.postStateChecksum ?? null;
  return {
    ok:
      mismatches.length === 0 &&
      expectedChecksum !== null &&
      hashEquals(finalChecksum, expectedChecksum),
    worldId: genesisEvent.worldId,
    replayedEvents: state.sequence + 1,
    finalChecksum,
    expectedChecksum,
    state,
    mismatches,
  };
}
