// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Tests for FirestoreWorldSource read-only compliance.
 *
 * These tests verify that FirestoreWorldSource:
 *   1. Implements the full WorldSource interface.
 *   2. Contains no mutation calls (set, update, delete, add, writeBatch,
 *      runTransaction).
 *   3. Exports no function whose name suggests a write operation.
 *
 * The structural checks parse the actual source file to enforce the read-only
 * contract at the module level, in the same spirit as `read-only.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorldSource } from "./world-source";
import { FirestoreWorldSource } from "./firestore-world-source";

const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "firestore-world-source.ts",
);
const source = readFileSync(FILE, "utf8");

describe("FirestoreWorldSource read-only compliance", () => {
  it("implements every method of the WorldSource interface", () => {
    const expectedMethods: (keyof WorldSource)[] = [
      "getWorldSummary",
      "getMap",
      "getInhabitants",
      "getInhabitant",
      "getEvents",
      "getOrganisations",
      "getArtifacts",
      "getEconomy",
      "getLineage",
      "getAuditStatus",
    ];

    for (const method of expectedMethods) {
      expect(source).toContain(`async ${method}(`);
    }
  });

  // Strip block and line comments to avoid false positives on docstrings
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

  it("never imports Firestore mutation functions", () => {
    const mutationImports = [
      "setDoc",
      "updateDoc",
      "deleteDoc",
      "addDoc",
      "writeBatch",
      "runTransaction",
      "deleteField",
      "arrayUnion",
      "arrayRemove",
      "increment",
    ];
    for (const fn of mutationImports) {
      expect(codeOnly).not.toContain(fn);
    }
  });

  it("never calls any Firestore mutation method in the source body", () => {
    const mutationCalls = [
      ".set(",
      ".update(",
      ".delete(",
      "setDoc(",
      "updateDoc(",
      "deleteDoc(",
      "addDoc(",
      "writeBatch(",
      "runTransaction(",
    ];
    for (const call of mutationCalls) {
      expect(codeOnly).not.toContain(call);
    }
  });

  it("exports no member whose name suggests a write operation", () => {
    const writePatterns = [
      /export\s+(?:async\s+)?function\s+(?:create|update|set|delete|send|submit|propose|write|remove|insert|patch|put|enqueue|publish)/i,
    ];
    for (const pattern of writePatterns) {
      expect(source).not.toMatch(pattern);
    }
  });

  it("class exists and can be referenced as a WorldSource type", () => {
    // TypeScript structural check — this assignment would fail at compile time
    // if FirestoreWorldSource did not satisfy WorldSource.
    const check: new (...args: never[]) => WorldSource = FirestoreWorldSource;
    expect(check).toBe(FirestoreWorldSource);
  });
});
