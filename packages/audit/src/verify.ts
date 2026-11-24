// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * The public verifier (§16, §28).
 *
 * Anyone — with no access to our infrastructure, no credentials, and no reason
 * to trust us — must be able to take an exported history and check it. That is
 * the entire basis for calling this world auditable. If verification required
 * our cooperation it would prove nothing.
 *
 * This module deliberately depends on nothing but the core event definitions.
 * No network, no database, no cloud SDK. A reader can audit the world with a
 * checkout of this repository and a file.
 *
 * What this proves and what it does not:
 *
 * - It PROVES the log is internally consistent: unbroken hash chain, monotonic
 *   sequence and time, continuous state checksums, one world.
 * - It does NOT prove the recorded state is what the engine would produce. That
 *   requires replaying the log through the engine and comparing checksums, which
 *   is the replay service's job. A log can be perfectly self-consistent and
 *   still describe a world whose rules were applied incorrectly.
 *
 * Both checks are needed. Conflating them would be the easiest way to make a
 * dishonest world look honest.
 */
import {
  CanonicalEventSchema,
  GENESIS_PREV_HASH,
  hashEquals,
  verifyChain,
  type CanonicalEvent,
  type ChainViolation,
} from "@after-genesis/core";

export interface VerificationReport {
  readonly ok: boolean;
  readonly worldId: string | null;
  readonly eventCount: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  /** Hash of the final event — the value to compare against a published anchor. */
  readonly headHash: string | null;
  /** State checksum after the final event. */
  readonly headStateChecksum: string | null;
  readonly violations: readonly VerificationIssue[];
  readonly warnings: readonly string[];
}

export interface VerificationIssue {
  readonly sequence: number | null;
  readonly kind: ChainViolation["kind"] | "malformed-event" | "not-anchored" | "empty-log";
  readonly detail: string;
}

export interface VerifyOptions {
  /** If given, every event must belong to this world. */
  readonly expectedWorldId?: string;
  /**
   * A previously published head hash (§16 anchors the chain outside Firestore
   * via a public GitHub artifact). Supplying it is what turns "this log is
   * self-consistent" into "this log is the one that was published", which is the
   * check that actually catches a wholesale replacement of history.
   */
  readonly expectedHeadHash?: string;
  /** Require the log to begin at sequence 0. Off for partial-range exports. */
  readonly requireGenesis?: boolean;
}

/**
 * Parse and verify an exported history.
 *
 * Accepts already-parsed events. Malformed entries are reported rather than
 * thrown, so a reader gets a complete report instead of the first failure.
 */
export function verifyExport(
  rawEvents: readonly unknown[],
  options: VerifyOptions = {},
): VerificationReport {
  const issues: VerificationIssue[] = [];
  const warnings: string[] = [];
  const events: CanonicalEvent[] = [];

  // 1. Structural validation. An event that does not parse cannot be chained,
  //    but we keep going so the report covers the whole file.
  for (let i = 0; i < rawEvents.length; i++) {
    const parsed = CanonicalEventSchema.safeParse(rawEvents[i]);
    if (parsed.success) {
      events.push(parsed.data);
    } else {
      const seq = (rawEvents[i] as { sequence?: unknown })?.sequence;
      issues.push({
        sequence: typeof seq === "number" ? seq : null,
        kind: "malformed-event",
        detail: `entry ${i} failed schema validation: ${parsed.error.issues
          .slice(0, 3)
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join("; ")}`,
      });
    }
  }

  if (events.length === 0) {
    return {
      ok: false,
      worldId: null,
      eventCount: 0,
      firstSequence: null,
      lastSequence: null,
      headHash: null,
      headStateChecksum: null,
      violations: [
        ...issues,
        { sequence: null, kind: "empty-log", detail: "no valid events to verify" },
      ],
      warnings,
    };
  }

  // 2. Chain integrity — hashes, links, ordering, checksum continuity.
  const chainViolations = verifyChain(events, {
    ...(options.expectedWorldId !== undefined
      ? { expectedWorldId: options.expectedWorldId }
      : {}),
  });
  for (const v of chainViolations) {
    issues.push({ sequence: v.sequence, kind: v.kind, detail: v.detail });
  }

  const first = events[0]!;
  const head = events[events.length - 1]!;

  // 3. Genesis anchoring. A log that does not start at sequence 0 is a partial
  //    export: still verifiable internally, but it cannot prove its own origin,
  //    because the events before it could say anything.
  if (options.requireGenesis === true && first.sequence !== 0) {
    issues.push({
      sequence: first.sequence,
      kind: "not-anchored",
      detail: `log begins at sequence ${first.sequence}, not 0, so its origin is unverifiable`,
    });
  } else if (first.sequence !== 0) {
    warnings.push(
      `Partial export: begins at sequence ${first.sequence}. Chain integrity is verified ` +
        `from that point forward, but the history before it is not covered by this check.`,
    );
  } else if (!hashEquals(first.prevHash, GENESIS_PREV_HASH)) {
    issues.push({
      sequence: 0,
      kind: "not-anchored",
      detail: "sequence 0 does not chain from the genesis terminator",
    });
  }

  // 4. Comparison against an externally published anchor. Without this, a log
  //    forged wholesale from a different Genesis would verify perfectly — every
  //    hash would be internally correct, just for a different world.
  if (options.expectedHeadHash !== undefined) {
    if (!hashEquals(head.hash, options.expectedHeadHash)) {
      issues.push({
        sequence: head.sequence,
        kind: "bad-hash",
        detail:
          `head hash ${head.hash.slice(0, 16)}… does not match the published anchor ` +
          `${options.expectedHeadHash.slice(0, 16)}…. This log is not the published history.`,
      });
    }
  } else {
    warnings.push(
      "No expectedHeadHash supplied. This verifies the log is self-consistent, but not " +
        "that it is the published history — a wholesale forgery from a different Genesis " +
        "would pass. Compare the head hash against the public anchor.",
    );
  }

  return {
    ok: issues.length === 0,
    worldId: first.worldId,
    eventCount: events.length,
    firstSequence: first.sequence,
    lastSequence: head.sequence,
    headHash: head.hash,
    headStateChecksum: head.postStateChecksum,
    violations: issues,
    warnings,
  };
}

/** Parse newline-delimited JSON, tolerating blank lines and a trailing newline. */
export function parseJsonl(contents: string): { values: unknown[]; parseErrors: string[] } {
  const values: unknown[] = [];
  const parseErrors: string[] = [];
  const lines = contents.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    try {
      values.push(JSON.parse(line));
    } catch (error) {
      parseErrors.push(
        `line ${i + 1}: ${error instanceof Error ? error.message : "invalid JSON"}`,
      );
    }
  }
  return { values, parseErrors };
}

/** Render a report as human-readable text for the CLI. */
export function formatReport(report: VerificationReport): string {
  const lines: string[] = [];
  lines.push(report.ok ? "VERIFIED" : "FAILED");
  lines.push("");
  lines.push(`  World:            ${report.worldId ?? "(none)"}`);
  lines.push(`  Events:           ${report.eventCount}`);
  lines.push(`  Sequence range:   ${report.firstSequence ?? "-"} … ${report.lastSequence ?? "-"}`);
  lines.push(`  Head hash:        ${report.headHash ?? "(none)"}`);
  lines.push(`  Head checksum:    ${report.headStateChecksum ?? "(none)"}`);

  if (report.violations.length > 0) {
    lines.push("");
    lines.push(`  ${report.violations.length} violation(s):`);
    for (const v of report.violations.slice(0, 50)) {
      lines.push(`    [seq ${v.sequence ?? "?"}] ${v.kind}: ${v.detail}`);
    }
    if (report.violations.length > 50) {
      lines.push(`    … and ${report.violations.length - 50} more`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("  Warnings:");
    for (const w of report.warnings) lines.push(`    - ${w}`);
  }

  lines.push("");
  lines.push(
    "  Note: this checks the log's internal consistency only. Proving the recorded",
  );
  lines.push(
    "  state is what the rules produce additionally requires a full replay.",
  );
  return lines.join("\n");
}
