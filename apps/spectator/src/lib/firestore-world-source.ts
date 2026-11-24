// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
/**
 * A `WorldSource` backed by Cloud Firestore public projections.
 *
 * ## Read-only by construction
 *
 * This class connects to Firestore using the **client SDK** (Web modular API)
 * which respects security rules. The deployed security rules (§17) enforce:
 *
 *   - `/worlds/{worldId}` — public read, no write.
 *   - `/worlds/{worldId}/public/{document=**}` — public read, no write.
 *   - everything else — no read, no write.
 *
 * The client SDK credential used here has no Admin scope and cannot bypass
 * rules. This class is strictly query-only and performs zero write operations.
 *
 * ## Firestore document schema
 *
 * The runtime worker writes public projections under:
 *
 *   /worlds/{worldId}                          → WorldSummary header
 *   /worlds/{worldId}/public/map               → WorldMap document
 *   /worlds/{worldId}/public/inhabitants       → { items: Inhabitant[] }
 *   /worlds/{worldId}/public/events            → subcollection, one doc per event
 *   /worlds/{worldId}/public/organisations     → { items: Organisation[] }
 *   /worlds/{worldId}/public/artifacts         → { items: Artifact[] }
 *   /worlds/{worldId}/public/economy           → EconomySnapshot document
 *   /worlds/{worldId}/public/lineage           → Lineage document
 *   /worlds/{worldId}/public/audit             → AuditStatus document (minus chain)
 *
 * This class queries those documents. It never writes, enqueues, publishes, or
 * otherwise emits anything the simulation engine could observe.
 */

import { initializeApp, type FirebaseApp } from "firebase/app";
import {
  getFirestore,
  doc,
  getDoc,
  getDocs,
  collection,
  query,
  orderBy,
  limit as firestoreLimit,
  startAfter,
  where,
  type Firestore,
} from "firebase/firestore";

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

export interface FirestoreWorldSourceConfig {
  /** Firebase project configuration. */
  readonly firebaseConfig: {
    readonly apiKey: string;
    readonly authDomain: string;
    readonly projectId: string;
    readonly storageBucket?: string;
    readonly messagingSenderId?: string;
    readonly appId?: string;
  };
  /** The world to read from. */
  readonly worldId: string;
}

const DEFAULT_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 500;

export class FirestoreWorldSource implements WorldSource {
  readonly #db: Firestore;
  readonly #worldId: string;

  constructor(config: FirestoreWorldSourceConfig) {
    const app: FirebaseApp = initializeApp(config.firebaseConfig, `spectator-${config.worldId}`);
    this.#db = getFirestore(app);
    this.#worldId = config.worldId;
  }

  /** For testing: inject a Firestore instance directly. */
  static fromFirestore(db: Firestore, worldId: string): FirestoreWorldSource {
    const instance = Object.create(FirestoreWorldSource.prototype) as FirestoreWorldSource;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam
    (instance as any)["#db"] = db;
    (instance as any)["#worldId"] = worldId;
    return instance;
  }

  async getWorldSummary(): Promise<WorldSummary> {
    const snap = await getDoc(doc(this.#db, "worlds", this.#worldId));
    if (!snap.exists()) {
      throw new Error(`World "${this.#worldId}" not found in Firestore`);
    }
    return snap.data() as WorldSummary;
  }

  async getMap(): Promise<WorldMap> {
    const snap = await getDoc(doc(this.#db, "worlds", this.#worldId, "public", "map"));
    if (!snap.exists()) {
      throw new Error(`Map document not found for world "${this.#worldId}"`);
    }
    return snap.data() as WorldMap;
  }

  async getInhabitants(): Promise<InhabitantSummary[]> {
    const snap = await getDoc(doc(this.#db, "worlds", this.#worldId, "public", "inhabitants"));
    if (!snap.exists()) return [];
    const data = snap.data() as { items: Inhabitant[] };
    return data.items.map((i): InhabitantSummary => ({
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
      ...(i.topSkill ? { topSkill: i.topSkill } : {}),
      ...(i.deceasedAt !== undefined ? { deceasedAt: i.deceasedAt } : {}),
    }));
  }

  async getInhabitant(id: string): Promise<Inhabitant | null> {
    const snap = await getDoc(doc(this.#db, "worlds", this.#worldId, "public", "inhabitants"));
    if (!snap.exists()) return null;
    const data = snap.data() as { items: Inhabitant[] };
    return data.items.find((i) => i.id === id) ?? null;
  }

  async getEvents(eventQuery: EventQuery = {}): Promise<EventPage> {
    const pageLimit = Math.max(1, Math.min(eventQuery.limit ?? DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT));
    const eventsRef = collection(this.#db, "worlds", this.#worldId, "public", "events", "items");

    // Build query constraints
    const constraints: Parameters<typeof query>[1][] = [
      orderBy("sequence", "desc"),
      firestoreLimit(pageLimit + 1), // fetch one extra to determine nextCursor
    ];

    if (eventQuery.cursor !== undefined) {
      constraints.push(startAfter(Number(eventQuery.cursor)));
    }

    const filter = eventQuery.filter;
    if (filter?.types && filter.types.length > 0) {
      constraints.push(where("type", "in", filter.types.slice(0, 10)));
    }
    if (filter?.actorIds && filter.actorIds.length > 0) {
      constraints.push(where("actor", "in", filter.actorIds.slice(0, 10)));
    }
    if (filter?.fromSimTime !== undefined) {
      constraints.push(where("simTime", ">=", filter.fromSimTime));
    }
    if (filter?.toSimTime !== undefined) {
      constraints.push(where("simTime", "<=", filter.toSimTime));
    }

    const q = query(eventsRef, ...constraints);
    const snapshot = await getDocs(q);

    const events: WorldEvent[] = [];
    snapshot.forEach((docSnap) => {
      events.push(docSnap.data() as WorldEvent);
    });

    // Client-side filter for search and subjectId (not indexable in Firestore)
    const filtered = filter
      ? events.filter((e) => {
          if (filter.subjectId && !e.subjects.includes(filter.subjectId)) return false;
          if (filter.withClaimsOnly && e.claims.length === 0) return false;
          if (filter.search) {
            const needle = filter.search.toLowerCase();
            const haystack = `${e.description} ${e.type} ${e.actorName ?? ""} ${e.id} ${e.hash}`.toLowerCase();
            if (!haystack.includes(needle)) return false;
          }
          return true;
        })
      : events;

    const page = filtered.slice(0, pageLimit);
    const hasNext = filtered.length > pageLimit;

    return {
      events: page,
      nextCursor: hasNext && page.length > 0 ? String(page[page.length - 1]?.sequence) : null,
      total: page.length, // Firestore does not provide free total counts
    };
  }

  async getOrganisations(): Promise<Organisation[]> {
    const snap = await getDoc(doc(this.#db, "worlds", this.#worldId, "public", "organisations"));
    if (!snap.exists()) return [];
    return (snap.data() as { items: Organisation[] }).items;
  }

  async getArtifacts(): Promise<Artifact[]> {
    const snap = await getDoc(doc(this.#db, "worlds", this.#worldId, "public", "artifacts"));
    if (!snap.exists()) return [];
    return (snap.data() as { items: Artifact[] }).items;
  }

  async getEconomy(): Promise<EconomySnapshot> {
    const snap = await getDoc(doc(this.#db, "worlds", this.#worldId, "public", "economy"));
    if (!snap.exists()) {
      return { currencies: [], ledger: [], trades: [], contracts: [], nonMonetaryTransferCount: 0 };
    }
    return snap.data() as EconomySnapshot;
  }

  async getLineage(): Promise<Lineage> {
    const snap = await getDoc(doc(this.#db, "worlds", this.#worldId, "public", "lineage"));
    if (!snap.exists()) {
      return { nodes: [], rootIds: [], generationCount: 0 };
    }
    return snap.data() as Lineage;
  }

  async getAuditStatus(): Promise<AuditStatus> {
    const snap = await getDoc(doc(this.#db, "worlds", this.#worldId, "public", "audit"));
    if (!snap.exists()) {
      throw new Error(`Audit document not found for world "${this.#worldId}"`);
    }
    const audit = snap.data() as Omit<AuditStatus, "chain">;

    // Retrieve the full event log and recompute the chain locally — the
    // spectator never trusts a pre-computed chain from the publisher (§16).
    const eventsRef = collection(this.#db, "worlds", this.#worldId, "public", "events", "items");
    const q = query(eventsRef, orderBy("sequence", "asc"));
    const eventSnap = await getDocs(q);
    const events: WorldEvent[] = [];
    eventSnap.forEach((d) => events.push(d.data() as WorldEvent));

    const chain = verifyEventChain(events);

    return {
      ...audit,
      chain: { ...chain, computedAt: new Date().toISOString() },
    };
  }
}
