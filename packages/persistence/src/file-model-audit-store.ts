/**
 * Write-once storage of raw model requests and responses (§16).
 *
 * This store is the reason replay is possible. No hosted LLM is bit-reproducible
 * — not even at temperature 0 — so a replay that re-called the model would
 * produce a different history and prove nothing. Instead the engine records the
 * exact prompt and the untouched raw response at the moment they happen, and
 * replay serves those recordings back through a `ModelProvider` that never
 * touches a network (§4I). `get()` is that seam.
 *
 * ## Write-once, and the one exception
 *
 * The turn lifecycle stores the request *before* calling the model (§14.6) and
 * the raw response *after* (§14.8), so an entry legitimately transitions from
 * "request recorded, no response" to "request and response recorded". Exactly
 * one such transition is permitted, and only if the request is byte-identical.
 *
 * Everything else is refused:
 *  - a different response for a sequence that already has one — the violation
 *    that would let someone author a history that never happened;
 *  - a different request for a sequence that already has one;
 *  - replacing a recorded response with `null`.
 *
 * Recording the *same* entry twice is a no-op, because §18 requires every queued
 * unit of work to tolerate duplicate delivery. Idempotent, not permissive: the
 * comparison is over a digest of the whole record.
 *
 * ## Layout
 *
 * `<dir>/<world>/<sequence padded to 12>.json` for attempt one and
 * `<sequence>-a02.json` for the single correction. Padding keeps a directory
 * listing in turn/attempt order. One file per entry means it can be created with `O_EXCL`, so
 * first-writer-wins is enforced by the kernel rather than by a check-then-write
 * this process could lose a race on.
 */
import { mkdir, readFile, readdir, rename, unlink, open as fsOpen } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  sha256Hex,
  type Clock,
  type ModelAuditStore,
  type ModelResponse,
  type Sha256Hex,
} from "@after-genesis/core";
import { SystemClock } from "./clock.js";
import { AuditIntegrityError } from "./errors.js";
import { KeyedMutex } from "./internal/keyed-mutex.js";
import { stableStringify } from "./internal/stable-json.js";
import { worldFileStem } from "./internal/world-file.js";

/** The exact argument shape `ModelAuditStore.record` accepts. */
export type AuditEntry = Parameters<ModelAuditStore["record"]>[0];

/**
 * The request as stored. Identical to `ModelRequest` except `responseSchema` is
 * required-and-nullable rather than optional: an absent key and a key set to
 * `undefined` must not be able to produce two different digests for one record.
 */
export interface StoredModelRequest {
  readonly modelId: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly responseSchema: unknown;
  readonly maxOutputTokens: number;
  readonly temperature: number;
}

/** A stored audit record, as it appears on disk. */
export interface StoredAuditEntry {
  readonly worldId: string;
  readonly sequence: number;
  readonly attempt: number;
  readonly request: StoredModelRequest;
  readonly requestHash: Sha256Hex;
  readonly response: ModelResponse | null;
  readonly responseHash: Sha256Hex | null;
  readonly costMicros: number;
  /** Wall clock at the moment of recording. Forensic only; outside the digest. */
  readonly recordedAt: string;
  /** Digest of everything above except `recordedAt`. */
  readonly entryDigest: Sha256Hex;
}

const SEQUENCE_PAD = 12;

export class FileModelAuditStore implements ModelAuditStore {
  readonly #directory: string;
  readonly #clock: Clock;
  readonly #mutex = new KeyedMutex();

  private constructor(directory: string, clock: Clock) {
    this.#directory = directory;
    this.#clock = clock;
  }

  static async open(
    directory: string,
    options: { readonly clock?: Clock } = {},
  ): Promise<FileModelAuditStore> {
    await mkdir(directory, { recursive: true });
    return new FileModelAuditStore(directory, options.clock ?? new SystemClock());
  }

  pathFor(worldId: string, sequence: number, attempt: number = 1): string {
    assertSequence(sequence);
    assertAttempt(attempt);
    const suffix = attempt === 1 ? "" : `-a${String(attempt).padStart(2, "0")}`;
    return join(
      this.#directory,
      worldFileStem(worldId),
      `${String(sequence).padStart(SEQUENCE_PAD, "0")}${suffix}.json`,
    );
  }

  async record(entry: AuditEntry): Promise<void> {
    assertSequence(entry.sequence);
    const attempt = entry.attempt ?? 1;
    assertAttempt(attempt);
    const path = this.pathFor(entry.worldId, entry.sequence, attempt);
    const key = `${entry.worldId}#${entry.sequence}#${attempt}`;

    // Serialised per key so two in-process callers cannot both read "no entry"
    // and both create one. Across processes, the `wx` open below is the guard.
    await this.#mutex.run(key, async () => {
      const incoming = buildRecord(entry, this.#clock);
      const existing = await this.#readEntry(path);

      if (existing === null) {
        await this.#createExclusive(path, incoming);
        return;
      }

      if (existing.entryDigest === incoming.entryDigest) {
        // Duplicate delivery of the identical record. Nothing changes.
        return;
      }

      if (existing.requestHash !== incoming.requestHash) {
        throw new AuditIntegrityError(
          entry.worldId,
          entry.sequence,
          `a different model request is already recorded for this sequence ` +
            `(stored ${existing.requestHash.slice(0, 12)}…, incoming ${incoming.requestHash.slice(0, 12)}…)`,
        );
      }

      if (existing.response !== null) {
        throw new AuditIntegrityError(
          entry.worldId,
          entry.sequence,
          incoming.response === null
            ? `a response is already recorded and cannot be erased`
            : `a different response is already recorded ` +
              `(stored ${String(existing.responseHash).slice(0, 12)}…, ` +
              `incoming ${String(incoming.responseHash).slice(0, 12)}…). ` +
              `Rewriting a recorded response would let replay produce a history that never happened`,
        );
      }

      if (incoming.response === null) {
        // Nothing was recorded and nothing is being added beyond metadata drift
        // (cost, say). Refuse rather than silently rewrite an audit record.
        throw new AuditIntegrityError(
          entry.worldId,
          entry.sequence,
          `the stored record differs from the incoming one but neither carries a response; ` +
            `audit records are not editable`,
        );
      }

      // The one permitted transition: request-only becomes request+response.
      await this.#replaceAtomically(path, incoming);
    });
  }

  /**
   * The recorded response for a sequence, or `null`.
   *
   * `null` covers both "no record" and "request recorded but the model never
   * answered". A replay provider must treat both the same way: it cannot invent
   * a response, so the turn resolves as it did originally — model unavailability
   * reschedules the turn, it does not create a different state transition
   * (§14).
   */
  async get(
    worldId: string,
    sequence: number,
    attempt: number = 1,
  ): Promise<{ rawText: string; modelId: string } | null> {
    const stored = await this.#readEntry(this.pathFor(worldId, sequence, attempt));
    if (stored === null || stored.response === null) return null;
    return { rawText: stored.response.rawText, modelId: stored.response.modelId };
  }

  /** The complete stored record, for auditors and the verifier. */
  async getEntry(
    worldId: string,
    sequence: number,
    attempt: number = 1,
  ): Promise<StoredAuditEntry | null> {
    return this.#readEntry(this.pathFor(worldId, sequence, attempt));
  }

  /** Sequences with a record, ascending. */
  async sequences(worldId: string): Promise<number[]> {
    const dir = join(this.#directory, worldFileStem(worldId));
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    return names
      .filter((n) => /^\d{12}\.json$/.test(n))
      .map((n) => Number.parseInt(n.slice(0, -".json".length), 10))
      .filter((n) => Number.isSafeInteger(n))
      .sort((a, b) => a - b);
  }

  async #readEntry(path: string): Promise<StoredAuditEntry | null> {
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as StoredAuditEntry;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
  }

  async #createExclusive(path: string, record: StoredAuditEntry): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    let handle;
    try {
      // "wx" is O_CREAT|O_EXCL: the kernel refuses if the file exists, so two
      // processes racing to create the same entry cannot both believe they won.
      handle = await fsOpen(path, "wx");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        // Lost the race to another process. Re-enter the comparison path rather
        // than clobbering whatever it wrote.
        const existing = await this.#readEntry(path);
        if (existing !== null && existing.entryDigest === record.entryDigest) return;
        throw new AuditIntegrityError(
          record.worldId,
          record.sequence,
          "another writer recorded a different entry for this sequence first",
        );
      }
      throw cause;
    }
    try {
      await handle.writeFile(`${stableStringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #replaceAtomically(path: string, record: StoredAuditEntry): Promise<void> {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await fsOpen(temporary, "wx");
    try {
      await handle.writeFile(`${stableStringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      throw cause;
    }
  }
}

function buildRecord(entry: AuditEntry, clock: Clock): StoredAuditEntry {
  const core = {
    worldId: entry.worldId,
    sequence: entry.sequence,
    attempt: entry.attempt ?? 1,
    request: {
      modelId: entry.request.modelId,
      systemPrompt: entry.request.systemPrompt,
      userPrompt: entry.request.userPrompt,
      // `responseSchema` is optional on the port; normalising absence to null
      // keeps the digest stable whether a caller omitted it or passed undefined.
      responseSchema: entry.request.responseSchema ?? null,
      maxOutputTokens: entry.request.maxOutputTokens,
      temperature: entry.request.temperature,
    },
    requestHash: entry.requestHash,
    response:
      entry.response === null
        ? null
        : {
            rawText: entry.response.rawText,
            modelId: entry.response.modelId,
            inputTokens: entry.response.inputTokens,
            outputTokens: entry.response.outputTokens,
            finishReason: entry.response.finishReason,
          },
    responseHash: entry.responseHash,
    costMicros: entry.costMicros,
  };

  return {
    ...core,
    recordedAt: clock.nowIso(),
    entryDigest: sha256Hex(stableStringify(core)),
  };
}

function assertSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError(`Audit sequence must be a non-negative safe integer, got ${sequence}`);
  }
  if (String(sequence).length > SEQUENCE_PAD) {
    throw new RangeError(`Audit sequence ${sequence} exceeds the ${SEQUENCE_PAD}-digit file name`);
  }
}

function assertAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 99) {
    throw new RangeError(`Audit attempt must be an integer from 1 to 99, got ${attempt}`);
  }
}
