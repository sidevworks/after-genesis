// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { resolveReferenceAddress } from "./reference-address";

describe("permanent Observatory addresses", () => {
  const refId = "AG:W001:ENT:000000000001";

  it("resolves an original deep link", () => {
    expect(
      resolveReferenceAddress(`/world/W001/ref/${encodeURIComponent(refId)}`, ""),
    ).toEqual({ worldId: "W001", view: "ref", refId });
  });

  it("survives the static asset rewrite with its identity and view intact", () => {
    expect(
      resolveReferenceAddress(
        "/reference/",
        `?world=W001&view=watch&ref=${encodeURIComponent(refId)}`,
      ),
    ).toEqual({ worldId: "W001", view: "watch", refId });
  });
});
