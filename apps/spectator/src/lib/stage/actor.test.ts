// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { visualIdentityFor } from "./actor";

describe("procedural inhabitant identity", () => {
  it("is deterministic and stays within neutral presentation bounds", () => {
    const identity = visualIdentityFor("INH-004");
    expect(visualIdentityFor("INH-004")).toEqual(identity);
    expect(identity.height).toBeGreaterThanOrEqual(0.94);
    expect(identity.height).toBeLessThanOrEqual(1.06);
    expect(identity.breadth).toBeGreaterThanOrEqual(0.92);
    expect(identity.breadth).toBeLessThanOrEqual(1.08);
    expect([0, 1, 2]).toContain(identity.headwear);
  });

  it("gives a small cast visibly varied silhouettes", () => {
    const identities = Array.from({ length: 8 }, (_, index) =>
      visualIdentityFor(`INH-${String(index + 1).padStart(3, "0")}`));
    expect(new Set(identities.map((value) => value.headwear)).size).toBeGreaterThan(1);
    expect(new Set(identities.map((value) => value.mantle)).size).toBeGreaterThan(1);
  });
});
