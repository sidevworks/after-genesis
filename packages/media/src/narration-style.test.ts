// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Dramatised narration tests (§21, §12, §11G, §26).
 *
 * The prompt is not the safeguard — a model can ignore a prompt. These tests
 * exercise the validator, which is what actually decides whether a generated
 * sentence is allowed to be spoken over the record.
 *
 * Every rejection case below is a real thing a model does when asked to make a
 * dry line "more of a story".
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildNarrationRequest,
  dayPartOf,
  documentaryFallback,
  extractLine,
  isStyleable,
  spanOf,
  styleNarration,
  validateNarration,
  type NarrationContext,
  type StyleDeps,
} from "./narration-style.js";

const context: NarrationContext = {
  canonical: "Gathered 6 food at (14, 17) over 30 minutes.",
  actionType: "gather",
  allowedNames: ["Aleth"],
};

const check = (line: string, over: Partial<NarrationContext> = {}) =>
  validateNarration(line, { ...context, ...over });

const respond = (...texts: string[]) => {
  let call = 0;
  return vi.fn<StyleDeps["generate"]>(async () => {
    const rawText = texts[Math.min(call, texts.length - 1)] ?? "";
    call += 1;
    return {
      rawText,
      modelId: "gemini-3.5-flash-lite",
      inputTokens: 10,
      outputTokens: 5,
      finishReason: "stop",
    };
  });
};

describe("validateNarration accepts a faithful rewrite", () => {
  it("accepts a plain sentence about the recorded activity", () => {
    expect(check("Aleth spent the morning gathering food.").ok).toBe(true);
  });

  it("accepts a line with no name at all", () => {
    expect(check("Food was gathered through the morning.").ok).toBe(true);
  });

  it("accepts two sentences", () => {
    expect(check("Aleth gathered food. The work filled the morning.").ok).toBe(true);
  });

  it("accepts a possessive form of an allowed name", () => {
    expect(check("The morning was Aleth's, spent gathering food.").ok).toBe(true);
  });
});

describe("validateNarration refuses invented interior life (§11G, §26)", () => {
  it.each([
    ["Aleth gathered food, hoping to feed the others.", "hoping"],
    ["Aleth wanted more food before nightfall.", "wanted"],
    ["Aleth gathered food because the stores were low.", "because"],
    ["Aleth gathered food, determined to finish early.", "determined"],
    ["A weary Aleth gathered food.", "weary"],
    ["Aleth decided to gather food.", "decided"],
    ["Aleth gathered food so that the village would eat.", "so that"],
  ])("refuses %j", (line) => {
    const result = check(line);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("asserts_motive");
  });
});

describe("validateNarration refuses invented facts", () => {
  it("refuses a name the record does not contain", () => {
    const result = check("Aleth gathered food with Berrun.");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invented_name");
  });

  it("refuses an invented place", () => {
    const result = check("Aleth gathered food near the Eastern Grove.");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invented_name");
  });

  it("allows a second name when the record contains it", () => {
    expect(check("Aleth gathered food with Berrun.", { allowedNames: ["Aleth", "Berrun"] }).ok).toBe(
      true,
    );
  });

  it("refuses a line describing a different activity", () => {
    // No motive, no numbers, no invented name — and still false.
    const result = check("Aleth worked on the new hall through the morning.");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong_action");
  });

  it("refuses quoted speech, which would imply canonical dialogue", () => {
    const result = check('Aleth said "the food is gathered" that morning.');
    expect(result.ok).toBe(false);
  });
});

describe("validateNarration refuses the numbers the rewrite exists to remove", () => {
  it.each([
    "Aleth gathered 6 food that morning.",
    "Aleth gathered food at 14, 17.",
    "Aleth gathered food for 30 minutes.",
  ])("refuses %j", (line) => {
    const result = check(line);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("contains_numbers");
  });
});

describe("validateNarration keeps spoken lines short", () => {
  it("refuses a paragraph", () => {
    const result = check(`Aleth gathered food. ${"The morning went on. ".repeat(12)}`);
    expect(result.ok).toBe(false);
    expect(["too_long", "too_many_sentences"]).toContain(result.reason);
  });

  it("refuses an empty line", () => {
    expect(check("   ").reason).toBe("empty");
  });
});

describe("isStyleable", () => {
  it("covers the activities the record actually contains", () => {
    for (const action of ["gather", "move", "build", "craft", "rest", "consume"]) {
      expect(isStyleable(action), action).toBe(true);
    }
  });

  it("refuses to style an action it has no verb list for", () => {
    // A new world action must degrade to its canonical caption, never to an
    // unchecked rewrite.
    expect(isStyleable("impose_confinement")).toBe(false);
  });
});

describe("buildNarrationRequest", () => {
  it("asks for no embellishment and a bounded reply", () => {
    const request = buildNarrationRequest(context, "gemini-3.5-flash-lite");
    expect(request.temperature).toBe(0);
    expect(request.maxOutputTokens).toBeLessThanOrEqual(128);
    expect(request.userPrompt).toContain(context.canonical);
    expect(request.userPrompt).toContain("Aleth");
  });

  it("is deterministic, so it can be hashed and cached", () => {
    const a = buildNarrationRequest(context, "m");
    const b = buildNarrationRequest(context, "m");
    expect(a).toEqual(b);
  });
});

describe("styleNarration", () => {
  it("uses a valid rewrite and records its provenance (§16)", async () => {
    const generate = respond("Aleth spent the morning gathering food.");
    const result = await styleNarration(context, { generate, modelId: "gemini-3.5-flash-lite" });

    expect(result.styled).toBe(true);
    expect(result.text).toBe("Aleth spent the morning gathering food.");
    expect(result.canonical).toBe(context.canonical);
    expect(result.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.responseHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("retries once with the rejection reason, then accepts", async () => {
    const generate = respond(
      "Aleth gathered food, hoping to feed the others.",
      "Aleth gathered food through the morning.",
    );
    const result = await styleNarration(context, { generate, modelId: "m" });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.styled).toBe(true);
    expect(result.rejections[0]).toContain("asserts_motive");
    // The correction names the fault, so the second attempt is informed.
    expect(generate.mock.calls[1]?.[0]?.userPrompt).toContain("rejected");
  });

  it("falls back to a documentary-safe spoken line after two bad replies (§14)", async () => {
    const generate = respond("Aleth gathered food, hoping to feed everyone.");
    const result = await styleNarration(context, { generate, modelId: "m" });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.styled).toBe(false);
    expect(result.text).toBe("Aleth gathers food.");
    expect(result.canonical).toBe(context.canonical);
    expect(result.rejections).toHaveLength(2);
  });

  it("falls back to a documentary-safe spoken line when the provider fails", async () => {
    const generate = vi.fn(async () => {
      throw new Error("503 unavailable");
    });
    const result = await styleNarration(context, { generate, modelId: "m" });

    expect(result.styled).toBe(false);
    expect(result.text).toBe("Aleth gathers food.");
    expect(result.canonical).toBe(context.canonical);
    expect(result.rejections[0]).toContain("503");
  });

  it("never calls the model for an action it cannot check", async () => {
    const generate = respond("anything at all");
    const result = await styleNarration(
      { ...context, actionType: "attempt_escape" },
      { generate, modelId: "m" },
    );

    expect(generate).not.toHaveBeenCalled();
    expect(result.text).not.toContain("(14, 17)");
    expect(result.canonical).toBe(context.canonical);
  });

  it("strips the wrapping a chat model adds", async () => {
    const generate = respond('Spoken line: "Aleth gathered food that morning."');
    const result = await styleNarration(context, { generate, modelId: "m" });

    expect(result.styled).toBe(true);
    expect(result.text).toBe("Aleth gathered food that morning.");
  });

  it("keeps the canonical caption available whatever happens", async () => {
    // §12: generated media must stay distinguishable from canonical action.
    // Both readings are always present on the result.
    const styled = await styleNarration(context, {
      generate: respond("Aleth gathered food that morning."),
      modelId: "m",
    });
    const fell = await styleNarration(context, {
      generate: respond("Aleth gathered 6 food."),
      modelId: "m",
    });

    expect(styled.canonical).toBe(context.canonical);
    expect(fell.canonical).toBe(context.canonical);
  });
});

describe("documentaryFallback removes audit-only fields without adding facts", () => {
  it("turns a coordinate-heavy caption into a speakable line", () => {
    const line = documentaryFallback({
      ...context,
      dayPart: "morning",
      span: "briefly",
    });

    expect(line).toBe("Aleth gathers food through the morning.");
    expect(line).not.toMatch(/\d|\(|\)/);
    expect(validateNarration(line, context).ok).toBe(true);
  });

  it("keeps the exact canonical caption separately when fallback is used", async () => {
    const result = await styleNarration(context, {
      generate: respond("Aleth gathered food because everyone was hungry."),
      modelId: "m",
    });

    expect(result.text).toBe("Aleth gathers food.");
    expect(result.canonical).toBe("Gathered 6 food at (14, 17) over 30 minutes.");
  });
});

describe("extractLine tolerates every wrapping a provider has produced", () => {
  it.each([
    ["a bare sentence", "Aleth gathers food.", "Aleth gathers food."],
    ["a JSON string", '"Aleth gathers food."', "Aleth gathers food."],
    ["a JSON array", '[\n  "Aleth gathers food."\n]', "Aleth gathers food."],
    ["an object under line", '{"line": "Aleth gathers food."}', "Aleth gathers food."],
    ["a fenced block", '```json\n{"line": "Aleth gathers food."}\n```', "Aleth gathers food."],
    ["a labelled prose reply", "Spoken line: Aleth gathers food.", "Aleth gathers food."],
  ])("unwraps %s", (_name, raw, expected) => {
    expect(extractLine(raw)).toBe(expected);
  });

  it("passes unrecognised shapes through for the validator to judge", () => {
    // Never invent a line when the reply is not understood — hand the raw text
    // to the validator, which will reject it.
    expect(extractLine("{not json at all")).toBe("{not json at all");
  });
});

describe("ACTION_VERBS covers the plainest form of each verb", () => {
  // The first version omitted "move", "transfer" and "communicate" themselves
  // while listing their synonyms, so a perfectly faithful "Aleth moves." was
  // refused. The base verb is the likeliest word a model reaches for.
  it.each([
    ["move", "Aleth moves."],
    ["transfer", "Aleth and Berrun complete a transfer."],
    ["communicate", "Aleth and Berrun communicate."],
    ["gather", "Aleth gathers food."],
    ["build", "Aleth builds through the day."],
    ["rest", "Aleth rests."],
  ])("accepts the plain form for %s", (actionType, line) => {
    const result = validateNarration(line, {
      canonical: "irrelevant",
      actionType,
      allowedNames: ["Aleth", "Berrun"],
    });
    expect(result.ok, `${line}: ${result.detail}`).toBe(true);
  });
});

describe("spanOf and dayPartOf never contradict the caption beside them", () => {
  it("calls three quarters of an hour brief, not a couple of hours", () => {
    // The first bucketing put 45 minutes in "a couple of hours", so a caption
    // reading "over 45 minutes" was narrated as two hours of work.
    expect(spanOf(45)).toBe("briefly");
    expect(spanOf(30)).toBe("briefly");
  });

  it("never describes a span as shorter than it was", () => {
    const rank = ["briefly", "for an hour or two", "for a few hours", "for most of the day"];
    let previous = 0;
    for (const minutes of [10, 59, 60, 179, 180, 419, 420, 900]) {
      const index = rank.indexOf(spanOf(minutes));
      expect(index, `${minutes} minutes`).toBeGreaterThanOrEqual(previous);
      previous = index;
    }
  });

  it("maps the world clock to the part of day a listener would recognise", () => {
    expect(dayPartOf(0)).toBe("night");
    expect(dayPartOf(9 * 60)).toBe("morning");
    expect(dayPartOf(14 * 60)).toBe("afternoon");
    expect(dayPartOf(19 * 60)).toBe("evening");
    expect(dayPartOf(23 * 60)).toBe("night");
  });

  it("wraps a tick past midnight rather than running off the clock", () => {
    expect(dayPartOf(1440 + 9 * 60)).toBe("morning");
  });
});
