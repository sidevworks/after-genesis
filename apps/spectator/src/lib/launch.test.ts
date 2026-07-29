/**
 * The launch gate.
 *
 * The functions under test read `NEXT_PUBLIC_GENESIS_AT` through a module-level
 * constant, because Next inlines `process.env.X` by textual substitution at
 * build time and a dynamic read would never be replaced. That makes the value
 * fixed for the lifetime of a module instance, so each case re-imports the
 * module with the environment it wants.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const MODULE = "./launch";

async function loadWith(value: string | undefined) {
  vi.resetModules();
  if (value === undefined) delete process.env.NEXT_PUBLIC_GENESIS_AT;
  else process.env.NEXT_PUBLIC_GENESIS_AT = value;
  return import(MODULE);
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_GENESIS_AT;
  vi.resetModules();
});

describe("with no announced date", () => {
  it("reports no date", async () => {
    const { genesisAt, genesisDateAnnounced } = await loadWith(undefined);
    expect(genesisAt()).toBeNull();
    expect(genesisDateAnnounced()).toBe(false);
  });

  it("keeps the observatory sealed", async () => {
    const { isSealed } = await loadWith(undefined);
    expect(isSealed()).toBe(true);
  });

  it("offers no countdown to count", async () => {
    const { timeUntilGenesis } = await loadWith(undefined);
    expect(timeUntilGenesis()).toBeNull();
  });

  it("treats an empty value as absent", async () => {
    const { genesisDateAnnounced, isSealed } = await loadWith("   ");
    expect(genesisDateAnnounced()).toBe(false);
    expect(isSealed()).toBe(true);
  });

  /*
   * A typo must not take down the one page that explains the project, and it
   * must never accidentally *open* the world.
   */
  it("treats an unparseable value as absent, and stays sealed", async () => {
    const { genesisDateAnnounced, isSealed } = await loadWith("next tuesday-ish");
    expect(genesisDateAnnounced()).toBe(false);
    expect(isSealed()).toBe(true);
  });
});

describe("with a future date", () => {
  const AT = "2027-03-01T12:00:00.000Z";

  it("stays sealed", async () => {
    const { isSealed } = await loadWith(AT);
    expect(isSealed(new Date("2027-02-28T12:00:00.000Z"))).toBe(true);
  });

  it("counts down in whole units", async () => {
    const { timeUntilGenesis } = await loadWith(AT);
    const remaining = timeUntilGenesis(new Date("2027-02-27T09:30:15.000Z"));
    expect(remaining).toEqual({
      days: 2,
      hours: 2,
      minutes: 29,
      seconds: 45,
      elapsed: false,
    });
  });

  it("opens the instant the date passes, with no redeploy", async () => {
    const { isSealed } = await loadWith(AT);
    expect(isSealed(new Date("2027-03-01T11:59:59.999Z"))).toBe(true);
    expect(isSealed(new Date("2027-03-01T12:00:00.000Z"))).toBe(false);
  });

  it("floors the countdown at zero rather than going negative", async () => {
    const { timeUntilGenesis } = await loadWith(AT);
    expect(timeUntilGenesis(new Date("2027-03-05T12:00:00.000Z"))).toEqual({
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      elapsed: true,
    });
  });
});

describe("with a past date", () => {
  it("opens the observatory", async () => {
    const { isSealed, genesisDateAnnounced } = await loadWith("2020-01-01T00:00:00.000Z");
    expect(genesisDateAnnounced()).toBe(true);
    expect(isSealed()).toBe(false);
  });
});
