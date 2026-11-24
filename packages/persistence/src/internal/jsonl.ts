// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Streaming JSONL reading, and the crash-detection rule that comes with it.
 *
 * Logs are expected to reach millions of events, so nothing here ever holds the
 * whole file. The reader yields one line at a time from a 64 KiB read stream.
 *
 * The important behaviour is what happens at the end of the file. A well-formed
 * append writes `<json>\n` in one `write(2)` on a descriptor opened `O_APPEND`.
 * If the process or machine dies mid-write, the kernel may have persisted only a
 * prefix of those bytes — a torn record. The tell is always the same: the file
 * does not end with a newline. So a non-empty trailing remainder is treated as
 * corruption rather than as a final record, and reading throws.
 *
 * This is stronger than relying on `JSON.parse` to fail. A truncated object is
 * almost always unparseable, but "almost always" is not a guarantee we can build
 * an audit trail on; "the last byte is not `\n`" is.
 */
import { createReadStream } from "node:fs";
import { LogCorruptionError } from "../errors.js";

export interface JsonLine {
  /** 1-based, for error messages that a human can act on. */
  readonly lineNumber: number;
  readonly text: string;
}

/**
 * Yield the complete lines of a file.
 *
 * Throws `LogCorruptionError` for a blank line, or for a trailing partial line
 * (a torn append). Does not parse: the caller decides what a line means.
 */
export async function* readLines(path: string): AsyncGenerator<JsonLine> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 16 });
  let buffer = "";
  let lineNumber = 0;

  try {
    // `encoding: "utf8"` puts a StringDecoder in front of the stream, so a
    // multi-byte character split across two chunks is reassembled correctly and
    // can never be mistaken for a record boundary.
    for await (const chunk of stream as AsyncIterable<string>) {
      buffer += chunk;
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt !== -1) {
        const text = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        lineNumber += 1;
        if (text.length === 0) {
          throw new LogCorruptionError(
            path,
            "blank-line",
            "an empty line is not an event; something wrote bytes that are not a record",
            lineNumber,
          );
        }
        yield { lineNumber, text };
        newlineAt = buffer.indexOf("\n");
      }
    }
  } finally {
    stream.destroy();
  }

  if (buffer.length > 0) {
    throw new LogCorruptionError(
      path,
      "truncated-line",
      `the file does not end with a newline; ${buffer.length} trailing byte(s) are a ` +
        `record torn by a crash mid-append. The log is not safe to extend — the last ` +
        `complete record must be established and the partial bytes removed by an ` +
        `operator, never by this process`,
      lineNumber + 1,
    );
  }
}
