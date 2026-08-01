import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonl, replayHistory } from "@after-genesis/audit";
import type { CanonicalEvent, WorldState } from "@after-genesis/core";

const EXPLORE_RADIUS = 5;

function expandDiscovery(knownLocations: readonly string[], map: { readonly width: number; readonly height: number }): Set<string> {
  const discovered = new Set<string>();
  for (const key of knownLocations) {
    const [rawX, rawY] = key.split(",");
    const x = Number(rawX);
    const y = Number(rawY);
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    for (let dy = -EXPLORE_RADIUS; dy <= EXPLORE_RADIUS; dy += 1) {
      for (let dx = -EXPLORE_RADIUS; dx <= EXPLORE_RADIUS; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        if (Math.max(Math.abs(dx), Math.abs(dy)) > EXPLORE_RADIUS) continue;
        discovered.add(`${nx},${ny}`);
      }
    }
  }
  return discovered;
}

describe("Export simulation run to Spectator fixture", () => {
  it("converts 2,001-turn simulation run into world.json fixture", () => {
    const RUN_DIR = resolve(process.env.AG_EXPORT_RUN_DIR ?? ".worlds/3-month-run");
    const OUTPUT_FILE = resolve(
      process.env.AG_EXPORT_OUTPUT_FILE ?? "apps/spectator/src/fixtures/world-run-test.json",
    );

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

    const livingInhabitants = Object.values(state.inhabitants).filter(
      (i) => i.status === "active" || i.status === "alive",
    );
    const deceasedInhabitants = Object.values(state.inhabitants).filter((i) => i.status === "deceased");

    const formattedInhabitants = Object.values(state.inhabitants).map((i) => ({
      id: i.id,
      name: i.displayName,
      generation: i.generation,
      status: i.status === "alive" ? "active" : i.status,
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
        description: formatEventDescription(e, state),
        subjects: e.actor ? [e.actor] : [],
        location: actorInhabitant?.location,
        inputs: e.inputs as Record<string, unknown>,
        resolution: "applied" as const,
        visibility: "public",
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

    const discovered = Object.values(state.inhabitants).reduce((acc, inhabitant) => {
      for (const tile of expandDiscovery(inhabitant.knownLocations ?? [], state.map)) {
        acc.add(tile);
      }
      return acc;
    }, new Set<string>());

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
        x,
        y,
        terrain: terrainKind,
        ...(tileDeposits[0]
          ? {
              deposit: {
                resource: tileDeposits[0].resource,
                remaining: tileDeposits[0].remaining,
              },
            }
          : {}),
        ...(structOnTile ? { structureId: structOnTile.id } : {}),
      };
    });

    const map = {
      width: state.map.width,
      height: state.map.height,
      genesisSeed: state.seed,
      tiles,
      discovered: [...discovered],
      deposits: rawDeposits.map((d: any) => ({
        id: d.id,
        resource: d.resource,
        at: d.location ?? d.at,
        remaining: d.remaining,
        initialQuantity: d.initialQuantity ?? d.remaining,
      })),
      structures: Object.values(state.structures).map((s) => ({
        id: s.id,
        // Engine structures are canonical physical objects.  Their creation
        // time and owner are `createdAt` / `owner`, not the old fixture-only
        // `creationTime` / `ownerId` aliases.  Exporting those aliases left
        // `builtAt` undefined and rendered “Day NaN” in the live map.
        name: s.kind,
        kind: s.kind,
        at: s.location,
        ownerId: s.owner ?? s.ownerOrganisation ?? "none",
        ownerKind: s.owner !== null ? "inhabitant" : "organisation",
        builtAt: s.createdAt,
        builtByEvent: `evt_${s.createdSequence.toString().padStart(6, "0")}`,
        condition: s.integrity / 100,
        capacity: s.capacity,
      })),
      occupants: Object.values(state.inhabitants).map((i) => ({
        id: i.id,
        name: i.displayName,
        at: i.location,
        status: i.status === "alive" ? "active" : i.status,
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
        status: i.status === "alive" ? "active" : i.status,
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
        startedAt: lastEvent.realTimestamp,
        finishedAt: lastEvent.realTimestamp,
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
      withheld: [
        {
          kind: "model-audit",
          reason:
            "This offline rehearsal did not write a separate model audit directory. Run with a provider/audit store to expose raw model prompts and responses.",
        },
      ],
    };

    expect(map.structures.every((structure) => Number.isFinite(structure.builtAt))).toBe(true);

    const fixture = {
      generatedBy: "apps/spectator/scripts/export-run-to-fixture.test.ts",
      note:
        "Generated directly from a 2,001-event simulation run. This rehearsal export is transparent: all event visibility is opened for spectator inspection.",
      summary,
      map,
      inhabitants: formattedInhabitants,
      events: formattedEvents,
      organisations: [],
      artifacts: Object.values(state.artifacts).map((a) => {
        const owner = a.owner ? state.inhabitants[a.owner] : null;
        return {
          id: a.id,
          title: a.title,
          kind: a.kind as any,
          excerpt: a.content,
          creatorIds: [...a.creators],
          creatorNames: a.creators.map((id) => state.inhabitants[id]?.displayName ?? id),
          createdAt: a.createdAt,
          creationEventId: `evt_000000`,
          ownerId: a.owner ?? "none",
          ownerName: owner?.displayName ?? a.owner ?? "None",
          ownerKind: (a.owner ? "inhabitant" : "organisation") as any,
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
          kind: "sale" as const,
          counterpartyIds: [...c.parties],
          counterpartyNames: c.parties.map((id) => state.inhabitants[id]?.displayName ?? id),
          summary: c.terms,
          agreedAt: c.createdAt,
          status:
            c.status === "active"
              ? "active" as const
              : c.status === "performed"
                ? "fulfilled" as const
                : c.status === "terminated"
                  ? "breached" as const
                  : "void" as const,
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

function actorName(e: CanonicalEvent, state: WorldState): string {
  if (e.actor === null) return "The world engine";
  return state.inhabitants[e.actor]?.displayName ?? e.actor;
}

function coordText(coord: unknown): string | null {
  if (typeof coord !== "object" || coord === null) return null;
  const value = coord as { readonly x?: unknown; readonly y?: unknown };
  return typeof value.x === "number" && typeof value.y === "number"
    ? `tile (${value.x},${value.y})`
    : null;
}

function payloadOf(e: CanonicalEvent): Record<string, unknown> {
  const inputs = e.inputs as Record<string, unknown>;
  const action = inputs.action;
  if (typeof action === "object" && action !== null) {
    const actionPayload = (action as Record<string, unknown>).payload;
    if (typeof actionPayload === "object" && actionPayload !== null) {
      return actionPayload as Record<string, unknown>;
    }
  }
  const payload = inputs.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : inputs;
}

function textAt(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberAt(record: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function listNames(ids: readonly string[], state: WorldState): string {
  const names = ids.map((id) => state.inhabitants[id]?.displayName ?? id);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * What an inhabitant reached for, when the world refused to let them have it.
 *
 * Deliberately an attempt rather than an accomplishment: a rejected action
 * changed nothing, and the log has to say so.
 */
function formatRejection(
  actionType: string,
  actor: string,
  payload: Readonly<Record<string, unknown>>,
  reason: string | null,
): string {
  const resource = textAt(payload, "resource");
  const attempt =
    actionType === "gather"
      ? `gather ${resource ?? "resources"}`
      : actionType === "consume"
        ? `consume ${resource ?? "resources"}`
        : actionType === "move"
          ? `move${coordText(payload.to) === null ? "" : ` to ${coordText(payload.to)}`}`
          : actionType.replace(/_/g, " ");
  return `${actor} tried to ${attempt}, without effect${reason === null ? "" : `: ${reason}`}.`;
}

function formatEventDescription(e: CanonicalEvent, state: WorldState): string {
  if (e.type === "genesis") return "Genesis — the world is spoken into being.";
  const actor = actorName(e, state);
  const payload = payloadOf(e);
  const detail = (e.resolution as { readonly detail?: unknown } | undefined)?.detail;
  const outcome = (
    e.resolution as
      | {
          readonly outcome?: {
            readonly detail?: unknown;
            readonly status?: unknown;
            readonly reason?: unknown;
          };
        }
      | undefined
  )?.outcome;

  // A refused action is not a smaller version of a successful one. Rendering it
  // as an accomplishment states that something occurred which did not, and this
  // log is the engine's record of what observably happened (§16, §11G).
  if (outcome?.status === "rejected") {
    return formatRejection(
      e.type.replace(/^action\./, ""),
      actor,
      payload,
      typeof outcome.reason === "string" && outcome.reason.trim().length > 0
        ? outcome.reason.trim()
        : null,
    );
  }

  const outcomeDetail = outcome?.detail;
  const resolved =
    typeof outcomeDetail === "object" && outcomeDetail !== null
      ? (outcomeDetail as Record<string, unknown>)
      : typeof detail === "object" && detail !== null
        ? (detail as Record<string, unknown>)
        : {};
  const actionType = e.type.replace(/^action\./, "");

  if (actionType === "move") {
    const to = coordText(payload.to) ?? coordText(payload.destination) ?? coordText(resolved.to);
    return `${actor} moved${to === null ? "" : ` to ${to}`}.`;
  }
  if (actionType === "gather") {
    const resource = textAt(payload, "resource") ?? textAt(resolved, "resource") ?? "resources";
    const amount = numberAt(resolved, "amount") ?? numberAt(payload, "amount");
    const amountText = amount === null ? "" : `${amount} `;
    return `${actor} gathered ${amountText}${resource}.`;
  }
  if (actionType === "consume") {
    const resource = textAt(payload, "resource") ?? textAt(resolved, "resource") ?? "resources";
    // What was actually consumed, not merely what was asked for: the engine may
    // resolve a different amount than the proposal named.
    const amount = numberAt(resolved, "amount") ?? numberAt(payload, "amount");
    return `${actor} consumed${amount === null ? "" : ` ${amount}`} ${resource}.`;
  }
  if (actionType === "rest") {
    return `${actor} rested.`;
  }
  if (actionType === "wait") {
    return `${actor} waited.`;
  }
  if (actionType === "observe") {
    return `${actor} observed the nearby world.`;
  }
  if (actionType === "communicate" || actionType === "announce" || actionType === "perform") {
    const message = textAt(payload, "message") ?? textAt(resolved, "message");
    const recipients = Array.isArray(payload.recipients)
      ? payload.recipients.filter((id): id is string => typeof id === "string")
      : [];
    const audience = recipients.length > 0 ? ` to ${listNames(recipients, state)}` : "";
    return message === null
      ? `${actor} communicated${audience}.`
      : `${actor} communicated${audience}: ${message}`;
  }
  if (actionType === "study") {
    const skill = textAt(payload, "skill") ?? textAt(resolved, "skill") ?? "a subject";
    return `${actor} studied ${skill}.`;
  }
  if (actionType === "teach") {
    const students = Array.isArray(payload.studentIds)
      ? payload.studentIds.filter((id): id is string => typeof id === "string")
      : [];
    const skill = textAt(payload, "skill") ?? "a skill";
    const studentText = students.length > 0 ? ` to ${listNames(students, state)}` : "";
    return `${actor} taught ${skill}${studentText}.`;
  }
  if (actionType === "create_artifact") {
    const title = textAt(payload, "title") ?? textAt(resolved, "title") ?? "an artifact";
    return `${actor} created ${title}.`;
  }
  if (actionType === "create_inhabitant") {
    const childId = textAt(resolved, "childId") ?? textAt(payload, "childId");
    const child = childId === null ? "a new inhabitant" : (state.inhabitants[childId]?.displayName ?? childId);
    return `${actor} created ${child}.`;
  }
  if (actionType === "build") {
    const structure = textAt(payload, "name") ?? textAt(resolved, "structureId") ?? "a structure";
    return `${actor} built ${structure}.`;
  }
  return `${actor} performed ${e.type}.`;
}
