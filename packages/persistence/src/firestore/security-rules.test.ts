// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Firestore client security rules", () => {
  it("contains no client write grant anywhere", async () => {
    const rules = await readFile(resolve("firestore.rules"), "utf8");
    expect(rules).not.toMatch(/allow\s+(?:create|update|delete|write)[^:]*:\s*if\s+true/);
    expect(rules).not.toMatch(/allow\s+(?:create|update|delete|write)[^:]*:\s*if\s+request\.auth/);
    expect(rules).toContain("allow write: if false");
    expect(rules).toContain("allow read, write: if false");
  });

  it("does not expose canonical events or private trees to client reads", async () => {
    const rules = await readFile(resolve("firestore.rules"), "utf8");
    expect(rules).not.toMatch(/match\s+\/events\/.*allow read:\s*if true/s);
    expect(rules).not.toMatch(/match\s+\/private\/.*allow read:\s*if true/s);
  });
});
