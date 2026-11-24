// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import {
  EVENT_SCHEMA_VERSION,
  GENESIS_PREV_HASH,
  HashDomain,
  hashValue,
  sealEvent,
  type CanonicalEvent,
  type Sha256Hex,
} from "@after-genesis/core";
import { formatReport, parseJsonl, verifyExport } from "./verify.js";

const checksum = (label: string): Sha256Hex => hashValue(HashDomain.StateChecksum, { label });

function makeChain(length: number, worldId = "world-alpha"): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  let prevHash = GENESIS_PREV_HASH;
  let prevPost = checksum(`${worldId}-state-0`);

  for (let i = 0; i < length; i++) {
    const post = checksum(`${worldId}-state-${i + 1}`);
    const event = sealEvent({
      worldId,
      sequence: i,
      simTime: i * 15,
      realTimestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
      actor: i === 0 ? null : "inh_founder",
      type: i === 0 ? "genesis" : "action.gather",
      inputs: { n: i },
      resolution: { status: "resolved", detail: {} },
      visibility: { kind: "public" },
      preStateChecksum: prevPost,
      postStateChecksum: post,
      provenance: {
        sourceCommit: "abc1234",
        deployedDigest: "local",
        modelRequestHash: null,
        modelResponseHash: null,
        modelId: null,
      },
      schemaVersion: EVENT_SCHEMA_VERSION,
      prevHash,
    });
    events.push(event);
    prevHash = event.hash;
    prevPost = post;
  }
  return events;
}

describe("verifyExport", () => {
  it("verifies an intact log", () => {
    const report = verifyExport(makeChain(50), { requireGenesis: true });
    expect(report.ok).toBe(true);
    expect(report.eventCount).toBe(50);
    expect(report.firstSequence).toBe(0);
    expect(report.lastSequence).toBe(49);
  });

  it("reports the head hash and checksum for anchor comparison", () => {
    const chain = makeChain(10);
    const report = verifyExport(chain);
    expect(report.headHash).toBe(chain[9]!.hash);
    expect(report.headStateChecksum).toBe(chain[9]!.postStateChecksum);
  });

  describe("tamper detection", () => {
    it("catches an edited event", () => {
      const chain = makeChain(20);
      chain[10] = { ...chain[10]!, actor: "inh_impostor" };
      const report = verifyExport(chain);
      expect(report.ok).toBe(false);
      expect(report.violations.some((v) => v.kind === "bad-hash")).toBe(true);
    });

    it("catches an edited AND re-sealed event via the broken forward link", () => {
      const chain = makeChain(20);
      chain[10] = sealEvent({ ...chain[10]!, actor: "inh_impostor" });
      const report = verifyExport(chain);
      expect(report.ok).toBe(false);
      expect(report.violations.some((v) => v.kind === "broken-link")).toBe(true);
    });

    it("catches a deleted event", () => {
      const chain = makeChain(20);
      chain.splice(10, 1);
      expect(verifyExport(chain).ok).toBe(false);
    });

    it("catches events from a foreign world", () => {
      const chain = makeChain(10);
      const report = verifyExport(chain, { expectedWorldId: "world-beta" });
      expect(report.ok).toBe(false);
      expect(report.violations.some((v) => v.kind === "world-mismatch")).toBe(true);
    });
  });

  describe("anchoring", () => {
    /**
     * The subtle failure the anchor exists to catch: a forged history can be
     * *perfectly* self-consistent. Every hash checks out — it is simply a
     * different world. Only comparison against an externally published head
     * hash distinguishes the real history from a well-made replacement.
     */
    it("a wholesale forgery from a different Genesis is internally consistent", () => {
      const forged = makeChain(30, "world-forged");
      expect(verifyExport(forged).ok).toBe(true);
    });

    it("…but fails against the genuine published anchor", () => {
      const genuine = makeChain(30, "world-alpha");
      const forged = makeChain(30, "world-forged");
      const report = verifyExport(forged, {
        expectedHeadHash: genuine[29]!.hash,
      });
      expect(report.ok).toBe(false);
      expect(report.violations.some((v) => v.detail.includes("not the published history"))).toBe(
        true,
      );
    });

    it("passes when the anchor matches", () => {
      const chain = makeChain(30);
      expect(verifyExport(chain, { expectedHeadHash: chain[29]!.hash }).ok).toBe(true);
    });

    it("warns loudly when no anchor is supplied", () => {
      const report = verifyExport(makeChain(5));
      expect(report.warnings.some((w) => w.includes("not that it is the published history"))).toBe(
        true,
      );
    });

    it("fails a non-genesis-anchored log when genesis is required", () => {
      const chain = makeChain(10).slice(3);
      const report = verifyExport(chain, { requireGenesis: true });
      expect(report.ok).toBe(false);
      expect(report.violations.some((v) => v.kind === "not-anchored")).toBe(true);
    });

    it("accepts a partial export with a warning when genesis is not required", () => {
      const chain = makeChain(10).slice(3);
      const report = verifyExport(chain);
      expect(report.ok).toBe(true);
      expect(report.warnings.some((w) => w.includes("Partial export"))).toBe(true);
    });
  });

  describe("malformed input", () => {
    it("reports malformed entries rather than throwing", () => {
      const report = verifyExport([{ not: "an event" }, null, 42]);
      expect(report.ok).toBe(false);
      expect(report.violations.filter((v) => v.kind === "malformed-event").length).toBe(3);
    });

    it("reports an empty log as a failure", () => {
      const report = verifyExport([]);
      expect(report.ok).toBe(false);
      expect(report.violations.some((v) => v.kind === "empty-log")).toBe(true);
    });

    it("continues past a malformed entry to report everything", () => {
      const chain: unknown[] = [...makeChain(5)];
      chain.splice(2, 0, { garbage: true });
      const report = verifyExport(chain);
      expect(report.violations.some((v) => v.kind === "malformed-event")).toBe(true);
      expect(report.eventCount).toBe(5);
    });
  });
});

describe("parseJsonl", () => {
  it("parses newline-delimited JSON and ignores blank lines", () => {
    const { values, parseErrors } = parseJsonl('{"a":1}\n\n{"b":2}\n');
    expect(values).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseErrors).toEqual([]);
  });

  it("reports the line number of an unparseable line", () => {
    const { values, parseErrors } = parseJsonl('{"a":1}\nnot json\n{"b":2}');
    expect(values).toHaveLength(2);
    expect(parseErrors[0]).toContain("line 2");
  });

  it("catches a truncated final line, as a crash mid-append would leave", () => {
    const { parseErrors } = parseJsonl('{"a":1}\n{"b":');
    expect(parseErrors).toHaveLength(1);
  });
});

describe("formatReport", () => {
  it("leads with the verdict", () => {
    expect(formatReport(verifyExport(makeChain(3)))).toMatch(/^VERIFIED/);
    expect(formatReport(verifyExport([]))).toMatch(/^FAILED/);
  });

  it("states the limits of what was proven", () => {
    expect(formatReport(verifyExport(makeChain(3)))).toContain("replay");
  });
});
