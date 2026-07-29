/**
 * A `WorldSource` backed by a committed deterministic JSON fixture.
 *
 * The engine and persistence layers are built in parallel with this app. Until
 * a real export exists, the spectator reads a fixture that has the same shape
 * and the same hash-chain discipline as the real thing — including a chain the
 * audit page genuinely recomputes rather than trusts.
 *
 * Read-only, like every `WorldSource`. It holds the fixture in memory, answers
 * queries from it, and never writes anything anywhere.
 *
 * Regenerate the fixture with `npm run fixtures:generate`.
 */

import fixture from "../fixtures/world.json";
import { readFile } from "node:fs/promises";
import { liveWorldPath } from "./dev-world-paths";
import { verifyEventChain } from "./event-hash";
import type { WorldSource } from "./world-source";
import type {
  Artifact,
  AuditStatus,
  EconomySnapshot,
  EventPage,
  EventQuery,
  Inhabitant,
  InhabitantSummary,
  Lineage,
  Organisation,
  WorldEvent,
  WorldMap,
  WorldSummary,
} from "./world-types";

interface WorldFixture {
  summary: WorldSummary;
  map: WorldMap;
  inhabitants: Inhabitant[];
  events: WorldEvent[];
  organisations: Organisation[];
  artifacts: Artifact[];
  economy: EconomySnapshot;
  lineage: Lineage;
  audit: Omit<AuditStatus, "chain">;
}

const world = fixture as unknown as WorldFixture;

const DEFAULT_LIMIT = 50;

function matches(event: WorldEvent, filter: NonNullable<EventQuery["filter"]>): boolean {
  if (filter.types && filter.types.length > 0 && !filter.types.includes(event.type)) {
    return false;
  }
  if (filter.actorIds && filter.actorIds.length > 0) {
    if (event.actor === null || !filter.actorIds.includes(event.actor)) return false;
  }
  if (filter.subjectId && !event.subjects.includes(filter.subjectId)) return false;
  if (filter.fromSimTime !== undefined && event.simTime < filter.fromSimTime) return false;
  if (filter.toSimTime !== undefined && event.simTime > filter.toSimTime) return false;
  if (filter.withClaimsOnly && event.claims.length === 0) return false;
  if (filter.search) {
    const needle = filter.search.toLowerCase();
    const haystack = `${event.description} ${event.type} ${event.actorName ?? ""} ${event.id} ${event.hash}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export class FixtureWorldSource implements WorldSource {
  readonly #world: WorldFixture;

  constructor(data: WorldFixture = world) {
    this.#world = data;
  }

  async #read(): Promise<WorldFixture> {
    if (process.env.NEXT_PUBLIC_DEV_WORLD_CONTROLS !== "true") return this.#world;
    const raw = await readFile(liveWorldPath(), "utf8");
    return JSON.parse(raw) as WorldFixture;
  }

  async getWorldSummary(): Promise<WorldSummary> {
    return (await this.#read()).summary;
  }

  async getMap(): Promise<WorldMap> {
    return (await this.#read()).map;
  }

  async getInhabitants(): Promise<InhabitantSummary[]> {
    return (await this.#read()).inhabitants.map((i) => {
      const summary: InhabitantSummary = {
        id: i.id,
        name: i.name,
        generation: i.generation,
        status: i.status,
        at: i.at,
        birthSimTime: i.birthSimTime,
        parentIds: i.parentIds,
        energy: i.energy,
        activity: i.activity,
        reputation: i.reputation,
      };
      if (i.topSkill) summary.topSkill = i.topSkill;
      if (i.deceasedAt !== undefined) summary.deceasedAt = i.deceasedAt;
      return summary;
    });
  }

  async getInhabitant(id: string): Promise<Inhabitant | null> {
    return (await this.#read()).inhabitants.find((i) => i.id === id) ?? null;
  }

  async getEvents(query: EventQuery = {}): Promise<EventPage> {
    const world = await this.#read();
    const filter = query.filter ?? {};
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_LIMIT, 500));

    const filtered = world.events
      .filter((event) => matches(event, filter))
      .sort((a, b) => b.sequence - a.sequence);

    const start =
      query.cursor === undefined
        ? 0
        : Math.max(
            0,
            filtered.findIndex((e) => e.sequence === Number(query.cursor)),
          );

    const page = filtered.slice(start, start + limit);
    const next = filtered[start + limit];

    return {
      events: page,
      nextCursor: next ? String(next.sequence) : null,
      total: filtered.length,
    };
  }

  async getOrganisations(): Promise<Organisation[]> {
    return (await this.#read()).organisations;
  }

  async getArtifacts(): Promise<Artifact[]> {
    return (await this.#read()).artifacts;
  }

  async getEconomy(): Promise<EconomySnapshot> {
    return (await this.#read()).economy;
  }

  async getLineage(): Promise<Lineage> {
    return (await this.#read()).lineage;
  }

  async getAuditStatus(): Promise<AuditStatus> {
    // Recomputed, not read from the fixture. If the committed log were altered
    // by hand, this is where it would show up.
    const world = await this.#read();
    const chain = verifyEventChain(world.events);
    return {
      ...world.audit,
      chain: { ...chain, computedAt: new Date().toISOString() },
    };
  }
}
