/**
 * Typed persistence failures.
 *
 * Every one of these represents a refusal, not a recovery. The persistence layer
 * is the last thing standing between a corrupt byte and the canonical history of
 * a world, so when it cannot prove that an operation is safe it throws rather
 * than guesses. Nothing here ever "repairs" a log.
 */
import type { ChainViolation } from "@after-genesis/core";

/** Base class so callers can catch everything this package throws. */
export class PersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistenceError";
  }
}

/**
 * Optimistic-concurrency failure: something already occupies the sequence the
 * caller tried to write.
 *
 * This is *the* primitive behind §15's "each task can commit at most once".
 * Two workers handed the same turn by a queue that delivers twice will both
 * compute the same `expectedSequence`; exactly one append wins and the other
 * receives this error, which the turn runner treats as "already committed by
 * someone else, abandon quietly" rather than as a failure to retry.
 */
export class SequenceConflictError extends PersistenceError {
  readonly worldId: string;
  readonly expectedSequence: number;
  /** The sequence of the newest event actually present, or -1 for an empty world. */
  readonly headSequence: number;

  constructor(worldId: string, expectedSequence: number, headSequence: number) {
    super(
      `Cannot append to world "${worldId}" at sequence ${expectedSequence}: ` +
        `the log head is ${headSequence}, so ${expectedSequence} is ` +
        (expectedSequence <= headSequence ? "already occupied" : "not the next sequence") +
        `. History is append-only and is never rewritten.`,
    );
    this.name = "SequenceConflictError";
    this.worldId = worldId;
    this.expectedSequence = expectedSequence;
    this.headSequence = headSequence;
  }
}

/**
 * The hash chain does not hold: either an event being appended does not link to
 * the current head, or a stored log failed `verifyChain` on open.
 */
export class ChainIntegrityError extends PersistenceError {
  readonly worldId: string;
  readonly violations: readonly ChainViolation[];

  constructor(worldId: string, detail: string, violations: readonly ChainViolation[] = []) {
    const summary = violations.map((v) => `  [${v.sequence}] ${v.kind}: ${v.detail}`).join("\n");
    super(
      `Event chain integrity failure in world "${worldId}": ${detail}` +
        (summary ? `\n${summary}` : ""),
    );
    this.name = "ChainIntegrityError";
    this.worldId = worldId;
    this.violations = violations;
  }
}

/** How an on-disk log failed to be a well-formed JSONL event log. */
export type LogCorruptionKind =
  /** The file does not end with a newline: an append was torn by a crash. */
  | "truncated-line"
  /** An empty line inside the log: something wrote bytes that were not an event. */
  | "blank-line"
  /** A line that is not valid JSON. */
  | "unparseable-line"
  /** Valid JSON that is not a canonical event. */
  | "schema-violation"
  /** The log does not begin at sequence 0. */
  | "missing-genesis"
  /** The file name does not match the world id recorded inside it. */
  | "filename-mismatch";

/**
 * The bytes on disk are not a readable event log. Distinct from
 * `ChainIntegrityError`, which means the bytes parsed fine but the history they
 * describe is inconsistent.
 */
export class LogCorruptionError extends PersistenceError {
  readonly path: string;
  readonly kind: LogCorruptionKind;
  readonly lineNumber: number | null;

  constructor(path: string, kind: LogCorruptionKind, detail: string, lineNumber: number | null) {
    super(
      `Corrupt event log at ${path}` +
        (lineNumber === null ? "" : ` (line ${lineNumber})`) +
        `: ${kind} — ${detail}`,
    );
    this.name = "LogCorruptionError";
    this.path = path;
    this.kind = kind;
    this.lineNumber = lineNumber;
  }
}

/**
 * A write to the log failed part-way. The store poisons the affected world: no
 * further appends are accepted until it is reopened and revalidated, because the
 * in-memory head can no longer be trusted to describe the bytes on disk.
 */
export class LogWriteError extends PersistenceError {
  readonly worldId: string;

  constructor(worldId: string, detail: string, options?: { cause?: unknown }) {
    super(
      `Append to world "${worldId}" failed: ${detail}. ` +
        `This store is now refusing further appends for that world; reopen it so ` +
        `the log can be revalidated against disk.`,
    );
    this.name = "LogWriteError";
    this.worldId = worldId;
    if (options && "cause" in options) this.cause = options.cause;
  }
}

/**
 * A snapshot could not be proven to correspond to an exact point in the log.
 *
 * Materialised state is only ever a cache (§4E). A snapshot that cannot prove
 * its provenance is worthless — it must be discarded and rebuilt from events,
 * never trusted.
 */
export class SnapshotChecksumError extends PersistenceError {
  readonly worldId: string;
  readonly sequence: number;
  readonly recorded: string;
  readonly actual: string;

  constructor(
    worldId: string,
    sequence: number,
    recorded: string,
    actual: string,
    detail: string,
  ) {
    super(
      `Snapshot for world "${worldId}" at sequence ${sequence} rejected: ${detail}. ` +
        `Recorded checksum ${recorded.slice(0, 12)}…, actual ${actual.slice(0, 12)}…. ` +
        `Rebuild the state from the event log.`,
    );
    this.name = "SnapshotChecksumError";
    this.worldId = worldId;
    this.sequence = sequence;
    this.recorded = recorded;
    this.actual = actual;
  }
}

/** A stored snapshot's bytes are unreadable or truncated. */
export class SnapshotCorruptionError extends PersistenceError {
  readonly path: string;

  constructor(path: string, detail: string, options?: { cause?: unknown }) {
    super(`Corrupt snapshot at ${path}: ${detail}`);
    this.name = "SnapshotCorruptionError";
    this.path = path;
    if (options && "cause" in options) this.cause = options.cause;
  }
}

/**
 * An attempt to change an audit record that already exists (§16).
 *
 * The audit log is the evidence that the engine, not the model, decided reality.
 * If a second, different response could be recorded for a sequence that already
 * has one, replay could be made to produce a history that never happened. The
 * store refuses, loudly.
 */
export class AuditIntegrityError extends PersistenceError {
  readonly worldId: string;
  readonly sequence: number;

  constructor(worldId: string, sequence: number, detail: string) {
    super(
      `Audit record for world "${worldId}" sequence ${sequence} is write-once and ` +
        `cannot be changed: ${detail}`,
    );
    this.name = "AuditIntegrityError";
    this.worldId = worldId;
    this.sequence = sequence;
  }
}
