// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  PROGENITOR_CHARACTER_KEYS,
  characterKeyForCanonicalId,
  characterProfileFor,
} from "./observatory-character-profiles";

describe("Observatory character profiles", () => {
  it("maps every declared Genesis progenitor to its supplied visual identity", () => {
    expect(PROGENITOR_CHARACTER_KEYS).toHaveLength(10);
    for (const [index, key] of PROGENITOR_CHARACTER_KEYS.entries()) {
      const canonicalId = `inh_${String(index + 1).padStart(2, "0")}_${key}`;
      expect(characterKeyForCanonicalId(canonicalId)).toBe(key);
      expect(characterProfileFor(key)?.key).toBe(key);
    }
  });

  it("does not assign an inherited progenitor look to later inhabitants", () => {
    expect(characterKeyForCanonicalId("inh_11_alpha_child")).toBeNull();
    expect(characterKeyForCanonicalId("ALPHA")).toBeNull();
    expect(characterKeyForCanonicalId(null)).toBeNull();
  });
});
