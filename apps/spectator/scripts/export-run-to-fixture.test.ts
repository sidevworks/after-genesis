import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonl, replayHistory } from "@after-genesis/audit";
import type { CanonicalEvent, WorldState } from "@after-genesis/core";

describe("Export simulation run to Spectator fixture", () => {
  it("converts 2,001-turn simulation run into world.json fixture", () => {
    const RUN_DIR = resolve(".worlds/3-month-run");
    const OUTPUT_FILE = resolve("apps/spectator/src/fixtures/world-run-test.json");

    const eventsPath = join(RUN_DIR, "events", "after-genesis-demo.jsonl");
    if (!existsSync(eventsPath)) {
      console.warn("No simulation run found at", eventsPath);
      return;
    }

    const rawEvents = readFileSync(eventsPath, "utf8");
    const { values } = parseJsonl(rawEvents);
    const events = values as CanonicalEvent[];
    expect(events.length).toBeGreaterThan(0);

    const replay = replayHistory(events);
    // A recording made before a canonical schema change cannot replay against
    // the current engine: the inhabitant checksum covers different fields, so
    // every post-state hash in the file disagrees. That is the intended
    // behaviour (§23 — a constitutional change ends the current experiment),
    // not a replay defect. `.worlds/` is a local rehearsal artifact, so the
    // fix is to re-record it, and the message needs to say which of the two
    // situations this is.
    expect(
      replay.ok,
      `replay of ${eventsPath} failed at ${replay.mismatches.length} event(s); ` +
        `first: ${JSON.stringify(replay.mismatches[0] ?? null)}. ` +
        `If the engine's canonical schema has changed since this run was recorded, ` +
        `re-record it with \`npm run world\` rather than relaxing this assertion.`,
    ).toBe(true);
    expect(replay.state).not.toBeNull();

    const state: WorldState = replay.state!;
    const lastEvent = events[events.length - 1]!;

    const livingInhabitants = Object.values(state.inhabitants).filter((i) => i.status === "active");
    const deceasedInhabitants = Object.values(state.inhabitants).filter((i) => i.status === "deceased");

    const formattedInhabitants = Object.values(state.inhabitants).map((i) => ({
      id: i.id,
      name: i.displayName,
      generation: i.generation,
      status: i.status,
      at: i.location,
      birthSimTime: i.birthTime,
      creationEventId: `evt_${i.creationSequence.toString().padStart(6, "0")}`,
      parentIds: i.parentIds,
      childIds: i.childIds,
      energy: i.inventory.energy ?? 100,
      activity: i.activityState,
      reputation: 50,
      traits: Object.entries(i.traits).map(([name, level]) => ({ name, level })),
      values: i.values,
      privateGoals: i.privateGoals,
      privateGoalCount: i.privateGoals?.length ?? 1,
      disclosedGoals: [],
      needs: [
        { name: "nourishment", level: 0.8 },
        { name: "rest", level: 0.8 },
      ],
      computeAllowance: { usedToday: 12, dailyLimit: 100 },
      skills: [],
      property: { structureIds: [], landTiles: [] },
      balances: [],
      relationships: [],
      reputationDetail: [{ context: "general", value: 0.5 }],
      memberships: [],
      contracts: [],
      health: { integrity: 1.0, conditions: [], history: [] },
      publicMemories: [],
      voice: { voiceId: "voice-standard", description: "Clear, neutral tone." },
      model: { provider: "gemini", model: "gemini-2.5-flash", version: "1.0" },
      lastActionSimTime: state.simTime,
      nextEligibleSimTime: state.simTime + 15,
      inventory: Object.entries(i.inventory ?? {}).map(([resource, quantity]) => ({
        resource,
        quantity: typeof quantity === "number" ? quantity : 0,
      })),
      ...(i.deceasedAt !== undefined ? { deceasedAt: i.deceasedAt } : {}),
    }));

    const formattedEvents = events.map((e) => {
      const actorInhabitant = e.actor ? state.inhabitants[e.actor] : null;
      return {
        id: `evt_${e.sequence.toString().padStart(6, "0")}`,
        worldId: e.worldId,
        sequence: e.sequence,
        simTime: e.simTime,
        realTime: e.realTimestamp,
        actor: e.actor,
        actorName: actorInhabitant?.displayName ?? e.actor,
        type: e.type,
        description: formatEventDescription(e),
        subjects: e.actor ? [e.actor] : [],
        location: actorInhabitant?.location,
        inputs: e.inputs as Record<string, string | number | boolean>,
        resolution: "applied" as const,
        visibility: e.visibility.kind === "public" ? "public" : "restricted",
        preStateChecksum: e.preStateChecksum,
        postStateChecksum: e.postStateChecksum,
        prevHash: e.prevHash,
        hash: e.hash,
        sourceCommit: e.provenance.sourceCommit,
        imageDigest: e.provenance.deployedDigest,
        claims: [],
      };
    });

    const summary = {
      worldId: state.worldId,
      genesisSeed: state.seed,
      schemaVersion: "world-rules/1.4.0",
      status: "running",
      simTime: state.simTime,
      lastEventAt: lastEvent.realTimestamp,
      mapWidth: state.map.width,
      mapHeight: state.map.height,
      population: {
        living: livingInhabitants.length,
        deceased: deceasedInhabitants.length,
        total: Object.keys(state.inhabitants).length,
        byGeneration: [0, 1, 2].map((g) => livingInhabitants.filter((i) => i.generation === g).length),
      },
      structureCount: Object.keys(state.structures).length,
      organisationCount: Object.keys(state.organisations).length,
      artifactCount: Object.keys(state.artifacts).length,
      eventCount: events.length,
      chainHead: lastEvent.hash,
      stateChecksum: replay.finalChecksum!,
      sourceCommit: lastEvent.provenance.sourceCommit,
      imageDigest: lastEvent.provenance.deployedDigest,
    };

    const rawDeposits = state.map.deposits ?? Object.values(state.deposits ?? {});
    const tiles = state.map.terrain.map((terrainKind, index) => {
      const x = index % state.map.width;
      const y = Math.floor(index / state.map.width);
      const tileDeposits = rawDeposits
        .filter((d: any) => {
          const loc = d.location ?? d.at;
          return loc && loc.x === x && loc.y === y;
        })
        .map((d: any) => ({
          id: d.id,
          resource: d.resource,
          at: { x, y },
          remaining: d.remaining,
          initialQuantity: d.initialQuantity ?? d.remaining,
        }));
      const structOnTile = Object.values(state.structures).find(
        (s) => s.location.x === x && s.location.y === y,
      );
      return {
        coord: { x, y },
        terrain: terrainKind,
        deposits: tileDeposits,
        ...(structOnTile ? { structureId: structOnTile.id } : {}),
      };
    });

    const map = {
      width: state.map.width,
      height: state.map.height,
      genesisSeed: state.seed,
      tiles,
      deposits: rawDeposits.map((d: any) => ({
        id: d.id,
        resource: d.resource,
        at: d.location ?? d.at,
        remaining: d.remaining,
        initialQuantity: d.initialQuantity ?? d.remaining,
      })),
      structures: Object.values(state.structures).map((s) => ({
        id: s.id,
        name: s.displayName,
        kind: s.kind,
        at: s.location,
        ownerId: s.ownerId ?? s.governingOrganisationId ?? "none",
        ownerKind: s.ownerId ? "inhabitant" : "organisation",
        builtAt: s.creationTime,
        condition: s.integrity / 100,
        capacity: s.capacity,
      })),
      occupants: Object.values(state.inhabitants).map((i) => ({
        id: i.id,
        name: i.displayName,
        at: i.location,
        status: i.status,
        generation: i.generation,
      })),
    };

    const lineage = {
      nodes: Object.values(state.inhabitants).map((i) => ({
        id: i.id,
        name: i.displayName,
        generation: i.generation,
        parentIds: i.parentIds,
        childIds: i.childIds,
        status: i.status,
        birthSimTime: i.birthTime,
        creationEventId: `evt_${i.creationSequence.toString().padStart(6, "0")}`,
        ...(i.deceasedAt !== undefined ? { deathSimTime: i.deceasedAt } : {}),
      })),
      rootIds: Object.values(state.inhabitants).filter((i) => i.generation === 0).map((i) => i.id),
      generationCount: 1,
    };

    const audit = {
      stateChecksum: replay.finalChecksum!,
      sourceCommit: lastEvent.provenance.sourceCommit,
      imageDigest: lastEvent.provenance.deployedDigest,
      schemaVersion: "world-rules/1.4.0",
      genesisSeed: state.seed,
      lastReplay: {
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        reconstructedChecksum: replay.finalChecksum!,
        matchesProduction: true,
        eventsReplayed: events.length,
      },
      anchors: [],
      verifier: {
        repository: "github.com/sidevworks/after-genesis",
        command: `npx @after-genesis/verify --export world-${state.worldId}.jsonl`,
        exportUrl: `https://storage.after-genesis.example/exports/world-${state.worldId}.jsonl`,
        notes: ["Verifier checks hash chain continuity and state checksum recomputation."],
      },
      withheld: [],
    };

    const fixture = {
      generatedBy: "apps/spectator/scripts/export-run-to-fixture.test.ts",
      note: "Generated directly from 2,001-event simulation run.",
      summary,
      map,
      inhabitants: formattedInhabitants,
      events: formattedEvents,
      organisations: [],
      artifacts: Object.values(state.artifacts).map((a) => {
        const creator = state.inhabitants[a.creatorId];
        const owner = a.ownerId ? state.inhabitants[a.ownerId] : null;
        return {
          id: a.id,
          title: a.displayName,
          kind: a.kind as any,
          excerpt: a.displayName,
          creatorIds: [a.creatorId],
          creatorNames: [creator?.displayName ?? a.creatorId],
          createdAt: a.creationTime,
          creationEventId: `evt_000000`,
          ownerId: a.ownerId ?? "none",
          ownerName: owner?.displayName ?? a.ownerId ?? "None",
          ownerKind: (a.ownerId ? "inhabitant" : "organisation") as any,
          publicationStatus: "published" as const,
          provenance: [],
          revisions: [],
          costs: [],
          generatedMedia: [],
        };
      }),
      economy: {
        currencies: Object.values(state.currencies).map((c) => ({
          id: c.id,
          issuerId: c.issuer,
          name: c.name,
          symbol: c.symbol,
          issuedSupply: c.issuedSupply,
          publicLedger: c.publicLedger,
          transferRule: c.transferRule,
        })),
        ledger: [],
        trades: [],
        contracts: Object.values(state.contracts).map((c) => ({
          id: c.id,
          parties: c.parties,
          status: c.status,
          terms: c.terms,
        })),
        nonMonetaryTransferCount: 0,
      },
      lineage,
      audit,
    };

    writeFileSync(OUTPUT_FILE, JSON.stringify(fixture, null, 1) + "\n", "utf8");
    expect(existsSync(OUTPUT_FILE)).toBe(true);
  });
});

function formatEventDescription(e: CanonicalEvent): string {
  if (e.type === "genesis") return "Genesis — the world is spoken into being.";
  const actor = e.actor ?? "Engine";
  if (e.type === "move") {
    const to = (e.inputs as { payload?: { to?: { x: number; y: number } } })?.payload?.to;
    return `${actor} moved${to ? ` to tile (${to.x},${to.y})` : ""}.`;
  }
  if (e.type === "gather") {
    const res = (e.inputs as { payload?: { resource?: string } })?.payload?.resource ?? "resources";
    return `${actor} gathered ${res}.`;
  }
  if (e.type === "rest") {
    return `${actor} rested.`;
  }
  if (e.type === "wait") {
    return `${actor} waited.`;
  }
  return `${actor} performed ${e.type}.`;
}
