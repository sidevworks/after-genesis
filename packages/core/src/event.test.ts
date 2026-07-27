import { describe, expect, it } from "vitest";
import {
  CanonicalEventSchema,
  EVENT_SCHEMA_VERSION,
  computeEventHash,
  sealEvent,
  verifyChain,
  type CanonicalEvent,
  type UnsealedEvent,
} from "./event.js";
import { GENESIS_PREV_HASH, hashValue, HashDomain, type Sha256Hex } from "./util/hash.js";

const checksum = (label: string): Sha256Hex => hashValue(HashDomain.StateChecksum, { label });

function makeEvent(overrides: Partial<UnsealedEvent> = {}): CanonicalEvent {
  const base: UnsealedEvent = {
    worldId: "world-test",
    sequence: 0,
    simTime: 0,
    realTimestamp: "2026-01-01T00:00:00.000Z",
    actor: null,
    type: "genesis",
    inputs: { seed: "abc" },
    resolution: { status: "resolved", detail: {} },
    visibility: { kind: "public" },
    preStateChecksum: checksum("empty"),
    postStateChecksum: checksum("after-genesis"),
    provenance: {
      sourceCommit: "0000000",
      deployedDigest: "local",
      modelRequestHash: null,
      modelResponseHash: null,
      modelId: null,
    },
    schemaVersion: EVENT_SCHEMA_VERSION,
    prevHash: GENESIS_PREV_HASH,
    ...overrides,
  };
  return sealEvent(base);
}

/** Build a well-formed chain of `length` events. */
function makeChain(length: number): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  let prevHash = GENESIS_PREV_HASH;
  let prevPost = checksum("state-0");

  for (let i = 0; i < length; i++) {
    const post = checksum(`state-${i + 1}`);
    const event = makeEvent({
      sequence: i,
      simTime: i * 10,
      type: i === 0 ? "genesis" : "action.move",
      actor: i === 0 ? null : "inh_founder",
      prevHash,
      preStateChecksum: prevPost,
      postStateChecksum: post,
    });
    events.push(event);
    prevHash = event.hash;
    prevPost = post;
  }
  return events;
}

describe("event hashing", () => {
  it("is stable across recomputation", () => {
    const event = makeEvent();
    expect(computeEventHash(event)).toBe(event.hash);
  });

  it("excludes the hash field from its own preimage", () => {
    const event = makeEvent();
    const tamperedHashOnly = { ...event, hash: "f".repeat(64) as Sha256Hex };
    // Recomputing ignores the stored hash, so it still yields the true hash.
    expect(computeEventHash(tamperedHashOnly)).toBe(event.hash);
  });

  it("is insensitive to property insertion order", () => {
    const a = makeEvent();
    const reordered = Object.fromEntries(
      Object.entries(a).reverse(),
    ) as unknown as CanonicalEvent;
    expect(computeEventHash(reordered)).toBe(a.hash);
  });

  it.each([
    ["actor", { actor: "inh_someone_else" }],
    ["type", { type: "action.gather" }],
    ["simTime", { simTime: 999 }],
    ["sequence", { sequence: 7 }],
    ["inputs", { inputs: { seed: "different" } }],
    ["resolution", { resolution: { status: "rejected" } }],
    ["visibility", { visibility: { kind: "private", owner: "inh_x" } as const }],
    ["postStateChecksum", { postStateChecksum: checksum("forged") }],
    ["prevHash", { prevHash: checksum("forged") as unknown as Sha256Hex }],
  ])("changes when %s changes", (_field, override) => {
    const original = makeEvent();
    const modified = makeEvent(override as Partial<UnsealedEvent>);
    expect(modified.hash).not.toBe(original.hash);
  });

  it("distinguishes provenance, so the same action from different code is a different event", () => {
    const a = makeEvent();
    const b = makeEvent({
      provenance: { ...a.provenance, sourceCommit: "deadbee" },
    });
    expect(b.hash).not.toBe(a.hash);
  });
});

describe("verifyChain", () => {
  it("accepts a well-formed chain", () => {
    expect(verifyChain(makeChain(20))).toEqual([]);
  });

  it("accepts an empty log", () => {
    expect(verifyChain([])).toEqual([]);
  });

  it("requires the first event to chain from the genesis terminator", () => {
    const orphan = makeEvent({ sequence: 0, prevHash: checksum("not-genesis") as Sha256Hex });
    const violations = verifyChain([orphan]);
    expect(violations.map((v) => v.kind)).toContain("broken-link");
  });

  describe("tamper detection", () => {
    /**
     * The core promise of §16 and §28: "A technical fault can pause the world
     * but cannot silently rewrite its history." Each of these is an attempt to
     * rewrite history; each must be caught.
     */
    it("detects a field edited in place without rehashing", () => {
      const chain = makeChain(10);
      chain[4] = { ...chain[4]!, actor: "inh_impostor" };
      const violations = verifyChain(chain);
      expect(violations.some((v) => v.sequence === 4 && v.kind === "bad-hash")).toBe(true);
    });

    it("detects a field edited AND rehashed, because the link to the next event breaks", () => {
      // The sophisticated attack: forge the event and fix up its own hash.
      // The chain still breaks, because event 5 committed to the old hash.
      const chain = makeChain(10);
      chain[4] = sealEvent({ ...chain[4]!, actor: "inh_impostor" });
      const violations = verifyChain(chain);
      expect(violations.some((v) => v.sequence === 4 && v.kind === "bad-hash")).toBe(false);
      expect(violations.some((v) => v.sequence === 5 && v.kind === "broken-link")).toBe(true);
    });

    it("detects a deleted event", () => {
      const chain = makeChain(10);
      chain.splice(5, 1);
      const violations = verifyChain(chain);
      expect(violations.some((v) => v.kind === "non-monotonic-sequence")).toBe(true);
      expect(violations.some((v) => v.kind === "broken-link")).toBe(true);
    });

    it("detects reordered events", () => {
      const chain = makeChain(10);
      const a = chain[3]!;
      chain[3] = chain[4]!;
      chain[4] = a;
      expect(verifyChain(chain).length).toBeGreaterThan(0);
    });

    it("detects an inserted event", () => {
      const chain = makeChain(10);
      chain.splice(5, 0, makeEvent({ sequence: 99, type: "action.fabricated" }));
      expect(verifyChain(chain).length).toBeGreaterThan(0);
    });

    it("detects simulated time moving backwards", () => {
      const chain = makeChain(5);
      const forged = sealEvent({ ...chain[3]!, simTime: 0 });
      chain[3] = forged;
      chain[4] = sealEvent({ ...chain[4]!, prevHash: forged.hash });
      const violations = verifyChain(chain);
      expect(violations.some((v) => v.kind === "time-travel")).toBe(true);
    });

    it("detects a state checksum discontinuity", () => {
      // Catches an event whose recorded 'before' state disagrees with the
      // previous event's 'after' state — i.e. an unrecorded mutation.
      const chain = makeChain(5);
      const forged = sealEvent({ ...chain[3]!, preStateChecksum: checksum("phantom") });
      chain[3] = forged;
      chain[4] = sealEvent({ ...chain[4]!, prevHash: forged.hash });
      const violations = verifyChain(chain);
      expect(violations.some((v) => v.kind === "checksum-discontinuity")).toBe(true);
    });

    it("detects events spliced in from another world", () => {
      const chain = makeChain(5);
      chain[2] = sealEvent({ ...chain[2]!, worldId: "world-other" });
      const violations = verifyChain(chain, { expectedWorldId: "world-test" });
      expect(violations.some((v) => v.kind === "world-mismatch")).toBe(true);
    });
  });

  it("reports every violation rather than stopping at the first", () => {
    const chain = makeChain(10);
    chain[2] = { ...chain[2]!, actor: "x" };
    chain[7] = { ...chain[7]!, type: "y" };
    const violations = verifyChain(chain);
    expect(violations.filter((v) => v.kind === "bad-hash").length).toBe(2);
  });
});

describe("CanonicalEventSchema", () => {
  it("accepts a well-formed event", () => {
    expect(CanonicalEventSchema.safeParse(makeEvent()).success).toBe(true);
  });

  it.each([
    ["a malformed hash", { hash: "not-a-hash" }],
    ["a negative sequence", { sequence: -1 }],
    ["a negative simTime", { simTime: -1 }],
    ["a fractional sequence", { sequence: 1.5 }],
    ["an empty type", { type: "" }],
  ])("rejects %s", (_label, override) => {
    const event = { ...makeEvent(), ...override };
    expect(CanonicalEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects a participants visibility with no participants", () => {
    const event = { ...makeEvent(), visibility: { kind: "participants", participants: [] } };
    expect(CanonicalEventSchema.safeParse(event).success).toBe(false);
  });
});
