// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * An append-only JSONL `EventStore` on the local filesystem.
 *
 * This is what lets the whole vertical slice — Genesis, turns, replay, the
 * public verifier — run with zero cloud dependency. One file per world, one JSON
 * object per line, sequence number equal to line index.
 *
 * ## Crash safety: what is guaranteed, and what is not
 *
 * An append is a single `write(2)` of one complete buffer ending in `\n`, on a
 * descriptor opened with `O_APPEND`, followed by `fsync(2)`. That gives:
 *
 *  - **No interleaving.** `O_APPEND` makes the seek-to-end and the write one
 *    atomic operation with respect to other writers on the same file, so two
 *    processes appending concurrently cannot produce a line spliced out of two
 *    records. (POSIX guarantees this for regular files; it is famously *not*
 *    guaranteed over NFS, which is one reason this store is for local disk and
 *    Firestore is the production path — see `src/firestore/README.md`.)
 *  - **No torn record survives undetected.** A crash part-way through the write
 *    can leave a prefix of the buffer on disk. Because every complete record
 *    ends in `\n`, a file whose last byte is not `\n` is definitionally torn,
 *    and `readLines` refuses it. The store therefore *detects* the tear on the
 *    next open and refuses to append rather than chaining a new event onto
 *    garbage.
 *  - **Durability of an acknowledged append.** `append()` does not resolve until
 *    `fsync` returns, so a caller that has awaited it may treat the event as
 *    committed.
 *
 * What is explicitly **not** guaranteed:
 *
 *  - **Automatic repair.** A torn tail is an operator decision, not a library
 *    one. Truncating to the last complete record would be right most of the time
 *    and catastrophic the rest, so the store throws and stops.
 *  - **`fsync` reaching the platter on macOS.** Node's `FileHandle.sync()` calls
 *    `fsync(2)`; on Darwin that flushes to the drive but does not force the
 *    drive's own write cache — `F_FULLFSYNC` would be needed, and Node exposes
 *    no binding for it. On a power cut a macOS dev box can therefore lose an
 *    acknowledged append. Detection still holds (the log is torn or short, never
 *    silently wrong); durability does not.
 *  - **Multi-process sequence allocation.** The optimistic-concurrency check
 *    below is in-process. Two *processes* opening the same log would each hold
 *    their own head and could both write sequence N, producing a duplicate that
 *    is caught on the next open but not prevented. Single-writer per world is
 *    the operating assumption for the file store; the Firestore transaction is
 *    what makes it safe across workers.
 *
 * ## Measured cost
 *
 * On an APFS SSD (macOS 15, Node 22), 1,000 sequential appends of a typical
 * event:
 *
 *  - `fsync: true`  — 4.1 ms per append (~240 appends/second)
 *  - `fsync: false` — 0.022 ms per append (~45,000 appends/second)
 *
 * The 190x gap is entirely `fsync(2)`. It is irrelevant to the live turn-rate
 * budget — a turn costs a model round trip measured in seconds, so 4 ms of
 * durability is noise — but it dominates bulk work like replay and import,
 * which is the only reason `fsync` is an option at all.
 */
import { constants as fsConstants } from "node:fs";
import { open as fsOpen, mkdir, readdir, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  CanonicalEventSchema,
  GENESIS_PREV_HASH,
  hashEquals,
  verifyChain,
  type CanonicalEvent,
  type EventStore,
} from "@after-genesis/core";
import {
  ChainIntegrityError,
  LogCorruptionError,
  LogWriteError,
  SequenceConflictError,
} from "./errors.js";
import { readLines } from "./internal/jsonl.js";
import { worldFileStem } from "./internal/world-file.js";

/**
 * How many events are handed to `verifyChain` at once during a scan.
 *
 * `verifyChain` wants an ordered array; a million-event log cannot become one.
 * Feeding it overlapping windows keeps memory flat while still running the exact
 * function the public verifier runs, rather than a re-implementation of it that
 * could drift.
 */
const VERIFY_CHUNK = 1024;

export interface FileEventStoreOptions {
  /**
   * Run `verifyChain` over every existing log during `open`. Default `true`.
   *
   * Turning it off still parses every line and still rejects a torn tail — the
   * head has to be found by scanning regardless — it only skips rehashing. Worth
   * it on a multi-million-event log where the nightly replay already proves the
   * chain (§18); never worth it in production startup for a fresh worker.
   */
  readonly verifyOnOpen?: boolean;

  /**
   * `fsync` after every append. Default `true`.
   *
   * The only legitimate reason to disable this is bulk import or replay into a
   * throwaway log, where a crash means "start over" rather than "lose canonical
   * history". Never disable it for a live world.
   */
  readonly fsync?: boolean;
}

interface WorldLog {
  readonly worldId: string;
  readonly path: string;
  handle: FileHandle | null;
  /** In-memory head. Advanced at reservation time, before the write completes. */
  headEvent: CanonicalEvent | null;
  /** The next free sequence. Equals `headEvent.sequence + 1`, or 0 when empty. */
  nextSequence: number;
  /** Serialises queued writes so lines land in sequence order. */
  tail: Promise<void>;
  /** Set once a write fails; every later append rejects with it. */
  poison: Error | null;
}

export class FileEventStore implements EventStore {
  readonly #directory: string;
  readonly #worlds = new Map<string, WorldLog>();
  readonly #fsync: boolean;
  #closed = false;

  private constructor(directory: string, fsync: boolean) {
    this.#directory = directory;
    this.#fsync = fsync;
  }

  /**
   * Open a store over `directory`, scanning and validating every log it finds.
   *
   * Throws `LogCorruptionError` if a log cannot be read as JSONL events (which
   * includes the torn-tail case) and `ChainIntegrityError` if it reads fine but
   * the history it describes is inconsistent. In both cases the store is not
   * constructed at all: there is no object on which a caller could accidentally
   * append to a corrupt log.
   */
  static async open(
    directory: string,
    options: FileEventStoreOptions = {},
  ): Promise<FileEventStore> {
    const verify = options.verifyOnOpen ?? true;
    const store = new FileEventStore(directory, options.fsync ?? true);
    await mkdir(directory, { recursive: true });

    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(directory, entry.name);
      const scan = await scanLog(path, verify);
      // An existing but empty file describes no world; there is nothing to
      // validate and no world id to recover from it.
      if (scan === null) continue;

      const expectedName = `${worldFileStem(scan.worldId)}.jsonl`;
      if (expectedName !== entry.name) {
        throw new LogCorruptionError(
          path,
          "filename-mismatch",
          `the file holds world "${scan.worldId}", which belongs in ${expectedName}. ` +
            `A renamed or copied log is not a world`,
          null,
        );
      }

      store.#worlds.set(scan.worldId, {
        worldId: scan.worldId,
        path,
        handle: null,
        headEvent: scan.head,
        nextSequence: scan.head.sequence + 1,
        tail: Promise.resolve(),
        poison: null,
      });
    }

    return store;
  }

  /**
   * Append at `expectedSequence`.
   *
   * The conflict check and the head advance happen synchronously, before the
   * first `await`, for the same reason as in `MemoryEventStore`: that is what
   * makes two concurrent callers at the same sequence resolve to exactly one
   * winner. The actual write is then queued behind any earlier write so lines
   * reach the file in sequence order, and this call resolves only once its own
   * bytes are fsynced.
   */
  append(event: CanonicalEvent, expectedSequence: number): Promise<void> {
    // Synchronous section — no `await` until the reservation is made.
    if (this.#closed) {
      return Promise.reject(new LogWriteError(event.worldId, "the store is closed"));
    }

    let world: WorldLog;
    try {
      world = this.#worldFor(event.worldId);
    } catch (error) {
      return Promise.reject(error as Error);
    }

    if (world.poison !== null) return Promise.reject(world.poison);

    if (event.sequence !== expectedSequence) {
      return Promise.reject(
        new SequenceConflictError(event.worldId, expectedSequence, world.nextSequence - 1),
      );
    }
    if (expectedSequence !== world.nextSequence) {
      return Promise.reject(
        new SequenceConflictError(event.worldId, expectedSequence, world.nextSequence - 1),
      );
    }

    const expectedPrevHash = world.headEvent === null ? GENESIS_PREV_HASH : world.headEvent.hash;
    if (!hashEquals(event.prevHash, expectedPrevHash)) {
      return Promise.reject(
        new ChainIntegrityError(
          event.worldId,
          `event ${event.sequence} does not chain from the current head`,
          [
            {
              sequence: event.sequence,
              kind: "broken-link",
              detail: `prevHash ${event.prevHash.slice(0, 12)}… does not match ${expectedPrevHash.slice(0, 12)}…`,
            },
          ],
        ),
      );
    }

    const line = `${JSON.stringify(event)}\n`;
    if (line.indexOf("\n") !== line.length - 1) {
      // JSON.stringify escapes newlines inside strings, so this is unreachable
      // for a well-formed event — but a record containing a raw newline would
      // silently split into two lines and corrupt every sequence after it, so
      // the invariant is checked rather than assumed.
      return Promise.reject(
        new LogWriteError(event.worldId, "serialised event contains an embedded newline"),
      );
    }

    // Reserve. From here on the head describes an event that is promised but not
    // yet durable; `head()`/`headSequence()`/`read()` all await the write queue
    // so no caller can observe the gap.
    world.headEvent = event;
    world.nextSequence = expectedSequence + 1;

    const write = world.tail.then(() => this.#writeLine(world, line));
    world.tail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  /**
   * Stream a contiguous range, both bounds inclusive.
   *
   * Reads scan from the start of the file: JSONL has no index, so seeking to
   * sequence N is O(N) bytes. That is a deliberate trade — the format stays
   * something a human and a public verifier can both read with no tooling — and
   * it is why replay reads forward from Genesis rather than sampling.
   */
  async *read(
    worldId: string,
    fromSequence: number,
    toSequence?: number,
  ): AsyncIterable<CanonicalEvent> {
    const world = this.#worlds.get(worldId);
    if (world === undefined) return;
    await world.tail;
    if (world.poison !== null) throw world.poison;

    const upper = toSequence ?? Number.POSITIVE_INFINITY;
    if (upper < fromSequence) return;

    for await (const line of readLines(world.path)) {
      const event = parseEventLine(world.path, line.lineNumber, line.text);
      if (event.sequence < fromSequence) continue;
      if (event.sequence > upper) return;
      yield event;
    }
  }

  async headSequence(worldId: string): Promise<number> {
    const world = this.#worlds.get(worldId);
    if (world === undefined) return -1;
    await world.tail;
    if (world.poison !== null) throw world.poison;
    return world.nextSequence - 1;
  }

  async head(worldId: string): Promise<CanonicalEvent | null> {
    const world = this.#worlds.get(worldId);
    if (world === undefined) return null;
    await world.tail;
    if (world.poison !== null) throw world.poison;
    return world.headEvent;
  }

  /** Path of a world's log file, whether or not it exists yet. */
  pathFor(worldId: string): string {
    return join(this.#directory, `${worldFileStem(worldId)}.jsonl`);
  }

  /** Flush queued writes and release every file handle. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const world of this.#worlds.values()) {
      await world.tail;
      if (world.handle !== null) {
        await world.handle.close();
        world.handle = null;
      }
    }
  }

  #worldFor(worldId: string): WorldLog {
    let world = this.#worlds.get(worldId);
    if (world === undefined) {
      world = {
        worldId,
        path: this.pathFor(worldId),
        handle: null,
        headEvent: null,
        nextSequence: 0,
        tail: Promise.resolve(),
        poison: null,
      };
      this.#worlds.set(worldId, world);
    }
    return world;
  }

  async #writeLine(world: WorldLog, line: string): Promise<void> {
    try {
      const handle = await this.#handleFor(world);
      const buffer = Buffer.from(line, "utf8");
      const { bytesWritten } = await handle.write(buffer, 0, buffer.length);
      if (bytesWritten !== buffer.length) {
        // A short write on a regular file means the filesystem ran out of room
        // or the descriptor is in a state we do not understand. Either way a
        // partial line is now on disk and this log must not be extended.
        throw new Error(`short write: ${bytesWritten} of ${buffer.length} bytes`);
      }
      if (this.#fsync) await handle.sync();
    } catch (cause) {
      const error = new LogWriteError(
        world.worldId,
        cause instanceof Error ? cause.message : String(cause),
        { cause },
      );
      world.poison = error;
      // The head is no longer trustworthy: it may describe an event whose bytes
      // are partly on disk. Only a fresh `open()` — which rescans and revalidates
      // — may clear this.
      throw error;
    }
  }

  async #handleFor(world: WorldLog): Promise<FileHandle> {
    if (world.handle !== null) return world.handle;

    const isNewFile = !(await pathExists(world.path));
    // O_APPEND: every write atomically seeks to end-of-file, so no reader or
    // concurrent writer can ever see a line spliced out of two records.
    world.handle = await fsOpen(world.path, "a");
    if (isNewFile) await fsyncDirectory(this.#directory);
    return world.handle;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `fsync` the containing directory after creating a file.
 *
 * On POSIX, fsyncing a file does not guarantee its *directory entry* survives a
 * crash; the file can come back as a zero-length orphan or not at all. Best
 * effort: some platforms and filesystems refuse an fsync on a directory
 * descriptor, and failing an append over that would be worse than the risk.
 */
async function fsyncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await fsOpen(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch {
    // Platform does not permit it; the file's own fsync still stands.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseEventLine(path: string, lineNumber: number, text: string): CanonicalEvent {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new LogCorruptionError(
      path,
      "unparseable-line",
      `not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
      lineNumber,
    );
  }

  const parsed = CanonicalEventSchema.safeParse(json);
  if (!parsed.success) {
    throw new LogCorruptionError(
      path,
      "schema-violation",
      `valid JSON but not a canonical event: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
      lineNumber,
    );
  }
  return parsed.data;
}

interface LogScan {
  readonly worldId: string;
  readonly head: CanonicalEvent;
  readonly count: number;
}

/**
 * Read a log end to end, establishing its head and (optionally) proving its
 * chain. Returns `null` for an empty file.
 *
 * Verification runs `verifyChain` over overlapping windows: each window starts
 * with the last event of the previous one, so every adjacency is checked exactly
 * once and memory stays flat regardless of log size. The carried event was
 * already proven clean in the previous window, so it can only contribute a
 * violation involving its successor — no violation is reported twice, and none
 * is filtered away.
 */
async function scanLog(path: string, verify: boolean): Promise<LogScan | null> {
  let worldId: string | null = null;
  let head: CanonicalEvent | null = null;
  let count = 0;

  let carry: CanonicalEvent | null = null;
  let batch: CanonicalEvent[] = [];

  const flush = (): void => {
    if (!verify || batch.length === 0) return;
    const window = carry === null ? batch : [carry, ...batch];
    const violations = verifyChain(window, worldId === null ? {} : { expectedWorldId: worldId });
    if (violations.length > 0) {
      throw new ChainIntegrityError(
        worldId ?? path,
        `the stored log at ${path} failed verification`,
        violations,
      );
    }
    carry = batch[batch.length - 1] ?? carry;
    batch = [];
  };

  for await (const line of readLines(path)) {
    const event = parseEventLine(path, line.lineNumber, line.text);

    if (worldId === null) {
      worldId = event.worldId;
      if (event.sequence !== 0) {
        throw new LogCorruptionError(
          path,
          "missing-genesis",
          `the first record is sequence ${event.sequence}; a world log always begins at 0`,
          line.lineNumber,
        );
      }
    }

    if (verify) {
      batch.push(event);
      if (batch.length >= VERIFY_CHUNK) flush();
    }
    head = event;
    count += 1;
  }
  flush();

  if (worldId === null || head === null) return null;
  return { worldId, head, count };
}
