import worldFixture from "../../fixtures/world.json";
import type { ObservatoryRun } from "../observatory-types";

const WEEK_END = 7 * 24 * 60;
const world = worldFixture as any;
const inhabitants = world.inhabitants
  .filter((inhabitant: any) => inhabitant.birthSimTime < WEEK_END)
  .map((inhabitant: any) => ({
    id: inhabitant.id,
    displayName: inhabitant.name,
    generation: inhabitant.generation,
    creationSequence: Number(
      String(inhabitant.creationEventId ?? "0").replace(/\D/g, ""),
    ),
    birthTime: inhabitant.birthSimTime,
    location: inhabitant.at,
    status: inhabitant.status === "active" ? "alive" : inhabitant.status,
    activity: { state: "idle", activityId: null, busyUntil: 0 },
    voiceId: inhabitant.voice?.voiceId ?? `demo-${inhabitant.id}`,
  }));
const inhabitantIds = new Set(inhabitants.map((inhabitant: any) => inhabitant.id));

const mapping: Record<string, readonly [string, string]> = {
  move: ["move", "travelling"],
  gather: ["gather", "gathering"],
  "artifact.created": ["craft", "crafting"],
  "structure.built": ["build", "building"],
  "transfer.executed": ["transfer", "working"],
  "conversation.public": ["communicate", "conversing"],
  rest: ["rest", "sleeping"],
};

function minutesOf(event: any): number {
  const value = Number(event.inputs?.minutes);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

function detailOf(event: any): Record<string, unknown> {
  const location = event.location ?? { x: 0, y: 0 };
  if (event.type === "move") {
    const from = { x: Number(event.inputs.fromX), y: Number(event.inputs.fromY) };
    const to = { x: Number(event.inputs.toX), y: Number(event.inputs.toY) };
    return { from, to, path: [to], minutes: minutesOf(event) };
  }
  if (event.type === "gather") {
    return {
      resource: event.inputs.resource,
      amount: event.inputs.quantity,
      from: location,
      depositRemaining: Math.max(0, 12 - Number(event.inputs.depositDepletion ?? 0)),
      minutes: minutesOf(event),
    };
  }
  return {
    ...event.inputs,
    location,
    materials: {
      wood: Number(event.inputs.wood ?? 0),
      stone: Number(event.inputs.stone ?? 0),
    },
    minutes: minutesOf(event),
  };
}

const sourceEvents = world.events.filter(
  (event: any) => event.simTime < WEEK_END && mapping[event.type] !== undefined,
);

export const physicalDemoRun: ObservatoryRun = {
  exportVersion: 3,
  disclosurePolicy:
    "A deterministic seven-day canonical fixture for validating physical action replay.",
  disclosure: {
    policyVersion: 2,
    envelope: "Canonical participants, place, activity and duration.",
    contents: "This test reel contains public physical actions only.",
  },
  activities: sourceEvents.flatMap((event: any) => {
    const mapped = mapping[event.type];
    if (mapped === undefined || event.actor === null) return [];
    const duration = minutesOf(event);
    const participants = event.subjects.filter((id: string) => inhabitantIds.has(id));
    return [{
      id: `physical-${event.id}`,
      sequence: event.sequence,
      actionType: mapped[0],
      activityState: mapped[1],
      participants: participants.length > 0 ? participants : [event.actor],
      location: event.location ?? { x: 0, y: 0 },
      startedAt: Math.max(0, event.simTime - (event.type === "structure.built" ? duration : 0)),
      endsAt:
        event.type === "structure.built" ? event.simTime : event.simTime + duration,
      interruption: "partial_progress_kept",
      open: false,
      contentsDisclosed: true,
    }];
  }),
  world: {
    id: "AG-1-PHYSICAL-WEEK",
    seed: world.summary.genesisSeed,
    schemaVersion: 3,
    simTime: WEEK_END - 1,
    sequence: sourceEvents.at(-1)?.sequence ?? 0,
    checksum: world.summary.stateChecksum,
    chainHead: world.summary.chainHead,
  },
  map: {
    width: world.map.width,
    height: world.map.height,
    terrain: [...world.map.tiles]
      .sort((left: any, right: any) => left.y - right.y || left.x - right.x)
      .map((tile: any) => tile.terrain),
  },
  inhabitants,
  structures: world.map.structures.filter((structure: any) => structure.builtAt < WEEK_END),
  artifacts: world.artifacts.filter((artifact: any) => artifact.createdAt < WEEK_END),
  events: sourceEvents.map((event: any) => ({
    sequence: event.sequence,
    simTime: event.simTime,
    realTimestamp: event.realTime,
    canonicalType: event.type,
    actorId: event.actor,
    visibility: event.visibility,
    location: event.location ?? null,
    outcomeStatus: event.resolution,
    detail: detailOf(event),
    hash: event.hash,
    prevHash: event.prevHash,
  })),
};
