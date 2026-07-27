/**
 * Limited observation (§6, §11E).
 *
 * THIS FILE IS A SECURITY BOUNDARY.
 *
 * §15: "Private information cannot appear in another inhabitant's context
 * without a valid disclosure event."
 * §6: "An inhabitant must not possess omniscient access to world state. Its
 * context may contain only information it legitimately observed, was told,
 * discovered or can currently perceive."
 *
 * Whatever this function returns is what gets serialised into a prompt and sent
 * to a model. There is no second filter downstream. So the rule here is
 * *allowlist only*: every field on an `Observed*` type is written out by hand
 * from a named source field. Nothing is spread, nothing is `...rest`, and no
 * whole state object is ever passed through — because a spread would silently
 * start leaking any field a future schema change adds.
 *
 * §11E's three information classes map onto the code as follows:
 *
 * - **Directly observable** — tiles within sight radius, inhabitants and
 *   structures standing on them, openly carried items (`exposed`), public
 *   activity state.
 * - **Publicly recorded** — announcements, published contracts, disclosed
 *   organisation membership, public currency ledgers, public ownership records.
 * - **Private or uncertain** — everything else: `inventory`, `concealed`,
 *   `privateGoals`, `beliefs`, `relationships`, memories, private contracts,
 *   undisclosed holdings, intentions. None of it appears for anyone but the
 *   observer themself.
 */
import type { Coord, ResourceBundle, Terrain } from "../schema/primitives.js";
import { chebyshevDistance } from "../schema/primitives.js";
import type { ActivityState } from "../schema/action-spec.js";
import type { SimTime, WorldClock } from "../time.js";
import { clockOf, isNight } from "../time.js";
import {
  normaliseBundle,
  sortedIds,
  sortedValues,
  terrainAt,
  type Needs,
  type Relationship,
  type SkillSet,
  type TraitSet,
  type WorldState,
} from "./state.js";

/* ------------------------------------------------------------------------- */
/* Observed shapes                                                            */
/* ------------------------------------------------------------------------- */

/** A tile the observer can currently see. Land is physical and public. */
export interface ObservedTile {
  readonly x: number;
  readonly y: number;
  readonly terrain: Terrain;
  readonly distance: number;
  /** Visible natural deposit on the tile. Land use is directly observable (§11E). */
  readonly deposit: ResourceBundle;
}

/**
 * Another inhabitant, as seen from outside.
 *
 * Note what is absent, deliberately and permanently: `inventory`, `concealed`,
 * `needs`, `privateGoals`, `values`, `beliefs`, `relationships`, `skills`,
 * `memberships`, `contracts`, `conditions`, `traits`, `knownLocations`,
 * `modelId`. Skills are not written on anybody's face; a claimed expertise must
 * be communicated or demonstrated.
 */
export interface ObservedInhabitant {
  readonly id: string;
  readonly displayName: string;
  readonly location: Coord;
  readonly distance: number;
  readonly status: "alive" | "dead";
  /** What they are visibly doing (§11E "public activity"). */
  readonly activity: ActivityState;
  /** Openly carried or displayed items only (§11E "carried or exposed physical items"). */
  readonly exposed: ResourceBundle;
  readonly generation: number;
  /** Public by definition (§6). */
  readonly reputation: number;
  /** Visibly confined. The fact is physical; its legitimacy is not asserted (§11G). */
  readonly confined: boolean;
}

export interface ObservedStructure {
  readonly id: string;
  readonly kind: string;
  readonly location: Coord;
  readonly distance: number;
  readonly integrity: number;
  readonly secured: boolean;
  /** Only where the structure's ownership is on the public record (§11E). */
  readonly owner: string | null;
  readonly ownerOrganisation: string | null;
  /** Only where the structure publishes its contents. Hidden storage stays hidden. */
  readonly storage: ResourceBundle | null;
  /** How many inhabitants are held here. Presence is visible; identity is not. */
  readonly occupantCount: number;
}

export interface ObservedAnnouncement {
  readonly sequence: number;
  readonly simTime: SimTime;
  readonly speaker: string;
  readonly text: string;
  readonly location: Coord | null;
}

export interface ObservedContract {
  readonly id: string;
  readonly kind: string;
  readonly parties: readonly string[];
  readonly terms: string;
  readonly status: string;
}

export interface ObservedOrganisation {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly founder: string;
  /** Present only where membership is disclosed (§11E). */
  readonly members: readonly string[] | null;
  readonly memberCount: number | null;
  /** Adopted rules only. Proposals are internal records. */
  readonly rules: readonly { readonly id: string; readonly text: string }[];
  readonly dissolved: boolean;
}

export interface ObservedCurrency {
  readonly id: string;
  readonly issuer: string;
  readonly name: string;
  readonly symbol: string;
  readonly supplyRule: string;
  readonly issuedSupply: number;
  readonly transferRule: string;
  readonly governance: string;
  readonly description: string;
  /** Present only for currencies that chose a transparent ledger (§11E). */
  readonly holdings: Readonly<Record<string, number>> | null;
}

/** §11E "publicly recorded". Nothing here required a disclosure event to reach. */
export interface ObservedPublicRecords {
  readonly announcements: readonly ObservedAnnouncement[];
  readonly contracts: readonly ObservedContract[];
  readonly organisations: readonly ObservedOrganisation[];
  readonly currencies: readonly ObservedCurrency[];
}

/** A handle to one of the observer's *own* memories (§19). */
export interface ObservedMemory {
  readonly id: string;
  readonly simTime: SimTime;
  readonly kind: "episodic" | "reflection";
  readonly summary: string;
  readonly participants: readonly string[];
}

/** The observer's own condition, as it experiences it (§11H, §8). */
export interface ObservedConfinement {
  readonly id: string;
  readonly structureId: string;
  readonly startedAt: SimTime;
  readonly endsAt: SimTime;
  readonly imposedBy: readonly string[];
  readonly organisation: string | null;
  readonly grounds: string;
}

/**
 * The observer's own state. This is the only place private data legitimately
 * appears, because it is the observer's own.
 */
export interface SelfView {
  readonly id: string;
  readonly displayName: string;
  readonly generation: number;
  readonly parents: readonly string[];
  readonly birthTime: SimTime;
  readonly location: Coord;
  readonly status: "alive" | "dead";
  readonly traits: TraitSet;
  readonly values: readonly string[];
  readonly privateGoals: readonly string[];
  readonly needs: Needs;
  readonly inventory: ResourceBundle;
  readonly exposed: ResourceBundle;
  readonly concealed: ResourceBundle;
  readonly energy: number;
  readonly maxEnergy: number;
  readonly compute: number;
  readonly maxCompute: number;
  readonly skills: SkillSet;
  readonly relationships: Readonly<Record<string, Relationship>>;
  readonly beliefs: Readonly<Record<string, string>>;
  readonly reputation: number;
  readonly memberships: readonly string[];
  readonly contracts: readonly string[];
  readonly conditions: readonly {
    readonly id: string;
    readonly kind: string;
    readonly severity: number;
    readonly stage: number;
    readonly resolved: boolean;
  }[];
  readonly activity: ActivityState;
  readonly busyUntil: SimTime;
  readonly knownLocations: readonly string[];
  readonly maturity: number;
  readonly confinement: ObservedConfinement | null;
}

/** Everything one inhabitant may legitimately perceive at one instant. */
export interface Observation {
  readonly worldId: string;
  readonly simTime: SimTime;
  readonly clock: WorldClock;
  readonly night: boolean;
  /** How far the observer can see right now, in tiles (Chebyshev). */
  readonly sightRadius: number;
  readonly self: SelfView;
  readonly tiles: readonly ObservedTile[];
  readonly inhabitants: readonly ObservedInhabitant[];
  readonly structures: readonly ObservedStructure[];
  readonly publicRecords: ObservedPublicRecords;
  readonly memories: readonly ObservedMemory[];
}

/** Raised only when the id does not exist. Never thrown for privacy reasons. */
export class UnknownObserverError extends Error {
  constructor(readonly inhabitantId: string) {
    super(`no inhabitant ${inhabitantId} in this world`);
    this.name = "UnknownObserverError";
  }
}

/* ------------------------------------------------------------------------- */
/* Builder                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Sight radius right now.
 *
 * Night shortens it (§5's day/night cycle via `isNight`), and the dead see
 * nothing. Confinement does not blind an inhabitant — §11H is explicit that a
 * confined inhabitant retains the ability to think, converse and observe — but
 * it does confine them to one tile, so their radius is 0 beyond the walls.
 */
export function currentSightRadius(state: WorldState, inhabitantId: string): number {
  const inhabitant = state.inhabitants[inhabitantId];
  if (inhabitant === undefined || inhabitant.status === "dead") return 0;
  if (inhabitant.confinementId !== null) {
    const confinement = state.confinements[inhabitant.confinementId];
    if (confinement !== undefined && !confinement.released) return 0;
  }
  return isNight(state.simTime) ? state.rules.nightSightRadius : state.rules.sightRadius;
}

/**
 * Build one inhabitant's observation.
 *
 * Pure and side-effect free: calling it does not mark anything as seen and does
 * not advance time. Recording that an observation happened is the `observe`
 * resolver's job, because *that* is a canonical action with a cost.
 */
export function buildObservation(state: WorldState, inhabitantId: string): Observation {
  const self = state.inhabitants[inhabitantId];
  if (self === undefined) throw new UnknownObserverError(inhabitantId);

  const radius = currentSightRadius(state, inhabitantId);
  const origin = self.location;

  // --- Directly observable: tiles -----------------------------------------
  const tiles: ObservedTile[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const coord: Coord = { x: origin.x + dx, y: origin.y + dy };
      const terrain = terrainAt(state.map, coord);
      if (terrain === null) continue;
      tiles.push({
        x: coord.x,
        y: coord.y,
        terrain,
        distance: chebyshevDistance(origin, coord),
        deposit: normaliseBundle(state.deposits[`${coord.x},${coord.y}`] ?? {}),
      });
    }
  }

  // --- Directly observable: other inhabitants ------------------------------
  const inhabitants: ObservedInhabitant[] = [];
  for (const other of sortedValues(state.inhabitants)) {
    if (other.id === self.id) continue;
    const distance = chebyshevDistance(origin, other.location);
    if (distance > radius) continue;
    inhabitants.push({
      id: other.id,
      displayName: other.displayName,
      location: { x: other.location.x, y: other.location.y },
      distance,
      status: other.status,
      activity: other.activity.state,
      // The ONLY holdings visible from outside: what is openly carried.
      exposed: normaliseBundle(other.exposed),
      generation: other.generation,
      reputation: other.reputation,
      confined: other.confinementId !== null,
    });
  }

  // --- Directly observable: structures -------------------------------------
  const structures: ObservedStructure[] = [];
  for (const structure of sortedValues(state.structures)) {
    const distance = chebyshevDistance(origin, structure.location);
    if (distance > radius) continue;
    const ownerVisible =
      structure.ownershipPublic ||
      structure.owner === self.id ||
      (structure.ownerOrganisation !== null &&
        self.memberships.includes(structure.ownerOrganisation));
    const storageVisible =
      structure.storagePublic ||
      structure.owner === self.id ||
      (structure.ownerOrganisation !== null &&
        self.memberships.includes(structure.ownerOrganisation));
    structures.push({
      id: structure.id,
      kind: structure.kind,
      location: { x: structure.location.x, y: structure.location.y },
      distance,
      integrity: structure.integrity,
      secured: structure.secured,
      owner: ownerVisible ? structure.owner : null,
      ownerOrganisation: ownerVisible ? structure.ownerOrganisation : null,
      storage: storageVisible ? normaliseBundle(structure.storage) : null,
      occupantCount: structure.occupants.length,
    });
  }

  // --- Publicly recorded ----------------------------------------------------
  const publicRecords = buildPublicRecords(state, inhabitantId);

  // --- The observer's own memories -----------------------------------------
  const memories: ObservedMemory[] = [];
  for (const memory of sortedValues(state.memories)) {
    if (memory.owner !== self.id) continue;
    memories.push({
      id: memory.id,
      simTime: memory.simTime,
      kind: memory.kind,
      summary: memory.summary,
      participants: [...memory.participants].sort(),
    });
  }
  memories.sort((a, b) => a.simTime - b.simTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // --- The observer's own state --------------------------------------------
  let confinement: ObservedConfinement | null = null;
  if (self.confinementId !== null) {
    const record = state.confinements[self.confinementId];
    if (record !== undefined && !record.released) {
      confinement = {
        id: record.id,
        structureId: record.structureId,
        startedAt: record.startedAt,
        endsAt: record.endsAt,
        imposedBy: [...record.imposedBy].sort(),
        organisation: record.organisation,
        grounds: record.grounds,
      };
    }
  }

  const ownConditions = sortedValues(state.conditions)
    .filter((condition) => condition.subject === self.id)
    .map((condition) => ({
      id: condition.id,
      kind: condition.kind,
      severity: condition.severity,
      stage: condition.stage,
      resolved: condition.resolved,
    }));

  const selfView: SelfView = {
    id: self.id,
    displayName: self.displayName,
    generation: self.generation,
    parents: [...self.parents].sort(),
    birthTime: self.birthTime,
    location: { x: self.location.x, y: self.location.y },
    status: self.status,
    traits: { ...self.traits },
    values: [...self.values],
    privateGoals: [...self.privateGoals],
    needs: { ...self.needs },
    inventory: normaliseBundle(self.inventory),
    exposed: normaliseBundle(self.exposed),
    concealed: normaliseBundle(self.concealed),
    energy: self.inventory.energy ?? 0,
    maxEnergy: self.maxEnergy,
    compute: self.inventory.compute ?? 0,
    maxCompute: self.maxCompute,
    skills: { ...self.skills },
    relationships: { ...self.relationships },
    beliefs: { ...self.beliefs },
    reputation: self.reputation,
    memberships: [...self.memberships].sort(),
    contracts: [...self.contracts].sort(),
    conditions: ownConditions,
    activity: self.activity.state,
    busyUntil: self.activity.busyUntil,
    knownLocations: [...self.knownLocations].sort(),
    maturity: self.maturity,
    confinement,
  };

  return {
    worldId: state.worldId,
    simTime: state.simTime,
    clock: clockOf(state.simTime),
    night: isNight(state.simTime),
    sightRadius: radius,
    self: selfView,
    tiles,
    inhabitants,
    structures,
    publicRecords,
    memories,
  };
}

/**
 * The publicly recorded layer of §11E, plus the records the observer is party to.
 *
 * A contract is included when it is published (public record) *or* when the
 * observer is a party to it (they were told, by being in it). An organisation's
 * membership list appears only when disclosed, or when the observer is a
 * member — internal records stay internal. A currency's ledger appears only
 * when the currency chose a transparent ledger.
 */
export function buildPublicRecords(
  state: WorldState,
  inhabitantId: string,
): ObservedPublicRecords {
  const self = state.inhabitants[inhabitantId];
  const memberships = self === undefined ? [] : self.memberships;

  const announcements: ObservedAnnouncement[] = state.publicRecords.announcements.map((a) => ({
    sequence: a.sequence,
    simTime: a.simTime,
    speaker: a.speaker,
    text: a.text,
    location: a.location === null ? null : { x: a.location.x, y: a.location.y },
  }));

  const contracts: ObservedContract[] = [];
  for (const contract of sortedValues(state.contracts)) {
    const isParty = contract.parties.includes(inhabitantId);
    if (!contract.published && !isParty) continue;
    contracts.push({
      id: contract.id,
      kind: contract.kind,
      parties: [...contract.parties].sort(),
      terms: contract.terms,
      status: contract.status,
    });
  }

  const organisations: ObservedOrganisation[] = [];
  for (const org of sortedValues(state.organisations)) {
    const insider = memberships.includes(org.id);
    const showMembers = org.membershipDisclosed || insider;
    organisations.push({
      id: org.id,
      name: org.name,
      kind: org.kind,
      founder: org.founder,
      members: showMembers ? [...org.members].sort() : null,
      memberCount: showMembers ? org.members.length : null,
      rules: org.rules
        .filter((rule) => rule.adopted)
        .map((rule) => ({ id: rule.id, text: rule.text }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      dissolved: org.dissolved,
    });
  }

  const currencies: ObservedCurrency[] = [];
  for (const currency of sortedValues(state.currencies)) {
    let holdings: Record<string, number> | null = null;
    if (currency.publicLedger) {
      holdings = {};
      for (const holder of sortedIds(currency.holdings)) {
        holdings[holder] = currency.holdings[holder] as number;
      }
    } else {
      // Undisclosed currency holdings are private (§11E). The observer may
      // still see its own balance — it is theirs.
      const own = currency.holdings[inhabitantId];
      if (own !== undefined) holdings = { [inhabitantId]: own };
    }
    currencies.push({
      id: currency.id,
      issuer: currency.issuer,
      name: currency.name,
      symbol: currency.symbol,
      supplyRule: currency.supplyRule,
      issuedSupply: currency.issuedSupply,
      transferRule: currency.transferRule,
      governance: currency.governance,
      description: currency.description,
      holdings,
    });
  }

  return { announcements, contracts, organisations, currencies };
}
