/**
 * Spend control tests (§15).
 *
 * The headline requirement: reaching a ceiling throws, and nothing is emitted.
 * The world pauses rather than proceeding unfunded.
 */
import { describe, expect, it, vi } from "vitest";
import { SpendLimitExceededError } from "@after-genesis/core";
import {
  SpendLedger,
  UnknownModelPriceError,
  assertSealedWorldPolicy,
  usdToMicros,
} from "./budget.js";
import { TEST_PRICES } from "./testing.js";

const limits = { dailyMicros: 1_000_000, totalMicros: 5_000_000 };

function ledger(overrides: Partial<typeof limits> = {}): SpendLedger {
  return new SpendLedger({ limits: { ...limits, ...overrides }, prices: TEST_PRICES });
}

describe("cost estimation", () => {
  it("computes integer micros from the verified price table", () => {
    // 1,000,000 input tokens at 100,000 micros/M = 100,000 micros.
    expect(ledger().estimateMicros("test-model", 1_000_000, 0)).toBe(100_000);
    expect(ledger().estimateMicros("test-model", 0, 1_000_000)).toBe(400_000);
  });

  it("rounds up, so the ledger never systematically under-counts", () => {
    // 1 token at 100,000 micros/M is 0.1 micros, which must cost 1, not 0.
    expect(ledger().estimateMicros("test-model", 1, 0)).toBe(1);
  });

  it("always returns a safe integer", () => {
    const value = ledger().estimateMicros("test-model", 123_457, 65_537);
    expect(Number.isSafeInteger(value)).toBe(true);
  });

  it("refuses an unpriced model rather than treating it as free", () => {
    // A zero default would make an unpriced model infinitely spendable, which is
    // exactly the failure this module exists to prevent.
    expect(() => ledger().estimateMicros("unknown-model", 1, 1)).toThrow(UnknownModelPriceError);
  });

  it("rejects a fractional limit at construction", () => {
    expect(
      () => new SpendLedger({ limits: { dailyMicros: 1.5, totalMicros: 10 }, prices: TEST_PRICES }),
    ).toThrow(RangeError);
  });
});

describe("ceilings", () => {
  it("permits a request that fits", () => {
    const l = ledger();
    expect(() =>
      l.assertCanSpend({
        modelId: "test-model",
        dayKey: "2026-07-28",
        estimatedInputTokens: 1_000,
        maxOutputTokens: 500,
      }),
    ).not.toThrow();
  });

  it("throws SpendLimitExceededError when the daily ceiling would be crossed", () => {
    const l = ledger({ dailyMicros: 1_000 });
    expect(() =>
      l.assertCanSpend({
        modelId: "test-model",
        dayKey: "2026-07-28",
        estimatedInputTokens: 100_000,
        maxOutputTokens: 100_000,
      }),
    ).toThrow(SpendLimitExceededError);
  });

  it("throws when the total ceiling would be crossed", () => {
    const l = ledger({ dailyMicros: 10_000_000, totalMicros: 1_000 });
    expect(() =>
      l.assertCanSpend({
        modelId: "test-model",
        dayKey: "2026-07-28",
        estimatedInputTokens: 100_000,
        maxOutputTokens: 100_000,
      }),
    ).toThrow(SpendLimitExceededError);
  });

  it("names which limit tripped, so an operator knows what to raise", () => {
    const l = ledger({ dailyMicros: 1 });
    const error = catchError(() =>
      l.assertCanSpend({
        modelId: "test-model",
        dayKey: "2026-07-28",
        estimatedInputTokens: 10_000,
        maxOutputTokens: 10_000,
      }),
    ) as SpendLimitExceededError;
    expect(error.limitName).toBe("daily:2026-07-28");
    expect(error.limitMicros).toBe(1);
  });

  it("DOES NOT EMIT A REQUEST when a ceiling is reached", async () => {
    // The whole point: the ceiling is checked before the provider is contacted.
    const provider = { name: "spy", generate: vi.fn() };
    const l = ledger({ dailyMicros: 1 });

    const run = async (): Promise<void> => {
      l.assertCanSpend({
        modelId: "test-model",
        dayKey: "2026-07-28",
        estimatedInputTokens: 10_000,
        maxOutputTokens: 10_000,
      });
      await provider.generate();
    };

    await expect(run()).rejects.toBeInstanceOf(SpendLimitExceededError);
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("charges the full maxOutputTokens, so the last request of the day cannot overshoot", () => {
    // 10,000 output tokens at 400,000 micros/M = 4,000 micros.
    const l = ledger({ dailyMicros: 3_999 });
    expect(() =>
      l.assertCanSpend({
        modelId: "test-model",
        dayKey: "d",
        estimatedInputTokens: 0,
        maxOutputTokens: 10_000,
      }),
    ).toThrow(SpendLimitExceededError);
  });

  it("isolates days from one another", () => {
    const l = ledger({ dailyMicros: 5_000 });
    l.record({ dayKey: "day-1", modelId: "test-model", inputTokens: 0, outputTokens: 10_000, sequence: 1 });
    expect(l.spentToday("day-1")).toBe(4_000);
    expect(l.spentToday("day-2")).toBe(0);
    expect(() =>
      l.assertCanSpend({ modelId: "test-model", dayKey: "day-2", estimatedInputTokens: 0, maxOutputTokens: 1_000 }),
    ).not.toThrow();
  });

  it("accumulates towards the total across days", () => {
    const l = ledger({ dailyMicros: 10_000, totalMicros: 6_000 });
    l.record({ dayKey: "day-1", modelId: "test-model", inputTokens: 0, outputTokens: 10_000, sequence: 1 });
    l.record({ dayKey: "day-2", modelId: "test-model", inputTokens: 0, outputTokens: 5_000, sequence: 2 });
    expect(l.spentTotal()).toBe(6_000);
    expect(() =>
      l.assertCanSpend({ modelId: "test-model", dayKey: "day-3", estimatedInputTokens: 0, maxOutputTokens: 1 }),
    ).toThrow(SpendLimitExceededError);
  });

  it("reports frozen state without needing a request", () => {
    const l = ledger({ dailyMicros: 4_000 });
    expect(l.isFrozen("day-1")).toBe(false);
    l.record({ dayKey: "day-1", modelId: "test-model", inputTokens: 0, outputTokens: 10_000, sequence: 1 });
    expect(l.isFrozen("day-1")).toBe(true);
  });
});

describe("recording", () => {
  it("records actual usage and never throws on the ceiling", () => {
    // By the time record() runs the money is spent. Refusing to write it down
    // would leave the ledger understating reality.
    const l = ledger({ dailyMicros: 1 });
    expect(() =>
      l.record({ dayKey: "d", modelId: "test-model", inputTokens: 1_000_000, outputTokens: 0, sequence: 1 }),
    ).not.toThrow();
    expect(l.spentTotal()).toBe(100_000);
    // ...and the next check sees the true total.
    expect(() =>
      l.assertCanSpend({ modelId: "test-model", dayKey: "d", estimatedInputTokens: 1, maxOutputTokens: 1 }),
    ).toThrow(SpendLimitExceededError);
  });

  it("keeps an append-only history", () => {
    const l = ledger();
    l.record({ dayKey: "d", modelId: "test-model", inputTokens: 10, outputTokens: 20, sequence: 7 });
    const history = l.history();
    expect(history).toHaveLength(1);
    expect(history[0]?.sequence).toBe(7);
    // The returned array is a copy: a caller cannot rewrite the ledger.
    (history as unknown as unknown[]).push({});
    expect(l.history()).toHaveLength(1);
  });

  it("produces a deterministic snapshot with sorted day keys", () => {
    const l = ledger();
    for (const day of ["2026-07-30", "2026-07-28", "2026-07-29"]) {
      l.record({ dayKey: day, modelId: "test-model", inputTokens: 100, outputTokens: 0, sequence: 1 });
    }
    expect(Object.keys(l.snapshot().byDay)).toEqual([
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
    ]);
  });
});

describe("usdToMicros", () => {
  it("converts whole and fractional amounts exactly", () => {
    expect(usdToMicros("25")).toBe(25_000_000);
    expect(usdToMicros("0.5")).toBe(500_000);
    expect(usdToMicros("25.10")).toBe(25_100_000);
    expect(usdToMicros("0.000001")).toBe(1);
  });

  it("does not go through binary floating point", () => {
    // parseFloat("25.10") * 1e6 is 25099999.999999996, which truncates to a
    // ceiling one micro below what was configured.
    expect(usdToMicros("25.10")).toBe(25_100_000);
    expect(usdToMicros("0.07")).toBe(70_000);
    expect(usdToMicros("1.005")).toBe(1_005_000);
  });

  it("rejects anything it cannot represent exactly", () => {
    expect(() => usdToMicros("-1")).toThrow(RangeError);
    expect(() => usdToMicros("1.2345678")).toThrow(RangeError);
    expect(() => usdToMicros("1e6")).toThrow(RangeError);
    expect(() => usdToMicros("free")).toThrow(RangeError);
  });
});

function catchError(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

/* -------------------------------------------------------------------------- */
/* Observe mode — the meter without the brake                                  */
/* -------------------------------------------------------------------------- */

/**
 * `"observe"` exists for a disposable testbed, where an unexpected freeze costs
 * more than an unexpected bill. These tests pin both halves of that bargain:
 * nothing is ever refused, and every number is still correct — because a mode
 * that stopped counting would leave an operator with no way to notice a runaway.
 */
function observing(overrides: Partial<typeof limits> = {}): SpendLedger {
  return new SpendLedger({
    limits: { ...limits, ...overrides },
    prices: TEST_PRICES,
    enforcement: "observe",
  });
}

describe("observe mode never stops the world", () => {
  it("defaults to freeze, so the safe behaviour is the one you get for free", () => {
    expect(ledger().enforcement).toBe("freeze");
  });

  it("permits a request that would blow the daily ceiling many times over", () => {
    const observer = observing({ dailyMicros: 1 });
    expect(() =>
      observer.assertCanSpend({
        modelId: "test-model",
        dayKey: "2026-07-28",
        estimatedInputTokens: 10_000_000,
        maxOutputTokens: 10_000_000,
      }),
    ).not.toThrow();
  });

  it("permits a request that would blow the lifetime ceiling", () => {
    const observer = observing({ totalMicros: 1 });
    expect(() =>
      observer.assertCanSpend({
        modelId: "test-model",
        dayKey: "2026-07-28",
        estimatedInputTokens: 10_000_000,
        maxOutputTokens: 0,
      }),
    ).not.toThrow();
  });

  it("keeps refusing an unpriced model — that is a bug, not a budget", () => {
    // Turning off the ceiling must not turn off correctness. An unpriced model
    // would silently record zero cost and make the meter lie.
    expect(() =>
      observing().assertCanSpend({
        modelId: "unknown-model",
        dayKey: "2026-07-28",
        estimatedInputTokens: 1,
        maxOutputTokens: 1,
      }),
    ).toThrow(UnknownModelPriceError);
  });

  it("still returns the true projected cost", () => {
    const projected = observing({ dailyMicros: 1 }).assertCanSpend({
      modelId: "test-model",
      dayKey: "2026-07-28",
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 0,
    });
    expect(projected).toBe(100_000);
  });

  it("never reports itself frozen, however much has been spent", () => {
    const observer = observing({ dailyMicros: 1, totalMicros: 1 });
    observer.record({
      dayKey: "2026-07-28",
      modelId: "test-model",
      inputTokens: 5_000_000,
      outputTokens: 0,
      sequence: 1,
    });
    expect(observer.isFrozen("2026-07-28")).toBe(false);
  });

  it("still tells the truth about having passed a stated ceiling", () => {
    // This is the distinction that makes "observe" safe to operate: the brake is
    // gone, the warning light is not.
    const observer = observing({ dailyMicros: 1, totalMicros: 1 });
    observer.record({
      dayKey: "2026-07-28",
      modelId: "test-model",
      inputTokens: 5_000_000,
      outputTokens: 0,
      sequence: 1,
    });
    expect(observer.isOverLimit("2026-07-28")).toBe(true);
    expect(observer.snapshot().overLimit).toBe(true);
    expect(observer.snapshot().enforcement).toBe("observe");
  });

  it("accounts identically to freeze mode", () => {
    const strict = ledger();
    const relaxed = observing();
    const entry = {
      dayKey: "2026-07-28",
      modelId: "test-model",
      inputTokens: 1_234_567,
      outputTokens: 7_654,
      sequence: 1,
    } as const;
    expect(relaxed.record(entry).micros).toBe(strict.record(entry).micros);
    expect(relaxed.spentTotal()).toBe(strict.spentTotal());
  });
});

describe("a world in observe mode cannot be sealed", () => {
  it("refuses to seal, because §15 and §28 require working spend limits", () => {
    expect(() => assertSealedWorldPolicy(observing())).toThrow(/refusing to seal/i);
  });

  it("names the setting that fixes it, so the error is actionable", () => {
    expect(() => assertSealedWorldPolicy(observing())).toThrow(/AG_SPEND_ENFORCEMENT=freeze/);
  });

  it("allows sealing a world that enforces its ceilings", () => {
    expect(() => assertSealedWorldPolicy(ledger())).not.toThrow();
  });
});
