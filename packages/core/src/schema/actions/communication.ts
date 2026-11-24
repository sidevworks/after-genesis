// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Speech (§13).
 *
 * The distinction between `communicate` and `announce` is not politeness, it is
 * time. A conversation binds every participant's attention for its duration
 * (§11J: "Conversations consume time for every participant"), so it needs their
 * consent. An announcement binds only the speaker's: listeners may attend to it
 * or not, and a crowd costs the speaker no more than an empty field does.
 */
import { z } from "zod";
import {
  LONG_TEXT_MAX,
  MAX_PLANNED_MINUTES,
  MAX_SMALL_LIST,
  MESSAGE_MAX,
  NAME_MAX,
  OptionalIdSchema,
  minutesInRange,
  optionalText,
  requiredIdList,
  requiredText,
} from "./common.js";

/**
 * Say something to specific inhabitants.
 *
 * `recipients` is capped at 8. Beyond that the act is really an announcement:
 * the point of the cap is that a conversation is a mutual commitment of
 * attention, and a "conversation" with fifty participants is a way of spending
 * fifty inhabitants' time at the cost of one, which §11J forbids.
 *
 * `isPrivate` decides whether the resulting event's visibility is `participants`
 * or `local`. A private conversation is genuinely unobservable to others — its
 * contents can enter another inhabitant's knowledge only through a later
 * disclosure event (§11E, §15).
 */
export const CommunicatePayloadSchema = z.object({
  recipients: requiredIdList(MAX_SMALL_LIST),
  message: requiredText(MESSAGE_MAX),
  isPrivate: z.boolean().default(true),
  topic: optionalText(NAME_MAX),
  /** Whether the speaker intends to hold the floor and wait for a reply. */
  expectsReply: z.boolean().default(true),
  /**
   * How long the speaker intends to talk. Every recipient who accepts is
   * committed for the same period; that reciprocity is the whole point.
   */
  intendedMinutes: minutesInRange(5, MAX_PLANNED_MINUTES).default(30),
  /** Continues an existing exchange, so memory can thread it (§19). */
  inReplyToEventSequence: z.number().int().nonnegative().nullable().default(null),
});

/**
 * Say something to whoever is present, or to a whole organisation, or to the
 * world.
 *
 * An announcement creates no obligation on anyone. Whether it is heard depends
 * on who is physically present at the time (§11E) — the engine resolves the
 * witness set; the speaker cannot conjure an audience by declaring one.
 */
export const AnnouncePayloadSchema = z.object({
  message: requiredText(LONG_TEXT_MAX),
  scope: z.enum(["local", "organisation", "world"]).default("local"),
  organisationId: OptionalIdSchema,
  topic: optionalText(NAME_MAX),
  /** An artifact read aloud or posted, e.g. a written proclamation (§12). */
  artifactId: OptionalIdSchema,
});
