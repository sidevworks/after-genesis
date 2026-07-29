/**
 * After Genesis — the spectator application's only door onto the world.
 *
 * ## Read-only by construction
 *
 * `WorldSource` is the complete set of operations this application may perform
 * against world state. Every method is a query. There is deliberately no
 * `create*`, `update*`, `set*`, `delete*`, `send*`, `submit*` or `propose*`
 * member, and there must never be one.
 *
 *   claude.md §17  — "The public client must have no canonical write path."
 *   claude.md §20  — "The spectator interface must never contain controls
 *                     capable of influencing inhabitants."
 *   claude.md §28  — "No human-facing canonical write route exists."
 *
 * The shape of this interface is the enforcement mechanism, not a convention:
 * `src/lib/read-only.test.ts` fails the build if a mutating member name is
 * introduced here, if any route gains a form or a submitting control, or if any
 * source file gains a non-GET network call or a server action.
 *
 * ## Swapping the data source
 *
 * Exactly one line below binds the implementation. Replacing the fixture with a
 * real Firestore reader is that single change; nothing else in the application
 * knows where the data came from.
 *
 *     export const worldSource: WorldSource = new FirestoreWorldSource(db);
 *
 * A Firestore implementation must be constructed from a credential with read
 * scope only, and must never be given a client that can write.
 */

import { FixtureWorldSource } from "./fixture-world-source";
import { FirestoreWorldSource } from "./firestore-world-source";
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
  WorldMap,
  WorldSummary,
} from "./world-types";

export type * from "./world-types";

/**
 * A read-only projection of the canonical world.
 *
 * Implementations must be side-effect free with respect to world state. They
 * may cache, memoise and paginate. They may not write, enqueue, publish or
 * otherwise emit anything that the simulation engine could observe.
 */
export interface WorldSource {
  /** Clock, population, checksums and chain head for the header and landing page. */
  getWorldSummary(): Promise<WorldSummary>;

  /** Terrain grid, constructed structures and current inhabitant positions. */
  getMap(): Promise<WorldMap>;

  /** Every inhabitant, living and deceased. Death never removes anyone (§8). */
  getInhabitants(): Promise<InhabitantSummary[]>;

  /** Full profile, or `null` when no such inhabitant has ever existed. */
  getInhabitant(id: string): Promise<Inhabitant | null>;

  /** A page of the append-only canonical log, newest first. */
  getEvents(query?: EventQuery): Promise<EventPage>;

  getOrganisations(): Promise<Organisation[]>;

  getArtifacts(): Promise<Artifact[]>;

  /** Currencies, ledgers, trades and contracts. */
  getEconomy(): Promise<EconomySnapshot>;

  /** Descent graph across all generations, including deceased inhabitants. */
  getLineage(): Promise<Lineage>;

  /**
   * Chain verification result, state checksum, deployed commit and the
   * instructions a member of the public needs to reproduce all of it (§16).
   */
  getAuditStatus(): Promise<AuditStatus>;
}

/**
 * The bound implementation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SWAP POINT — set NEXT_PUBLIC_WORLD_SOURCE=firestore to read from Firestore.
 * Defaults to "fixture" for local offline rendering and development.
 * ─────────────────────────────────────────────────────────────────────────────
 */
function createWorldSource(): WorldSource {
  const sourceMode = process.env.NEXT_PUBLIC_WORLD_SOURCE ?? "fixture";

  if (sourceMode === "firestore") {
    const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    const worldId = process.env.NEXT_PUBLIC_WORLD_ID;

    if (!apiKey || !projectId || !worldId) {
      throw new Error(
        "Firestore world source requires NEXT_PUBLIC_FIREBASE_API_KEY, " +
          "NEXT_PUBLIC_FIREBASE_PROJECT_ID, and NEXT_PUBLIC_WORLD_ID environment variables.",
      );
    }

    return new FirestoreWorldSource({
      firebaseConfig: {
        apiKey,
        authDomain: `${projectId}.firebaseapp.com`,
        projectId,
      },
      worldId,
    });
  }

  return new FixtureWorldSource();
}

export const worldSource: WorldSource = createWorldSource();

