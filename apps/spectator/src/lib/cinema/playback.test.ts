// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
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
