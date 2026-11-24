// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import world from "./world.json";

const WEEK_END = 7 * 24 * 60;
const week = world.events.filter((event) => event.simTime < WEEK_END);

describe("seven-day physical civilisation fixture", () => {
  it("contains the canonical processes needed by the Watch reel", () => {
    const types = new Set(week.map((event) => event.type));
    for (const type of [
      "move",
      "gather",
      "artifact.created",
      "structure.built",
      "transfer.executed",
      "conversation.public",
    ]) {
      expect(types.has(type)).toBe(true);
    }
  });

  it("contains a real multi-participant conversation", () => {
    const conversation = week.find((event) => event.type === "conversation.public");
    expect(conversation?.subjects.length).toBeGreaterThanOrEqual(2);
    expect(conversation?.inputs.participants).toBeGreaterThanOrEqual(2);
  });

  it("records route endpoints and finite deposit depletion", () => {
    const move = week.find((event) => event.type === "move");
    expect(move?.inputs).toMatchObject({ fromX: expect.any(Number), toX: expect.any(Number) });
    const gather = week.find((event) => event.type === "gather");
    expect(gather?.inputs.depositDepletion ?? gather?.inputs.quantity).toBeGreaterThan(0);
  });
});
