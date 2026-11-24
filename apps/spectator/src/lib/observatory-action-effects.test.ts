// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { observatoryActionKind } from "./observatory-action-effects";

describe("Observatory action presentation", () => {
  it("maps disclosed primitives to stable visual families", () => {
    expect(observatoryActionKind("movement.walk")).toBe("move");
    expect(observatoryActionKind("structure.built")).toBe("build");
    expect(observatoryActionKind("resource.harvest")).toBe("gather");
    expect(observatoryActionKind("artifact.created")).toBe("craft");
  });

  it("keeps unfamiliar disclosed actions visible without inventing a tool", () => {
    expect(observatoryActionKind("social.observe")).toBe("generic");
  });
});
