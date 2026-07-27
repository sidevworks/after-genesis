import {
  SpendLimitExceededError,
  buildObservation,
  getActionSpec,
  type ModelAuditStore,
  type ModelProvider,
  type ResourceKind,
} from "@after-genesis/core";
import {
  ModelProviderError,
  SpendLedger,
  proposeAction,
  type MemoryRecord,
  type Observation,
  type PriceTable,
  type SpendLimits,
} from "@after-genesis/cognition";
import { IMPLEMENTED_ACTIONS } from "@after-genesis/core";
import {
  ModelUnavailableError,
  type CognitionInput,
  type CognitionOutcome,
  type CognitionService,
} from "./turn.js";

export interface ProviderCognitionOptions {
  readonly provider: ModelProvider;
  readonly audit: ModelAuditStore;
  readonly modelId: string;
  readonly prices: readonly PriceTable[];
  readonly limits: SpendLimits;
  /** Explicit calendar partition supplied by the scheduler, e.g. 2026-07-28. */
  readonly dayKey: string;
}

/**
 * Production composition between the limited-observation engine boundary and
 * the provider-neutral cognition package.
 */
export class ProviderCognitionService implements CognitionService {
  readonly #provider: ModelProvider;
  readonly #audit: ModelAuditStore;
  readonly #modelId: string;
  readonly #ledger: SpendLedger;
  readonly #dayKey: string;

  constructor(options: ProviderCognitionOptions) {
    if (options.modelId.trim() === "") throw new Error("modelId must not be empty");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(options.dayKey)) {
      throw new Error("dayKey must use YYYY-MM-DD");
    }
    this.#provider = options.provider;
    this.#audit = options.audit;
    this.#modelId = options.modelId;
    this.#ledger = new SpendLedger({ prices: options.prices, limits: options.limits });
    this.#dayKey = options.dayKey;
  }

  get spend(): SpendLedger {
    return this.#ledger;
  }

  async propose(input: CognitionInput): Promise<CognitionOutcome> {
    const coreObservation = buildObservation(input.state, input.actorId);
    const observation = projectObservation(coreObservation, input.sequence, input.state.sequence + 1);
    const memories = projectMemories(coreObservation);

    try {
      const result = await proposeAction(
        { provider: this.#provider, ledger: this.#ledger, audit: this.#audit },
        {
          observation,
          memoryCandidates: memories,
          retrieval: {
            nowSimTime: observation.simTime,
            location: observation.self.location,
            focusInhabitantIds: observation.nearbyInhabitants.map((item) => item.id),
            needs: observation.self.needs,
            goals: observation.self.privateGoals,
            situationTags: observation.nearbyTiles.map((tile) => tile.terrain),
            cognitionLevel: observation.cognitionLevel,
            maturity: observation.self.maturity,
          },
          modelId: this.#modelId,
          dayKey: this.#dayKey,
        },
      );
      const last = result.attempts.at(-1);
      return {
        action: result.status === "proposed" ? result.action : null,
        modelId: last?.modelId ?? this.#modelId,
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
    cognitionLevel: "routine",
    self: {
      id: source.self.id,
      displayName: source.self.displayName,
      generation: source.self.generation,
      maturity: source.self.maturity,
      birthTime: source.self.birthTime,
      location: source.self.location,
      terrain: tileAtSelf?.terrain ?? "unknown",
      activity: source.self.activity,
      energy: source.self.energy,
      computeAllowance: source.self.compute,
      integrity: source.self.integrity,
      confined: source.self.confinement !== null,
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
    authoredTexts: source.publicRecords.announcements.map((announcement) => ({
      id: `announcement_${announcement.sequence}`,
      kind: "announcement",
      authorId: announcement.speaker,
      authorName: announcement.speaker,
      simTime: announcement.simTime,
      body: announcement.text,
    })),
    worldNotices:
      source.self.confinement === null
        ? []
        : [`You are confined in structure ${source.self.confinement.structureId}.`],
    availableActions: IMPLEMENTED_ACTIONS.map((type) => {
      const spec = getActionSpec(type);
      return { type, description: spec.description };
    }),
  };
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

function tagsFrom(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])].sort().slice(0, 12);
}
