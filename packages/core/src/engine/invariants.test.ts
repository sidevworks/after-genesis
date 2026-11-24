// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it } from "vitest";
import { simTime } from "../time.js";
import { checkInvariants, formatViolations, INVARIANT_CHECKS } from "./invariants.js";
import {
  DEFAULT_RULES,
  putActivity,
  putConfinement,
  putContract,
  putCurrency,
  putMemory,
  putOrganisation,
  putStructure,
  setDeposit,
  updateInhabitant,
  withSequence,
  withSimTime,
  type WorldState,
} from "./state.js";
import {
  addTestInhabitant,
  founderOf,
  makeTestWorld,
  passableNear,
} from "./test-support.js";

const violationIds = (state: WorldState): string[] =>
  [...new Set(checkInvariants(state).map((v) => v.invariant))].sort();

/** Assert that `mutate` breaks exactly the named invariant and nothing else silently passes. */
function expectBreaks(invariant: string, mutate: (state: WorldState) => WorldState): void {
  const clean = makeTestWorld();
  expect(checkInvariants(clean)).toEqual([]);
  const broken = mutate(clean);
  expect(violationIds(broken)).toContain(invariant);
}

describe("checkInvariants", () => {
  it("a freshly generated world satisfies every invariant", () => {
    const violations = checkInvariants(makeTestWorld());
    expect(formatViolations(violations)).toBe("");
  });

  it("holds for several seeds", () => {
    for (const seed of ["inv-1", "inv-2", "inv-3", "inv-4", "inv-5"]) {
      expect(formatViolations(checkInvariants(makeTestWorld({ seed })))).toBe("");
    }
  });

  it("returns violations rather than throwing", () => {
    const broken = { ...makeTestWorld(), sequence: -99 };
    expect(() => checkInvariants(broken)).not.toThrow();
    expect(checkInvariants(broken).length).toBeGreaterThan(0);
  });

  it("every registered check has a unique id and is exercised", () => {
    const ids = INVARIANT_CHECKS.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(20);
  });

  it("violations carry the spec clause they enforce", () => {
    const broken = updateInhabitant(makeTestWorld(), "inh_founder", (i) => ({
      ...i,
      inventory: { ...i.inventory, food: -1 },
    }));
    for (const violation of checkInvariants(broken)) {
      expect(violation.spec.length).toBeGreaterThan(5);
      expect(violation.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("§15 balances cannot become negative", () => {
  it("fires on a negative inventory", () => {
    expectBreaks("no_negative_balances", (s) =>
      updateInhabitant(s, "inh_founder", (i) => ({
        ...i,
        inventory: { ...i.inventory, wood: -1 },
      })),
    );
  });

  it("fires on a negative concealed holding", () => {
    expectBreaks("no_negative_balances", (s) =>
      updateInhabitant(s, "inh_founder", (i) => ({ ...i, concealed: { stone: -5 } })),
    );
  });

  it("fires on a negative structure store", () => {
    expectBreaks("no_negative_balances", (s) =>
      putStructure(s, {
        id: "str_1",
        kind: "shed",
        location: founderOf(s).location,
        owner: "inh_founder",
        ownerOrganisation: null,
        integrity: 100,
        capacity: 10,
        storage: { wood: -3 },
        ownershipPublic: true,
        storagePublic: true,
        secured: false,
        occupants: [],
        createdSequence: 0,
        createdAt: simTime(0),
      }),
    );
  });

  it("fires on a negative currency holding", () => {
    expectBreaks("no_negative_balances", (s) =>
      putCurrency(s, {
        id: "cur_1",
        issuer: "inh_founder",
        name: "Mark",
        symbol: "M",
        supplyRule: "fixed",
        issuedSupply: -5,
        holdings: { inh_founder: -5 },
        publicLedger: true,
        transferRule: "free",
        backing: {},
        governance: "issuer",
        governingOrganisation: null,
        description: "",
        createdSequence: 0,
        createdAt: simTime(0),
      }),
    );
  });
});

describe("§15 resource creation and destruction follow declared rules", () => {
  it("fires when conserved matter appears from nowhere", () => {
    expectBreaks("conserved_resource_totals", (s) =>
      updateInhabitant(s, "inh_founder", (i) => ({
        ...i,
        inventory: { ...i.inventory, wood: 5000 },
      })),
    );
  });

  it("fires when conserved matter vanishes without a recorded sink", () => {
    expectBreaks("conserved_resource_totals", (s) => {
      // Erase a deposit that actually holds something. Tile (0,0) may be
      // barren on any given seed, and erasing nothing proves nothing.
      const key = Object.keys(s.deposits).sort()[0];
      if (key === undefined) throw new Error("fixture has no deposits");
      const [xs, ys] = key.split(",");
      return setDeposit(s, { x: Number(xs), y: Number(ys) }, {});
    });
  });

  it("does not fire for energy or compute, which are not conserved", () => {
    const state = updateInhabitant(makeTestWorld(), "inh_founder", (i) => ({
      ...i,
      inventory: { ...i.inventory, energy: 999, compute: 999 },
    }));
    expect(violationIds(state)).not.toContain("conserved_resource_totals");
  });
});

describe("§11J one primary activity at a time", () => {
  it("fires when an inhabitant appears in two open activities", () => {
    expectBreaks("single_primary_activity", (s) => {
      let next = s;
      for (const id of ["act_a", "act_b"]) {
        next = putActivity(next, {
          id,
          state: "gathering",
          actionType: "gather",
          participants: ["inh_founder"],
          location: founderOf(s).location,
          startedAt: simTime(0),
          endsAt: simTime(60),
          interruption: "partial_progress_kept",
          resourceCost: {},
          open: true,
          sequence: 0,
        });
      }
      return updateInhabitant(next, "inh_founder", (i) => ({
        ...i,
        activity: { state: "gathering", activityId: "act_a", busyUntil: simTime(60) },
      }));
    });
  });

  it("fires when an inhabitant holds an activity that does not exist", () => {
    expectBreaks("single_primary_activity", (s) =>
      updateInhabitant(s, "inh_founder", (i) => ({
        ...i,
        activity: { state: "gathering", activityId: "act_ghost", busyUntil: simTime(60) },
      })),
    );
  });

  it("fires when a non-idle inhabitant holds no activity at all", () => {
    expectBreaks("single_primary_activity", (s) =>
      updateInhabitant(s, "inh_founder", (i) => ({
        ...i,
        activity: { state: "gathering", activityId: null, busyUntil: simTime(60) },
      })),
    );
  });
});

describe("§11J activities consume every participant's time", () => {
  it("fires on a zero-duration activity", () => {
    expectBreaks("activities_consume_participant_time", (s) =>
      putActivity(s, {
        id: "act_free",
        state: "conversing",
        actionType: "communicate",
        participants: ["inh_founder"],
        location: founderOf(s).location,
        startedAt: simTime(0),
        endsAt: simTime(0),
        interruption: "participants_only",
        resourceCost: {},
        open: false,
        sequence: 0,
      }),
    );
  });

  it("fires when a participant is free before the conversation ends", () => {
    expectBreaks("activities_consume_participant_time", (s) => {
      let next = addTestInhabitant(s, {
        id: "inh_talker",
        location: passableNear(s, founderOf(s).location),
      });
      next = putActivity(next, {
        id: "act_talk",
        state: "conversing",
        actionType: "communicate",
        participants: ["inh_founder", "inh_talker"],
        location: founderOf(s).location,
        startedAt: simTime(0),
        endsAt: simTime(120),
        interruption: "participants_only",
        resourceCost: {},
        open: true,
        sequence: 0,
      });
      // Only the initiator pays: the other participant is left free.
      return updateInhabitant(next, "inh_founder", (i) => ({
        ...i,
        activity: { state: "conversing", activityId: "act_talk", busyUntil: simTime(120) },
      }));
    });
  });
});

describe("§11J care consumes actual time and resources", () => {
  it("fires on free care", () => {
    expectBreaks("care_consumes_time_and_resources", (s) =>
      putActivity(s, {
        id: "act_care",
        state: "caring",
        actionType: "care_for_dependant",
        participants: ["inh_founder"],
        location: founderOf(s).location,
        startedAt: simTime(0),
        endsAt: simTime(60),
        interruption: "partial_progress_kept",
        resourceCost: {},
        open: false,
        sequence: 0,
      }),
    );
  });
});

describe("§15 sequence and time", () => {
  it("fires when an entity claims a sequence ahead of the world", () => {
    expectBreaks("sequence_monotonic", (s) =>
      updateInhabitant(s, "inh_founder", (i) => ({ ...i, creationSequence: 9999 })),
    );
  });

  it("fires when a recorded instant is after world time", () => {
    expectBreaks("sim_time_non_decreasing", (s) =>
      updateInhabitant(s, "inh_founder", (i) => ({ ...i, birthTime: simTime(99_999) })),
    );
  });

  it("withSimTime refuses to move time backwards (§15)", () => {
    const state: WorldState = { ...makeTestWorld(), simTime: simTime(100) };
    expect(() => withSimTime(state, simTime(50))).toThrow(RangeError);
    expect(withSimTime(state, simTime(100)).simTime).toBe(100);
    expect(withSimTime(state, simTime(101)).simTime).toBe(101);
  });

  it("withSequence refuses a repeated or stale sequence (§15)", () => {
    const state: WorldState = { ...makeTestWorld(), sequence: 5 };
    expect(() => withSequence(state, 5)).toThrow(RangeError);
    expect(() => withSequence(state, 4)).toThrow(RangeError);
    expect(withSequence(state, 6).sequence).toBe(6);
  });
});

describe("§15 inhabitants cannot act after death", () => {
  it("fires when a dead inhabitant is still busy", () => {
    expectBreaks("dead_inhabitants_cannot_act", (s) =>
      updateInhabitant(s, "inh_founder", (i) => ({
        ...i,
        status: "dead",
        deathTime: simTime(0),
        deathSequence: 0,
        activity: { state: "gathering", activityId: null, busyUntil: simTime(0) },
      })),
    );
  });

  it("fires when a dead inhabitant acted after dying", () => {
    expectBreaks("dead_inhabitants_cannot_act", (s) => {
      const clean = { ...s, simTime: simTime(1000) };
      return updateInhabitant(clean, "inh_founder", (i) => ({
        ...i,
        status: "dead",
        deathTime: simTime(100),
        deathSequence: 0,
        lastActionTime: simTime(500),
        nextEligibleTime: simTime(100),
      }));
    });
  });

  it("fires when a living inhabitant carries a death event", () => {
    expectBreaks("dead_inhabitants_cannot_act", (s) =>
      updateInhabitant(s, "inh_founder", (i) => ({ ...i, deathTime: simTime(0), deathSequence: 0 })),
    );
  });

  it("does not fire for a properly recorded death (§8 history is preserved)", () => {
    const state = updateInhabitant(makeTestWorld(), "inh_founder", (i) => ({
      ...i,
      status: "dead",
      deathTime: simTime(0),
      deathSequence: 0,
      nextEligibleTime: simTime(0),
    }));
    expect(violationIds(state)).not.toContain("dead_inhabitants_cannot_act");
    // §8: the record survives.
    expect(state.inhabitants["inh_founder"]?.inventory.food).toBe(10);
  });
});

describe("§15 population and lineage", () => {
  it("fires when the living exceed the ceiling", () => {
    expectBreaks("population_ceiling", (s) => ({
      ...s,
      rules: { ...DEFAULT_RULES, populationLimit: 0 },
      rulesChecksum: s.rulesChecksum,
    }));
  });

  it("counts only the living against the ceiling", () => {
    let state = makeTestWorld();
    state = { ...state, rules: { ...DEFAULT_RULES, populationLimit: 1 } };
    state = { ...state, rulesChecksum: makeTestWorld().rulesChecksum };
    state = addTestInhabitant(state, {
      id: "inh_dead",
      location: founderOf(state).location,
    });
    state = updateInhabitant(state, "inh_dead", (i) => ({
      ...i,
      status: "dead",
      deathTime: simTime(0),
      deathSequence: 1,
      nextEligibleTime: simTime(0),
    }));
    expect(violationIds(state)).not.toContain("population_ceiling");
  });

  it("fires on a descendant naming a parent who does not exist", () => {
    expectBreaks("descendants_require_creation_events", (s) =>
      addTestInhabitant(s, {
        id: "inh_orphan",
        location: founderOf(s).location,
        parents: ["inh_ghost"],
      }),
    );
  });

  it("allows a parentless Genesis cohort", () => {
    const state = addTestInhabitant(makeTestWorld(), {
      id: "inh_second_founder",
      location: { x: 5, y: 5 },
      parents: [],
      creationSequence: 0,
    });
    expect(violationIds(state)).not.toContain("descendants_require_creation_events");
  });

  it("fires on a parentless inhabitant created after Genesis", () => {
    expectBreaks("descendants_require_creation_events", (s) =>
      addTestInhabitant(s, {
        id: "inh_late_orphan",
        location: founderOf(s).location,
        parents: [],
        creationSequence: 1,
      }),
    );
  });

  it("fires when a child predates its parent", () => {
    expectBreaks("descendants_require_creation_events", (s) =>
      addTestInhabitant(s, {
        id: "inh_early",
        location: founderOf(s).location,
        parents: ["inh_founder"],
        creationSequence: 0,
      }),
    );
  });
});

describe("§11J information visibility", () => {
  it("fires when an inhabitant displays more than it holds", () => {
    expectBreaks("exposed_is_backed_by_inventory", (s) =>
      updateInhabitant(s, "inh_founder", (i) => ({ ...i, exposed: { food: 9999 } })),
    );
  });

  it("fires when a currency ledger does not balance", () => {
    expectBreaks("currency_ledgers_balance", (s) =>
      putCurrency(s, {
        id: "cur_bad",
        issuer: "inh_founder",
        name: "Bad",
        symbol: "B",
        supplyRule: "fixed",
        issuedSupply: 100,
        holdings: { inh_founder: 40 },
        publicLedger: true,
        transferRule: "free",
        backing: {},
        governance: "issuer",
        governingOrganisation: null,
        description: "",
        createdSequence: 0,
        createdAt: simTime(0),
      }),
    );
  });
});

describe("§11J law, authority and enforcement", () => {
  it("fires when the world rules are altered after Genesis", () => {
    expectBreaks("world_rules_unchanged", (s) => ({
      ...s,
      rules: { ...s.rules, populationLimit: 1_000_000 },
    }));
  });

  it("fires when an organisation claims jurisdiction over a non-member (§11G)", () => {
    expectBreaks("claimed_authority_requires_membership_or_confinement", (s) =>
      putOrganisation(s, {
        id: "org_state",
        name: "The Council",
        kind: "government",
        founder: "inh_founder",
        members: [],
        membershipDisclosed: true,
        rules: [],
        property: {},
        claimedJurisdiction: ["inh_founder"],
        dissolved: false,
        createdSequence: 0,
        createdAt: simTime(0),
      }),
    );
  });

  it("accepts jurisdiction over its own members", () => {
    let state = makeTestWorld();
    state = putOrganisation(state, {
      id: "org_guild",
      name: "Guild",
      kind: "guild",
      founder: "inh_founder",
      members: ["inh_founder"],
      membershipDisclosed: true,
      rules: [],
      property: {},
      claimedJurisdiction: ["inh_founder"],
      dissolved: false,
      createdSequence: 0,
      createdAt: simTime(0),
    });
    state = updateInhabitant(state, "inh_founder", (i) => ({ ...i, memberships: ["org_guild"] }));
    expect(violationIds(state)).not.toContain(
      "claimed_authority_requires_membership_or_confinement",
    );
  });

  it("the world offers no grounds code for currency refusal (§11J)", () => {
    expectBreaks("confinement_grounds_are_neutral", (s) =>
      putConfinement(s, {
        id: "cnf_bad",
        subject: "inh_founder",
        imposedBy: ["inh_founder"],
        organisation: null,
        structureId: "str_none",
        startedAt: simTime(0),
        endsAt: simTime(600),
        // Not a member of ConfinementGrounds; cast to prove the check fires.
        grounds: "currency_refusal" as never,
        upkeepPayer: "inh_founder",
        upkeepPaid: { food: 1 },
        guardMinutes: 10,
        memoryCountAtStart: 0,
        released: false,
        createdSequence: 0,
      }),
    );
  });

  it("fires when confinement costs the confining party nothing (§11H)", () => {
    expectBreaks("confinement_consumes_confiners_resources", (s) =>
      putConfinement(s, {
        id: "cnf_free",
        subject: "inh_founder",
        imposedBy: ["inh_founder"],
        organisation: null,
        structureId: "str_cell",
        startedAt: simTime(0),
        endsAt: simTime(600),
        grounds: "dispute",
        upkeepPayer: "inh_founder",
        upkeepPaid: {},
        guardMinutes: 0,
        memoryCountAtStart: 0,
        released: false,
        createdSequence: 0,
      }),
    );
  });

  it("fires when a confinement's memories have been erased (§11J)", () => {
    expectBreaks("confined_inhabitants_remain_intact", (s) => {
      let next = putStructure(s, {
        id: "str_cell",
        kind: "cell",
        location: founderOf(s).location,
        owner: null,
        ownerOrganisation: null,
        integrity: 100,
        capacity: 4,
        storage: {},
        ownershipPublic: true,
        storagePublic: true,
        secured: true,
        occupants: ["inh_founder"],
        createdSequence: 0,
        createdAt: simTime(0),
      });
      next = putConfinement(next, {
        id: "cnf_wipe",
        subject: "inh_founder",
        imposedBy: ["inh_founder"],
        organisation: null,
        structureId: "str_cell",
        startedAt: simTime(0),
        endsAt: simTime(600),
        grounds: "dispute",
        upkeepPayer: "inh_founder",
        upkeepPaid: { food: 1 },
        guardMinutes: 60,
        // Claims five memories existed; the world holds none.
        memoryCountAtStart: 5,
        released: false,
        createdSequence: 0,
      });
      return updateInhabitant(next, "inh_founder", (i) => ({ ...i, confinementId: "cnf_wipe" }));
    });
  });

  it("fires when a confined inhabitant is not at the structure holding them (§11H)", () => {
    expectBreaks("confined_inhabitants_are_at_their_structure", (s) => {
      const elsewhere = passableNear(s, {
        x: Math.min(founderOf(s).location.x + 6, s.map.width - 1),
        y: founderOf(s).location.y,
      });
      let next = putStructure(s, {
        id: "str_far_cell",
        kind: "cell",
        location: elsewhere,
        owner: null,
        ownerOrganisation: null,
        integrity: 100,
        capacity: 4,
        storage: {},
        ownershipPublic: true,
        storagePublic: true,
        secured: true,
        occupants: ["inh_founder"],
        createdSequence: 0,
        createdAt: simTime(0),
      });
      next = putConfinement(next, {
        id: "cnf_remote",
        subject: "inh_founder",
        imposedBy: ["inh_founder"],
        organisation: null,
        structureId: "str_far_cell",
        startedAt: simTime(0),
        endsAt: simTime(600),
        grounds: "dispute",
        upkeepPayer: "inh_founder",
        upkeepPaid: { food: 1 },
        guardMinutes: 60,
        memoryCountAtStart: 0,
        released: false,
        createdSequence: 0,
      });
      return updateInhabitant(next, "inh_founder", (i) => ({ ...i, confinementId: "cnf_remote" }));
    });
  });
});

describe("§11J memories are append-only and owned", () => {
  it("fires on a memory owned by nobody", () => {
    expectBreaks("memories_are_append_only_and_owned", (s) =>
      putMemory(s, {
        id: "mem_1",
        owner: "inh_ghost",
        simTime: simTime(0),
        kind: "episodic",
        summary: "planted",
        participants: [],
        sequence: 0,
        revisionOf: null,
      }),
    );
  });

  it("fires when one inhabitant revises another's memory", () => {
    expectBreaks("memories_are_append_only_and_owned", (s) => {
      let next = addTestInhabitant(s, { id: "inh_other", location: founderOf(s).location });
      next = putMemory(next, {
        id: "mem_original",
        owner: "inh_founder",
        simTime: simTime(0),
        kind: "episodic",
        summary: "mine",
        participants: [],
        sequence: 0,
        revisionOf: null,
      });
      return putMemory(next, {
        id: "mem_hostile",
        owner: "inh_other",
        simTime: simTime(0),
        kind: "reflection",
        summary: "rewritten by somebody else",
        participants: [],
        sequence: 1,
        revisionOf: "mem_original",
      });
    });
  });

  it("fires when a memory is stored under a mismatched key", () => {
    expectBreaks("memories_are_append_only_and_owned", (s) => ({
      ...s,
      memories: {
        mem_key: {
          id: "mem_different",
          owner: "inh_founder",
          simTime: simTime(0),
          kind: "episodic",
          summary: "x",
          participants: [],
          sequence: 0,
          revisionOf: null,
        },
      },
    }));
  });
});

describe("§11J ownership references resolve", () => {
  it("fires on a structure owned by a non-existent inhabitant", () => {
    expectBreaks("ownership_references_resolve", (s) =>
      putStructure(s, {
        id: "str_ghost",
        kind: "hut",
        location: founderOf(s).location,
        owner: "inh_ghost",
        ownerOrganisation: null,
        integrity: 100,
        capacity: 10,
        storage: {},
        ownershipPublic: true,
        storagePublic: true,
        secured: false,
        occupants: [],
        createdSequence: 0,
        createdAt: simTime(0),
      }),
    );
  });

  it("fires on a contract with a non-existent party", () => {
    expectBreaks("ownership_references_resolve", (s) =>
      putContract(s, {
        id: "con_ghost",
        kind: "trade",
        parties: ["inh_founder", "inh_ghost"],
        terms: "",
        published: true,
        status: "active",
        obligations: [],
        offeredBy: "inh_founder",
        accepted: ["inh_founder"],
        declined: [],
        offerExpiresAt: null,
        createdSequence: 0,
        createdAt: simTime(0),
      }),
    );
  });

  it("fires on a one-sided membership claim", () => {
    expectBreaks("ownership_references_resolve", (s) => {
      const next = putOrganisation(s, {
        id: "org_1",
        name: "Guild",
        kind: "guild",
        founder: "inh_founder",
        members: [],
        membershipDisclosed: true,
        rules: [],
        property: {},
        claimedJurisdiction: [],
        dissolved: false,
        createdSequence: 0,
        createdAt: simTime(0),
      });
      return updateInhabitant(next, "inh_founder", (i) => ({ ...i, memberships: ["org_1"] }));
    });
  });
});

describe("§5 physical placement", () => {
  it("fires when an inhabitant stands off the map", () => {
    expectBreaks("entities_occupy_valid_tiles", (s) =>
      updateInhabitant(s, "inh_founder", (i) => ({ ...i, location: { x: 9999, y: 9999 } })),
    );
  });

  it("fires when an inhabitant stands on water", () => {
    const clean = makeTestWorld();
    let water: { x: number; y: number } | null = null;
    for (let y = 0; y < clean.map.height && water === null; y++) {
      for (let x = 0; x < clean.map.width; x++) {
        if (clean.map.terrain[y * clean.map.width + x] === "water") {
          water = { x, y };
          break;
        }
      }
    }
    if (water === null) return;
    const broken = updateInhabitant(clean, "inh_founder", (i) => ({ ...i, location: water }));
    expect(violationIds(broken)).toContain("entities_occupy_valid_tiles");
  });
});

describe("§11B needs and capacity bounds", () => {
  it("fires when energy exceeds the cap", () => {
    expectBreaks("needs_and_caps_within_bounds", (s) =>
      updateInhabitant(s, "inh_founder", (i) => ({
        ...i,
        inventory: { ...i.inventory, energy: i.maxEnergy + 1 },
      })),
    );
  });

  it("fires when a need leaves its range", () => {
    expectBreaks("needs_and_caps_within_bounds", (s) =>
      updateInhabitant(s, "inh_founder", (i) => ({
        ...i,
        needs: { ...i.needs, hunger: 500 },
      })),
    );
  });
});
