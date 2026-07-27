/**
 * Spend control (§15: "Spend limits freeze further paid inference safely").
 *
 * The design decision that matters here is what happens at the ceiling. The
 * ledger throws `SpendLimitExceededError` *before* a request is emitted, and the
 * turn scheduler is expected to let that propagate and pause the world.
 *
 * The alternative — degrade to a cheaper model, or skip cognition and take a
 * default action — is worse than it looks. A world that keeps running on
 * degraded cognition when it runs out of money produces canonical history that
 * nobody chose: the inhabitants did not decide to become simpler, the billing
 * did. Pausing is honest. It is recoverable, it is visible, and it leaves the
 * history intact. Running unfunded is none of those things.
 *
 * All amounts are integer micros (millionths of a currency unit). No floats
 * anywhere: cost feeds the audit record, and a value that differed in the last
 * bit across machines would break replay comparison (§15).
 *
 * ---------------------------------------------------------------------------
 * PRICING IS NOT ASSUMED.
 *
 * Every entry in a `PriceTable` must be verified against the provider's live,
 * published pricing page before Genesis, and re-verified whenever a model id in
 * `AG_MODEL_ROUTINE` / `AG_MODEL_DELIBERATE` changes. Prices move, tiers change
 * above a context threshold, and a stale table silently under-charges the ledger
 * — which means the ceiling that is supposed to pause the world never trips.
 *
 * There are deliberately NO default prices in this file. A missing price is an
 * error (`UnknownModelPriceError`), not a zero. A zero would make an unpriced
 * model free and infinitely spendable, which is exactly the failure this module
 * exists to prevent.
 * ---------------------------------------------------------------------------
 */
import { SpendLimitExceededError } from "@after-genesis/core";

/** Raised when a model has no verified price entry. Never defaults to zero. */
export class UnknownModelPriceError extends Error {
  constructor(readonly modelId: string) {
    super(
      `No verified price is configured for model "${modelId}". Cognition is refused ` +
        `rather than billed at an assumed rate. Add a verified PriceTable entry ` +
        `(see §15) before running this model.`,
    );
    this.name = "UnknownModelPriceError";
  }
}

/**
 * Verified per-model pricing.
 *
 * Expressed per million tokens because that is how providers publish it, which
 * makes the table directly checkable against the pricing page by a human. Both
 * fields are integer micros.
 */
export interface PriceTable {
  /** Exact provider model id, matching what is sent on the request (§3). */
  readonly modelId: string;
  /** Integer micros charged per million input tokens. VERIFY AGAINST LIVE PRICING. */
  readonly inputMicrosPerMillionTokens: number;
  /** Integer micros charged per million output tokens. VERIFY AGAINST LIVE PRICING. */
  readonly outputMicrosPerMillionTokens: number;
  /**
   * ISO date on which this entry was last checked against the provider's public
   * pricing. Recorded so a stale table is visible in the audit export rather
   * than being an invisible assumption.
   */
  readonly verifiedOn: string;
}

export interface SpendLimits {
  /** Ceiling per calendar day, in integer micros. */
  readonly dailyMicros: number;
  /** Ceiling for the world's entire lifetime, in integer micros. */
  readonly totalMicros: number;
}

/** A recorded charge. Append-only, like everything else in this world. */
export interface SpendEntry {
  /** Caller-supplied day key, e.g. "2026-07-28". Never derived from a clock here. */
  readonly dayKey: string;
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly micros: number;
  /** Canonical event sequence the charge belongs to. */
  readonly sequence: number;
}

export interface SpendSnapshot {
  readonly totalMicros: number;
  readonly byDay: Readonly<Record<string, number>>;
  readonly entryCount: number;
  readonly limits: SpendLimits;
}

/**
 * Ceiling division on integers.
 *
 * Rounding up rather than to nearest is deliberate: a ledger that rounds down
 * accumulates a systematic under-count, and the whole point is that the ceiling
 * trips before the money runs out rather than after.
 */
function divCeil(numerator: number, denominator: number): number {
  return Math.trunc((numerator + denominator - 1) / denominator);
}

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Tracks estimated cognition spend and refuses to exceed a ceiling.
 *
 * Deliberately not a singleton and deliberately clock-free: the day key is
 * supplied by the caller. A ledger that read `Date.now()` would behave
 * differently on replay and could not be tested for boundary behaviour without
 * mocking global time.
 */
export class SpendLedger {
  private readonly prices: ReadonlyMap<string, PriceTable>;
  private readonly limits: SpendLimits;
  private readonly entries: SpendEntry[] = [];
  private readonly dayTotals = new Map<string, number>();
  private total = 0;

  constructor(options: { readonly limits: SpendLimits; readonly prices: readonly PriceTable[] }) {
    assertNonNegativeInteger(options.limits.dailyMicros, "dailyMicros");
    assertNonNegativeInteger(options.limits.totalMicros, "totalMicros");
    for (const price of options.prices) {
      assertNonNegativeInteger(price.inputMicrosPerMillionTokens, "inputMicrosPerMillionTokens");
      assertNonNegativeInteger(price.outputMicrosPerMillionTokens, "outputMicrosPerMillionTokens");
    }
    this.limits = options.limits;
    this.prices = new Map(options.prices.map((price) => [price.modelId, price]));
  }

  /** Cost in integer micros for a given token count. Throws for an unpriced model. */
  estimateMicros(modelId: string, inputTokens: number, outputTokens: number): number {
    const price = this.prices.get(modelId);
    if (price === undefined) throw new UnknownModelPriceError(modelId);
    return (
      divCeil(Math.max(0, Math.trunc(inputTokens)) * price.inputMicrosPerMillionTokens, TOKENS_PER_MILLION) +
      divCeil(Math.max(0, Math.trunc(outputTokens)) * price.outputMicrosPerMillionTokens, TOKENS_PER_MILLION)
    );
  }

  /**
   * Check that a request may be made, and throw if it may not.
   *
   * Called BEFORE the provider is contacted. The estimate charges the full
   * `maxOutputTokens` rather than a guess at actual output, so the ceiling is
   * evaluated against the worst case the request could produce. Under-estimating
   * here would let the last request of the day overshoot the limit, and a limit
   * that can be overshot is not a limit.
   */
  assertCanSpend(options: {
    readonly modelId: string;
    readonly dayKey: string;
    readonly estimatedInputTokens: number;
    readonly maxOutputTokens: number;
  }): number {
    const projected = this.estimateMicros(
      options.modelId,
      options.estimatedInputTokens,
      options.maxOutputTokens,
    );

    const dayAlready = this.dayTotals.get(options.dayKey) ?? 0;
    if (dayAlready + projected > this.limits.dailyMicros) {
      throw new SpendLimitExceededError(
        `daily:${options.dayKey}`,
        dayAlready + projected,
        this.limits.dailyMicros,
      );
    }

    if (this.total + projected > this.limits.totalMicros) {
      throw new SpendLimitExceededError("total", this.total + projected, this.limits.totalMicros);
    }

    return projected;
  }

  /**
   * Record actual usage after a call completed.
   *
   * Recording never throws on the ceiling. By the time this runs the money is
   * already spent, and refusing to write it down would leave the ledger
   * understating reality — the next `assertCanSpend` is where the ceiling is
   * enforced, and it will see the true total.
   */
  record(entry: Omit<SpendEntry, "micros">): SpendEntry {
    const micros = this.estimateMicros(entry.modelId, entry.inputTokens, entry.outputTokens);
    const recorded: SpendEntry = { ...entry, micros };
    this.entries.push(recorded);
    this.dayTotals.set(entry.dayKey, (this.dayTotals.get(entry.dayKey) ?? 0) + micros);
    this.total += micros;
    return recorded;
  }

  /** True if either ceiling is already at or past its limit. */
  isFrozen(dayKey: string): boolean {
    return (
      this.total >= this.limits.totalMicros ||
      (this.dayTotals.get(dayKey) ?? 0) >= this.limits.dailyMicros
    );
  }

  spentToday(dayKey: string): number {
    return this.dayTotals.get(dayKey) ?? 0;
  }

  spentTotal(): number {
    return this.total;
  }

  /** Every recorded charge, in the order it happened. */
  history(): readonly SpendEntry[] {
    return [...this.entries];
  }

  snapshot(): SpendSnapshot {
    const byDay: Record<string, number> = {};
    // Sorted so the snapshot is itself deterministic and diffable.
    for (const key of [...this.dayTotals.keys()].sort()) {
      byDay[key] = this.dayTotals.get(key) ?? 0;
    }
    return {
      totalMicros: this.total,
      byDay,
      entryCount: this.entries.length,
      limits: this.limits,
    };
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${name} must be a non-negative safe integer of micros, received ${value}. ` +
        `Fractional currency is banned; convert to micros before configuring the ledger.`,
    );
  }
}

/**
 * Parse a USD ceiling from configuration into integer micros.
 *
 * Accepts at most six decimal places, since a micro is the smallest unit the
 * ledger represents. Parsing is done on the *string* rather than via
 * `parseFloat` so that `"25.10"` cannot become `25.099999999999998` and then
 * truncate to a ceiling one micro below what was configured.
 */
export function usdToMicros(value: string): number {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (match === null) {
    throw new RangeError(
      `Spend limit "${value}" is not a non-negative decimal with at most six decimal places.`,
    );
  }
  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(6, "0");
  return whole * 1_000_000 + Number(fraction);
}
