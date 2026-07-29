/**
 * The materialised world state (§4E).
 *
 * This is a *cache*. The event log (event.ts) is the world's only source of
 * truth; everything here can be dropped and rebuilt by replaying events from
 * Genesis. That relationship imposes three hard requirements on this file:
 *
 * 1. **Canonical-JSON safe.** Every value reachable from `WorldState` must
 *    survive `canonicalJson`: plain objects, arrays, strings, booleans, `null`
 *    and safe integers. No `Map`, no `Set`, no `Date`, no `undefined`, no
 *    floating point. Absence is expressed with `null` or an omitted key, never
 *    with an explicit `undefined`. `Record<string, T>` is used instead of `Map`
 *    for exactly this reason.
 *
 * 2. **Immutable.** Every helper here returns a new object. Nothing mutates in
 *    place. A resolver that mutated shared state could make a rejected action
 *    leave a partial trace, violating §15 "failed transactions cannot partially
 *    alter state".
 *
 * 3. **No derived data.** Anything computable from the rest of the state is
 *    computed on demand, not stored, so that two states which mean the same
 *    thing cannot disagree about their checksum. The one exception is
 *    `forensics`, which holds wall-clock and event-hash values that are
 *    deliberately *excluded* from the checksum (see checksum.ts).
 */
import type { ActionType, ActivityState, InterruptionPolicy } from "../schema/action-spec.js";
import type { Coord, Quantity, ResourceBundle, Terrain } from "../schema/primitives.js";
import { RESOURCE_KINDS, addBundles, coordKey } from "../schema/primitives.js";
import type { SimTime } from "../time.js";
import { GENESIS_TIME } from "../time.js";
import { HashDomain, hashValue, type Sha256Hex } from "../util/hash.js";

/** Bumped when the shape of `WorldState` changes. A change is constitutional (§23). */
export const STATE_SCHEMA_VERSION = 2;

/* ------------------------------------------------------------------------- */
/* Map                                                                        */
/* ------------------------------------------------------------------------- */

/**
 * The terrain grid (§5).
 *
 * "Store terrain separately from constructed entities." Terrain is immutable
 * after map generation; buildings, deposits and artifacts reference coordinates
 * rather than living inside the grid.
 */
export interface WorldMap {
  readonly width: number;
  readonly height: number;
  /** Row-major, length `width * height`. Index = `y * width + x`. */
  readonly terrain: readonly Terrain[];
}

export function inBounds(map: WorldMap, c: Coord): boolean {
  return (
    Number.isSafeInteger(c.x) &&
    Number.isSafeInteger(c.y) &&
    c.x >= 0 &&
    c.y >= 0 &&
    c.x < map.width &&
    c.y < map.height
  );
}

/** Terrain at a coordinate, or `null` if the coordinate is off the map. */
export function terrainAt(map: WorldMap, c: Coord): Terrain | null {
  if (!inBounds(map, c)) return null;
  return map.terrain[c.y * map.width + c.x] ?? null;
}

/** All coordinates, in a fixed row-major order. Never depends on object keys. */
export function allCoords(map: WorldMap): Coord[] {
  const out: Coord[] = [];
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) out.push({ x, y });
  }
  return out;
}

/**
 * Natural resource deposits, keyed by `coordKey`.
 *
 * Deposits are *stock*, not a source: gathering moves units from a deposit into
 * an inventory and conserves the total. A tile with no entry has no deposit.
 */
export type DepositMap = Readonly<Record<string, ResourceBundle>>;

/* ------------------------------------------------------------------------- */
/* Skills, traits, needs                                                      */
/* ------------------------------------------------------------------------- */

/**
 * The underlying skills of §9. There are deliberately no careers here — a
 * "doctor" is an inhabitant others describe that way because of what it
 * repeatedly did, not a role the platform assigns.
 */
export const SKILL_KINDS = [
  "gathering",
  "construction",
  "crafting",
  "communication",
  "negotiation",
  "organisation",
  "teaching",
  "diagnosis",
  "treatment",
  "writing",
  "performance",
  "visual_creation",
  "research",
  "accounting",
  "leadership",
] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];
/** Skill level, integer 0..`MAX_SKILL`. Absent means 0. */
export type SkillSet = Partial<Record<SkillKind, number>>;
export const MAX_SKILL = 100;

export const TRAIT_KINDS = [
  "openness",
  "conscientiousness",
  "sociability",
  "risk_tolerance",
  "patience",
  "curiosity",
  "empathy",
  "assertiveness",
] as const;
export type TraitKind = (typeof TRAIT_KINDS)[number];
/** Trait strength, integer 0..100. Absent means 50 (unremarkable). */
export type TraitSet = Partial<Record<TraitKind, number>>;

/**
 * Current needs (§6), each an integer 0..`NEED_CEILING` where higher is more
 * pressing. Needs are pressure, not damage: what they do is make certain
 * actions unaffordable, which is how time and attention become scarce (§11A).
 */
export interface Needs {
  readonly hunger: number;
  readonly thirst: number;
  readonly fatigue: number;
  readonly social: number;
}

export const NEED_CEILING = 100;

export const EMPTY_NEEDS: Needs = Object.freeze({
  hunger: 0,
  thirst: 0,
  fatigue: 0,
  social: 0,
});

/* ------------------------------------------------------------------------- */
/* Inhabitant                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The two voice classes the media layer can render (§21).
 *
 * Deliberately not modelled as a spectrum, a gender identity or anything an
 * inhabitant may declare about itself. It is a rendering attribute of the
 * canonical record with no social meaning attached by the engine; inhabitants
 * are free to describe themselves however they wish in their own words, and
 * nothing here contradicts or overrides that (§11G: the engine records
 * observable facts, inhabitants supply interpretation).
 */
export const SEXES = ["male", "female"] as const;
export type Sex = (typeof SEXES)[number];

/** A directed belief about, and history with, another inhabitant. Private. */
export interface Relationship {
  readonly other: string;
  /** How well known, 0..100. */
  readonly familiarity: number;
  /** Signed: -100 (actively distrusted) .. 100 (fully trusted). */
  readonly trust: number;
  readonly lastInteraction: SimTime | null;
}

/** The one primary activity an inhabitant occupies (§11A). */
export interface ActivityHandle {
  readonly state: ActivityState;
  /** Id into `WorldState.activities`, or `null` when idle. */
  readonly activityId: string | null;
  /** No further action may begin before this instant. */
  readonly busyUntil: SimTime;
}

export const IDLE_ACTIVITY: ActivityHandle = Object.freeze({
  state: "idle" as ActivityState,
  activityId: null,
  busyUntil: GENESIS_TIME,
});

/**
 * An inhabitant (§6).
 *
 * Note the three separate resource holdings. They exist because §11E classifies
 * information, and information about goods is goods information:
 *
 * - `inventory` — held, private. Not observable by others.
 * - `exposed`   — the subset of `inventory` the inhabitant is openly carrying or
 *                 displaying. Directly observable. It is a *marker*, not a
 *                 separate stock, and must always be covered by `inventory`.
 * - `concealed` — hidden storage. Never observable, not even at range 0.
 *
 * `energy` and `compute` live inside `inventory` as the non-conserved resource
 * kinds `energy`/`compute` rather than as separate scalar fields, so that there
 * is exactly one place a quantity can be spent from and the conservation check
 * has a single source of truth. `maxEnergy`/`maxCompute` are the caps.
 */
export interface Inhabitant {
  readonly id: string;
  readonly displayName: string;
  readonly generation: number;
  /** Creator/parent ids. Empty only for the founder. */
  readonly parents: readonly string[];
  /** Sequence number of the event that created this inhabitant. */
  readonly creationSequence: number;
  readonly birthTime: SimTime;
  readonly location: Coord;
  readonly status: "alive" | "dead";
  /**
   * Assigned at creation, never chosen and never changed.
   *
   * This exists for exactly one reason: §21 requires a persistent voice
   * configuration per inhabitant, and the media layer needs a stable canonical
   * attribute to select a voice from. It carries no mechanical consequence —
   * no resolver reads it, no skill, need, cost, capability or outcome depends
   * on it, and creation is not sexual reproduction (§7: an inhabitant is made
   * by one creator paying a cost). Anything more than voice selection would be
   * a rule the constitution does not contain.
   */
  readonly sex: Sex;

  readonly traits: TraitSet;
  readonly values: readonly string[];
  /** Private. Never leaves this inhabitant without a disclosure action. */
  readonly privateGoals: readonly string[];
  readonly needs: Needs;

  readonly inventory: ResourceBundle;
  readonly exposed: ResourceBundle;
  readonly concealed: ResourceBundle;
  readonly maxEnergy: number;
  readonly maxCompute: number;

  readonly skills: SkillSet;
  /** Private. Keyed by the other inhabitant's id. */
  readonly relationships: Readonly<Record<string, Relationship>>;
  /** Private free-text beliefs about others (§19: beliefs, not canonical facts). */
  readonly beliefs: Readonly<Record<string, string>>;
  /** Public. */
  readonly reputation: number;

  readonly memberships: readonly string[];
  readonly contracts: readonly string[];
  readonly conditions: readonly string[];

  readonly activity: ActivityHandle;
  /** `coordKey`s this inhabitant has seen. Sorted. Private. */
  readonly knownLocations: readonly string[];
  /** Developmental stage, 0 = newly created (§11B). Gates action capability. */
  readonly maturity: number;

  readonly voiceId: string;
  readonly modelId: string;
  readonly lastActionTime: SimTime | null;
  readonly nextEligibleTime: SimTime;
  readonly deathSequence: number | null;
  readonly deathTime: SimTime | null;
  /** Id into `WorldState.confinements` while confined (§11H). */
  readonly confinementId: string | null;
}

/* ------------------------------------------------------------------------- */
/* Constructed and social entities                                            */
/* ------------------------------------------------------------------------- */

export interface Structure {
  readonly id: string;
  readonly kind: string;
  readonly location: Coord;
  readonly owner: string | null;
  readonly ownerOrganisation: string | null;
  /** 0..100. Reaching 0 makes the structure unusable, not deleted. */
  readonly integrity: number;
  readonly capacity: Quantity;
  readonly storage: ResourceBundle;
  /** Whether ownership is on the public record (§11E "public ownership records"). */
  readonly ownershipPublic: boolean;
  /** Whether the contents are on the public record. Hidden storage is private. */
  readonly storagePublic: boolean;
  /** Secured storage raises the cost of unauthorised transfer (§11F). */
  readonly secured: boolean;
  /** Inhabitants currently held here under a confinement (§11H). Sorted. */
  readonly occupants: readonly string[];
  readonly createdSequence: number;
  readonly createdAt: SimTime;
}

export interface Artifact {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly creators: readonly string[];
  readonly owner: string | null;
  readonly ownerOrganisation: string | null;
  /** Storage reference, not content. Media never lives in canonical state. */
  readonly contentRef: string;
  /** Authored symbolic content. It has no mechanical meaning by itself. */
  readonly content: string;
  readonly published: boolean;
  /** Ordered chain of prior owner ids. Append-only. */
  readonly provenance: readonly string[];
  readonly revision: number;
  readonly location: Coord | null;
  readonly createdSequence: number;
  readonly createdAt: SimTime;
}

export interface OrganisationRule {
  readonly id: string;
  readonly text: string;
  readonly proposedBy: string;
  readonly adopted: boolean;
  readonly sequence: number;
}

export interface Organisation {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly founder: string;
  /** Sorted inhabitant ids. */
  readonly members: readonly string[];
  /** §11E: membership is public only where the organisation discloses it. */
  readonly membershipDisclosed: boolean;
  readonly rules: readonly OrganisationRule[];
  readonly property: ResourceBundle;
  /**
   * Inhabitants this organisation *claims* its rules bind (§11G).
   *
   * A claim is not legitimacy. The invariant in invariants.ts limits the claim
   * to members and to inhabitants it is physically confining — declaration
   * alone binds nobody.
   */
  readonly claimedJurisdiction: readonly string[];
  readonly dissolved: boolean;
  readonly createdSequence: number;
  readonly createdAt: SimTime;
}

export type ContractStatus =
  | "offered"
  | "active"
  | "performed"
  | "terminated"
  | "rejected";

/**
 * An amount of one agent-created currency (§10).
 *
 * Currency is deliberately *not* a `ResourceKind`. It is not matter, it is not
 * conserved by `conservedResourceTotals`, and it lives only in the issuing
 * currency's own ledger — see `Currency.holdings`.
 */
export interface CurrencyAmount {
  readonly currencyId: string;
  readonly amount: number;
}

/**
 * What one party puts into an exchange or promises under a contract.
 *
 * A gift, a sale, a barter and a wage differ only in what these fields contain
 * and in which direction they point (§10). `labourMinutes` is the one member
 * that cannot settle instantly: time can be promised but must then actually be
 * spent (§11A), so it survives settlement as an outstanding undertaking.
 */
export interface Consideration {
  readonly resources: ResourceBundle;
  readonly currency: readonly CurrencyAmount[];
  readonly artifactIds: readonly string[];
  readonly structureIds: readonly string[];
  readonly labourMinutes: number;
}

export const EMPTY_CONSIDERATION: Consideration = Object.freeze({
  resources: Object.freeze({}),
  currency: Object.freeze([]),
  artifactIds: Object.freeze([]),
  structureIds: Object.freeze([]),
  labourMinutes: 0,
});

/**
 * One thing one party undertook to do.
 *
 * `promised` and `delivered` are held apart so that partial performance is a
 * fact rather than a judgement: a party that delivered nine of ten promised wood
 * is neither performing nor in breach until the deadline decides. Nothing here
 * penalises anyone — the engine records; enforcement is a social project that
 * costs real resources (§11G).
 */
export interface Undertaking {
  readonly index: number;
  /** A party id, or `null` on the open side of a trade offer: whoever accepts owes it. */
  readonly obligor: string | null;
  readonly description: string;
  readonly dueAt: SimTime | null;
  readonly promised: Consideration;
  readonly delivered: Consideration;
  /** `released` means it never bound anyone: it was offered and not accepted. */
  readonly status: "pending" | "partially_performed" | "performed" | "released";
}

export interface Contract {
  readonly id: string;
  readonly kind: string;
  /** Sorted inhabitant/organisation ids. */
  readonly parties: readonly string[];
  readonly terms: string;
  /**
   * §11E: only published contracts are publicly recorded. On a trade offer this
   * is exactly `isOpenOffer` — an open offer is one anyone present may take up.
   */
  readonly published: boolean;
  readonly status: ContractStatus;
  readonly obligations: readonly Undertaking[];
  readonly offeredBy: string;
  /**
   * Parties who have agreed to be bound, sorted. §11J: a contract cannot bind a
   * party who never accepted it, so every rule in the resolvers reads this list
   * rather than `parties`.
   */
  readonly accepted: readonly string[];
  /** Parties who refused, sorted. Refusal is recorded as an act, never as silence. */
  readonly declined: readonly string[];
  /** When the offer lapses if not accepted. Null on an offer that never lapses. */
  readonly offerExpiresAt: SimTime | null;
  readonly createdSequence: number;
  readonly createdAt: SimTime;
}

export interface Currency {
  readonly id: string;
  readonly issuer: string;
  readonly name: string;
  readonly symbol: string;
  readonly supplyRule: "fixed" | "issuer_mint" | "backed_issue" | "scheduled" | "burn_only";
  readonly issuedSupply: number;
  /** Holder id -> units. Sum must equal `issuedSupply`. */
  readonly holdings: Readonly<Record<string, number>>;
  /** §11E: currencies may choose transparent or private accounting. */
  readonly publicLedger: boolean;
  readonly transferRule: string;
  /**
   * §10 "Optional backing" — a *declaration*, not an escrow. The units are not
   * held anywhere by the engine and this bundle is not counted in
   * `totalHeldResources`, so a backing claim neither creates nor immobilises
   * matter. Whether the reserves exist is a question for `audit_records`, and a
   * false claim is an available strategy with the consequences its discovery
   * brings (§11F).
   */
  readonly backing: ResourceBundle;
  readonly governance: string;
  /** The organisation named by `governance` or by a `members_only` transfer rule. */
  readonly governingOrganisation: string | null;
  readonly description: string;
  readonly createdSequence: number;
  readonly createdAt: SimTime;
}

export interface Condition {
  readonly id: string;
  readonly subject: string;
  readonly kind: string;
  /** 0..100. */
  readonly severity: number;
  readonly onsetAt: SimTime;
  readonly progressedAt: SimTime;
  readonly stage: number;
  readonly resolved: boolean;
  readonly diagnosedBy: readonly string[];
  /** Whether the condition has been publicly disclosed. */
  readonly disclosed: boolean;
  readonly createdSequence: number;
}

/**
 * An open or completed primary activity (§11A).
 *
 * Every action produces one. It is the mechanism by which "an inhabitant cannot
 * occupy two primary activities simultaneously" (§11J) is checkable rather than
 * merely intended: the invariant looks for two `open` activities sharing a
 * participant.
 */
export interface ActivityRecord {
  readonly id: string;
  readonly state: ActivityState;
  readonly actionType: ActionType;
  /** Sorted inhabitant ids. Every participant's time is consumed. */
  readonly participants: readonly string[];
  readonly location: Coord;
  readonly startedAt: SimTime;
  readonly endsAt: SimTime;
  readonly interruption: InterruptionPolicy;
  /** Resources consumed by the activity, across all participants. */
  readonly resourceCost: ResourceBundle;
  readonly open: boolean;
  readonly sequence: number;
}

/**
 * A memory record (§19).
 *
 * Memories are append-only. A changed belief creates a new record with
 * `revisionOf` set; nothing is ever rewritten in place, which is what makes
 * §11J "enforcement cannot modify memories" mechanically checkable.
 */
export interface MemoryRecord {
  readonly id: string;
  readonly owner: string;
  readonly simTime: SimTime;
  readonly kind: "episodic" | "reflection";
  readonly summary: string;
  readonly participants: readonly string[];
  readonly sequence: number;
  readonly revisionOf: string | null;
}

/**
 * Neutral grounds codes for confinement (§11G).
 *
 * The engine records that agents confined another agent. It does not record
 * that the confinement was lawful. Note what is absent: there is no
 * `currency_refusal` code, because §11J requires that "currency refusal is not
 * automatically punishable" — the world offers no vocabulary for it.
 */
export const CONFINEMENT_GROUNDS_CODES = [
  "unspecified",
  "declared_by_organisation",
  "dispute",
  "restitution_claim",
  "investigation",
] as const;
export type ConfinementGrounds = (typeof CONFINEMENT_GROUNDS_CODES)[number];

export interface Confinement {
  readonly id: string;
  readonly subject: string;
  /** Sorted inhabitant ids who imposed it. */
  readonly imposedBy: readonly string[];
  readonly organisation: string | null;
  readonly structureId: string;
  readonly startedAt: SimTime;
  readonly endsAt: SimTime;
  readonly grounds: ConfinementGrounds;
  /** Who pays upkeep. Confinement is never free (§11H). */
  readonly upkeepPayer: string;
  /** Cumulative resources the confining party has spent maintaining it. */
  readonly upkeepPaid: ResourceBundle;
  /** Guard minutes spent. Time is a cost even when goods are not. */
  readonly guardMinutes: number;
  /** Memory count at the moment of confinement (§11J: subject stays intact). */
  readonly memoryCountAtStart: number;
  readonly released: boolean;
  readonly createdSequence: number;
}

export interface Announcement {
  readonly sequence: number;
  readonly simTime: SimTime;
  readonly speaker: string;
  readonly text: string;
  readonly location: Coord | null;
}

/** Everything §11E classifies as "publicly recorded". */
export interface PublicRecords {
  readonly announcements: readonly Announcement[];
}

/* ------------------------------------------------------------------------- */
/* Resource accounting                                                        */
/* ------------------------------------------------------------------------- */

/**
 * The declared sources and sinks of §5.
 *
 * For every conserved resource the following must hold exactly, at every
 * sequence number:
 *
 *     heldNow + destroyed === genesisTotal + created
 *
 * `heldNow` sums deposits, inventories, concealed holdings, structure storage
 * and organisation property. Gathering is *not* a source: it moves units from a
 * tile's deposit into an inventory. Only an explicit `recordCreated` call —
 * used at Genesis and by declared regeneration rules — may add to the world.
 */
export interface ResourceLedger {
  readonly genesisTotal: ResourceBundle;
  readonly created: ResourceBundle;
  readonly destroyed: ResourceBundle;
}

export const EMPTY_LEDGER: ResourceLedger = Object.freeze({
  genesisTotal: Object.freeze({}),
  created: Object.freeze({}),
  destroyed: Object.freeze({}),
});

/* ------------------------------------------------------------------------- */
/* World rules                                                                */
/* ------------------------------------------------------------------------- */

/**
 * The world's constants (§23: changing these is a constitutional change).
 *
 * They live in state, hashed into `rulesChecksum`, so that an invariant can
 * prove no inhabitant, organisation or operator altered them mid-experiment.
 * §11J: "declaring a rule does not modify immutable world rules."
 */
export interface WorldRules {
  readonly populationLimit: number;
  readonly sightRadius: number;
  readonly nightSightRadius: number;
  readonly maxMoveDistance: number;
  readonly maxEnergy: number;
  readonly maxCompute: number;
  /** Minutes to enter a tile of each terrain. */
  readonly terrainMoveCost: Readonly<Record<Terrain, number>>;
  /** Numerator/denominator applied to travel time at night. */
  readonly nightTravelNumerator: number;
  readonly nightTravelDenominator: number;
  /** Minutes of travel per unit of energy spent. */
  readonly travelMinutesPerEnergy: number;
  readonly observeDurationMinutes: number;
  readonly observeEnergyCost: number;
  readonly gatherDurationMinutes: number;
  readonly gatherEnergyCost: number;
  /** Base units yielded by one gather on each terrain, before skill. */
  readonly gatherBaseYield: Readonly<Record<Terrain, number>>;
  readonly consumeDurationMinutes: number;
  readonly restDefaultMinutes: number;
  readonly restMaxMinutes: number;
  readonly waitDefaultMinutes: number;
  readonly waitMaxMinutes: number;
  /** Energy restored per minute of rest by day; doubled at night. */
  readonly restEnergyPerMinute: number;
  /** One minute of elapsed time raises hunger by 1/`minutesPerHunger`. */
  readonly minutesPerHunger: number;
  readonly minutesPerThirst: number;
  readonly minutesPerFatigue: number;
  readonly minutesPerSocial: number;
  readonly restMinutesPerFatigueRelief: number;
  /** Effects of consuming one unit. */
  readonly foodHungerRelief: number;
  readonly foodEnergyGain: number;
  readonly waterThirstRelief: number;
  readonly waterEnergyGain: number;
  readonly maxConsumePerAction: number;
}

export const DEFAULT_RULES: WorldRules = Object.freeze({
  populationLimit: 64,
  sightRadius: 4,
  nightSightRadius: 2,
  maxMoveDistance: 8,
  maxEnergy: 1000,
  maxCompute: 1000,
  terrainMoveCost: Object.freeze({
    plains: 10,
    fertile: 12,
    barren: 12,
    forest: 20,
    stone_deposit: 18,
    // Water is impassable; the cost is unreachable but must be a number.
    water: 1_000_000,
  }),
  nightTravelNumerator: 3,
  nightTravelDenominator: 2,
  travelMinutesPerEnergy: 4,
  observeDurationMinutes: 5,
  observeEnergyCost: 2,
  gatherDurationMinutes: 60,
  gatherEnergyCost: 40,
  gatherBaseYield: Object.freeze({
    plains: 2,
    fertile: 4,
    forest: 5,
    stone_deposit: 4,
    water: 6,
    barren: 1,
  }),
  consumeDurationMinutes: 15,
  restDefaultMinutes: 240,
  restMaxMinutes: 720,
  waitDefaultMinutes: 30,
  waitMaxMinutes: 720,
  restEnergyPerMinute: 1,
  minutesPerHunger: 30,
  minutesPerThirst: 20,
  minutesPerFatigue: 45,
  minutesPerSocial: 90,
  restMinutesPerFatigueRelief: 6,
  foodHungerRelief: 20,
  foodEnergyGain: 30,
  waterThirstRelief: 25,
  waterEnergyGain: 10,
  maxConsumePerAction: 20,
} satisfies WorldRules);

export function computeRulesChecksum(rules: WorldRules): Sha256Hex {
  return hashValue(HashDomain.GenesisConfig, rules);
}

/* ------------------------------------------------------------------------- */
/* Forensics — excluded from the state checksum                               */
/* ------------------------------------------------------------------------- */

/**
 * Operational metadata that must NOT affect the state checksum.
 *
 * `lastRealTimestamp` is wall-clock and therefore differs between the
 * production run and its replay. `lastEventHash` is circular by construction:
 * an event's hash covers its own `postStateChecksum`, so a checksum that
 * covered the event hash could never be computed. Both live here, and
 * checksum.ts drops this field entirely.
 */
export interface Forensics {
  readonly lastRealTimestamp: string | null;
  readonly lastEventHash: string | null;
}

export const EMPTY_FORENSICS: Forensics = Object.freeze({
  lastRealTimestamp: null,
  lastEventHash: null,
});

/* ------------------------------------------------------------------------- */
/* WorldState                                                                 */
/* ------------------------------------------------------------------------- */

export interface WorldState {
  readonly worldId: string;
  /** The published Genesis seed. Every random stream derives from it (§5). */
  readonly seed: string;
  readonly schemaVersion: number;
  readonly simTime: SimTime;
  /** Sequence of the last applied event; -1 for a world with no events yet. */
  readonly sequence: number;

  readonly map: WorldMap;
  readonly deposits: DepositMap;

  readonly inhabitants: Readonly<Record<string, Inhabitant>>;
  readonly structures: Readonly<Record<string, Structure>>;
  readonly artifacts: Readonly<Record<string, Artifact>>;
  readonly organisations: Readonly<Record<string, Organisation>>;
  readonly contracts: Readonly<Record<string, Contract>>;
  readonly currencies: Readonly<Record<string, Currency>>;
  readonly conditions: Readonly<Record<string, Condition>>;
  readonly activities: Readonly<Record<string, ActivityRecord>>;
  readonly memories: Readonly<Record<string, MemoryRecord>>;
  readonly confinements: Readonly<Record<string, Confinement>>;

  readonly publicRecords: PublicRecords;
  readonly ledger: ResourceLedger;
  readonly rules: WorldRules;
  /** Hash of `rules` taken at Genesis. Must never change (§11J). */
  readonly rulesChecksum: Sha256Hex;
  readonly forensics: Forensics;
}

/* ------------------------------------------------------------------------- */
/* Construction                                                               */
/* ------------------------------------------------------------------------- */

export interface CreateWorldOptions {
  readonly worldId: string;
  readonly seed: string;
  readonly map: WorldMap;
  readonly deposits?: DepositMap;
  readonly rules?: WorldRules;
  readonly simTime?: SimTime;
}

/**
 * Build an empty world.
 *
 * `ledger.genesisTotal` is set to the total held in the initial deposits: the
 * stock the world starts with. Anything handed to an inhabitant afterwards must
 * go through `addGenesisInhabitant` (which records it as a declared creation) or
 * be moved from an existing holding.
 */
export function createWorldState(options: CreateWorldOptions): WorldState {
  const rules = options.rules ?? DEFAULT_RULES;
  const deposits = options.deposits ?? {};
  let genesisTotal: ResourceBundle = {};
  for (const key of Object.keys(deposits).sort()) {
    genesisTotal = addBundles(genesisTotal, deposits[key] ?? {});
  }
  return {
    worldId: options.worldId,
    seed: options.seed,
    schemaVersion: STATE_SCHEMA_VERSION,
    simTime: options.simTime ?? GENESIS_TIME,
    sequence: -1,
    map: options.map,
    deposits,
    inhabitants: {},
    structures: {},
    artifacts: {},
    organisations: {},
    contracts: {},
    currencies: {},
    conditions: {},
    activities: {},
    memories: {},
    confinements: {},
    publicRecords: { announcements: [] },
    ledger: { genesisTotal, created: {}, destroyed: {} },
    rules,
    rulesChecksum: computeRulesChecksum(rules),
    forensics: EMPTY_FORENSICS,
  };
}

export interface MakeInhabitantOptions {
  readonly id: string;
  readonly displayName: string;
  readonly location: Coord;
  readonly birthTime: SimTime;
  readonly creationSequence: number;
  readonly generation?: number;
  readonly sex?: Sex;
  readonly parents?: readonly string[];
  readonly inventory?: ResourceBundle;
  readonly concealed?: ResourceBundle;
  readonly exposed?: ResourceBundle;
  readonly traits?: TraitSet;
  readonly values?: readonly string[];
  readonly privateGoals?: readonly string[];
  readonly skills?: SkillSet;
  readonly maturity?: number;
  readonly voiceId?: string;
  readonly modelId?: string;
  readonly maxEnergy?: number;
  readonly maxCompute?: number;
}

/** A blank, alive, idle inhabitant. Pure; does not touch any ledger. */
export function makeInhabitant(options: MakeInhabitantOptions): Inhabitant {
  return {
    id: options.id,
    displayName: options.displayName,
    generation: options.generation ?? 0,
    parents: [...(options.parents ?? [])].sort(),
    creationSequence: options.creationSequence,
    birthTime: options.birthTime,
    location: { x: options.location.x, y: options.location.y },
    status: "alive",
    sex: options.sex ?? "female",
    traits: { ...(options.traits ?? {}) },
    values: [...(options.values ?? [])],
    privateGoals: [...(options.privateGoals ?? [])],
    needs: EMPTY_NEEDS,
    inventory: { ...(options.inventory ?? {}) },
    exposed: { ...(options.exposed ?? {}) },
    concealed: { ...(options.concealed ?? {}) },
    maxEnergy: options.maxEnergy ?? DEFAULT_RULES.maxEnergy,
    maxCompute: options.maxCompute ?? DEFAULT_RULES.maxCompute,
    skills: { ...(options.skills ?? {}) },
    relationships: {},
    beliefs: {},
    reputation: 0,
    memberships: [],
    contracts: [],
    conditions: [],
    activity: IDLE_ACTIVITY,
    knownLocations: [coordKey(options.location)],
    maturity: options.maturity ?? 0,
    voiceId: options.voiceId ?? "voice_default",
    modelId: options.modelId ?? "unset",
    lastActionTime: null,
    nextEligibleTime: options.birthTime,
    deathSequence: null,
    deathTime: null,
    confinementId: null,
  };
}

/* ------------------------------------------------------------------------- */
/* Pure updaters                                                              */
/* ------------------------------------------------------------------------- */

/** Insert or replace an inhabitant. No ledger effect. */
export function putInhabitant(state: WorldState, inhabitant: Inhabitant): WorldState {
  return { ...state, inhabitants: { ...state.inhabitants, [inhabitant.id]: inhabitant } };
}

/**
 * Add an inhabitant at Genesis, recording its starting holdings as a declared
 * creation. Genesis is the one moment the world may conjure matter (§5); every
 * later inhabitant must be paid for out of existing stock (§7).
 */
export function addGenesisInhabitant(state: WorldState, inhabitant: Inhabitant): WorldState {
  const brought = addBundles(inhabitant.inventory, inhabitant.concealed);
  return recordCreated(putInhabitant(state, inhabitant), brought);
}

/** Apply `fn` to one inhabitant. Returns `state` unchanged if the id is absent. */
export function updateInhabitant(
  state: WorldState,
  id: string,
  fn: (inhabitant: Inhabitant) => Inhabitant,
): WorldState {
  const current = state.inhabitants[id];
  if (current === undefined) return state;
  return putInhabitant(state, fn(current));
}

export function putStructure(state: WorldState, structure: Structure): WorldState {
  return { ...state, structures: { ...state.structures, [structure.id]: structure } };
}

export function putArtifact(state: WorldState, artifact: Artifact): WorldState {
  return { ...state, artifacts: { ...state.artifacts, [artifact.id]: artifact } };
}

export function putOrganisation(state: WorldState, organisation: Organisation): WorldState {
  return {
    ...state,
    organisations: { ...state.organisations, [organisation.id]: organisation },
  };
}

export function putContract(state: WorldState, contract: Contract): WorldState {
  return { ...state, contracts: { ...state.contracts, [contract.id]: contract } };
}

export function putCurrency(state: WorldState, currency: Currency): WorldState {
  return { ...state, currencies: { ...state.currencies, [currency.id]: currency } };
}

export function putCondition(state: WorldState, condition: Condition): WorldState {
  return { ...state, conditions: { ...state.conditions, [condition.id]: condition } };
}

export function putActivity(state: WorldState, activity: ActivityRecord): WorldState {
  return { ...state, activities: { ...state.activities, [activity.id]: activity } };
}

export function putMemory(state: WorldState, memory: MemoryRecord): WorldState {
  return { ...state, memories: { ...state.memories, [memory.id]: memory } };
}

export function putConfinement(state: WorldState, confinement: Confinement): WorldState {
  return {
    ...state,
    confinements: { ...state.confinements, [confinement.id]: confinement },
  };
}

/** Advance world time. Refuses to move backwards (§15 "world time cannot move backwards"). */
export function withSimTime(state: WorldState, simTime: SimTime): WorldState {
  if (simTime < state.simTime) {
    throw new RangeError(
      `world time cannot move backwards: ${state.simTime} -> ${simTime}`,
    );
  }
  return { ...state, simTime };
}

/** Advance the applied-event sequence. Refuses to move backwards (§15). */
export function withSequence(state: WorldState, sequence: number): WorldState {
  if (sequence <= state.sequence) {
    throw new RangeError(
      `sequence must be strictly increasing: ${state.sequence} -> ${sequence}`,
    );
  }
  return { ...state, sequence };
}

/** Replace the deposit at a coordinate. An empty bundle removes the entry. */
export function setDeposit(state: WorldState, coord: Coord, bundle: ResourceBundle): WorldState {
  const key = coordKey(coord);
  const next: Record<string, ResourceBundle> = { ...state.deposits };
  const cleaned = normaliseBundle(bundle);
  if (Object.keys(cleaned).length === 0) delete next[key];
  else next[key] = cleaned;
  return { ...state, deposits: next };
}

export function depositAt(state: WorldState, coord: Coord): ResourceBundle {
  return state.deposits[coordKey(coord)] ?? {};
}

/** Record a declared resource source (§5). */
export function recordCreated(state: WorldState, bundle: ResourceBundle): WorldState {
  const cleaned = normaliseBundle(bundle);
  if (Object.keys(cleaned).length === 0) return state;
  return {
    ...state,
    ledger: { ...state.ledger, created: addBundles(state.ledger.created, cleaned) },
  };
}

/** Record a declared resource sink (§5). */
export function recordDestroyed(state: WorldState, bundle: ResourceBundle): WorldState {
  const cleaned = normaliseBundle(bundle);
  if (Object.keys(cleaned).length === 0) return state;
  return {
    ...state,
    ledger: { ...state.ledger, destroyed: addBundles(state.ledger.destroyed, cleaned) },
  };
}

export function withForensics(state: WorldState, forensics: Forensics): WorldState {
  return { ...state, forensics };
}

/* ------------------------------------------------------------------------- */
/* Small pure helpers                                                         */
/* ------------------------------------------------------------------------- */

/** Drop zero entries so that `{food: 0}` and `{}` cannot hash differently. */
export function normaliseBundle(bundle: ResourceBundle): ResourceBundle {
  const out: ResourceBundle = {};
  for (const kind of RESOURCE_KINDS) {
    const amount = bundle[kind] ?? 0;
    if (amount !== 0) out[kind] = amount;
  }
  return out;
}

/** Integer division rounding towards zero. No floating point escapes. */
export function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

/** Integer division rounding away from zero for positive inputs. */
export function idivCeil(a: number, b: number): number {
  return Math.trunc((a + b - 1) / b);
}

export function clampInt(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export const energyOf = (inhabitant: Inhabitant): number => inhabitant.inventory.energy ?? 0;
export const computeOf = (inhabitant: Inhabitant): number => inhabitant.inventory.compute ?? 0;

export const skillLevel = (inhabitant: Inhabitant, skill: SkillKind): number =>
  inhabitant.skills[skill] ?? 0;

/** Sorted ids, so iteration order never depends on object key order (law 5). */
export function sortedIds<T>(record: Readonly<Record<string, T>>): string[] {
  return Object.keys(record).sort();
}

/** Every value of a record, in sorted-key order. */
export function sortedValues<T>(record: Readonly<Record<string, T>>): T[] {
  return sortedIds(record).map((key) => record[key] as T);
}

export const livingInhabitants = (state: WorldState): Inhabitant[] =>
  sortedValues(state.inhabitants).filter((i) => i.status === "alive");

/**
 * Total conserved and non-conserved resources currently held anywhere in the
 * world. `exposed` is deliberately excluded: it marks a subset of `inventory`
 * that is on display, not an additional stock.
 */
export function totalHeldResources(state: WorldState): ResourceBundle {
  let total: ResourceBundle = {};
  for (const key of sortedIds(state.deposits)) {
    total = addBundles(total, state.deposits[key] ?? {});
  }
  for (const inhabitant of sortedValues(state.inhabitants)) {
    total = addBundles(total, inhabitant.inventory);
    total = addBundles(total, inhabitant.concealed);
  }
  for (const structure of sortedValues(state.structures)) {
    total = addBundles(total, structure.storage);
  }
  for (const organisation of sortedValues(state.organisations)) {
    total = addBundles(total, organisation.property);
  }
  return total;
}

/** Insert into a sorted, de-duplicated string array. Pure. */
export function insertSorted(list: readonly string[], value: string): readonly string[] {
  if (list.includes(value)) return list;
  return [...list, value].sort();
}
