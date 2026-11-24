// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { effectivePlaybackRate } from "./playback";

describe("effectivePlaybackRate", () => {
  const intervals = [{ start: 100, end: 105 }, { start: 200, end: 260 }];

  it("preserves the chosen rate outside recorded actions", () => {
    expect(effectivePlaybackRate(50, 60, intervals)).toBe(60);
  });

  it("gives short actions at least three seconds of screen time", () => {
    expect(effectivePlaybackRate(102, 60, intervals)).toBeCloseTo(5 / 3);
  });

  it("does not speed up actions already playing slowly", () => {
    expect(effectivePlaybackRate(220, 1, intervals)).toBe(1);
  });
});
