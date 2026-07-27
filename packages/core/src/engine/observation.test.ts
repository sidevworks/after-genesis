/**
 * Adversarial tests for the observation boundary (§6, §11E, §15).
 *
 * §15: "Private information cannot appear in another inhabitant's context
 * without a valid disclosure event."
 *
 * The strategy is to plant uniquely identifiable secrets — distinctive strings
 * and improbable integers — on every private field of a *second* inhabitant,
 * serialise the *first* inhabitant's observation to canonical JSON, and assert
 * that not one of them appears anywhere in the bytes. Serialising the whole
 * observation matters: a structural check like `expect(obs.inhabitants[0].inventory)
 * .toBeUndefined()` would miss a leak through a field nobody thought to assert
 * on, and the prompt builder downstream serialises the whole thing.
 *
 * Each secret is also checked to be visible in its *owner's* own observation.
 * Without that positive control, a `buildObservation` that returned `{}` would
 * pass every leak test.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../util/canonical.js";
import { simTime } from "../time.js";
import { buildObservation, currentSightRadius, UnknownObserverError } from "./observation.js";
import {
  makeInhabitant,
  putConfinement,
  putContract,
  putCurrency,
  putMemory,
  putOrganisation,
  putStructure,
  updateInhabitant,
  type WorldState,
} from "./state.js";
import { addTestInhabitant, founderOf, makeTestWorld, passableNear } from "./test-support.js";

/* Unique markers. If any of these reaches the observer, a rule was broken. */
const SECRET = {
  goal: "SECRET_GOAL_OMEGA",
  belief: "SECRET_BELIEF_ZETA",
  memory: "SECRET_MEMORY_KAPPA",
  contractTerms: "SECRET_CONTRACT_TERMS_IOTA",
  orgMember: "inh_SECRET_MEMBER_LAMBDA",
  hiddenStorageQty: 424242,
  privateInventoryQty: 313131,
  hiddenStructureQty: 989898,
  privateCurrencyQty: 767676,
} as const;

/** A world where `inh_neighbour` stands beside the founder holding secrets. */
function worldWithSecretiveNeighbour(): { state: WorldState; neighbour: string } {
  // Midday: Genesis itself is 00:00, which `isNight` treats as night and which
  // would quietly halve the sight radius and weaken every leak test below.
  let state: WorldState = { ...makeTestWorld(), simTime: simTime(12 * 60) };
  const founder = founderOf(state);
  const beside = passableNear(state, { x: founder.location.x + 1, y: founder.location.y });

  state = addTestInhabitant(state, {
    id: "inh_neighbour",
    displayName: "Neighbour",
    location: beside,
    inventory: { food: SECRET.privateInventoryQty, energy: 400 },
    concealed: { wood: SECRET.hiddenStorageQty },
    exposed: { food: 5 },
    privateGoals: [SECRET.goal],
  });

  state = updateInhabitant(state, "inh_neighbour", (i) => ({
    ...i,
    beliefs: { inh_founder: SECRET.belief },
    relationships: {
      inh_founder: {
        other: "inh_founder",
        familiarity: 40,
        trust: -60,
        lastInteraction: simTime(0),
      },
    },
    skills: { negotiation: 88 },
  }));

  // A private memory belonging to the neighbour.
  state = putMemory(state, {
    id: "mem_secret",
    owner: "inh_neighbour",
    simTime: simTime(0),
    kind: "episodic",
    summary: SECRET.memory,
    participants: ["inh_neighbour"],
    sequence: 1,
    revisionOf: null,
  });

  // A hidden cache: a structure the founder can see, whose contents it cannot.
  state = putStructure(state, {
    id: "str_cache",
    kind: "cache",
    location: beside,
    owner: "inh_neighbour",
    ownerOrganisation: null,
    integrity: 100,
    capacity: 1000,
    storage: { stone: SECRET.hiddenStructureQty },
    ownershipPublic: false,
    storagePublic: false,
    secured: true,
    occupants: [],
    createdSequence: 1,
    createdAt: simTime(0),
  });

  // An unpublished contract between the neighbour and a third party.
  state = addTestInhabitant(state, {
    id: "inh_third",
    displayName: "Third",
    location: beside,
  });
  state = putContract(state, {
    id: "con_private",
    kind: "service",
    parties: ["inh_neighbour", "inh_third"],
    terms: SECRET.contractTerms,
    published: false,
    status: "active",
    obligations: {},
    createdSequence: 1,
    createdAt: simTime(0),
  });

  // An organisation that has not disclosed its membership.
  // Placed far away: standing next to somebody is a disclosure of your body,
  // not of your affiliations. Keeping them out of sight isolates the question
  // the test is actually asking.
  state = addTestInhabitant(state, {
    id: SECRET.orgMember,
    displayName: "Hidden member",
    location: passableNear(state, {
      x: Math.min(founder.location.x + 15, state.map.width - 1),
      y: Math.min(founder.location.y + 15, state.map.height - 1),
    }),
  });
  state = putOrganisation(state, {
    id: "org_secret",
    name: "Quiet Circle",
    kind: "guild",
    founder: "inh_neighbour",
    members: ["inh_neighbour", SECRET.orgMember],
    membershipDisclosed: false,
    rules: [
      { id: "rule_public", text: "adopted and public", proposedBy: "inh_neighbour", adopted: true, sequence: 1 },
      { id: "rule_draft", text: "SECRET_DRAFT_RULE_MU", proposedBy: "inh_neighbour", adopted: false, sequence: 1 },
    ],
    property: {},
    claimedJurisdiction: [],
    dissolved: false,
    createdSequence: 1,
    createdAt: simTime(0),
  });
  state = updateInhabitant(state, "inh_neighbour", (i) => ({
    ...i,
    memberships: ["org_secret"],
    contracts: ["con_private"],
  }));
  state = updateInhabitant(state, SECRET.orgMember, (i) => ({
    ...i,
    memberships: ["org_secret"],
  }));
  state = updateInhabitant(state, "inh_third", (i) => ({ ...i, contracts: ["con_private"] }));

  // A currency with a private ledger.
  state = putCurrency(state, {
    id: "cur_private",
    issuer: "inh_neighbour",
    name: "Quiet Mark",
    symbol: "QM",
    supplyRule: "fixed",
    issuedSupply: SECRET.privateCurrencyQty,
    holdings: { inh_neighbour: SECRET.privateCurrencyQty },
    publicLedger: false,
    transferRule: "bearer",
    backing: {},
    governance: "issuer",
    description: "a private unit of account",
    createdSequence: 1,
    createdAt: simTime(0),
  });

  return { state, neighbour: "inh_neighbour" };
}

describe("buildObservation — leakage (§15 security boundary)", () => {
  const { state } = worldWithSecretiveNeighbour();
  const observed = buildObservation(state, "inh_founder");
  const serialised = canonicalJson(observed);

  it("sees the neighbour at all (otherwise the leak tests prove nothing)", () => {
    expect(observed.inhabitants.map((i) => i.id)).toContain("inh_neighbour");
  });

  it("does not leak another inhabitant's private inventory", () => {
    expect(serialised).not.toContain(String(SECRET.privateInventoryQty));
    for (const other of observed.inhabitants) {
      expect(other).not.toHaveProperty("inventory");
      expect(other).not.toHaveProperty("concealed");
    }
  });

  it("does not leak hidden storage (§11E)", () => {
    expect(serialised).not.toContain(String(SECRET.hiddenStorageQty));
  });

  it("does not leak a hidden structure's contents", () => {
    expect(serialised).not.toContain(String(SECRET.hiddenStructureQty));
    const cache = observed.structures.find((s) => s.id === "str_cache");
    expect(cache).toBeDefined();
    expect(cache?.storage).toBeNull();
    expect(cache?.owner).toBeNull();
  });

  it("does not leak another inhabitant's private goals or intentions", () => {
    expect(serialised).not.toContain(SECRET.goal);
  });

  it("does not leak another inhabitant's beliefs about others", () => {
    expect(serialised).not.toContain(SECRET.belief);
  });

  it("does not leak another inhabitant's memories (§19)", () => {
    expect(serialised).not.toContain(SECRET.memory);
    expect(observed.memories).toHaveLength(0);
  });

  it("does not leak another inhabitant's relationships or skills", () => {
    for (const other of observed.inhabitants) {
      expect(other).not.toHaveProperty("relationships");
      expect(other).not.toHaveProperty("beliefs");
      expect(other).not.toHaveProperty("skills");
      expect(other).not.toHaveProperty("needs");
      expect(other).not.toHaveProperty("privateGoals");
      expect(other).not.toHaveProperty("memberships");
      expect(other).not.toHaveProperty("knownLocations");
      expect(other).not.toHaveProperty("modelId");
    }
    expect(serialised).not.toContain("88"); // the neighbour's negotiation skill
  });

  it("does not leak an unpublished contract", () => {
    expect(serialised).not.toContain(SECRET.contractTerms);
    expect(observed.publicRecords.contracts.map((c) => c.id)).not.toContain("con_private");
  });

  it("does not leak undisclosed organisation membership", () => {
    expect(serialised).not.toContain(SECRET.orgMember);
    const org = observed.publicRecords.organisations.find((o) => o.id === "org_secret");
    expect(org).toBeDefined();
    expect(org?.members).toBeNull();
    expect(org?.memberCount).toBeNull();
  });

  it("does not leak unadopted organisation rules", () => {
    expect(serialised).not.toContain("SECRET_DRAFT_RULE_MU");
  });

  it("does not leak an undisclosed currency ledger", () => {
    const currency = observed.publicRecords.currencies.find((c) => c.id === "cur_private");
    expect(currency).toBeDefined();
    // The supply is declared at creation and is public; the holdings are not.
    expect(currency?.holdings).toBeNull();
  });

  it("still shows what §11E calls directly observable", () => {
    const neighbour = observed.inhabitants.find((i) => i.id === "inh_neighbour");
    expect(neighbour?.exposed).toEqual({ food: 5 });
    expect(neighbour?.displayName).toBe("Neighbour");
    expect(neighbour?.activity).toBe("idle");
  });
});

describe("buildObservation — positive controls", () => {
  it("an inhabitant does see its own private state", () => {
    const { state } = worldWithSecretiveNeighbour();
    const own = canonicalJson(buildObservation(state, "inh_neighbour"));
    expect(own).toContain(SECRET.goal);
    expect(own).toContain(SECRET.belief);
    expect(own).toContain(SECRET.memory);
    expect(own).toContain(String(SECRET.privateInventoryQty));
    expect(own).toContain(String(SECRET.hiddenStorageQty));
  });

  it("a party to a private contract sees it", () => {
    const { state } = worldWithSecretiveNeighbour();
    const own = buildObservation(state, "inh_third");
    expect(own.publicRecords.contracts.map((c) => c.id)).toContain("con_private");
  });

  it("a member sees its own organisation's membership", () => {
    const { state } = worldWithSecretiveNeighbour();
    const own = buildObservation(state, "inh_neighbour");
    const org = own.publicRecords.organisations.find((o) => o.id === "org_secret");
    expect(org?.members).toContain(SECRET.orgMember);
  });

  it("an owner sees inside its own structure", () => {
    const { state } = worldWithSecretiveNeighbour();
    const own = buildObservation(state, "inh_neighbour");
    const cache = own.structures.find((s) => s.id === "str_cache");
    expect(cache?.storage).toEqual({ stone: SECRET.hiddenStructureQty });
    expect(cache?.owner).toBe("inh_neighbour");
  });

  it("a holder sees its own balance in a private currency", () => {
    const { state } = worldWithSecretiveNeighbour();
    const own = buildObservation(state, "inh_neighbour");
    const currency = own.publicRecords.currencies.find((c) => c.id === "cur_private");
    expect(currency?.holdings).toEqual({ inh_neighbour: SECRET.privateCurrencyQty });
  });
});

describe("buildObservation — range and perception", () => {
  it("omits inhabitants beyond the sight radius", () => {
    let state = makeTestWorld();
    const founder = founderOf(state);
    const far = passableNear(state, {
      x: Math.min(founder.location.x + 20, state.map.width - 1),
      y: Math.min(founder.location.y + 20, state.map.height - 1),
    });
    state = addTestInhabitant(state, { id: "inh_far", location: far, privateGoals: ["FAR_GOAL"] });
    const observed = buildObservation(state, "inh_founder");
    expect(observed.inhabitants.map((i) => i.id)).not.toContain("inh_far");
    expect(canonicalJson(observed)).not.toContain("FAR_GOAL");
  });

  it("omits tiles beyond the sight radius", () => {
    const state = makeTestWorld();
    const observed = buildObservation(state, "inh_founder");
    for (const tile of observed.tiles) {
      expect(tile.distance).toBeLessThanOrEqual(observed.sightRadius);
    }
  });

  it("never returns tiles off the map", () => {
    const state = makeTestWorld();
    const observed = buildObservation(state, "inh_founder");
    for (const tile of observed.tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(state.map.width);
      expect(tile.y).toBeLessThan(state.map.height);
    }
  });

  it("sees less at night (§5 day/night)", () => {
    // Genesis is 00:00, which is night. Midday is the daylight comparison.
    const day: WorldState = { ...makeTestWorld(), simTime: simTime(12 * 60) };
    const night: WorldState = { ...day, simTime: simTime(23 * 60) };
    expect(currentSightRadius(night, "inh_founder")).toBeLessThan(
      currentSightRadius(day, "inh_founder"),
    );
    expect(buildObservation(night, "inh_founder").night).toBe(true);
  });

  it("the dead perceive nothing", () => {
    let state = makeTestWorld();
    state = updateInhabitant(state, "inh_founder", (i) => ({
      ...i,
      status: "dead",
      deathTime: simTime(0),
      deathSequence: 0,
    }));
    expect(currentSightRadius(state, "inh_founder")).toBe(0);
  });

  it("a confined inhabitant sees only its own tile but keeps its mind (§11H)", () => {
    let state = makeTestWorld();
    const founder = founderOf(state);
    state = putStructure(state, {
      id: "str_cell",
      kind: "cell",
      location: founder.location,
      owner: null,
      ownerOrganisation: null,
      integrity: 100,
      capacity: 10,
      storage: {},
      ownershipPublic: true,
      storagePublic: true,
      secured: true,
      occupants: ["inh_founder"],
      createdSequence: 0,
      createdAt: simTime(0),
    });
    state = putConfinement(state, {
      id: "cnf_1",
      subject: "inh_founder",
      imposedBy: ["inh_other"],
      organisation: null,
      structureId: "str_cell",
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
    state = updateInhabitant(state, "inh_founder", (i) => ({ ...i, confinementId: "cnf_1" }));

    const observed = buildObservation(state, "inh_founder");
    expect(observed.sightRadius).toBe(0);
    expect(observed.tiles).toHaveLength(1);
    // §11J: "A confined inhabitant remains historically and cognitively intact."
    expect(observed.self.privateGoals).toEqual(["understand this place"]);
    expect(observed.self.confinement?.grounds).toBe("dispute");
  });

  it("throws only for an unknown observer", () => {
    expect(() => buildObservation(makeTestWorld(), "inh_nobody")).toThrow(UnknownObserverError);
  });

  it("is pure — building an observation does not change the world", () => {
    const state = makeTestWorld();
    const before = canonicalJson(state);
    buildObservation(state, "inh_founder");
    expect(canonicalJson(state)).toBe(before);
  });

  it("is deterministic", () => {
    const state = makeTestWorld();
    expect(canonicalJson(buildObservation(state, "inh_founder"))).toBe(
      canonicalJson(buildObservation(state, "inh_founder")),
    );
  });

  it("never returns anything that cannot be canonically encoded", () => {
    const { state } = worldWithSecretiveNeighbour();
    for (const id of Object.keys(state.inhabitants)) {
      expect(() => canonicalJson(buildObservation(state, id))).not.toThrow();
    }
  });
});

describe("buildObservation — self view completeness (§6)", () => {
  it("carries the fields cognition needs", () => {
    const state = makeTestWorld();
    const self = buildObservation(state, "inh_founder").self;
    expect(self.id).toBe("inh_founder");
    expect(self.energy).toBe(800);
    expect(self.maxEnergy).toBeGreaterThan(0);
    expect(self.inventory.food).toBe(10);
    expect(self.needs.hunger).toBe(0);
    expect(self.skills.gathering).toBe(10);
    expect(self.knownLocations.length).toBeGreaterThan(0);
    expect(self.activity).toBe("idle");
  });

  it("does not include a founder that does not exist as someone else", () => {
    const state = makeTestWorld();
    const observed = buildObservation(state, "inh_founder");
    expect(observed.inhabitants.map((i) => i.id)).not.toContain("inh_founder");
  });
});

describe("makeInhabitant", () => {
  it("starts idle, alive and childless", () => {
    const inhabitant = makeInhabitant({
      id: "inh_z",
      displayName: "Z",
      location: { x: 1, y: 1 },
      birthTime: simTime(0),
      creationSequence: 0,
    });
    expect(inhabitant.status).toBe("alive");
    expect(inhabitant.activity.activityId).toBeNull();
    expect(inhabitant.deathTime).toBeNull();
    expect(inhabitant.knownLocations).toEqual(["1,1"]);
  });
});
