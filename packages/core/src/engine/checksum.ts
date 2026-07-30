/**
 * The state checksum (§14.3, §14.16, §15, §16).
 *
 * Every canonical event records the checksum before and after it was applied.
 * The replay service rebuilds the world from Genesis and compares its checksum
 * with production's; §28 makes that match a launch requirement. So this function
 * is the single point where "the same world" is defined.
 *
 * Two rules govern the projection below, and both exist because a checksum that
 * disagrees with itself is worse than no checksum at all:
 *
 * 1. **Order must not matter where order has no meaning.** `canonicalJson`
 *    already sorts object keys, so two states that inserted inhabitants in
 *    different orders hash the same. But it does *not* sort arrays, because
 *    array order is usually meaningful. Any array here whose order is
 *    incidental — member lists, participant lists, known locations — is sorted
 *    explicitly. Arrays whose order *is* meaning (the terrain grid, provenance
 *    chains, announcements) are left alone.
 *
 * 2. **Non-deterministic and circular fields must be excluded.** `forensics`
 *    carries the wall-clock timestamp of the last applied event and the last
 *    event hash. The first differs between a production run and its replay by
 *    construction; the second is circular, since an event's hash covers the
 *    post-state checksum it would then be part of. Both are dropped.
 *
 * CONSTITUTIONAL: changing this projection changes every checksum in the world.
 */
import { RESOURCE_KINDS, type ResourceBundle } from "../schema/primitives.js";
import { HashDomain, hashValue, type Sha256Hex } from "../util/hash.js";
import type {
  ActivityRecord,
  Artifact,
  Condition,
  Confinement,
  Consideration,
  Contract,
  Currency,
  Inhabitant,
  MemoryRecord,
  Organisation,
  ResourceLedger,
  Structure,
  WorldState,
} from "./state.js";
import { sortedIds } from "./state.js";

/** A value that is guaranteed encodable by `canonicalJson`. */
type Normal = null | boolean | number | string | Normal[] | { [key: string]: Normal };

const sortedCopy = (values: readonly string[]): string[] => [...values].sort();

/** Bundles are normalised so `{food: 0}` and `{}` cannot hash differently. */
function bundle(input: ResourceBundle): Normal {
  const out: Record<string, Normal> = {};
  for (const kind of RESOURCE_KINDS) {
    const amount = input[kind] ?? 0;
    if (amount !== 0) out[kind] = amount;
  }
  return out;
}

function record<T>(input: Readonly<Record<string, T>>, project: (value: T) => Normal): Normal {
  const out: Record<string, Normal> = {};
  // Explicit sort: the projection must not depend on insertion order even
  // though canonicalJson would sort anyway. Belt and braces (law 5).
  for (const key of sortedIds(input)) out[key] = project(input[key] as T);
  return out;
}

function numberRecord(input: Readonly<Record<string, number>>): Normal {
  const out: Record<string, Normal> = {};
  for (const key of sortedIds(input)) out[key] = input[key] as number;
  return out;
}

function stringRecord(input: Readonly<Record<string, string>>): Normal {
  const out: Record<string, Normal> = {};
  for (const key of sortedIds(input)) out[key] = input[key] as string;
  return out;
}

function inhabitant(i: Inhabitant): Normal {
  return {
    id: i.id,
    displayName: i.displayName,
    generation: i.generation,
    parents: sortedCopy(i.parents),
    creationSequence: i.creationSequence,
    birthTime: i.birthTime,
    location: { x: i.location.x, y: i.location.y },
    status: i.status,
    sex: i.sex,
    traits: numberRecord(i.traits as Readonly<Record<string, number>>),
    // `values` and `privateGoals` are ordered by the inhabitant's own
    // priority, so their order is meaning and is preserved.
    values: [...i.values],
    privateGoals: [...i.privateGoals],
    needs: {
      hunger: i.needs.hunger,
      thirst: i.needs.thirst,
      fatigue: i.needs.fatigue,
      social: i.needs.social,
    },
    inventory: bundle(i.inventory),
    exposed: bundle(i.exposed),
    concealed: bundle(i.concealed),
    maxEnergy: i.maxEnergy,
    maxCompute: i.maxCompute,
    skills: numberRecord(i.skills as Readonly<Record<string, number>>),
    relationships: record(i.relationships, (r) => ({
      other: r.other,
      familiarity: r.familiarity,
      trust: r.trust,
      lastInteraction: r.lastInteraction,
    })),
    beliefs: stringRecord(i.beliefs),
    reputation: i.reputation,
    memberships: sortedCopy(i.memberships),
    contracts: sortedCopy(i.contracts),
    conditions: sortedCopy(i.conditions),
    activity: {
      state: i.activity.state,
      activityId: i.activity.activityId,
      busyUntil: i.activity.busyUntil,
    },
    knownLocations: sortedCopy(i.knownLocations),
    maturity: i.maturity,
    voiceId: i.voiceId,
    modelId: i.modelId,
    lastActionTime: i.lastActionTime,
    nextEligibleTime: i.nextEligibleTime,
    deathSequence: i.deathSequence,
    deathTime: i.deathTime,
    confinementId: i.confinementId,
  };
}

function structure(s: Structure): Normal {
  return {
    id: s.id,
    kind: s.kind,
    location: { x: s.location.x, y: s.location.y },
    owner: s.owner,
    ownerOrganisation: s.ownerOrganisation,
    integrity: s.integrity,
    capacity: s.capacity,
    storage: bundle(s.storage),
    ownershipPublic: s.ownershipPublic,
    storagePublic: s.storagePublic,
    secured: s.secured,
    occupants: sortedCopy(s.occupants),
    createdSequence: s.createdSequence,
    createdAt: s.createdAt,
  };
}

function artifact(a: Artifact): Normal {
  return {
    id: a.id,
    title: a.title,
    kind: a.kind,
    creators: sortedCopy(a.creators),
    owner: a.owner,
    ownerOrganisation: a.ownerOrganisation,
    contentRef: a.contentRef,
    content: a.content,
    published: a.published,
    // Provenance is a chain: its order is the history and must not be sorted.
    provenance: [...a.provenance],
    revision: a.revision,
    location: a.location === null ? null : { x: a.location.x, y: a.location.y },
    createdSequence: a.createdSequence,
    createdAt: a.createdAt,
  };
}

function organisation(o: Organisation): Normal {
  return {
    id: o.id,
    name: o.name,
    kind: o.kind,
    founder: o.founder,
    purpose: o.purpose ?? null,
    charter: o.charter ?? "",
    membershipRule: o.membershipRule ?? "invitation",
    decisionRule: o.decisionRule ?? "founder",
    invited: sortedCopy(o.invited ?? []),
    members: sortedCopy(o.members),
    membershipDisclosed: o.membershipDisclosed,
    // Rules are ordered by adoption; sorted by id to remove insertion-order
    // dependence while keeping every rule distinguishable.
    rules: [...o.rules]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => ({
        id: r.id,
        title: r.title ?? "",
        text: r.text,
        proposedBy: r.proposedBy,
        adopted: r.adopted,
        votes: Object.fromEntries(
          Object.entries(r.votes ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
        sequence: r.sequence,
      })),
    property: bundle(o.property),
    claimedJurisdiction: sortedCopy(o.claimedJurisdiction),
    dissolved: o.dissolved,
    createdSequence: o.createdSequence,
    createdAt: o.createdAt,
  };
}

/** Currency amounts are ordered by currency id: the order carries no meaning. */
function consideration(c: Consideration): Normal {
  return {
    resources: bundle(c.resources),
    currency: [...c.currency]
      .sort((a, b) => (a.currencyId < b.currencyId ? -1 : a.currencyId > b.currencyId ? 1 : 0))
      .map((amount) => ({ currencyId: amount.currencyId, amount: amount.amount })),
    artifactIds: sortedCopy(c.artifactIds),
    structureIds: sortedCopy(c.structureIds),
    labourMinutes: c.labourMinutes,
  };
}

function contract(c: Contract): Normal {
  return {
    id: c.id,
    kind: c.kind,
    parties: sortedCopy(c.parties),
    terms: c.terms,
    published: c.published,
    status: c.status,
    // Undertaking order IS meaning: `index` is what `perform_contract` names,
    // and what a party accepted by index must keep meaning the same thing.
    obligations: c.obligations.map((u) => ({
      index: u.index,
      obligor: u.obligor,
      description: u.description,
      dueAt: u.dueAt,
      promised: consideration(u.promised),
      delivered: consideration(u.delivered),
      status: u.status,
    })),
    offeredBy: c.offeredBy,
    accepted: sortedCopy(c.accepted),
    declined: sortedCopy(c.declined),
    offerExpiresAt: c.offerExpiresAt,
    createdSequence: c.createdSequence,
    createdAt: c.createdAt,
  };
}

function currency(c: Currency): Normal {
  return {
    id: c.id,
    issuer: c.issuer,
    name: c.name,
    symbol: c.symbol,
    supplyRule: c.supplyRule,
    issuedSupply: c.issuedSupply,
    holdings: numberRecord(c.holdings),
    publicLedger: c.publicLedger,
    transferRule: c.transferRule,
    backing: bundle(c.backing),
    governance: c.governance,
    governingOrganisation: c.governingOrganisation,
    description: c.description,
    createdSequence: c.createdSequence,
    createdAt: c.createdAt,
  };
}

function condition(c: Condition): Normal {
  return {
    id: c.id,
    subject: c.subject,
    kind: c.kind,
    severity: c.severity,
    onsetAt: c.onsetAt,
    progressedAt: c.progressedAt,
    stage: c.stage,
    resolved: c.resolved,
    diagnosedBy: sortedCopy(c.diagnosedBy),
    disclosed: c.disclosed,
    createdSequence: c.createdSequence,
  };
}

function activity(a: ActivityRecord): Normal {
  return {
    id: a.id,
    state: a.state,
    actionType: a.actionType,
    participants: sortedCopy(a.participants),
    location: { x: a.location.x, y: a.location.y },
    startedAt: a.startedAt,
    endsAt: a.endsAt,
    interruption: a.interruption,
    resourceCost: bundle(a.resourceCost),
    open: a.open,
    sequence: a.sequence,
  };
}

function memory(m: MemoryRecord): Normal {
  return {
    id: m.id,
    owner: m.owner,
    simTime: m.simTime,
    kind: m.kind,
    summary: m.summary,
    participants: sortedCopy(m.participants),
    sequence: m.sequence,
    revisionOf: m.revisionOf,
  };
}

function confinement(c: Confinement): Normal {
  return {
    id: c.id,
    subject: c.subject,
    imposedBy: sortedCopy(c.imposedBy),
    organisation: c.organisation,
    structureId: c.structureId,
    startedAt: c.startedAt,
    endsAt: c.endsAt,
    grounds: c.grounds,
    upkeepPayer: c.upkeepPayer,
    upkeepPaid: bundle(c.upkeepPaid),
    guardMinutes: c.guardMinutes,
    memoryCountAtStart: c.memoryCountAtStart,
    released: c.released,
    createdSequence: c.createdSequence,
  };
}

function ledger(l: ResourceLedger): Normal {
  return {
    genesisTotal: bundle(l.genesisTotal),
    created: bundle(l.created),
    destroyed: bundle(l.destroyed),
  };
}

/**
 * The exact projection of world state that is hashed.
 *
 * Exported so tests and the audit tooling can diff two worlds field by field
 * instead of staring at two different 64-character strings.
 */
export function normaliseState(state: WorldState): Normal {
  return {
    worldId: state.worldId,
    seed: state.seed,
    schemaVersion: state.schemaVersion,
    simTime: state.simTime,
    sequence: state.sequence,
    map: {
      width: state.map.width,
      height: state.map.height,
      // Row-major order IS the map. Never sorted.
      terrain: [...state.map.terrain],
    },
    deposits: record(state.deposits, bundle),
    inhabitants: record(state.inhabitants, inhabitant),
    structures: record(state.structures, structure),
    artifacts: record(state.artifacts, artifact),
    organisations: record(state.organisations, organisation),
    contracts: record(state.contracts, contract),
    currencies: record(state.currencies, currency),
    conditions: record(state.conditions, condition),
    activities: record(state.activities, activity),
    memories: record(state.memories, memory),
    confinements: record(state.confinements, confinement),
    publicRecords: {
      // Announcements are a chronological record; order is history.
      announcements: state.publicRecords.announcements.map((a) => ({
        sequence: a.sequence,
        simTime: a.simTime,
        speaker: a.speaker,
        text: a.text,
        location: a.location === null ? null : { x: a.location.x, y: a.location.y },
      })),
    },
    ledger: ledger(state.ledger),
    // The rules themselves are covered by their checksum; including the
    // checksum alone keeps the projection small and makes a rules change
    // impossible to hide.
    rulesChecksum: state.rulesChecksum,
    // `forensics` is deliberately absent. See the module doc comment.
  };
}

/** The world's checksum: `sha256("<domain>\n" + canonicalJson(normaliseState(state)))`. */
export function computeStateChecksum(state: WorldState): Sha256Hex {
  return hashValue(HashDomain.StateChecksum, normaliseState(state));
}
