// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { simTime } from "@after-genesis/core";
import { REAL_MILLISECONDS_PER_SIMULATED_MINUTE, TimeScalingEngine } from "./time-scaling.js";

describe("TimeScalingEngine", () => {
  const clock = new TimeScalingEngine({ realAnchorMs: 1_000_000, simAnchor: simTime(720) });

  it("maps one real hour to four game hours without accumulated drift", () => {
    expect(clock.simulatedNow(1_000_000 + 60 * 60 * 1000)).toBe(960);
    expect(clock.simulatedNow(1_000_000 + 6 * 60 * 60 * 1000)).toBe(2160);
    expect(clock.simulatedNow(1_000_000 + 42 * 60 * 60 * 1000)).toBe(10_800);
  });

  it("uses the anchor rather than timer deltas and gives the exact due instant", () => {
    const target = simTime(721);
    expect(clock.realDueAt(target)).toBe(1_000_000 + REAL_MILLISECONDS_PER_SIMULATED_MINUTE);
    expect(clock.simulatedNow(clock.realDueAt(target) - 1)).toBe(720);
    expect(clock.simulatedNow(clock.realDueAt(target))).toBe(721);
  });
});
