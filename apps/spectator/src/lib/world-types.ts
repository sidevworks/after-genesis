/**
 * After Genesis — spectator read model.
 *
 * These are *projection* types: the shape the public window needs in order to
 * render history. They are intentionally not the canonical engine types. The
 * canonical types live in `packages/core`; this app must never import a writer,
 * a transaction helper or an action constructor from them.
 *
 * Every field here is derived from the append-only event log or from the
 * materialised state that the log produces (claude.md §4D, §4E, §16).
 */

/** Minutes elapsed since Genesis. Rendered as `Day N HH:MM`. */
export type SimTime = number;

export const MINUTES_PER_DAY = 1440;

export type Terrain =
  | "water"
  | "plains"
  | "fertile"
  | "forest"
  | "stone"
  | "barren";

export type ResourceKind =
  | "food"
  | "water"
  | "wood"
  | "stone"
  | "energy"
  | "compute"
  | "land_rights"
  | "storage";

export type InhabitantStatus = "active" | "confined" | "deceased";

export type ActivityKind =
  | "idle"
  | "resting"
  | "travelling"
  | "gathering"
  | "building"
  | "crafting"
  | "conversing"
  | "teaching"
  | "studying"
  | "caring"
  | "guarding"
  | "confined"
  | "none";

/**
 * Who may see a record. The spectator app only ever receives `public` records
 * and `private_until_death` records belonging to inhabitants who have died
 * (claude.md §16). `restricted` never reaches this client; the type exists so
 * the UI can render an explicit, honest gap rather than pretending completeness.
 */
export type Visibility = "public" | "private_until_death" | "restricted";

export interface Coord {
  x: number;
  y: number;
}

/* ------------------------------------------------------------------ world */

export interface WorldSummary {
  worldId: string;
  /** Published Genesis seed — the map is deterministically derived from it (§5). */
  genesisSeed: string;
  schemaVersion: string;
  /** Frozen worlds are paused; freezing is itself a public audit event (§17). */
  status: "running" | "frozen";
  simTime: SimTime;
  /** Wall-clock time of the most recent canonical event. ISO 8601. */
  lastEventAt: string;
  mapWidth: number;
  mapHeight: number;
  population: {
    living: number;
    deceased: number;
    total: number;
    /** Living inhabitants per generation index. */
    byGeneration: number[];
  };
  structureCount: number;
  organisationCount: number;
  artifactCount: number;
  eventCount: number;
  /** Head of the hash chain (§16). */
  chainHead: string;
  stateChecksum: string;
  sourceCommit: string;
  imageDigest: string;
}

/* -------------------------------------------------------------------- map */

export interface Tile {
  x: number;
  y: number;
  terrain: Terrain;
  /** 0..1. Deterministically generated from the Genesis seed. */
  fertility: number;
  /** Remaining extractable units of the tile's primary resource, if any. */
  deposit?: { resource: ResourceKind; remaining: number };
  /** Inhabitant id holding recorded land-use rights over this tile. */
  claimedBy?: string;
}

export interface Structure {
  id: string;
  name: string;
  kind:
    | "shelter"
    | "hall"
    | "store"
    | "workshop"
    | "well"
    | "bridge"
    | "monument"
    | (string & {});
  at: Coord;
  /** Inhabitant id, or organisation id when owned communally. */
  ownerId: string;
  ownerKind: "inhabitant" | "organisation";
  builtAt: SimTime;
  builtByEvent: string;
  /** 0..1 structural condition. */
  condition: number;
  capacity: number;
}

export interface WorldMap {
  width: number;
  height: number;
  genesisSeed: string;
  /** Row-major, length = width * height. */
  tiles: Tile[];
  structures: Structure[];
  /** Tile ids (`x,y`) that are currently revealed. Omitted for legacy fixtures. */
  discovered?: readonly string[];
  /** Current positions of every inhabitant, living and deceased. */
  occupants: Array<{
    id: string;
    name: string;
    at: Coord;
    status: InhabitantStatus;
    generation: number;
  }>;
}

/* ------------------------------------------------------------- inhabitant */

export interface Trait {
  name: string;
  /** 0..1. Bounded, inherited-plus-novel at creation (§7). */
  value: number;
}

export interface Need {
  name: "food" | "water" | "rest" | "safety" | "purpose";
  /** 0..1, where 1 is fully satisfied. */
  level: number;
}

export interface InventoryEntry {
  resource: ResourceKind;
  quantity: number;
}

export interface Skill {
  name: string;
  /** 0..1 proficiency. Grows through practice, study and teaching (§9). */
  level: number;
  practiceCount: number;
  /** Inhabitant id who taught it, when the skill was taught rather than self-learned. */
  taughtBy?: string;
}

export interface Relationship {
  otherId: string;
  otherName: string;
  kind:
    | "parent"
    | "child"
    | "sibling"
    | "colleague"
    | "counterparty"
    | "adversary"
    | "acquaintance";
  /** -1..1 as recorded by the engine from observable interactions. */
  valence: number;
  since: SimTime;
  interactionCount: number;
}

export interface Membership {
  organisationId: string;
  organisationName: string;
  role: string;
  since: SimTime;
  /** Present when the inhabitant has left the organisation. */
  until?: SimTime;
}

export interface ContractRef {
  id: string;
  kind: "employment" | "service" | "loan" | "sale" | "joint_ownership";
  counterpartyIds: string[];
  counterpartyNames: string[];
  summary: string;
  agreedAt: SimTime;
  status: "active" | "fulfilled" | "breached" | "void";
  terms: string;
}

export interface HealthCondition {
  id: string;
  name: string;
  onset: SimTime;
  resolved?: SimTime;
  /** 0..1. */
  severity: number;
  /** Deterministic progression stage recorded by the engine (§8). */
  stage: string;
}

export interface HealthRecord {
  simTime: SimTime;
  eventId: string;
  /** Canonical neutral description of what was observed or applied. */
  description: string;
  /** Inhabitant who performed the observation or treatment, if any. */
  byId?: string;
}

export interface DeathRecord {
  eventId: string;
  simTime: SimTime;
  at: Coord;
  /** Canonical, neutral. Never a moral or narrative framing. */
  cause: string;
  /** Inhabitants who were present at the recorded location at the time. */
  witnessIds: string[];
  /** What happened to the estate afterwards, as recorded by later events (§8). */
  estateDisposition: string;
}

/**
 * A public memory or long-term reflection.
 *
 * Reflections are *beliefs*, not canonical facts (§19). The UI must render them
 * as attributed claims and never as history.
 */
export interface PublicMemory {
  id: string;
  simTime: SimTime;
  kind: "episodic" | "reflection";
  text: string;
  /** The canonical event this memory refers to, when it refers to one. */
  aboutEventId?: string;
  visibility: Visibility;
}

export interface InhabitantSummary {
  id: string;
  name: string;
  generation: number;
  status: InhabitantStatus;
  at: Coord;
  birthSimTime: SimTime;
  parentIds: string[];
  /** 0..1. */
  energy: number;
  activity: ActivityKind;
  topSkill?: { name: string; level: number };
  reputation: number;
  deceasedAt?: SimTime;
}

export interface Inhabitant extends InhabitantSummary {
  creatorId?: string;
  creationEventId: string;
  childIds: string[];
  traits: Trait[];
  values: string[];
  /**
   * Private goals are never exposed while an inhabitant lives (§6, §16).
   * The count is published so the gap is visible rather than invisible.
   */
  privateGoalCount: number;
  disclosedGoals: string[];
  needs: Need[];
  computeAllowance: { usedToday: number; dailyLimit: number };
  inventory: InventoryEntry[];
  property: {
    structureIds: string[];
    landTiles: Coord[];
  };
  skills: Skill[];
  relationships: Relationship[];
  /** 0..1 aggregate, plus per-organisation standing where recorded. */
  reputationDetail: Array<{ context: string; value: number }>;
  memberships: Membership[];
  contracts: ContractRef[];
  balances: Array<{ currencyId: string; currencySymbol: string; amount: number }>;
  publicMemories: PublicMemory[];
  health: {
    integrity: number;
    conditions: HealthCondition[];
    history: HealthRecord[];
  };
  voice: { voiceId: string; description: string };
  model: { provider: string; model: string; version: string };
  lastActionSimTime: SimTime;
  nextEligibleSimTime: SimTime;
  death?: DeathRecord;
  /** Currently active confinement, if any (§11H). */
  confinement?: {
    structureId: string;
    structureName: string;
    from: SimTime;
    until?: SimTime;
    imposedByIds: string[];
    imposedByNames: string[];
    imposedByOrganisationId?: string;
  };
}

/* ------------------------------------------------------------------ event */

/**
 * A non-canonical interpretation attached to a canonical event by an
 * inhabitant or organisation (§11G).
 *
 * Claims must always be rendered attributed, and visually distinct from the
 * canonical description. Organisational descriptions cannot overwrite
 * canonical descriptions (§11J).
 */
export interface EventClaim {
  id: string;
  byId: string;
  byName: string;
  byKind: "inhabitant" | "organisation";
  text: string;
  simTime: SimTime;
  /** The canonical event in which this claim was itself recorded. */
  recordedInEventId: string;
}

export interface WorldEvent {
  id: string;
  worldId: string;
  sequence: number;
  simTime: SimTime;
  /** Real wall-clock timestamp, ISO 8601. */
  realTime: string;
  /** Inhabitant id, or null for engine-level events such as Genesis. */
  actor: string | null;
  actorName: string | null;
  type: string;
  /**
   * Canonical neutral description (§11G, §11J). Render verbatim. Never
   * paraphrase, summarise or dramatise this string in the UI.
   */
  description: string;
  subjects: string[];
  location?: Coord;
  inputs: Record<string, unknown>;
  resolution: "applied" | "rejected" | "partial";
  /** Why the engine rejected or partially applied the action. */
  resolutionNote?: string;
  visibility: Visibility;
  preStateChecksum: string;
  postStateChecksum: string;
  modelRequestHash?: string;
  modelResponseHash?: string;
  prevHash: string;
  hash: string;
  sourceCommit: string;
  imageDigest: string;
  schemaVersion: string;
  claims: EventClaim[];
}

export interface EventQuery {
  /** Opaque cursor. For the fixture source this is the sequence number. */
  cursor?: string;
  limit?: number;
  filter?: {
    /** Free-text match against the canonical description and event type. */
    search?: string;
    types?: string[];
    actorIds?: string[];
    subjectId?: string;
    fromSimTime?: SimTime;
    toSimTime?: SimTime;
    /** Only events that carry at least one attributed claim. */
    withClaimsOnly?: boolean;
  };
}

export interface EventPage {
  events: WorldEvent[];
  nextCursor: string | null;
  /** Total matching the filter, not the page size. */
  total: number;
}

/* ----------------------------------------------------------- organisation */

/**
 * A rule an organisation has declared.
 *
 * Declaration alone does not make a rule universal (§11G). `recognisedBy` is
 * the set of inhabitants who have taken a recorded action accepting it;
 * `rejectedBy` is the set who have taken a recorded action refusing it.
 * Everyone else has done neither.
 */
export interface DeclaredRule {
  id: string;
  text: string;
  declaredAt: SimTime;
  declaredInEventId: string;
  recognisedBy: string[];
  rejectedBy: string[];
}

export interface Organisation {
  id: string;
  name: string;
  kind:
    | "household"
    | "partnership"
    | "business"
    | "guild"
    | "school"
    | "medical_group"
    | "collective"
    | "council"
    | "government"
    | "opposition";
  /** The organisation's own words. A claim, not a canonical description. */
  selfDescription: string;
  foundedAt: SimTime;
  foundedInEventId: string;
  founderIds: string[];
  members: Array<{ id: string; name: string; role: string; since: SimTime }>;
  formerMembers: Array<{ id: string; name: string; leftAt: SimTime }>;
  declaredRules: DeclaredRule[];
  propertyStructureIds: string[];
  treasury: Array<{ currencyId: string; currencySymbol: string; amount: number }>;
  status: "active" | "dissolved";
  /**
   * Whether other inhabitants treat this organisation as legitimate. Derived
   * only from recorded actions — never asserted by the platform (§11G).
   */
  recognition: {
    recognisedByIds: string[];
    rejectedByIds: string[];
    unengagedIds: string[];
  };
}

/* --------------------------------------------------------------- economy */

export interface Currency {
  id: string;
  name: string;
  symbol: string;
  issuerId: string;
  issuerName: string;
  issuerKind: "inhabitant" | "organisation";
  createdAt: SimTime;
  createdInEventId: string;
  supplyRule: string;
  totalIssued: number;
  backing: string;
  governance: string;
  description: string;
  /**
   * The engine records and transfers units. It never guarantees social value
   * (§10). This is the count of distinct holders who have accepted the unit in
   * a recorded trade.
   */
  acceptingHolderIds: string[];
  refusedByIds: string[];
}

export interface LedgerEntry {
  currencyId: string;
  holderId: string;
  holderName: string;
  holderKind: "inhabitant" | "organisation";
  amount: number;
}

export interface Trade {
  id: string;
  eventId: string;
  simTime: SimTime;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  gave: string;
  received: string;
  /** Canonical neutral description of the exchange. */
  description: string;
  consented: boolean;
}

export interface EconomySnapshot {
  currencies: Currency[];
  ledger: LedgerEntry[];
  trades: Trade[];
  contracts: ContractRef[];
  /** Barter and gift transfers that used no unit of account. */
  nonMonetaryTransferCount: number;
}

/* -------------------------------------------------------------- artifacts */

/**
 * Generated media derived from a canonical artifact or event.
 *
 * Media generation cannot modify the civilisation (§12) and must be clearly
 * distinguishable from canonical world actions (§12, §21).
 */
export interface GeneratedMedia {
  id: string;
  kind: "verbatim_dialogue" | "condensed_summary" | "dramatised_narration";
  producedBy: string;
  producedAt: string;
  /** Canonical event(s) the media was derived from. */
  sourceEventIds: string[];
  durationSeconds?: number;
  note: string;
}

export interface Artifact {
  id: string;
  title: string;
  kind:
    | "written_work"
    | "image"
    | "design"
    | "audio_concept"
    | "script"
    | "performance"
    | "research_notes"
    | "advertisement"
    | "news_report"
    | "invention";
  creatorIds: string[];
  creatorNames: string[];
  createdAt: SimTime;
  creationEventId: string;
  ownerId: string;
  ownerName: string;
  ownerKind: "inhabitant" | "organisation";
  publicationStatus: "private" | "published" | "withdrawn";
  /** Excerpt of the artifact's own content. The inhabitant's words, not canon. */
  excerpt: string;
  provenance: Array<{
    simTime: SimTime;
    eventId: string;
    kind: "created" | "revised" | "sold" | "gifted" | "inherited" | "published";
    description: string;
  }>;
  revisions: Array<{ revision: number; simTime: SimTime; eventId: string; note: string }>;
  costs: Array<{ resource: ResourceKind; quantity: number }>;
  generatedMedia: GeneratedMedia[];
}

/* --------------------------------------------------------------- lineage */

export interface LineageNode {
  id: string;
  name: string;
  generation: number;
  parentIds: string[];
  childIds: string[];
  status: InhabitantStatus;
  birthSimTime: SimTime;
  deathSimTime?: SimTime;
  creationEventId: string;
}

export interface Lineage {
  nodes: LineageNode[];
  /** Ids of generation-0 inhabitants — instantiated only at Genesis (§7). */
  rootIds: string[];
  generationCount: number;
}

/* ----------------------------------------------------------------- audit */

export interface AuditStatus {
  /** Recomputed from the exported event log, not asserted by the publisher. */
  chain: {
    verified: boolean;
    verifiedThroughSequence: number;
    eventCount: number;
    head: string;
    /** Populated only when verification failed. */
    brokenAtSequence?: number;
    brokenReason?: string;
    /** Where the recomputation ran. */
    computedAt: string;
  };
  stateChecksum: string;
  sourceCommit: string;
  imageDigest: string;
  schemaVersion: string;
  genesisSeed: string;
  lastReplay: {
    startedAt: string;
    finishedAt: string;
    reconstructedChecksum: string;
    matchesProduction: boolean;
    eventsReplayed: number;
  };
  /** Chain hashes anchored outside the primary database (§16). */
  anchors: Array<{
    sequence: number;
    hash: string;
    publishedAt: string;
    location: string;
  }>;
  /** How a member of the public runs the verifier themselves (§16). */
  verifier: {
    repository: string;
    command: string;
    exportUrl: string;
    notes: string[];
  };
  /** Categories of record the public export deliberately withholds. */
  withheld: Array<{
    category?: string;
    kind?: string;
    reason: string;
    releaseCondition?: string;
  }>;
}
