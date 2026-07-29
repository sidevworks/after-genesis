/**
 * The declared payload schema and the resolver must agree.
 *
 * These are two descriptions of one contract, written in different files and,
 * for a long time, disagreeing. The schema said `move` carries `destination`;
 * the resolver reads `to`. It said `consume` carries a list of `items`; the
 * resolver reads one `resource`. Nothing parsed the schemas, so nothing failed,
 * and the disagreement stayed invisible.
 *
 * Invisible is the problem. The action catalogue is what an inhabitant is shown
 * and what any future client would be written against, so a schema that
 * describes a payload the engine will not accept is a trap: it produces
 * rejected actions that look like the inhabitant's fault. That is not
 * hypothetical here — a description that disagreed with the gather resolver
 * about where water comes from killed three worlds by thirst before anyone
 * noticed the text was wrong rather than the model.
 *
 * So: build the payload the declared schema says is valid, hand it to the
 * resolver, and require the resolver not to reject it as malformed. The
 * resolver may still reject it for a *world* reason — no deposit here, not
 * enough energy — because those depend on circumstance. What it may not do is
 * fail to understand it.
 */

import { describe, expect, it } from "vitest";
import { RejectionCode } from "../../engine/resolvers/types.js";
import { runAction } from "../../engine/resolvers/index.js";
import { founderOf, makeTestWorld, passableNear } from "../../engine/test-support.js";
import { simTime } from "../../time.js";
import { getActionSpec } from "./index.js";

/**
 * A minimal payload for each action, written as the *declared schema* says it
 * should be. If a schema changes key names, its entry here must change with it,
 * and the resolver must still accept it.
 */
function payloadsUnderTest(destination: { x: number; y: number }) {
  return {
    observe: {},
    move: { to: destination },
    gather: { resource: "food" },
    consume: { resource: "food", amount: 1 },
    rest: { minutes: 60 },
    wait: { minutes: 30 },
  } as const;
}

describe("every declared payload schema is one the resolver understands", () => {
  for (const [type, payload] of Object.entries(payloadsUnderTest({ x: 0, y: 0 }))) {
    it(`${type}: the schema accepts what the resolver reads`, () => {
      const spec = getActionSpec(type as never);
      const parsed = spec.payload.safeParse(payload);
      expect(
        parsed.success,
        `the declared schema rejects its own documented payload: ${JSON.stringify(
          parsed.success ? null : parsed.error.issues,
        )}`,
      ).toBe(true);
    });
  }

  for (const type of ["observe", "move", "gather", "consume", "rest", "wait"] as const) {
    it(`${type}: the resolver does not call the schema's payload malformed`, () => {
      const state = makeTestWorld();
      const actor = founderOf(state);
      // Somewhere this actor can legally stand, so `move` has a real target.
      const destination = passableNear(state, actor.location) ?? actor.location;
      const payload = payloadsUnderTest(destination)[type];

      const result = runAction({
        state,
        actorId: actor.id,
        action: { type, payload },
        sequence: state.sequence + 1,
        simTime: simTime(state.simTime + 1),
      });

      if (result.outcome.status !== "rejected") return;

      // A world reason is fine. "I cannot read this" is not.
      expect(
        result.outcome.code,
        `${type} was rejected as malformed, which means the declared schema and the ` +
          `resolver disagree about the payload: ${result.outcome.reason}`,
      ).not.toBe(RejectionCode.InvalidPayload);
    });
  }
});
