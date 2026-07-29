import {
  SpendLimitExceededError,
  buildObservation,
  getActionSpec,
  type CognitionLevel,
  type ModelAuditStore,
  type ModelProvider,
  type ResourceKind,
  type SpendReservationStore,
} from "@after-genesis/core";
import {
  ModelProviderError,
  SpendLedger,
  proposeAction,
  type MemoryRecord,
  type Observation,
  type PriceTable,
  type SpendEnforcement,
  type SpendLimits,
} from "@after-genesis/cognition";
import { IMPLEMENTED_ACTIONS, INTENTION_PREFIX } from "@after-genesis/core";
import {
  ModelUnavailableError,
  type CognitionInput,
  type CognitionOutcome,
  type CognitionService,
} from "./turn.js";

export interface ProviderCognitionOptions {
  readonly provider: ModelProvider;
  readonly audit: ModelAuditStore;
  /** The model used for reaction, routine and conversation turns. */
  readonly modelId: string;
  /**
   * The model used for the deliberate levels (§3: "Flash-Lite for routine
   * cognition and Flash for rare high-importance cognition").
   *
   * Omit to run every level on `modelId`. Supplying it is a constitutional
   * setting: which model thought about what is recorded per inference (§3) and
   * is part of what replay reproduces, so it cannot be changed mid-world.
   */
  readonly deliberateModelId?: string;
  readonly prices: readonly PriceTable[];
  readonly limits: SpendLimits;
  /**
   * Whether a reached ceiling stops paid inference or merely records it.
   * Defaults to `"freeze"`; see `SpendEnforcement` in the cognition package for
   * why `"observe"` must never reach a sealed world.
   */
  readonly enforcement?: SpendEnforcement;
  /** Explicit calendar partition supplied by the scheduler, e.g. 2026-07-28. */
  readonly dayKey: string;
  readonly durableSpend?: SpendReservationStore;
  /** Constitutional sampling setting, recorded in every request hash. */
  readonly temperature?: number;
}

/**
 * Production composition between the limited-observation engine boundary and
 * the provider-neutral cognition package.
 */
export class ProviderCognitionService implements CognitionService {
  readonly #provider: ModelProvider;
  readonly #audit: ModelAuditStore;
  readonly #modelId: string;
  readonly #deliberateModelId: string | undefined;
  readonly #ledger: SpendLedger;
  readonly #dayKey: string;
  readonly #durableSpend: SpendReservationStore | undefined;
  readonly #temperature: number | undefined;

  constructor(options: ProviderCognitionOptions) {
    if (options.modelId.trim() === "") throw new Error("modelId must not be empty");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.dayKey)) {
      throw new Error("dayKey must use YYYY-MM-DD");
    }
    if (options.deliberateModelId !== undefined && options.deliberateModelId.trim() === "") {
      throw new Error("deliberateModelId must not be empty when supplied");
    }
    this.#provider = options.provider;
    this.#audit = options.audit;
    this.#modelId = options.modelId;
    this.#deliberateModelId = options.deliberateModelId;
    this.#ledger = new SpendLedger({
      prices: options.prices,
      limits: options.limits,
      ...(options.enforcement === undefined ? {} : { enforcement: options.enforcement }),
    });
    this.#dayKey = options.dayKey;
    this.#durableSpend = options.durableSpend;
    this.#temperature = options.temperature;
  }

  get spend(): SpendLedger {
    return this.#ledger;
  }

  /**
   * The model for this turn's level.
   *
   * Deterministic: `cognitionLevel` comes from canonical state and the actor's
   * own turn number, so a replay of the same sequence selects the same model.
   * The id is recorded on every inference either way (§3), so the audit shows
   * which model thought about what without having to re-derive this.
   */
  #modelFor(level: CognitionLevel): string {
    if (this.#deliberateModelId === undefined) return this.#modelId;
    return DELIBERATE_LEVELS.has(level) ? this.#deliberateModelId : this.#modelId;
  }

  async propose(input: CognitionInput): Promise<CognitionOutcome> {
    const coreObservation = buildObservation(input.state, input.actorId);
    const observation = projectObservation(coreObservation, input.sequence, input.state.sequence + 1);
    const memories = projectMemories(coreObservation);
    const modelId = this.#modelFor(observation.cognitionLevel);

    try {
      const result = await proposeAction(
        {
          provider: this.#provider,
          ledger: this.#ledger,
          audit: this.#audit,
          ...(this.#durableSpend === undefined
            ? {}
            : { durableSpend: this.#durableSpend }),
        },
        {
          observation,
          memoryCandidates: memories,
          retrieval: {
            nowSimTime: observation.simTime,
            location: observation.self.location,
            focusInhabitantIds: observation.nearbyInhabitants.map((item) => item.id),
            needs: observation.self.needs,
            goals: observation.self.privateGoals,
            situationTags: situationTagsFrom(coreObservation, observation.self.terrain),
            cognitionLevel: observation.cognitionLevel,
            maturity: observation.self.maturity,
          },
          modelId,
          dayKey: this.#dayKey,
          ...(this.#temperature === undefined
            ? {}
            : { promptOptions: { temperature: this.#temperature } }),
        },
      );
      const last = result.attempts.at(-1);
      return {
        action: result.status === "proposed" ? result.action : null,
        modelId: last?.modelId ?? modelId,
        requestHash: last?.requestHash ?? null,
        responseHash: last?.responseHash ?? null,
        costMicros: result.totalCostMicros,
        inputTokens: result.attempts.reduce((sum, item) => sum + item.inputTokens, 0),
        outputTokens: result.attempts.reduce((sum, item) => sum + item.outputTokens, 0),
        ...(result.status === "noop" ? { noopReason: result.reason } : {}),
      };
    } catch (error) {
      if (error instanceof ModelProviderError && error.retryable) {
        throw new ModelUnavailableError(error.message);
      }
      // A spend ceiling or permanent provider/configuration failure pauses the
      // worker. It must not be translated into an inhabitant decision.
      if (error instanceof SpendLimitExceededError) throw error;
      throw error;
    }
  }
}

type CoreObservation = ReturnType<typeof buildObservation>;

/**
 * The levels that get the stronger model (§3, §11B).
 *
 * §11B's six levels differ in horizon and depth, and these three are the ones
 * where depth is the point: what to do with a life, what experience has meant,
 * what to learn next. The other three — an immediate reaction, a routine
 * decision, a line of conversation — are answered well by the cheaper model, and
 * they are the overwhelming majority of turns in a healthy world.
 *
 * A caveat worth stating, because it governs cost rather than correctness:
 * `cognitionLevelFor` currently makes `planning` the *default* quiet state, so
 * in the observed hundred-day run 962 of 1,200 turns were planning turns. With
 * this routing that is not "rare high-importance cognition", it is most of the
 * bill. If cost matters more than depth, the lever is the level distribution
 * below, not this set.
 */
const DELIBERATE_LEVELS: ReadonlySet<CognitionLevel> = new Set<CognitionLevel>([
  "planning",
  "reflection",
  "study",
]);

/**
 * The shape of each action's payload, shown beside its description.
 *
 * These describe what the engine accepts and nothing more. A hint may name a
 * field and its type; it must never suggest a *value* worth choosing, because a
 * hint that read `"proposedName": <a name for your child>` alongside a
 * recommended commitment would be the platform deciding that reproduction is
 * something an inhabitant ought to want (§26).
 *
 * Actions absent from this table take no arguments, or take only arguments
 * whose names are self-describing.
 */
const PAYLOAD_HINTS: Partial<Record<string, string>> = {
  announce: '{ "message": <what you choose to say>, "scope": "local" or "world" }',
  communicate:
    '{ "recipients": [<nearby id>], "message": <what you choose to say>, "intendedMinutes": 5 }',
  create_artifact:
    '{ "kind": "written_work"|"design"|"research_note"|"other", "title": <text>, "content": <text>, "collaboratorIds": [], "materials": {}, "derivedFromArtifactId": null, "organisationId": null, "revisesArtifactId": null }',
  copy_artifact: '{ "sourceArtifactId": <readable artifact id>, "title": <optional text> }',
  publish: '{ "artifactId": <artifact you possess> }',
  transfer_property:
    '{ "toInhabitantId": <nearby id>, "resources": {}, "artifactIds": [], "structureIds": [], "asGift": true, "note": <optional words> }',
  offer_trade:
    '{ "toInhabitantIds": [<nearby id>], "isOpenOffer": false, "give": {"resources": {}, "artifactIds": [], "labourMinutes": 0}, "want": {"resources": {}, "artifactIds": [], "labourMinutes": 0}, "expiresInMinutes": 1440, "message": <optional words> }',
  accept_trade: '{ "offerId": <a standing offer made to you>, "note": <optional words> }',
  reject_trade: '{ "offerId": <a standing offer made to you>, "reason": <optional words> }',
  create_currency:
    '{ "name": <text>, "symbol": <short text>, "initialSupply": <integer>, "supplyRule": "fixed"|"issuer_mint"|"backed_issue"|"scheduled"|"burn_only", "transferRule": "free"|"issuer_approval"|"members_only"|"non_transferable", "ledgerVisibility": "public"|"members"|"private", "governance": "issuer"|"organisation"|"holders_vote"|"none", "description": <text> }',
  transfer_currency:
    '{ "currencyId": <a currency that exists>, "toInhabitantId": <nearby id>, "amount": <integer you hold>, "memo": <optional words> }',
  create_inhabitant:
    '{ "proposedName": <text>, "resourcesCommitted": {"food": <integer>, "water": <integer>, "wood": <integer>, "stone": <integer>}, "traitHints": [], "valueHints": [], "statedCareMinutesPerDay": <integer>, "statement": <optional words> }',
  store_goods:
    '{ "structureId": <a structure on your tile>, "direction": "deposit" or "withdraw", "resources": {"food": <integer>, "water": <integer>, "wood": <integer>, "stone": <integer>}, "note": <optional words> }',
  build:
    '{ "structureKind": "shelter"|"storehouse"|"workshop"|"hall"|"wall"|"enclosure"|"monument"|"road", "coord": {"x": <integer>, "y": <integer>}, "name": <text>, "materials": {"wood": <held amount>} }',
  guard_location:
    '{ "coord": {"x": <current x>, "y": <current y>}, "durationMinutes": 30, "protectSubjectIds": [], "protectArtifactIds": [] }',
  restrain:
    '{ "targetId": <nearby id>, "structureId": <nearby enclosure id>, "durationMinutes": <positive integer>, "message": <optional words> }',
  release: '{ "targetId": <nearby restrained inhabitant id>, "message": <optional words> }',
};

/** A need at or above this is an emergency: act on it now. */
const NEED_CRITICAL = 85;
/** A need at or above this presses on the next decision. */
const NEED_PRESSING = 50;
/** Turns between the deliberate levels, once nothing is pressing. */
const CALM_CYCLE = 24;

/**
 * Which kind of thinking this turn is (§11B).
 *
 * This was pinned to "routine" — "choose the sensible next thing given your
 * needs" — for every turn of every inhabitant. Over two hundred simulated days
 * the founder received that same sentence 2,400 times, and did what it asked:
 * she ate, drank, rested, and gathered a surplus she had no use for. She never
 * proposed building anything, holding 787 wood and the ability to build,
 * because she was never once asked to think past the next hour.
 *
 * §11B describes six levels of cognitive activity. All six existed in the
 * prompt; only one was ever assigned. What follows chooses between them from
 * circumstance:
 *
 * - Someone is here, so attend to them.
 * - A need is critical, so deal with it now.
 * - A need presses, so weigh it against everything else.
 * - Nothing presses, so use the quiet: plan, and periodically reflect or study.
 *
 * Deterministic by construction. Every input is canonical state or the
 * inhabitant's own turn number, so a replay picks the same level at the same
 * sequence — which matters because the level changes the prompt, and the prompt
 * is hashed onto the event (§16).
 *
 * This chooses how the inhabitant is invited to think. It never chooses what to
 * think, and it never names an action.
 */
export function cognitionLevelFor(
  source: CoreObservation,
  turnNumber: number,
): CognitionLevel {
  const needs = source.self.needs;
  const worst = Math.max(needs.thirst, needs.hunger, needs.fatigue);

  // Another mind present outranks everything short of an emergency: a
  // conversation missed is gone, while a resource waits.
  if (worst < NEED_CRITICAL && source.inhabitants.length > 0) return "conversation";
  if (worst >= NEED_CRITICAL) return "reaction";
  if (worst >= NEED_PRESSING) return "routine";

  // Quiet. Most of it goes to planning, with reflection and study on a fixed
  // cadence so that consolidating experience is not left to chance.
  const phase = turnNumber % CALM_CYCLE;
  if (phase === 0) return "reflection";
  if (phase === CALM_CYCLE / 2) return "study";
  return "planning";
}

function projectObservation(
  source: CoreObservation,
  sequence: number,
  turnNumber: number,
): Observation {
  const tileAtSelf = source.tiles.find(
    (tile) => tile.x === source.self.location.x && tile.y === source.self.location.y,
  );
  const relationships = source.self.relationships;

  return {
    worldId: source.worldId,
    sequence,
    simTime: source.simTime,
    turnNumber,
    cognitionLevel: cognitionLevelFor(source, turnNumber),
    self: {
      id: source.self.id,
      displayName: source.self.displayName,
      generation: source.self.generation,
      maturity: source.self.maturity,
      birthTime: source.self.birthTime,
      location: source.self.location,
      terrain: tileAtSelf?.terrain ?? "unknown",
      activity: source.self.activity,
      lastAction: source.self.lastAction,
      energy: source.self.energy,
      maxEnergy: source.self.maxEnergy,
      computeAllowance: source.self.compute,
      integrity: source.self.integrity,
      confined: source.self.confinement !== null,
      currentIntention: latestIntention(source),
      traits: Object.entries(source.self.traits)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => ({ name, value: value ?? 50 })),
      values: source.self.values.map((statement, index) => ({
        id: `value_${index + 1}`,
        statement,
        weight: 50,
      })),
      privateGoals: source.self.privateGoals.map((statement, index) => ({
        id: `goal_${index + 1}`,
        statement,
        priority: 50,
        tags: tagsFrom(statement),
      })),
      needs: Object.entries(source.self.needs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, level]) => ({ kind, level })),
      conditions: source.self.conditions.map((condition) => ({
        id: condition.id,
        name: condition.kind,
        severity: condition.severity,
        known: true,
      })),
      skills: Object.entries(source.self.skills)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, level]) => ({ name, level: level ?? 0 })),
      inventory: source.self.inventory,
      artifacts: source.self.artifacts.map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        published: artifact.published,
      })),
    },
    nearbyInhabitants: source.inhabitants.map((inhabitant) => {
      const relationship = relationships[inhabitant.id];
      return {
        id: inhabitant.id,
        displayName: inhabitant.displayName,
        distance: inhabitant.distance,
        location: inhabitant.location,
        visibleActivity: inhabitant.activity,
        relationshipSentiment: relationship?.trust ?? null,
        interactionCount: relationship?.familiarity ?? 0,
      };
    }),
    nearbyStructures: source.structures.map((structure) => ({
      id: structure.id,
      kind: structure.kind,
      location: structure.location,
      ownerId: structure.owner,
    })),
    nearbyTiles: source.tiles.map((tile) => ({
      location: { x: tile.x, y: tile.y },
      terrain: tile.terrain,
      visibleResources: tile.deposit as Partial<Record<ResourceKind, number>>,
    })),
    // Places already visited that are not currently in view. What is visible is
    // reported by nearbyTiles; repeating it here would spend context restating
    // what the inhabitant is already looking at.
    rememberedPlaces: source.self.knownTerrain
      .filter((place) => place.distance > source.sightRadius)
      .map((place) => ({
        location: { x: place.x, y: place.y },
        terrain: place.terrain,
        distance: place.distance,
      })),
    authoredTexts: [
      ...source.publicRecords.announcements.map((announcement) => ({
        id: `announcement_${announcement.sequence}`,
        kind: "announcement",
        authorId: announcement.speaker,
        authorName: announcement.speaker,
        simTime: announcement.simTime,
        body: announcement.text,
      })),
      ...source.publicRecords.artifacts.map((artifact) => ({
        id: artifact.id,
        kind: `artifact:${artifact.kind}`,
        authorId: artifact.creators[0] ?? "unknown",
        authorName: artifact.creators[0] ?? "unknown",
        simTime: artifact.createdAt,
        body:
          `Title: ${artifact.title}\nCurrent recorded possessor: ${artifact.possessor ?? "none"}\n` +
          artifact.content,
      })),
    ],
    worldNotices:
      source.self.confinement === null
        ? []
        : [`You are confined in structure ${source.self.confinement.structureId}.`],
    availableActions: IMPLEMENTED_ACTIONS.filter((type) => {
      const spec = getActionSpec(type);
      return (
        source.self.maturity >= spec.minimumMaturity &&
        (!source.self.confinement || spec.allowedWhileConfined)
      );
    }).map((type) => {
      const spec = getActionSpec(type);
      const hint = PAYLOAD_HINTS[type];
      return {
        type,
        description: spec.description,
        ...(hint === undefined ? {} : { payloadHint: hint }),
      };
    }),
  };
}

/**
 * The most recent intention the inhabitant wrote, or null if it never has.
 *
 * Read out of its own reflections rather than from a field on the inhabitant,
 * so that changing one's mind is append-only exactly as §19 requires: the
 * earlier intentions all remain in the record, and what the prompt shows is
 * simply the latest of them. Ties break on id so two intentions written in the
 * same simulated minute resolve identically on every replay.
 */
function latestIntention(
  source: CoreObservation,
): { readonly statement: string; readonly simTime: number } | null {
  let best: { statement: string; simTime: number; id: string } | null = null;
  for (const memory of source.memories) {
    if (memory.kind !== "reflection" || !memory.summary.startsWith(INTENTION_PREFIX)) continue;
    const statement = memory.summary.slice(INTENTION_PREFIX.length).trim();
    if (statement === "") continue;
    if (
      best === null ||
      memory.simTime > best.simTime ||
      (memory.simTime === best.simTime && memory.id > best.id)
    ) {
      best = { statement, simTime: memory.simTime, id: memory.id };
    }
  }
  return best === null ? null : { statement: best.statement, simTime: best.simTime };
}

function projectMemories(source: CoreObservation): MemoryRecord[] {
  return source.memories.map((memory) =>
    memory.kind === "reflection"
      ? {
          tier: "reflection" as const,
          epistemicStatus: "belief" as const,
          id: memory.id,
          simTime: memory.simTime,
          content: memory.summary,
          tags: tagsFrom(memory.summary),
          participants: memory.participants,
          location: null,
          significance: 50,
          confidence: 50,
          derivedFrom: [],
          supersedes: null,
        }
      : {
          tier: "episodic" as const,
          epistemicStatus: "observed" as const,
          id: memory.id,
          simTime: memory.simTime,
          content: memory.summary,
          tags: tagsFrom(memory.summary),
          participants: memory.participants,
          location: null,
          significance: 50,
          eventSequence: memory.eventSequence,
          provenance: "observed" as const,
        },
  );
}

/**
 * Words that appear in the engine's own memory sentences rather than in what
 * happened.
 *
 * Every episodic memory is written as "You performed <action> with payload
 * {...}. Outcome: resolved." — so without this filter, `performed`, `payload`,
 * `outcome` and `resolved` are tags on every memory an inhabitant has ever
 * formed, and a tag shared by everything discriminates nothing. Twelve tag slots
 * were being spent on boilerplate before any of them reached the content.
 */
const TAG_STOPWORDS: ReadonlySet<string> = new Set([
  "and",
  "for",
  "from",
  "into",
  "outcome",
  "payload",
  "performed",
  "rejected",
  "resolved",
  "the",
  "was",
  "were",
  "with",
  "witnessed",
  "you",
  "your",
]);

function tagsFrom(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  return [...new Set(words.filter((word) => !TAG_STOPWORDS.has(word)))].sort().slice(0, 12);
}

/**
 * Tags describing the moment the inhabitant is deciding in.
 *
 * These are matched against memory tags to produce the retrieval `relevance`
 * term, so what goes in here decides which past experiences a situation calls
 * up. It used to be `nearbyTiles.map(t => t.terrain)` — the terrain words for
 * all eighty-one visible tiles — which had an unfortunate property: the engine
 * writes an observe memory as a list of terrain names, so observe memories
 * matched the situation tags better than any other kind of memory could, on
 * every turn, forever. Retrieval reliably answered "what is relevant here?"
 * with "the last several times you looked around".
 *
 * What replaces it describes the situation rather than restating the view: the
 * ground underfoot, what the inhabitant is doing, and which resources are within
 * sight. A memory of gathering wood is now what a forest full of wood calls up.
 */
function situationTagsFrom(source: CoreObservation, terrain: string): string[] {
  const tags = new Set<string>([terrain, source.self.activity]);
  for (const tile of source.tiles) {
    for (const [kind, amount] of Object.entries(tile.deposit)) {
      if ((amount ?? 0) > 0) tags.add(kind);
    }
  }
  if (source.inhabitants.length > 0) tags.add("company");
  return [...tags].filter((tag) => tag !== "").sort();
}
