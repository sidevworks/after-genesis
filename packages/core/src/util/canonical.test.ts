// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { canonicalJson, NonCanonicalValueError } from "./canonical.js";

/**
 * These tests defend the property the entire audit chain rests on: the same
 * logical value always produces the same bytes. If any of these fail, every
 * hash in the world is unreliable and replay verification is meaningless.
 */
describe("canonicalJson", () => {
  describe("key ordering", () => {
    it("produces identical output regardless of property insertion order", () => {
      const a = { zebra: 1, alpha: 2, middle: 3 };
      const b = { middle: 3, zebra: 1, alpha: 2 };
      expect(canonicalJson(a)).toBe(canonicalJson(b));
      expect(canonicalJson(a)).toBe('{"alpha":2,"middle":3,"zebra":1}');
    });

    it("sorts nested keys too", () => {
      const a = { outer: { z: 1, a: 2 } };
      const b = { outer: { a: 2, z: 1 } };
      expect(canonicalJson(a)).toBe(canonicalJson(b));
    });

    it("preserves array order, which is semantic", () => {
      expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
      expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
    });
  });

  describe("floating point is banned", () => {
    // A float in world state would make replay platform-dependent. Rejecting at
    // encode time means the failure is loud and immediate rather than a
    // checksum mismatch discovered days later.
    it.each([0.1, 1.5, -2.75, 1e-7, Number.MIN_VALUE])("rejects %p", (value) => {
      expect(() => canonicalJson({ q: value })).toThrow(NonCanonicalValueError);
    });

    it.each([NaN, Infinity, -Infinity])("rejects non-finite %p", (value) => {
      expect(() => canonicalJson({ q: value })).toThrow(/Non-finite/);
    });

    it("rejects integers beyond safe range, where precision is already lost", () => {
      expect(() => canonicalJson({ q: 2 ** 53 })).toThrow(NonCanonicalValueError);
    });

    it("accepts safe integers including negatives and zero", () => {
      expect(canonicalJson({ q: 0 })).toBe('{"q":0}');
      expect(canonicalJson({ q: -42 })).toBe('{"q":-42}');
      expect(canonicalJson({ q: Number.MAX_SAFE_INTEGER })).toBe('{"q":9007199254740991}');
    });

    it("normalises -0 to 0 so one value cannot yield two hashes", () => {
      expect(canonicalJson({ q: -0 })).toBe(canonicalJson({ q: 0 }));
    });
  });

  describe("undefined is rejected", () => {
    // {a:1} and {a:1,b:undefined} are the same object to JSON.stringify but
    // different to a naive hasher. Rejecting removes the ambiguity entirely.
    it("rejects an undefined property value", () => {
      expect(() => canonicalJson({ a: 1, b: undefined })).toThrow(/undefined/);
    });

    it("rejects a bare undefined", () => {
      expect(() => canonicalJson(undefined)).toThrow(/undefined/);
    });

    it("rejects undefined inside an array", () => {
      expect(() => canonicalJson([1, undefined])).toThrow(/undefined/);
    });

    it("accepts null as an explicit empty value", () => {
      expect(canonicalJson({ a: null })).toBe('{"a":null}');
    });
  });

  describe("non-serialisable values are rejected rather than guessed at", () => {
    it("rejects bigint", () => {
      expect(() => canonicalJson({ q: 1n })).toThrow(/bigint/);
    });

    it("rejects Date, whose encoding depends on the runtime", () => {
      expect(() => canonicalJson({ t: new Date(0) })).toThrow(/plain objects/);
    });

    it("rejects Map and Set, which have no stable JSON form", () => {
      expect(() => canonicalJson({ m: new Map() })).toThrow(/plain objects/);
      expect(() => canonicalJson({ s: new Set() })).toThrow(/plain objects/);
    });

    it("rejects functions and symbols", () => {
      expect(() => canonicalJson({ f: () => 1 })).toThrow(/function/);
      expect(() => canonicalJson({ s: Symbol("x") })).toThrow(/symbol/);
    });

    it("rejects class instances", () => {
      class Inhabitant {
        name = "founder";
      }
      expect(() => canonicalJson(new Inhabitant())).toThrow(/plain objects/);
    });

    it("detects circular references instead of overflowing the stack", () => {
      const cyclic: Record<string, unknown> = { a: 1 };
      cyclic.self = cyclic;
      expect(() => canonicalJson(cyclic)).toThrow(/Circular/);
    });

    it("allows the same object to appear twice when it is not a cycle", () => {
      const shared = { x: 1 };
      expect(() => canonicalJson({ a: shared, b: shared })).not.toThrow();
    });
  });

  describe("string escaping", () => {
    it("escapes control characters, quotes and backslashes", () => {
      expect(canonicalJson("a\"b\\c\nd")).toBe('"a\\"b\\\\c\\nd"');
    });

    it("handles unicode and emoji stably", () => {
      const value = { note: "café 世界 🌍" };
      expect(canonicalJson(value)).toBe(canonicalJson(structuredClone(value)));
    });

    it("distinguishes a key from a value with the same text", () => {
      expect(canonicalJson({ a: "b" })).not.toBe(canonicalJson({ b: "a" }));
    });
  });

  describe("error reporting", () => {
    it("names the path to the offending value", () => {
      try {
        canonicalJson({ inhabitants: [{ inventory: { food: 1.5 } }] });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(NonCanonicalValueError);
        expect((error as NonCanonicalValueError).path).toBe("inhabitants[0].inventory.food");
      }
    });
  });

  it("produces minified output with no incidental whitespace", () => {
    expect(canonicalJson({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
  });
});
