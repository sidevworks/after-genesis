// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * Vitals are a *reading* of the record, not a model of it.
 *
 * These tests pin the two properties that keep that true: readings only ever
 * come from disclosed events, and a reading is never invented for a tick that
 * precedes any recorded sample.
 */
import { describe, expect, it } from "vitest";
import runFixture from "../../fixtures/observatory-run.json";
import type { ObservatoryRun } from "../observatory-types";
import { buildVitals, flowAt, readingAt } from "./vitals";

const run = runFixture as unknown as ObservatoryRun;

describe("vitals are read from disclosed canonical detail only", () => {
  const series = buildVitals(run);

  it("builds a series for every inhabitant in the export", () => {
    expect(series.size).toBe(run.inhabitants.length);
    for (const inhabitant of run.inhabitants) {
      expect(series.has(inhabitant.id)).toBe(true);
    }
  });

  it("finds real physiological readings in the demonstration run", () => {
    let hunger = 0;
    let thirst = 0;
    let fatigue = 0;
    for (const entry of series.values()) {
      hunger += entry.hunger.length;
      thirst += entry.thirst.length;
      fatigue += entry.fatigue.length;
    }
    // The run resolves 44 consume, 57 rest and 4 wait actions, every one of them
    // disclosed. If this drops to zero the extraction has silently broken.
    expect(hunger + thirst).toBeGreaterThan(0);
    expect(fatigue).toBeGreaterThan(0);
  });

  it("never takes a sample from an event whose contents were withheld", () => {
    const disclosedSequences = new Set(
      run.events.filter((event) => event.detail !== null).map((event) => event.sequence),
    );
    for (const entry of series.values()) {
      for (const sample of [...entry.hunger, ...entry.thirst, ...entry.fatigue]) {
        expect(disclosedSequences.has(sample.sequence)).toBe(true);
      }
      for (const sample of entry.flow) {
        expect(disclosedSequences.has(sample.sequence)).toBe(true);
      }
    }
  });

  it("keeps every series sorted by tick", () => {
    for (const entry of series.values()) {
      for (const samples of [entry.hunger, entry.thirst, entry.fatigue]) {
        for (let index = 1; index < samples.length; index += 1) {
          expect(samples[index]!.tick).toBeGreaterThanOrEqual(samples[index - 1]!.tick);
        }
      }
    }
  });
});

describe("readingAt reports staleness rather than smoothing over it", () => {
  const samples = [
    { tick: 100, value: 10, source: "consume", sequence: 1 },
    { tick: 500, value: 40, source: "wait", sequence: 2 },
    { tick: 900, value: 5, source: "consume", sequence: 3 },
  ];

  it("returns nothing before the first recorded sample", () => {
    expect(readingAt(samples, 99)).toEqual({ value: null, ageMinutes: null, source: null });
  });

  it("returns the sample itself at its own tick, with zero age", () => {
    expect(readingAt(samples, 500)).toEqual({ value: 40, ageMinutes: 0, source: "wait" });
  });

  it("holds the last reading and reports how old it is", () => {
    expect(readingAt(samples, 880)).toEqual({ value: 40, ageMinutes: 380, source: "wait" });
  });

  it("does not interpolate between two readings", () => {
    // Halfway between 10 and 40 in time; a modelled value would be about 25.
    const middle = readingAt(samples, 300);
    expect(middle.value).toBe(10);
  });

  it("returns nothing for an empty series", () => {
    expect(readingAt([], 500)).toEqual({ value: null, ageMinutes: null, source: null });
  });
});

describe("disclosed flow is a flow, not a balance", () => {
  it("nets recorded gathers against recorded consumption up to a tick", () => {
    const flow = [
      { tick: 10, resource: "food", delta: 2, sequence: 1 },
      { tick: 20, resource: "food", delta: -1, sequence: 2 },
      { tick: 30, resource: "water", delta: 3, sequence: 3 },
      { tick: 90, resource: "food", delta: 5, sequence: 4 },
    ];
    const totals = flowAt(flow, 40);
    expect(totals.get("food")).toBe(1);
    expect(totals.get("water")).toBe(3);
  });

  it("counts nothing before the first sample", () => {
    expect(flowAt([{ tick: 10, resource: "food", delta: 2, sequence: 1 }], 5).size).toBe(0);
  });
});
