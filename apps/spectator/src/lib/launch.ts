// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
/**
 * Whether the world has been released, and when.
 *
 * Before Genesis the observatory has nothing to show: no founder exists, no
 * canonical event has been written, and §22 makes the first event the point of
 * no return. So the platform stays sealed and the landing page is the whole
 * product — an explanation, a countdown, and a way to be told when it starts.
 *
 * A Firebase account *is* the waitlist. Signing in adds nothing to the world
 * and grants nothing inside it; it records that someone wants to be there when
 * it opens, and gives us an address to tell them at. That deliberately avoids
 * inventing a second store of people, a second write path, and an exception to
 * the read-only guarantee — see `read-only.test.ts`.
 *
 * `NEXT_PUBLIC_GENESIS_AT` is an ISO 8601 instant. Three states:
 *
 *   unset            → sealed, no date announced. The honest state before the
 *                      fourteen-day dress rehearsal has produced a real date
 *                      (claude.md §24). A countdown to a guess is a promise.
 *   set, in future   → sealed, counting down.
 *   set, in past     → open.
 *
 * The transition needs no deploy: the value is inlined at build time but the
 * comparison happens in the reader's browser, so the world opens on schedule.
 * Moving the date, however, does require a rebuild — `output: "export"` means
 * nothing reads the environment at runtime.
 */

const RAW_GENESIS_AT = process.env.NEXT_PUBLIC_GENESIS_AT;

/**
 * The announced Genesis instant, or `null` when no date has been published.
 *
 * An unparseable value is treated as absent rather than throwing. A typo in an
 * environment variable should show "date to be announced", not take down the
 * only page that explains what this is.
 */
export function genesisAt(): Date | null {
  if (typeof RAW_GENESIS_AT !== "string" || RAW_GENESIS_AT.trim() === "") return null;
  const parsed = new Date(RAW_GENESIS_AT.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Whether a date has been published at all. */
export function genesisDateAnnounced(): boolean {
  return genesisAt() !== null;
}

/**
 * Whether the observatory is sealed *right now*.
 *
 * Takes `now` so the behaviour is testable without touching the clock, and so
 * a ticking component can ask on every tick rather than caching a stale answer.
 */
export function isSealed(now: Date = new Date()): boolean {
  const at = genesisAt();
  if (at === null) return true;
  return now.getTime() < at.getTime();
}

export interface Remaining {
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  /** True once the instant has passed. */
  readonly elapsed: boolean;
}

/** Time from `now` until Genesis, floored at zero and split into units. */
export function timeUntilGenesis(now: Date = new Date()): Remaining | null {
  const at = genesisAt();
  if (at === null) return null;

  const ms = at.getTime() - now.getTime();
  if (ms <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, elapsed: true };
  }

  const totalSeconds = Math.floor(ms / 1000);
  return {
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3_600),
    minutes: Math.floor((totalSeconds % 3_600) / 60),
    seconds: totalSeconds % 60,
    elapsed: false,
  };
}
