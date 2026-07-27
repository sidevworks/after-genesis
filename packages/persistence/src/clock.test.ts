import { describe, expect, it } from "vitest";
import { FixedClock, SystemClock, clockMillis } from "./clock.js";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("SystemClock", () => {
  it("returns a UTC ISO timestamp", () => {
    const now = new SystemClock().nowIso();
    expect(now).toMatch(ISO);
    expect(Math.abs(Date.parse(now) - Date.now())).toBeLessThan(5_000);
  });
});

describe("FixedClock", () => {
  it("does not move on its own", () => {
    const clock = new FixedClock("2026-01-01T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.nowIso()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("normalises whatever instant it is given", () => {
    expect(new FixedClock("2026-06-15T12:30:00Z").nowIso()).toBe("2026-06-15T12:30:00.000Z");
    expect(new FixedClock(0).nowIso()).toBe("1970-01-01T00:00:00.000Z");
    expect(new FixedClock(new Date(86_400_000)).nowIso()).toBe("1970-01-02T00:00:00.000Z");
  });

  it("advances by milliseconds and seconds", () => {
    const clock = new FixedClock("2026-01-01T00:00:00.000Z");
    clock.advance(1_500);
    expect(clock.nowIso()).toBe("2026-01-01T00:00:01.500Z");
    clock.advanceSeconds(58.5);
    expect(clock.nowIso()).toBe("2026-01-01T00:01:00.000Z");
  });

  it("jumps to an absolute instant", () => {
    const clock = new FixedClock();
    clock.set("2030-12-25T06:00:00.000Z");
    expect(clock.nowIso()).toBe("2030-12-25T06:00:00.000Z");
  });

  // A clock that ran backwards would resurrect expired idempotency claims.
  it("refuses to run backwards", () => {
    const clock = new FixedClock();
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
  });

  it("refuses an unparseable instant", () => {
    expect(() => new FixedClock("not a date")).toThrow(RangeError);
  });

  it("exposes epoch milliseconds consistently with its ISO string", () => {
    const clock = new FixedClock("2026-04-01T09:15:30.250Z");
    expect(clock.nowMillis()).toBe(Date.parse(clock.nowIso()));
  });
});

describe("clockMillis", () => {
  it("reads any Clock as epoch milliseconds", () => {
    expect(clockMillis(new FixedClock("2026-01-01T00:00:00.000Z"))).toBe(
      Date.parse("2026-01-01T00:00:00.000Z"),
    );
  });

  it("throws rather than silently producing NaN", () => {
    expect(() => clockMillis({ nowIso: () => "yesterday-ish" })).toThrow(RangeError);
  });
});
