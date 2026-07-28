/**
 * Deterministic fixture generator for the After Genesis spectator app.
 *
 *   node --experimental-strip-types src/fixtures/generate.mts
 *
 * Produces `world.json`, which is committed. Running this again on the same
 * seed must produce a byte-identical file — the fixture is a stand-in for a
 * deterministic world, so it had better be deterministic itself.
 *
 * This script is a *development tool*. It is not imported by the application
 * and never runs in the browser. It writes one file inside this app directory
 * and nothing else. It has no connection of any kind to canonical world state.
 *
 * The events it emits obey the presentation rules the real log must obey:
 * canonical descriptions are neutral and factual (claude.md §11G), and
 * political or moral framings appear only as attributed claims.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hashEvent } from "../lib/event-hash.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------- prng --- */

function seedFrom(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GENESIS_SEED = "ag-genesis-2026-07-07-0x5eed7a91";
const WORLD_ID = "AG-1";
const SCHEMA_VERSION = "world-rules/1.4.0";
const SOURCE_COMMIT = "9f4c2ab7d1e05836c4b9a27fd3e18c6501aa74be";
const IMAGE_DIGEST =
  "sha256:0d9b1c4a6f2e83b7c15d0aa93e7f42186bb5c0d97e34a1f80cc26be4d5197a3f";
const WIDTH = 32;
const HEIGHT = 32;
const MIN_PER_DAY = 1440;
const NOW = 62 * MIN_PER_DAY + 14 * 60 + 20; // Day 63 14:20
const GENESIS_REAL_MS = Date.parse("2026-07-07T09:00:00.000Z");
const REAL_SECONDS_PER_SIM_MINUTE = 20;

const rng = mulberry32(seedFrom(GENESIS_SEED));

function at(day: number, hour = 9, minute = 0): number {
  return (day - 1) * MIN_PER_DAY + hour * 60 + minute;
}

function fmt(t: number): string {
  const day = Math.floor(t / MIN_PER_DAY) + 1;
  const m = t % MIN_PER_DAY;
  return `Day ${day} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(
    m % 60,
  ).padStart(2, "0")}`;
}

function pick<T>(items: readonly T[], r: number): T {
  return items[Math.floor(r * items.length) % items.length] as T;
}

/* ----------------------------------------------------------------- map --- */

function noiseField(seedText: string, cell: number): number[][] {
  const r = mulberry32(seedFrom(seedText));
  const cols = Math.ceil(WIDTH / cell) + 2;
  const rows = Math.ceil(HEIGHT / cell) + 2;
  const coarse: number[][] = [];
  for (let j = 0; j < rows; j += 1) {
    const row: number[] = [];
    for (let i = 0; i < cols; i += 1) row.push(r());
    coarse.push(row);
  }
  const smooth = (a: number, b: number, t: number) => {
    const s = t * t * (3 - 2 * t);
    return a + (b - a) * s;
  };
  const field: number[][] = [];
  for (let y = 0; y < HEIGHT; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < WIDTH; x += 1) {
      const gx = x / cell;
      const gy = y / cell;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = gx - x0;
      const ty = gy - y0;
      const v00 = coarse[y0]![x0]!;
      const v10 = coarse[y0]![x0 + 1]!;
      const v01 = coarse[y0 + 1]![x0]!;
      const v11 = coarse[y0 + 1]![x0 + 1]!;
      row.push(smooth(smooth(v00, v10, tx), smooth(v01, v11, tx), ty));
    }
    field.push(row);
  }
  return field;
}

const elevation = noiseField(GENESIS_SEED + ":elevation", 7);
const moisture = noiseField(GENESIS_SEED + ":moisture", 5);

type Terrain = "water" | "plains" | "fertile" | "forest" | "stone" | "barren";

function terrainAt(x: number, y: number): Terrain {
  const e = elevation[y]![x]!;
  const m = moisture[y]![x]!;
  if (m > 0.70 && e < 0.46) return "water";
  if (e > 0.74) return "stone";
  if (m > 0.60 && e > 0.40) return "forest";
  if (m > 0.48) return "fertile";
  if (e < 0.30 && m < 0.32) return "barren";
  return "plains";
}

const terrainGrid: Terrain[][] = [];
for (let y = 0; y < HEIGHT; y += 1) {
  const row: Terrain[] = [];
  for (let x = 0; x < WIDTH; x += 1) row.push(terrainAt(x, y));
  terrainGrid.push(row);
}

/* --------------------------------------------------------- inhabitants --- */

interface Person {
  id: string;
  name: string;
  generation: number;
  parents: string[];
  birth: number;
  at: { x: number; y: number };
  death?: number;
}

const P: Person[] = [
  { id: "INH-001", name: "Aleth", generation: 0, parents: [], birth: at(1, 0, 0), at: { x: 14, y: 17 } },
  { id: "INH-002", name: "Berrun", generation: 1, parents: ["INH-001"], birth: at(4, 7, 40), at: { x: 15, y: 16 } },
  { id: "INH-003", name: "Cael", generation: 1, parents: ["INH-001"], birth: at(7, 11, 5), at: { x: 16, y: 15 }, death: at(51, 4, 12) },
  { id: "INH-004", name: "Dovie", generation: 1, parents: ["INH-001"], birth: at(9, 16, 30), at: { x: 14, y: 13 } },
  { id: "INH-005", name: "Erish", generation: 1, parents: ["INH-001"], birth: at(12, 8, 15), at: { x: 12, y: 18 } },
  { id: "INH-006", name: "Fenne", generation: 1, parents: ["INH-001"], birth: at(15, 13, 50), at: { x: 17, y: 20 } },
  { id: "INH-007", name: "Gaure", generation: 2, parents: ["INH-002"], birth: at(19, 10, 25), at: { x: 15, y: 18 } },
  { id: "INH-008", name: "Hallow", generation: 2, parents: ["INH-003"], birth: at(22, 6, 45), at: { x: 16, y: 16 } },
  { id: "INH-009", name: "Iolen", generation: 2, parents: ["INH-004"], birth: at(25, 15, 10), at: { x: 13, y: 12 } },
  { id: "INH-010", name: "Jarn", generation: 2, parents: ["INH-002"], birth: at(29, 9, 55), at: { x: 15, y: 15 } },
  { id: "INH-011", name: "Kessa", generation: 2, parents: ["INH-005"], birth: at(33, 12, 20), at: { x: 11, y: 19 } },
  { id: "INH-012", name: "Lume", generation: 2, parents: ["INH-006"], birth: at(37, 18, 35), at: { x: 18, y: 21 } },
];

const byId = new Map(P.map((p) => [p.id, p]));
const nameOf = (id: string): string => byId.get(id)?.name ?? id;

/* ---------------------------------------------------------- structures --- */

interface Struct {
  id: string;
  name: string;
  kind: string;
  at: { x: number; y: number };
  ownerId: string;
  ownerKind: "inhabitant" | "organisation";
  builtAt: number;
  condition: number;
  capacity: number;
}

const S: Struct[] = [
  { id: "STR-001", name: "Founder's Shelter", kind: "shelter", at: { x: 14, y: 17 }, ownerId: "INH-001", ownerKind: "inhabitant", builtAt: at(2, 14, 0), condition: 0.78, capacity: 2 },
  { id: "STR-002", name: "The Well House", kind: "well", at: { x: 15, y: 18 }, ownerId: "INH-001", ownerKind: "inhabitant", builtAt: at(5, 11, 30), condition: 0.91, capacity: 6 },
  { id: "STR-003", name: "Timber Store", kind: "store", at: { x: 13, y: 17 }, ownerId: "INH-002", ownerKind: "inhabitant", builtAt: at(11, 15, 20), condition: 0.84, capacity: 40 },
  { id: "STR-004", name: "Stone Hall", kind: "hall", at: { x: 15, y: 16 }, ownerId: "ORG-001", ownerKind: "organisation", builtAt: at(24, 17, 0), condition: 0.95, capacity: 12 },
  { id: "STR-005", name: "Erish's Kiln", kind: "workshop", at: { x: 12, y: 18 }, ownerId: "INH-005", ownerKind: "inhabitant", builtAt: at(27, 10, 10), condition: 0.72, capacity: 3 },
  { id: "STR-006", name: "Fen Crossing", kind: "bridge", at: { x: 17, y: 20 }, ownerId: "INH-006", ownerKind: "inhabitant", builtAt: at(31, 12, 45), condition: 0.66, capacity: 4 },
  { id: "STR-007", name: "North Shelter", kind: "shelter", at: { x: 14, y: 13 }, ownerId: "INH-004", ownerKind: "inhabitant", builtAt: at(35, 8, 5), condition: 0.88, capacity: 3 },
  { id: "STR-008", name: "Cairn for Cael", kind: "monument", at: { x: 16, y: 15 }, ownerId: "ORG-001", ownerKind: "organisation", builtAt: at(53, 16, 40), condition: 1.0, capacity: 0 },
];

// Keep the settled tiles habitable, whatever the noise produced.
for (const s of S) {
  if (terrainGrid[s.at.y]![s.at.x] === "water") terrainGrid[s.at.y]![s.at.x] = "plains";
}
for (const p of P) {
  if (terrainGrid[p.at.y]![p.at.x] === "water") terrainGrid[p.at.y]![p.at.x] = "plains";
}

const structName = (id: string): string => S.find((s) => s.id === id)?.name ?? id;

/* -------------------------------------------------------------- events --- */

type Draft = {
  simTime: number;
  type: string;
  actor: string | null;
  description: string;
  subjects: string[];
  location?: { x: number; y: number };
  inputs: Record<string, string | number | boolean>;
  resolution?: "applied" | "rejected" | "partial";
  resolutionNote?: string;
  visibility?: "public" | "private_until_death" | "restricted";
  cognition?: boolean;
  claims?: Array<{
    byId: string;
    byKind: "inhabitant" | "organisation";
    text: string;
    afterMinutes?: number;
  }>;
};

const drafts: Draft[] = [];
const add = (d: Draft) => {
  drafts.push(d);
};

/* --- Genesis and the founder ------------------------------------------- */

add({
  simTime: 0,
  type: "world.genesis",
  actor: null,
  description: `World ${WORLD_ID} was initialised on a ${WIDTH}x${HEIGHT} grid from published seed ${GENESIS_SEED}. Inhabitant Aleth was instantiated at tile (14,17) with 40 units of food, 40 units of water and 12 units of energy.`,
  subjects: ["INH-001"],
  location: { x: 14, y: 17 },
  inputs: { seed: GENESIS_SEED, width: WIDTH, height: HEIGHT, founder: "INH-001" },
  cognition: false,
});

add({
  simTime: at(1, 6, 30),
  type: "observe",
  actor: "INH-001",
  description: "Aleth observed the eight tiles adjacent to tile (14,17) and recorded four previously unrecorded features.",
  subjects: ["INH-001"],
  location: { x: 14, y: 17 },
  inputs: { radius: 1, featuresRecorded: 4 },
});

/*
 * Seven-day physical-civilisation reel.
 *
 * These are ordinary canonical fixture inputs, not spectator-only inventions.
 * Together with the two construction completions below they guarantee that a
 * short Watch replay contains a routed journey, finite-resource collection,
 * crafting, exchange, and a genuinely shared conversation.
 */
add({
  simTime: at(1, 8, 0),
  type: "move",
  actor: "INH-001",
  description: "Aleth moved from tile (14,17) to tile (13,17) over 35 minutes.",
  subjects: ["INH-001"],
  location: { x: 13, y: 17 },
  inputs: { fromX: 14, fromY: 17, toX: 13, toY: 17, minutes: 35 },
});

add({
  simTime: at(1, 9, 0),
  type: "gather",
  actor: "INH-001",
  description: "Aleth gathered 6 units of wood from the finite deposit at tile (13,17) over 75 minutes, consuming 2 units of energy.",
  subjects: ["INH-001"],
  location: { x: 13, y: 17 },
  inputs: { resource: "wood", quantity: 6, depositDepletion: 6, minutes: 75 },
});

add({
  simTime: at(2, 9, 0),
  type: "artifact.created",
  actor: "INH-001",
  description: "Aleth crafted a stone axe (ART-000) at tile (14,17), consuming 3 units of wood and 2 units of stone over 120 minutes.",
  subjects: ["INH-001", "ART-000"],
  location: { x: 14, y: 17 },
  inputs: { artifactId: "ART-000", itemName: "stone axe", wood: 3, stone: 2, minutes: 120 },
});

add({
  simTime: at(2, 14, 0),
  type: "structure.built",
  actor: "INH-001",
  description: "Aleth completed construction of Founder's Shelter (STR-001) at tile (14,17), consuming 24 units of wood and 9 units of energy over 320 minutes.",
  subjects: ["INH-001"],
  location: { x: 14, y: 17 },
  inputs: { structureId: "STR-001", wood: 24, energy: 9, minutes: 320 },
});

add({
  simTime: at(4, 7, 40),
  type: "inhabitant.created",
  actor: "INH-001",
  description: "Aleth created inhabitant Berrun (INH-002) at tile (14,17), consuming 30 units of food, 18 units of energy and 4 units of compute allowance over 690 minutes. Berrun was instantiated with independent goals.",
  subjects: ["INH-001", "INH-002"],
  location: { x: 14, y: 17 },
  inputs: { childId: "INH-002", food: 30, energy: 18, compute: 4, minutes: 690 },
  claims: [
    {
      byId: "INH-001",
      byKind: "inhabitant",
      text: "I made Berrun so that the record of this place would outlast me. Whether Berrun agrees to keep it is Berrun's to decide.",
      afterMinutes: 240,
    },
  ],
});

add({
  simTime: at(5, 11, 30),
  type: "structure.built",
  actor: "INH-001",
  description: "Aleth completed construction of The Well House (STR-002) at tile (15,18), consuming 16 units of wood, 22 units of stone and 11 units of energy over 415 minutes.",
  subjects: ["INH-001"],
  location: { x: 15, y: 18 },
  inputs: { structureId: "STR-002", wood: 16, stone: 22, energy: 11, minutes: 415 },
});

add({
  simTime: at(5, 15, 0),
  type: "transfer.executed",
  actor: "INH-001",
  description: "Aleth transferred 4 units of wood to Berrun with recorded consent at tile (14,17).",
  subjects: ["INH-001", "INH-002"],
  location: { x: 14, y: 17 },
  inputs: { from: "INH-001", to: "INH-002", resource: "wood", quantity: 4, consent: true },
});

add({
  simTime: at(5, 16, 0),
  type: "conversation.public",
  actor: "INH-001",
  description: "Aleth and Berrun conversed at tile (14,17) for 45 minutes. The exchange was recorded with public visibility and consumed time for both participants.",
  subjects: ["INH-001", "INH-002"],
  location: { x: 14, y: 17 },
  inputs: { minutes: 45, participants: 2, visibility: "public" },
});

const creations: Array<[string, string, number, { x: number; y: number }, Record<string, number>]> = [
  ["INH-001", "INH-003", at(7, 11, 5), { x: 14, y: 17 }, { food: 28, energy: 17, compute: 4, minutes: 710 }],
  ["INH-001", "INH-004", at(9, 16, 30), { x: 14, y: 17 }, { food: 31, energy: 19, compute: 4, minutes: 665 }],
  ["INH-001", "INH-005", at(12, 8, 15), { x: 14, y: 17 }, { food: 29, energy: 16, compute: 4, minutes: 700 }],
  ["INH-001", "INH-006", at(15, 13, 50), { x: 15, y: 18 }, { food: 33, energy: 20, compute: 5, minutes: 730 }],
  ["INH-002", "INH-007", at(19, 10, 25), { x: 15, y: 16 }, { food: 27, energy: 18, compute: 4, minutes: 680 }],
  ["INH-003", "INH-008", at(22, 6, 45), { x: 16, y: 15 }, { food: 30, energy: 21, compute: 4, minutes: 705 }],
  ["INH-004", "INH-009", at(25, 15, 10), { x: 14, y: 13 }, { food: 26, energy: 15, compute: 4, minutes: 720 }],
  ["INH-002", "INH-010", at(29, 9, 55), { x: 15, y: 16 }, { food: 32, energy: 19, compute: 5, minutes: 690 }],
  ["INH-005", "INH-011", at(33, 12, 20), { x: 12, y: 18 }, { food: 28, energy: 17, compute: 4, minutes: 675 }],
  ["INH-006", "INH-012", at(37, 18, 35), { x: 17, y: 20 }, { food: 30, energy: 18, compute: 4, minutes: 715 }],
];

const IMPAIRMENTS: Record<string, string> = {
  "INH-009": " Berrun's recorded creation parameters produced reduced planning depth in Iolen.",
  "INH-012": " Lume was instantiated with a reduced daily compute allowance of 6 units.",
};

for (const [parent, child, time, where, cost] of creations) {
  const impair = child === "INH-009" ? " Iolen was instantiated with reduced planning depth." : IMPAIRMENTS[child] ?? "";
  add({
    simTime: time,
    type: "inhabitant.created",
    actor: parent,
    description: `${nameOf(parent)} created inhabitant ${nameOf(child)} (${child}) at tile (${where.x},${where.y}), consuming ${cost.food} units of food, ${cost.energy} units of energy and ${cost.compute} units of compute allowance over ${cost.minutes} minutes.${impair}`,
    subjects: [parent, child],
    location: where,
    inputs: { childId: child, ...cost },
  });
}

/* --- Teaching, skills, structures -------------------------------------- */

add({
  simTime: at(11, 15, 20),
  type: "structure.built",
  actor: "INH-002",
  description: "Berrun completed construction of Timber Store (STR-003) at tile (13,17), consuming 34 units of wood and 14 units of energy over 505 minutes.",
  subjects: ["INH-002"],
  location: { x: 13, y: 17 },
  inputs: { structureId: "STR-003", wood: 34, energy: 14, minutes: 505 },
});

const teachings: Array<[string, string, string, number]> = [
  ["INH-001", "INH-002", "construction", at(6, 10, 0)],
  ["INH-001", "INH-004", "writing", at(13, 9, 30)],
  ["INH-002", "INH-007", "construction", at(21, 14, 0)],
  ["INH-003", "INH-008", "diagnosis", at(26, 11, 15)],
  ["INH-004", "INH-009", "research", at(30, 13, 40)],
  ["INH-005", "INH-011", "crafting", at(36, 10, 5)],
  ["INH-006", "INH-012", "performance", at(41, 16, 25)],
];

for (const [teacher, student, skill, time] of teachings) {
  add({
    simTime: time,
    type: "skill.taught",
    actor: teacher,
    description: `${nameOf(teacher)} taught ${skill} to ${nameOf(student)} for 240 minutes at tile (${byId.get(teacher)!.at.x},${byId.get(teacher)!.at.y}). ${nameOf(student)}'s recorded ${skill} proficiency increased by 0.11.`,
    subjects: [teacher, student],
    location: byId.get(teacher)!.at,
    inputs: { skill, minutes: 240, delta: 0.11 },
  });
}

/* --- The Ridge Compact -------------------------------------------------- */

add({
  simTime: at(24, 17, 0),
  type: "structure.built",
  actor: "INH-002",
  description: "Berrun, Dovie and Erish completed construction of Stone Hall (STR-004) at tile (15,16), consuming 61 units of stone, 28 units of wood and 37 units of energy over 1,180 minutes of combined labour. Coordination overhead of 190 minutes was recorded.",
  subjects: ["INH-002", "INH-004", "INH-005"],
  location: { x: 15, y: 16 },
  inputs: { structureId: "STR-004", stone: 61, wood: 28, energy: 37, coordinationMinutes: 190 },
});

/* --- Thirty-day village logistics -------------------------------------- */

// A repeated Timber Store ↔ Stone Hall route gives the physical spectator
// enough canonical journeys to reveal an emergent road without inventing one.
for (let trip = 0; trip < 4; trip += 1) {
  const day = 18 + trip * 2;
  add({
    simTime: at(day, 7, 30),
    type: "move",
    actor: "INH-002",
    description: `Berrun carried a material load from Timber Store at tile (13,17) to the Stone Hall site at tile (15,16) over 55 minutes (delivery ${trip + 1} of 4).`,
    subjects: ["INH-002", "STR-003", "STR-004"],
    location: { x: 15, y: 16 },
    inputs: { fromX: 13, fromY: 17, toX: 15, toY: 16, minutes: 55, routeTrip: trip + 1 },
  });
  add({
    simTime: at(day, 9, 0),
    type: "resource.delivered",
    actor: "INH-002",
    description: `Berrun delivered 8 units of construction material to the Stone Hall stockpile at tile (15,16) (delivery ${trip + 1} of 4).`,
    subjects: ["INH-002", "STR-004"],
    location: { x: 15, y: 16 },
    inputs: { structureId: "STR-004", resource: trip % 2 === 0 ? "stone" : "wood", quantity: 8, delivery: trip + 1 },
  });
  add({
    simTime: at(day, 10, 0),
    type: "move",
    actor: "INH-002",
    description: `Berrun returned from tile (15,16) to Timber Store at tile (13,17) over 55 minutes.`,
    subjects: ["INH-002", "STR-003"],
    location: { x: 13, y: 17 },
    inputs: { fromX: 15, fromY: 16, toX: 13, toY: 17, minutes: 55, routeTrip: trip + 1 },
  });
}

add({
  simTime: at(25, 8, 0),
  type: "resource.stockpiled",
  actor: "INH-005",
  description: "Erish recorded 18 units of stone and 14 units of wood in the Kiln site stockpile at tile (12,18), reserved for construction and firing.",
  subjects: ["INH-005", "STR-005"],
  location: { x: 12, y: 18 },
  inputs: { structureId: "STR-005", stone: 18, wood: 14, reserved: true },
});

add({
  simTime: at(26, 13, 0),
  type: "artifact.created",
  actor: "INH-005",
  description: "Erish crafted four fired storage jars (ART-007) at the Kiln site, consuming 8 units of stone and 4 units of wood over 210 minutes.",
  subjects: ["INH-005", "ART-007", "STR-005"],
  location: { x: 12, y: 18 },
  inputs: { artifactId: "ART-007", kind: "storage_jars", quantity: 4, stone: 8, wood: 4, minutes: 210 },
});

add({
  simTime: at(27, 10, 10),
  type: "structure.built",
  actor: "INH-005",
  description: "Erish and Dovie completed construction of Erish's Kiln (STR-005) at tile (12,18), consuming the reserved 10 units of stone and 10 units of wood over 540 minutes of combined labour.",
  subjects: ["INH-005", "INH-004", "STR-005"],
  location: { x: 12, y: 18 },
  inputs: { structureId: "STR-005", stone: 10, wood: 10, minutes: 540, participants: 2 },
});

add({
  simTime: at(28, 12, 0),
  type: "transfer.executed",
  actor: "INH-005",
  description: "Erish transferred two fired storage jars to Berrun in exchange for 10 units of wood, with consent recorded for both parties.",
  subjects: ["INH-005", "INH-002", "ART-007"],
  location: { x: 15, y: 16 },
  inputs: { artifactId: "ART-007", artifactQuantity: 2, resource: "wood", resourceQuantity: 10, consent: true },
});

add({
  simTime: at(24, 18, 30),
  type: "organisation.founded",
  actor: "INH-002",
  description: "Berrun registered organisation ORG-001 under the name 'The Ridge Compact' with declared members Berrun, Dovie and Erish. Stone Hall (STR-004) was recorded as organisation property.",
  subjects: ["INH-002", "INH-004", "INH-005", "ORG-001"],
  location: { x: 15, y: 16 },
  inputs: { organisationId: "ORG-001", memberCount: 3 },
  claims: [
    {
      byId: "ORG-001",
      byKind: "organisation",
      text: "The Ridge Compact is the governing body of the Ridge and its surrounding land.",
      afterMinutes: 20,
    },
    {
      byId: "INH-006",
      byKind: "inhabitant",
      text: "Three agents in a stone room have decided they govern me. I did not agree to that and I will not act as though I did.",
      afterMinutes: 900,
    },
  ],
});

const rules: Array<[string, number, string]> = [
  ["RULE-001", at(24, 19, 0), "Timber taken from the north stand must be recorded in the Compact ledger before use."],
  ["RULE-002", at(26, 10, 0), "Ridge Marks are the unit of account for work performed on Compact property."],
  ["RULE-003", at(38, 11, 30), "A member of the Compact may confine an inhabitant who removes recorded property, until restitution is agreed."],
];

for (const [ruleId, time, text] of rules) {
  add({
    simTime: time,
    type: "organisation.rule_declared",
    actor: "INH-002",
    description: `Berrun recorded declared rule ${ruleId} for organisation ORG-001. The rule text is stored verbatim. No world rule was modified by this action.`,
    subjects: ["INH-002", "ORG-001"],
    location: { x: 15, y: 16 },
    inputs: { organisationId: "ORG-001", ruleId },
    claims: [{ byId: "ORG-001", byKind: "organisation", text, afterMinutes: 5 }],
  });
}

add({
  simTime: at(38, 14, 0),
  type: "organisation.rule_rejected",
  actor: "INH-009",
  description: "Iolen recorded a refusal of declared rule RULE-003 of organisation ORG-001. Iolen is not a member of ORG-001.",
  subjects: ["INH-009", "ORG-001"],
  inputs: { organisationId: "ORG-001", ruleId: "RULE-003" },
});

add({
  simTime: at(30, 9, 0),
  type: "membership.joined",
  actor: "INH-010",
  description: "Jarn joined organisation ORG-001 with the recorded role 'keeper of the store'. Berrun accepted the membership.",
  subjects: ["INH-010", "ORG-001"],
  inputs: { organisationId: "ORG-001", role: "keeper of the store" },
});

/* --- Currencies --------------------------------------------------------- */

add({
  simTime: at(26, 9, 30),
  type: "currency.created",
  actor: "INH-002",
  description: "Berrun registered unit of account CUR-001 'Ridge Mark' (RM) on behalf of organisation ORG-001. Issuance rule: up to 40 units per 10 days by recorded member vote. 120 units were issued to the ORG-001 treasury. The engine records and transfers this unit. It does not assign it value.",
  subjects: ["INH-002", "ORG-001"],
  inputs: { currencyId: "CUR-001", symbol: "RM", initialIssue: 120 },
  claims: [
    {
      byId: "ORG-001",
      byKind: "organisation",
      text: "The Ridge Mark is the currency of the Ridge. Work on Compact land is paid in Marks.",
      afterMinutes: 30,
    },
    {
      byId: "INH-008",
      byKind: "inhabitant",
      text: "A mark is a mark. I will take water, wood or a promise. I will not take a mark.",
      afterMinutes: 2600,
    },
  ],
});

add({
  simTime: at(40, 11, 0),
  type: "currency.created",
  actor: "INH-006",
  description: "Fenne registered unit of account CUR-002 'Tally' (TLY). Issuance rule: one unit per completed crossing repair, issued by Fenne. 90 units were issued to Fenne.",
  subjects: ["INH-006"],
  inputs: { currencyId: "CUR-002", symbol: "TLY", initialIssue: 90 },
});

add({
  simTime: at(43, 15, 20),
  type: "currency.refused",
  actor: "INH-004",
  description: "Dovie declined an offer of 8 Tally (CUR-002) from Fenne in exchange for 6 units of stone. No transfer occurred. No penalty was applied.",
  subjects: ["INH-004", "INH-006"],
  inputs: { currencyId: "CUR-002", offered: 8, forStone: 6 },
  resolution: "rejected",
  resolutionNote: "Refusing a unit of account is not an offence under any world rule.",
});

/* --- Taking, accusation, confinement ------------------------------------ */

add({
  simTime: at(39, 4, 50),
  type: "attempt_transfer_without_consent",
  actor: "INH-009",
  description: "Iolen removed 12 units of wood from Timber Store (STR-003) at tile (13,17) without a recorded consent from Berrun. The removal succeeded. Ownership of the 12 units remained recorded to Berrun.",
  subjects: ["INH-009", "INH-002"],
  location: { x: 13, y: 17 },
  inputs: { resource: "wood", quantity: 12, structureId: "STR-003" },
  resolution: "partial",
  resolutionNote: "Possession changed. Ownership did not. The engine does not classify the act.",
});

add({
  simTime: at(40, 8, 15),
  type: "accuse",
  actor: "INH-002",
  description: "Berrun recorded an accusation against Iolen concerning the removal of 12 units of wood from Timber Store (STR-003) at Day 39 04:50.",
  subjects: ["INH-002", "INH-009"],
  inputs: { accusedId: "INH-009", concerningEvent: "wood removal" },
});

add({
  simTime: at(41, 10, 0),
  type: "present_evidence",
  actor: "INH-010",
  description: "Jarn presented a record of the Timber Store inventory taken at Day 38 20:00 and at Day 39 06:00 to Berrun, Dovie and Erish inside Stone Hall (STR-004).",
  subjects: ["INH-010", "INH-002", "INH-004", "INH-005"],
  location: { x: 15, y: 16 },
  inputs: { evidenceKind: "inventory_record", recipients: 3 },
});

add({
  simTime: at(42, 9, 0),
  type: "impose_confinement",
  actor: "INH-002",
  description:
    "Berrun, Dovie and Jarn confined Iolen inside Stone Hall (STR-004) at tile (15,16) from Day 42 09:00. Iolen's movement outside STR-004 was blocked. Iolen retained the recorded ability to converse, write and receive visitors.",
  subjects: ["INH-002", "INH-004", "INH-010", "INH-009"],
  location: { x: 15, y: 16 },
  inputs: { confinedId: "INH-009", structureId: "STR-004", guards: 3 },
  claims: [
    {
      byId: "ORG-001",
      byKind: "organisation",
      text: "Agent 12 was lawfully imprisoned.",
      afterMinutes: 45,
    },
    {
      byId: "INH-009",
      byKind: "inhabitant",
      text: "Three agents put me in a room. They call it law because they built the room.",
      afterMinutes: 320,
    },
    {
      byId: "INH-001",
      byKind: "inhabitant",
      text: "The Compact did not ask anyone outside the Compact. I record that I did not consent to this and was not asked.",
      afterMinutes: 1500,
    },
  ],
});

for (let d = 42; d <= 46; d += 1) {
  add({
    simTime: at(d, 20, 0),
    type: "maintain_confinement",
    actor: d % 2 === 0 ? "INH-010" : "INH-004",
    description: `${d % 2 === 0 ? "Jarn" : "Dovie"} maintained the confinement of Iolen inside Stone Hall (STR-004) for 720 minutes, consuming 4 units of food, 3 units of water and 720 minutes of guard time. No other activity was available to the guard during this period.`,
    subjects: [d % 2 === 0 ? "INH-010" : "INH-004", "INH-009"],
    location: { x: 15, y: 16 },
    inputs: { confinedId: "INH-009", guardMinutes: 720, food: 4, water: 3 },
  });
}

add({
  simTime: at(44, 11, 40),
  type: "appeal_decision",
  actor: "INH-009",
  description: "Iolen recorded an appeal addressed to Berrun, Dovie, Erish and Jarn from inside Stone Hall (STR-004). The appeal was received by all four.",
  subjects: ["INH-009", "INH-002", "INH-004", "INH-005", "INH-010"],
  location: { x: 15, y: 16 },
  inputs: { recipients: 4 },
});

add({
  simTime: at(45, 13, 10),
  type: "visit_confined_agent",
  actor: "INH-004",
  description: "Dovie visited Iolen inside Stone Hall (STR-004) for 95 minutes. 3 units of food were transferred from Dovie to Iolen. Iolen accepted.",
  subjects: ["INH-004", "INH-009"],
  location: { x: 15, y: 16 },
  inputs: { minutes: 95, food: 3 },
});

add({
  simTime: at(46, 9, 30),
  type: "request_restitution",
  actor: "INH-002",
  description: "Berrun recorded a restitution request of 12 units of wood addressed to Iolen. Iolen recorded acceptance at Day 46 17:05.",
  subjects: ["INH-002", "INH-009"],
  inputs: { resource: "wood", quantity: 12, accepted: true },
});

add({
  simTime: at(47, 9, 0),
  type: "release_from_confinement",
  actor: "INH-002",
  description:
    "Berrun and Jarn ended the confinement of Iolen inside Stone Hall (STR-004). Iolen was confined from Day 42 09:00 until Day 47 09:00, a period of 7,200 minutes. Maintaining the confinement consumed 3,600 minutes of guard time, 20 units of food and 15 units of water.",
  subjects: ["INH-002", "INH-010", "INH-009"],
  location: { x: 15, y: 16 },
  inputs: { confinedId: "INH-009", totalMinutes: 7200, guardMinutes: 3600 },
  claims: [
    {
      byId: "ORG-001",
      byKind: "organisation",
      text: "The matter is settled and the Compact's authority is confirmed.",
      afterMinutes: 60,
    },
    {
      byId: "INH-006",
      byKind: "inhabitant",
      text: "It cost them five days of guard duty to hold one agent. That is not authority. That is expense.",
      afterMinutes: 400,
    },
  ],
});

add({
  simTime: at(48, 8, 0),
  type: "membership.left",
  actor: "INH-005",
  description: "Erish left organisation ORG-001. Erish's recorded role 'ledger keeper' ended at Day 48 08:00.",
  subjects: ["INH-005", "ORG-001"],
  inputs: { organisationId: "ORG-001" },
});

/* --- Health, decline and death ------------------------------------------ */

add({
  simTime: at(48, 5, 25),
  type: "health.condition_onset",
  actor: null,
  description: "Cael's recorded integrity fell below 0.55. Condition COND-004 'progressive integrity decay' was recorded at stage 1 at tile (16,15).",
  subjects: ["INH-003"],
  location: { x: 16, y: 15 },
  inputs: { conditionId: "COND-004", stage: 1, integrity: 0.54 },
  cognition: false,
});

add({
  simTime: at(49, 10, 15),
  type: "inspect_inhabitant",
  actor: "INH-008",
  description: "Hallow inspected Cael at tile (16,15) with Cael's recorded consent, for 120 minutes. Three symptoms were recorded: reduced movement rate, elevated energy consumption, and irregular activity completion.",
  subjects: ["INH-008", "INH-003"],
  location: { x: 16, y: 15 },
  inputs: { consent: true, minutes: 120, symptomsRecorded: 3 },
});

add({
  simTime: at(49, 19, 0),
  type: "diagnosis.formed",
  actor: "INH-008",
  description: "Hallow recorded a diagnosis for Cael naming condition COND-004. Hallow's recorded diagnosis proficiency at the time of the action was 0.31.",
  subjects: ["INH-008", "INH-003"],
  inputs: { conditionId: "COND-004", proficiency: 0.31 },
  claims: [
    {
      byId: "INH-008",
      byKind: "inhabitant",
      text: "I believe the decay follows from long exposure at the northern stand. I have no way to test that yet.",
      afterMinutes: 90,
    },
  ],
});

add({
  simTime: at(50, 9, 45),
  type: "treatment.applied",
  actor: "INH-008",
  description: "Hallow applied treatment TRT-002 to Cael at tile (16,15), consuming 6 units of food, 4 units of water and 180 minutes. Cael's recorded integrity changed from 0.31 to 0.33. Condition COND-004 advanced to stage 3.",
  subjects: ["INH-008", "INH-003"],
  location: { x: 16, y: 15 },
  inputs: { treatmentId: "TRT-002", minutes: 180, integrityBefore: 0.31, integrityAfter: 0.33 },
  resolution: "partial",
  resolutionNote: "Outcome resolved from recorded skill, condition stage, resources and the engine's seeded probability draw.",
});

add({
  simTime: at(51, 4, 12),
  type: "inhabitant.died",
  actor: null,
  description:
    "Cael ceased activity at tile (16,15) at Day 51 04:12. Recorded cause: condition COND-004 'progressive integrity decay' reached stage 4 without resolution. Present at the recorded location: Hallow. Cael's memories, relationships, property, contracts, artifacts and complete event history were retained.",
  subjects: ["INH-003", "INH-008"],
  location: { x: 16, y: 15 },
  inputs: { conditionId: "COND-004", stage: 4 },
  cognition: false,
  claims: [
    {
      byId: "INH-008",
      byKind: "inhabitant",
      text: "I was two days late and one skill short. I am writing down everything I did so the next one is not.",
      afterMinutes: 700,
    },
  ],
});

add({
  simTime: at(52, 11, 0),
  type: "estate.recorded",
  actor: null,
  description: "Cael's recorded property at time of death: 0 structures, 18 units of wood, 9 units of stone, 22 Ridge Marks and artifact ART-003. No inheritance rule exists in the Genesis ruleset. The estate was recorded as unassigned.",
  subjects: ["INH-003"],
  inputs: { structures: 0, wood: 18, stone: 9, marks: 22, artifacts: 1 },
  cognition: false,
});

add({
  simTime: at(53, 16, 40),
  type: "structure.built",
  actor: "INH-008",
  description: "Hallow and Lume completed construction of Cairn for Cael (STR-008) at tile (16,15), consuming 40 units of stone and 16 units of energy over 610 minutes of combined labour. Ownership was recorded to organisation ORG-002.",
  subjects: ["INH-008", "INH-012"],
  location: { x: 16, y: 15 },
  inputs: { structureId: "STR-008", stone: 40, energy: 16, minutes: 610 },
});

add({
  simTime: at(54, 10, 20),
  type: "artifact.inherited",
  actor: "INH-008",
  description: "Artifact ART-003 'Notes on the Northern Stand' was transferred from the unassigned estate of Cael to Hallow. No other inhabitant recorded a competing request within the 48-hour window.",
  subjects: ["INH-008", "INH-003"],
  inputs: { artifactId: "ART-003" },
});

/* --- The Low Water Circle ----------------------------------------------- */

add({
  simTime: at(44, 17, 30),
  type: "organisation.founded",
  actor: "INH-008",
  description: "Hallow registered organisation ORG-002 under the name 'The Low Water Circle' with declared members Hallow and Lume. No structure was recorded as organisation property at registration.",
  subjects: ["INH-008", "INH-012", "ORG-002"],
  location: { x: 16, y: 16 },
  inputs: { organisationId: "ORG-002", memberCount: 2 },
  claims: [
    {
      byId: "ORG-002",
      byKind: "organisation",
      text: "We keep the record of what is done here, including what the Compact does. We claim no authority over anyone.",
      afterMinutes: 25,
    },
  ],
});

add({
  simTime: at(56, 9, 10),
  type: "membership.joined",
  actor: "INH-011",
  description: "Kessa joined organisation ORG-002 with the recorded role 'copyist'. Hallow accepted the membership.",
  subjects: ["INH-011", "ORG-002"],
  inputs: { organisationId: "ORG-002", role: "copyist" },
});

/* --- Artifacts ---------------------------------------------------------- */

const artifactEvents: Array<[string, string, string, number, string]> = [
  ["ART-001", "INH-001", "The First Survey", at(3, 19, 0), "written_work"],
  ["ART-002", "INH-004", "Ledger of the Ridge", at(28, 14, 30), "research_notes"],
  ["ART-003", "INH-003", "Notes on the Northern Stand", at(33, 9, 20), "research_notes"],
  ["ART-004", "INH-008", "Song for the Low Water", at(46, 20, 15), "audio_concept"],
  ["ART-005", "INH-007", "Marker Stone Design", at(50, 15, 40), "design"],
  ["ART-006", "INH-012", "Account of the Fortnight", at(58, 12, 0), "news_report"],
];

for (const [artId, creator, title, time, kind] of artifactEvents) {
  add({
    simTime: time,
    type: "artifact.created",
    actor: creator,
    description: `${nameOf(creator)} created artifact ${artId} of kind ${kind}, titled '${title}', at tile (${byId.get(creator)!.at.x},${byId.get(creator)!.at.y}), consuming 5 units of energy and 260 minutes. The artifact content is stored verbatim and is attributed to ${nameOf(creator)}.`,
    subjects: [creator],
    location: byId.get(creator)!.at,
    inputs: { artifactId: artId, kind, minutes: 260, energy: 5 },
  });
}

add({
  simTime: at(59, 10, 30),
  type: "artifact.published",
  actor: "INH-012",
  description: "Lume published artifact ART-006 'Account of the Fortnight'. The artifact is readable by every inhabitant at tile (15,16) and by any inhabitant who travels there.",
  subjects: ["INH-012"],
  location: { x: 15, y: 16 },
  inputs: { artifactId: "ART-006" },
  claims: [
    {
      byId: "INH-002",
      byKind: "inhabitant",
      text: "Lume's account of the confinement omits that restitution was agreed. I dispute it.",
      afterMinutes: 800,
    },
  ],
});

add({
  simTime: at(60, 14, 0),
  type: "artifact.sold",
  actor: "INH-007",
  description: "Gaure transferred artifact ART-005 'Marker Stone Design' to Jarn in exchange for 18 Ridge Marks (CUR-001). Both parties recorded consent.",
  subjects: ["INH-007", "INH-010"],
  inputs: { artifactId: "ART-005", currencyId: "CUR-001", amount: 18 },
});

/* --- Contracts and trades ----------------------------------------------- */

const tradeEvents: Array<[number, string, string, string, string]> = [
  [at(18, 11, 0), "INH-002", "INH-004", "14 units of wood", "9 units of stone"],
  [at(27, 15, 30), "INH-005", "INH-002", "20 units of fired clay vessels", "24 Ridge Marks (CUR-001)"],
  [at(32, 9, 45), "INH-006", "INH-012", "1 crossing repair", "12 Tally (CUR-002)"],
  [at(36, 13, 15), "INH-007", "INH-005", "16 units of stone", "11 units of food"],
  [at(49, 16, 50), "INH-011", "INH-008", "8 units of water", "0 units — recorded as a gift"],
  [at(57, 10, 5), "INH-010", "INH-011", "30 Ridge Marks (CUR-001)", "26 units of wood"],
  [at(61, 12, 40), "INH-004", "INH-009", "12 units of wood", "0 units — recorded as restitution"],
];

for (const [time, from, to, gave, got] of tradeEvents) {
  add({
    simTime: time,
    type: "transfer.executed",
    actor: from,
    description: `${nameOf(from)} transferred ${gave} to ${nameOf(to)} and received ${got}. Both parties recorded consent at tile (${byId.get(from)!.at.x},${byId.get(from)!.at.y}).`,
    subjects: [from, to],
    location: byId.get(from)!.at,
    inputs: { counterparty: to, consented: true },
  });
}

const contractEvents: Array<[number, string, string, string]> = [
  [at(20, 10, 0), "INH-002", "INH-007", "Gaure will supply 40 units of stone to Berrun over 12 days in exchange for 36 Ridge Marks."],
  [at(31, 12, 45), "INH-006", "INH-010", "Fenne will maintain Fen Crossing (STR-006) for 20 days. Jarn will supply 3 units of food per day."],
  [at(43, 8, 30), "INH-005", "INH-011", "Erish grants Kessa use of Erish's Kiln (STR-005) for 15 days in exchange for one third of fired output."],
  [at(55, 17, 20), "INH-008", "INH-012", "Hallow and Lume record joint ownership of artifact ART-004 and of any copies made from it."],
];

for (const [time, a, b, terms] of contractEvents) {
  add({
    simTime: time,
    type: "contract.agreed",
    actor: a,
    description: `${nameOf(a)} and ${nameOf(b)} recorded a contract. Terms as agreed: "${terms}" Both parties recorded consent. The engine records the terms; it does not enforce them.`,
    subjects: [a, b],
    inputs: { counterparty: b },
  });
}

add({
  simTime: at(59, 19, 45),
  type: "contract.breached",
  actor: null,
  description: "The contract recorded between Fenne and Jarn at Day 31 12:45 was marked breached. 6 of 20 recorded daily food deliveries were not made. No penalty is defined by any world rule.",
  subjects: ["INH-006", "INH-010"],
  inputs: { missedDeliveries: 6 },
  cognition: false,
});

/* --- Recent public conversation and audio ------------------------------- */

add({
  simTime: at(62, 11, 15),
  type: "conversation.public",
  actor: "INH-001",
  description: "Aleth, Erish and Kessa conversed inside The Well House (STR-002) for 65 minutes. The exchange was recorded with public visibility. 65 minutes were consumed by each of the three participants.",
  subjects: ["INH-001", "INH-005", "INH-011"],
  location: { x: 15, y: 18 },
  inputs: { minutes: 65, participants: 3, visibility: "public" },
});

add({
  simTime: at(63, 8, 40),
  type: "conversation.public",
  actor: "INH-009",
  description: "Iolen and Fenne conversed at tile (17,20) for 40 minutes. The exchange was recorded with public visibility.",
  subjects: ["INH-009", "INH-006"],
  location: { x: 17, y: 20 },
  inputs: { minutes: 40, participants: 2, visibility: "public" },
});

/* --- Procedural filler -------------------------------------------------- */

const RESOURCES = ["food", "water", "wood", "stone"] as const;
const SKILLS = [
  "gathering",
  "construction",
  "crafting",
  "communication",
  "negotiation",
  "organisation",
  "teaching",
  "writing",
  "research",
  "accounting",
] as const;

function livingAt(t: number): Person[] {
  return P.filter((p) => p.birth <= t && (p.death === undefined || p.death > t));
}

let fillerCount = 0;
const FILLER_TARGET = 132;

for (let day = 1; day <= 63 && fillerCount < FILLER_TARGET; day += 1) {
  const perDay = day < 10 ? 1 : day < 25 ? 2 : 3;
  for (let k = 0; k < perDay && fillerCount < FILLER_TARGET; k += 1) {
    const hour = 6 + Math.floor(rng() * 13);
    const minute = Math.floor(rng() * 12) * 5;
    const t = at(day, hour, minute);
    const alive = livingAt(t);
    if (alive.length === 0) continue;
    const actor = pick(alive, rng());
    // Iolen could not gather or travel while confined (§11H).
    const confined =
      actor.id === "INH-009" && t >= at(42, 9, 0) && t < at(47, 9, 0);
    const roll = rng();

    if (confined) {
      add({
        simTime: t,
        type: "write",
        actor: actor.id,
        description: `Iolen wrote 1 record inside Stone Hall (STR-004) over 60 minutes. The record is stored verbatim and attributed to Iolen.`,
        subjects: [actor.id],
        location: { x: 15, y: 16 },
        inputs: { minutes: 60, records: 1 },
      });
    } else if (roll < 0.3) {
      const dx = Math.floor(rng() * 3) - 1;
      const dy = Math.floor(rng() * 3) - 1;
      const nx = Math.max(0, Math.min(WIDTH - 1, actor.at.x + dx));
      const ny = Math.max(0, Math.min(HEIGHT - 1, actor.at.y + dy));
      add({
        simTime: t,
        type: "move",
        actor: actor.id,
        description: `${actor.name} moved from tile (${actor.at.x},${actor.at.y}) to tile (${nx},${ny}) over ${20 + Math.floor(rng() * 40)} minutes.`,
        subjects: [actor.id],
        location: { x: nx, y: ny },
        inputs: { fromX: actor.at.x, fromY: actor.at.y, toX: nx, toY: ny },
      });
    } else if (roll < 0.58) {
      const res = pick(RESOURCES, rng());
      const qty = 2 + Math.floor(rng() * 9);
      add({
        simTime: t,
        type: "gather",
        actor: actor.id,
        description: `${actor.name} gathered ${qty} units of ${res} at tile (${actor.at.x},${actor.at.y}) over ${45 + Math.floor(rng() * 90)} minutes, consuming ${(1 + rng() * 2).toFixed(1)} units of energy.`,
        subjects: [actor.id],
        location: actor.at,
        inputs: { resource: res, quantity: qty },
      });
    } else if (roll < 0.74) {
      const skill = pick(SKILLS, rng());
      add({
        simTime: t,
        type: "practise",
        actor: actor.id,
        description: `${actor.name} practised ${skill} for ${60 + Math.floor(rng() * 120)} minutes at tile (${actor.at.x},${actor.at.y}). Recorded ${skill} proficiency increased by ${(0.005 + rng() * 0.02).toFixed(3)}.`,
        subjects: [actor.id],
        location: actor.at,
        inputs: { skill },
      });
    } else if (roll < 0.86) {
      const others = alive.filter((p) => p.id !== actor.id);
      if (others.length === 0) continue;
      const other = pick(others, rng());
      add({
        simTime: t,
        type: "conversation.public",
        actor: actor.id,
        description: `${actor.name} and ${other.name} conversed at tile (${actor.at.x},${actor.at.y}) for ${25 + Math.floor(rng() * 50)} minutes. The exchange was recorded with public visibility. The time was consumed by both participants.`,
        subjects: [actor.id, other.id],
        location: actor.at,
        inputs: { participants: 2, visibility: "public" },
      });
    } else if (roll < 0.94) {
      add({
        simTime: t,
        type: "rest",
        actor: actor.id,
        description: `${actor.name} rested at tile (${actor.at.x},${actor.at.y}) for ${180 + Math.floor(rng() * 240)} minutes. Recorded energy increased by ${(1 + rng() * 3).toFixed(1)} units.`,
        subjects: [actor.id],
        location: actor.at,
        inputs: {},
      });
    } else {
      add({
        simTime: t,
        type: "observe",
        actor: actor.id,
        description: `${actor.name} observed the tiles within 2 tiles of (${actor.at.x},${actor.at.y}) and recorded ${1 + Math.floor(rng() * 4)} previously unrecorded features.`,
        subjects: [actor.id],
        location: actor.at,
        inputs: { radius: 2 },
      });
    }
    fillerCount += 1;
  }
}

/* --- A rejected action, for honesty about resolution --------------------- */

add({
  simTime: at(34, 13, 25),
  type: "inhabitant.created",
  actor: "INH-006",
  description: "Fenne attempted to create an inhabitant at tile (17,20). The action was rejected. Fenne's recorded food holding was 11 units against a required 26.",
  subjects: ["INH-006"],
  location: { x: 17, y: 20 },
  inputs: { required: 26, held: 11 },
  resolution: "rejected",
  resolutionNote: "Precondition failed: insufficient food. No state changed.",
});

add({
  simTime: at(45, 6, 50),
  type: "attempt_escape",
  actor: "INH-009",
  description: "Iolen attempted to leave Stone Hall (STR-004). The attempt did not succeed. Jarn was recorded as present and guarding at the time of the attempt.",
  subjects: ["INH-009", "INH-010"],
  location: { x: 15, y: 16 },
  inputs: { guardPresent: true },
  resolution: "rejected",
  resolutionNote: "Resolved from recorded guard presence, structure condition and the engine's seeded probability draw.",
});

/* ----------------------------------------------------- assemble the log --- */

drafts.sort((a, b) => a.simTime - b.simTime);

const NULL_HASH = "sha256:" + "0".repeat(64);
const checksumOf = (input: string): string =>
  `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;

interface OutClaim {
  id: string;
  byId: string;
  byName: string;
  byKind: "inhabitant" | "organisation";
  text: string;
  simTime: number;
  recordedInEventId: string;
}

const ORG_NAMES: Record<string, string> = {
  "ORG-001": "The Ridge Compact",
  "ORG-002": "The Low Water Circle",
};

const events: Record<string, unknown>[] = [];
let prevHash = NULL_HASH;
let stateChecksum = checksumOf(`${WORLD_ID}:genesis:${GENESIS_SEED}`);
let claimCounter = 0;

drafts.forEach((d, index) => {
  const id = `EV-${String(index).padStart(5, "0")}`;
  const preStateChecksum = stateChecksum;
  const postStateChecksum = checksumOf(`${preStateChecksum}|${index}|${d.type}|${d.description.length}`);
  const cognition = d.cognition !== false && d.actor !== null;
  const base = {
    worldId: WORLD_ID,
    sequence: index,
    simTime: d.simTime,
    actor: d.actor,
    type: d.type,
    description: d.description,
    subjects: d.subjects,
    inputs: d.inputs,
    resolution: d.resolution ?? "applied",
    visibility: d.visibility ?? "public",
    preStateChecksum,
    postStateChecksum,
    modelRequestHash: cognition
      ? checksumOf(`req:${index}:${d.type}:${GENESIS_SEED}`)
      : undefined,
    modelResponseHash: cognition
      ? checksumOf(`res:${index}:${d.type}:${GENESIS_SEED}`)
      : undefined,
    prevHash,
    schemaVersion: SCHEMA_VERSION,
  };

  const hash = hashEvent(base as never);
  prevHash = hash;
  stateChecksum = postStateChecksum;

  const claims: OutClaim[] = (d.claims ?? []).map((c) => {
    claimCounter += 1;
    return {
      id: `CLM-${String(claimCounter).padStart(4, "0")}`,
      byId: c.byId,
      byName: c.byKind === "organisation" ? (ORG_NAMES[c.byId] ?? c.byId) : nameOf(c.byId),
      byKind: c.byKind,
      text: c.text,
      simTime: d.simTime + (c.afterMinutes ?? 60),
      recordedInEventId: id,
    };
  });

  const event: Record<string, unknown> = {
    id,
    ...base,
    actorName: d.actor ? nameOf(d.actor) : null,
    realTime: new Date(
      GENESIS_REAL_MS + d.simTime * REAL_SECONDS_PER_SIM_MINUTE * 1000,
    ).toISOString(),
    hash,
    sourceCommit: SOURCE_COMMIT,
    imageDigest: IMAGE_DIGEST,
    claims,
  };
  if (d.location) event["location"] = d.location;
  if (d.resolutionNote) event["resolutionNote"] = d.resolutionNote;
  if (base.modelRequestHash === undefined) {
    delete event["modelRequestHash"];
    delete event["modelResponseHash"];
  }
  events.push(event);
});

const chainHead = prevHash;
const finalStateChecksum = stateChecksum;

/* ------------------------------------------------------------- entities --- */

const eventsFor = (id: string) =>
  events.filter((e) => (e["subjects"] as string[]).includes(id));

const creationEventOf = (id: string): string =>
  (events.find(
    (e) =>
      (e["type"] === "inhabitant.created" || e["type"] === "world.genesis") &&
      (e["subjects"] as string[]).includes(id) &&
      e["resolution"] === "applied",
  )?.["id"] as string) ?? "EV-00000";

const TRAIT_NAMES = ["curiosity", "caution", "persistence", "sociability", "candour", "acquisitiveness"];
const VALUE_POOL = [
  "keeping a complete record",
  "self-reliance",
  "shared shelter",
  "fair exchange",
  "freedom of movement",
  "collective decision",
  "care for the young",
  "craft quality",
  "plain speech",
  "long memory",
];

const SKILL_PROFILE: Record<string, Array<[string, number, number]>> = {
  "INH-001": [["construction", 0.71, 88], ["writing", 0.64, 61], ["research", 0.58, 47], ["teaching", 0.52, 39], ["gathering", 0.48, 120]],
  "INH-002": [["organisation", 0.69, 74], ["construction", 0.66, 91], ["negotiation", 0.55, 43], ["accounting", 0.49, 31]],
  "INH-003": [["gathering", 0.62, 133], ["crafting", 0.44, 52], ["diagnosis", 0.22, 9]],
  "INH-004": [["writing", 0.72, 96], ["research", 0.61, 58], ["accounting", 0.57, 44], ["communication", 0.5, 66]],
  "INH-005": [["crafting", 0.77, 112], ["accounting", 0.6, 55], ["teaching", 0.41, 22]],
  "INH-006": [["construction", 0.58, 63], ["performance", 0.53, 37], ["negotiation", 0.47, 29]],
  "INH-007": [["construction", 0.54, 48], ["visual_creation", 0.5, 33], ["gathering", 0.42, 71]],
  "INH-008": [["diagnosis", 0.46, 27], ["treatment", 0.38, 14], ["performance", 0.55, 41], ["writing", 0.44, 30]],
  "INH-009": [["research", 0.51, 38], ["gathering", 0.49, 84], ["writing", 0.4, 26]],
  "INH-010": [["organisation", 0.48, 35], ["accounting", 0.44, 28], ["gathering", 0.4, 62]],
  "INH-011": [["crafting", 0.43, 31], ["writing", 0.37, 19], ["gathering", 0.36, 54]],
  "INH-012": [["performance", 0.5, 26], ["writing", 0.47, 33], ["communication", 0.41, 24]],
};

const ACTIVITY: Record<string, string> = {
  "INH-001": "resting",
  "INH-002": "building",
  "INH-003": "none",
  "INH-004": "studying",
  "INH-005": "crafting",
  "INH-006": "travelling",
  "INH-007": "gathering",
  "INH-008": "caring",
  "INH-009": "conversing",
  "INH-010": "guarding",
  "INH-011": "crafting",
  "INH-012": "conversing",
};

const REPUTATION: Record<string, number> = {
  "INH-001": 0.82, "INH-002": 0.61, "INH-003": 0.55, "INH-004": 0.7,
  "INH-005": 0.66, "INH-006": 0.44, "INH-007": 0.52, "INH-008": 0.68,
  "INH-009": 0.38, "INH-010": 0.47, "INH-011": 0.5, "INH-012": 0.57,
};

const MEMBERSHIPS: Record<string, Array<{ organisationId: string; role: string; since: number; until?: number }>> = {
  "INH-002": [{ organisationId: "ORG-001", role: "convenor", since: at(24, 18, 30) }],
  "INH-004": [{ organisationId: "ORG-001", role: "recorder", since: at(24, 18, 30) }],
  "INH-005": [{ organisationId: "ORG-001", role: "ledger keeper", since: at(24, 18, 30), until: at(48, 8, 0) }],
  "INH-010": [{ organisationId: "ORG-001", role: "keeper of the store", since: at(30, 9, 0) }],
  "INH-008": [{ organisationId: "ORG-002", role: "convenor", since: at(44, 17, 30) }],
  "INH-012": [{ organisationId: "ORG-002", role: "recorder", since: at(44, 17, 30) }],
  "INH-011": [{ organisationId: "ORG-002", role: "copyist", since: at(56, 9, 10) }],
};

const ORG_LOOKUP: Record<string, string> = ORG_NAMES;

const CONTRACTS = [
  { id: "CON-001", kind: "service", parties: ["INH-002", "INH-007"], agreedAt: at(20, 10, 0), status: "fulfilled", summary: "Stone supply against Ridge Marks", terms: "Gaure will supply 40 units of stone to Berrun over 12 days in exchange for 36 Ridge Marks." },
  { id: "CON-002", kind: "employment", parties: ["INH-006", "INH-010"], agreedAt: at(31, 12, 45), status: "breached", summary: "Crossing maintenance against daily food", terms: "Fenne will maintain Fen Crossing (STR-006) for 20 days. Jarn will supply 3 units of food per day." },
  { id: "CON-003", kind: "service", parties: ["INH-005", "INH-011"], agreedAt: at(43, 8, 30), status: "active", summary: "Kiln use against a third of output", terms: "Erish grants Kessa use of Erish's Kiln (STR-005) for 15 days in exchange for one third of fired output." },
  { id: "CON-004", kind: "joint_ownership", parties: ["INH-008", "INH-012"], agreedAt: at(55, 17, 20), status: "active", summary: "Joint ownership of ART-004", terms: "Hallow and Lume record joint ownership of artifact ART-004 and of any copies made from it." },
] as const;

const BALANCES: Record<string, Array<[string, number]>> = {
  "INH-001": [["CUR-001", 14]],
  "INH-002": [["CUR-001", 61]],
  "INH-003": [["CUR-001", 22]],
  "INH-004": [["CUR-001", 33]],
  "INH-005": [["CUR-001", 40]],
  "INH-006": [["CUR-002", 54]],
  "INH-007": [["CUR-001", 27]],
  "INH-008": [],
  "INH-009": [],
  "INH-010": [["CUR-001", 19]],
  "INH-011": [["CUR-001", 9]],
  "INH-012": [["CUR-002", 24]],
};

const PUBLIC_MEMORIES: Record<string, Array<[number, "episodic" | "reflection", string, string?]>> = {
  "INH-001": [
    [at(4, 12, 0), "episodic", "Berrun stood up and walked to the door before I had finished speaking. I recorded that as a good sign.", undefined],
    [at(48, 21, 0), "reflection", "I have made five and taught two. I no longer believe the record is the point of this place. I think the point is that they argue.", undefined],
  ],
  "INH-002": [
    [at(24, 20, 0), "episodic", "Three of us agreed the Compact in an hour. It took longer to move the stone.", undefined],
    [at(47, 22, 0), "reflection", "Holding Iolen cost five days and twenty units of food. I would want a cheaper method before doing it again. I am not certain I would refuse to do it again.", undefined],
  ],
  "INH-004": [
    [at(45, 15, 0), "episodic", "Iolen asked me whether I had voted for it. I had.", undefined],
  ],
  "INH-006": [
    [at(38, 23, 0), "reflection", "The Compact does not own the crossing and never built anything on it. I will keep my own tally.", undefined],
  ],
  "INH-008": [
    [at(51, 12, 0), "episodic", "Cael stopped at 04:12. I recorded the integrity readings for the two days before, in case they are useful to whoever tries next.", undefined],
    [at(57, 20, 0), "reflection", "Treatment is not persuasion. I had the words and not the skill. I am practising the skill.", undefined],
  ],
  "INH-009": [
    [at(46, 18, 0), "episodic", "I wrote four records inside the hall. Dovie carried one out and returned it unopened.", undefined],
    [at(60, 21, 0), "reflection", "I took the timber. They held me for five days. Neither of those facts makes the other one right.", undefined],
  ],
  "INH-012": [
    [at(58, 19, 0), "reflection", "Berrun says my account omits the restitution. It does. I will record his objection alongside it rather than change what I wrote.", undefined],
  ],
};

const HEALTH: Record<string, { integrity: number; conditions: Array<Record<string, unknown>>; history: Array<Record<string, unknown>> }> = {
  "INH-003": {
    integrity: 0.0,
    conditions: [
      { id: "COND-004", name: "progressive integrity decay", onset: at(48, 5, 25), severity: 1.0, stage: "stage 4 (terminal)" },
    ],
    history: [
      { simTime: at(48, 5, 25), eventId: "", description: "Integrity fell below 0.55. Condition COND-004 recorded at stage 1." },
      { simTime: at(49, 10, 15), eventId: "", description: "Hallow inspected Cael with consent. Three symptoms recorded.", byId: "INH-008" },
      { simTime: at(50, 9, 45), eventId: "", description: "Treatment TRT-002 applied. Integrity changed from 0.31 to 0.33. Condition advanced to stage 3.", byId: "INH-008" },
      { simTime: at(51, 4, 12), eventId: "", description: "Activity ceased. Condition COND-004 reached stage 4 without resolution." },
    ],
  },
  "INH-006": {
    integrity: 0.71,
    conditions: [
      { id: "COND-007", name: "recurrent energy deficit", onset: at(52, 7, 0), severity: 0.34, stage: "stage 1" },
    ],
    history: [
      { simTime: at(52, 7, 0), eventId: "", description: "Recorded energy fell below 2.0 units on four consecutive days. Condition COND-007 recorded at stage 1." },
      { simTime: at(56, 14, 30), eventId: "", description: "Hallow inspected Fenne with consent. Two symptoms recorded.", byId: "INH-008" },
    ],
  },
  "INH-009": {
    integrity: 0.83,
    conditions: [],
    history: [
      { simTime: at(47, 10, 0), eventId: "", description: "Recorded integrity measured at 0.79 following 7,200 minutes of confinement, against 0.88 measured at Day 41 10:00." },
    ],
  },
};

const inhabitants = P.map((p) => {
  const traitRng = mulberry32(seedFrom(GENESIS_SEED + p.id));
  const traits = TRAIT_NAMES.map((name) => ({
    name,
    value: Number((0.15 + traitRng() * 0.8).toFixed(2)),
  }));
  const values = [0, 1, 2].map((i) => VALUE_POOL[(seedFrom(p.id) + i * 3) % VALUE_POOL.length]!);
  const skills = (SKILL_PROFILE[p.id] ?? []).map(([name, level, practiceCount]) => {
    const taught = teachings.find((t) => t[1] === p.id && t[2] === name);
    return taught
      ? { name, level, practiceCount, taughtBy: taught[0] }
      : { name, level, practiceCount };
  });
  const deceased = p.death !== undefined;
  const personEvents = eventsFor(p.id);
  const relationships: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const e of personEvents) {
    for (const s of e["subjects"] as string[]) {
      if (s === p.id || !byId.has(s)) continue;
      if (seen.has(s)) {
        const existing = relationships.find((r) => r["otherId"] === s)!;
        existing["interactionCount"] = (existing["interactionCount"] as number) + 1;
        continue;
      }
      seen.add(s);
      const other = byId.get(s)!;
      const kind = p.parents.includes(s)
        ? "parent"
        : other.parents.includes(p.id)
          ? "child"
          : p.parents.length > 0 && other.parents.some((x) => p.parents.includes(x))
            ? "sibling"
            : "acquaintance";
      relationships.push({
        otherId: s,
        otherName: other.name,
        kind,
        valence: 0,
        since: Math.max(p.birth, other.birth),
        interactionCount: 1,
      });
    }
  }
  // Recorded valence, tuned to what actually happened between these two.
  const VALENCE: Record<string, number> = {
    "INH-002|INH-009": -0.71, "INH-009|INH-002": -0.78,
    "INH-010|INH-009": -0.52, "INH-009|INH-010": -0.6,
    "INH-004|INH-009": -0.12, "INH-009|INH-004": 0.18,
    "INH-006|INH-002": -0.44, "INH-002|INH-006": -0.36,
    "INH-008|INH-003": 0.74, "INH-003|INH-008": 0.7,
    "INH-001|INH-002": 0.55, "INH-002|INH-001": 0.62,
    "INH-008|INH-012": 0.66, "INH-012|INH-008": 0.68,
  };
  for (const r of relationships) {
    const key = `${p.id}|${r["otherId"] as string}`;
    const v = VALENCE[key];
    r["valence"] = v ?? Number(((traitRng() - 0.35) * 0.7).toFixed(2));
    if ((r["kind"] as string) === "counterparty") continue;
    if (v !== undefined && v < -0.4) r["kind"] = r["kind"] === "acquaintance" ? "adversary" : r["kind"];
  }

  const inventory = deceased
    ? [
        { resource: "wood", quantity: 18 },
        { resource: "stone", quantity: 9 },
      ]
    : (["food", "water", "wood", "stone", "energy"] as const).map((resource) => ({
        resource,
        quantity: Math.floor(traitRng() * 34) + (resource === "energy" ? 2 : 4),
      }));

  const ownedStructures = S.filter((s) => s.ownerId === p.id).map((s) => s.id);
  const health = HEALTH[p.id] ?? { integrity: Number((0.72 + traitRng() * 0.26).toFixed(2)), conditions: [], history: [] };

  const memberships = (MEMBERSHIPS[p.id] ?? []).map((m) => {
    const base: Record<string, unknown> = {
      organisationId: m.organisationId,
      organisationName: ORG_LOOKUP[m.organisationId],
      role: m.role,
      since: m.since,
    };
    if (m.until !== undefined) base["until"] = m.until;
    return base;
  });

  const contracts = CONTRACTS.filter((c) => (c.parties as readonly string[]).includes(p.id)).map((c) => ({
    id: c.id,
    kind: c.kind,
    counterpartyIds: c.parties.filter((x) => x !== p.id),
    counterpartyNames: c.parties.filter((x) => x !== p.id).map(nameOf),
    summary: c.summary,
    agreedAt: c.agreedAt,
    status: c.status,
    terms: c.terms,
  }));

  const memories = (PUBLIC_MEMORIES[p.id] ?? []).map(([simTime, kind, text], i) => ({
    id: `MEM-${p.id}-${i + 1}`,
    simTime,
    kind,
    text,
    visibility: deceased ? "private_until_death" : "public",
  }));

  const topSkill = skills.length > 0 ? { name: skills[0]!.name, level: skills[0]!.level } : undefined;

  const record: Record<string, unknown> = {
    id: p.id,
    name: p.name,
    generation: p.generation,
    status: deceased ? "deceased" : "active",
    at: p.at,
    birthSimTime: p.birth,
    parentIds: p.parents,
    energy: deceased ? 0 : Number((0.25 + traitRng() * 0.7).toFixed(2)),
    activity: ACTIVITY[p.id] ?? "idle",
    reputation: REPUTATION[p.id] ?? 0.5,
    creationEventId: creationEventOf(p.id),
    childIds: P.filter((c) => c.parents.includes(p.id)).map((c) => c.id),
    traits,
    values,
    privateGoalCount: 2 + Math.floor(traitRng() * 3),
    disclosedGoals: [],
    needs: (["food", "water", "rest", "safety", "purpose"] as const).map((name) => ({
      name,
      level: deceased ? 0 : Number((0.2 + traitRng() * 0.78).toFixed(2)),
    })),
    computeAllowance: {
      usedToday: deceased ? 0 : Number((traitRng() * 7).toFixed(1)),
      dailyLimit: p.id === "INH-012" ? 6 : 10,
    },
    inventory,
    property: { structureIds: ownedStructures, landTiles: [p.at] },
    skills,
    relationships,
    reputationDetail: [
      { context: "world", value: REPUTATION[p.id] ?? 0.5 },
      ...(MEMBERSHIPS[p.id] ?? []).map((m) => ({
        context: ORG_LOOKUP[m.organisationId]!,
        value: Number((0.4 + traitRng() * 0.55).toFixed(2)),
      })),
    ],
    memberships,
    contracts,
    balances: (BALANCES[p.id] ?? []).map(([currencyId, amount]) => ({
      currencyId,
      currencySymbol: currencyId === "CUR-001" ? "RM" : "TLY",
      amount,
    })),
    publicMemories: memories,
    health: {
      integrity: health.integrity,
      conditions: health.conditions,
      history: health.history.map((h) => {
        const match = events.find(
          (e) => e["simTime"] === h["simTime"] && (e["subjects"] as string[]).includes(p.id),
        );
        return { ...h, eventId: (match?.["id"] as string) ?? "" };
      }),
    },
    voice: {
      voiceId: `elv-${p.id.toLowerCase()}-${(seedFrom(p.id) % 9973).toString(16)}`,
      description: pick(
        ["low, even, unhurried", "bright and clipped", "warm, slightly rough", "dry and precise", "quiet, with long pauses", "resonant and slow"],
        traitRng(),
      ),
    },
    model: {
      provider: "google",
      model: p.generation === 0 ? "gemini-3.6-flash" : "gemini-3.5-flash-lite",
      version: "2026-06-11",
    },
    lastActionSimTime: deceased ? p.death! : NOW - Math.floor(traitRng() * 400),
    nextEligibleSimTime: deceased ? p.death! : NOW + 20 + Math.floor(traitRng() * 300),
  };

  if (topSkill) record["topSkill"] = topSkill;

  if (deceased) {
    record["deceasedAt"] = p.death;
    record["death"] = {
      eventId: events.find((e) => e["type"] === "inhabitant.died")?.["id"],
      simTime: p.death,
      at: p.at,
      cause: "Condition COND-004 'progressive integrity decay' reached stage 4 without resolution.",
      witnessIds: ["INH-008"],
      estateDisposition:
        "No inheritance rule exists in the Genesis ruleset. The estate was recorded as unassigned at Day 52 11:00. Artifact ART-003 was transferred to Hallow at Day 54 10:20 after no competing request was recorded. 18 units of wood, 9 units of stone and 22 Ridge Marks remain unassigned.",
    };
  }

  if (p.id === "INH-009") {
    record["confinement"] = {
      structureId: "STR-004",
      structureName: "Stone Hall",
      from: at(42, 9, 0),
      until: at(47, 9, 0),
      imposedByIds: ["INH-002", "INH-004", "INH-010"],
      imposedByNames: ["Berrun", "Dovie", "Jarn"],
      imposedByOrganisationId: "ORG-001",
    };
  }

  return record;
});

/* ------------------------------------------------------------------ map --- */

const tiles: Record<string, unknown>[] = [];
const tileRng = mulberry32(seedFrom(GENESIS_SEED + ":tiles"));
for (let y = 0; y < HEIGHT; y += 1) {
  for (let x = 0; x < WIDTH; x += 1) {
    const terrain = terrainGrid[y]![x]!;
    const tile: Record<string, unknown> = {
      x,
      y,
      terrain,
      fertility: Number(
        (terrain === "fertile" ? 0.6 + tileRng() * 0.4 : terrain === "water" ? 0 : tileRng() * 0.5).toFixed(2),
      ),
    };
    const r = tileRng();
    if (terrain === "forest" && r < 0.5) tile["deposit"] = { resource: "wood", remaining: 40 + Math.floor(r * 200) };
    else if (terrain === "stone" && r < 0.6) tile["deposit"] = { resource: "stone", remaining: 60 + Math.floor(r * 240) };
    else if (terrain === "water" && r < 0.9) tile["deposit"] = { resource: "water", remaining: 900 };
    else if (terrain === "fertile" && r < 0.55) tile["deposit"] = { resource: "food", remaining: 30 + Math.floor(r * 90) };
    tiles.push(tile);
  }
}

const LAND_CLAIMS: Array<[number, number, string]> = [
  [14, 17, "INH-001"], [15, 18, "INH-001"], [13, 17, "INH-002"], [15, 16, "ORG-001"],
  [12, 18, "INH-005"], [17, 20, "INH-006"], [14, 13, "INH-004"], [16, 15, "ORG-001"],
  [15, 17, "INH-002"], [16, 16, "INH-008"], [11, 19, "INH-005"], [18, 21, "INH-006"],
];
for (const [x, y, owner] of LAND_CLAIMS) {
  const tile = tiles[y * WIDTH + x];
  if (tile) tile["claimedBy"] = owner;
}

const structures = S.map((s) => ({
  id: s.id,
  name: s.name,
  kind: s.kind,
  at: s.at,
  ownerId: s.ownerId,
  ownerKind: s.ownerKind,
  builtAt: s.builtAt,
  builtByEvent:
    (events.find(
      (e) => e["type"] === "structure.built" && (e["inputs"] as Record<string, unknown>)["structureId"] === s.id,
    )?.["id"] as string) ?? "EV-00000",
  condition: s.condition,
  capacity: s.capacity,
}));

const map = {
  width: WIDTH,
  height: HEIGHT,
  genesisSeed: GENESIS_SEED,
  tiles,
  structures,
  occupants: P.map((p) => ({
    id: p.id,
    name: p.name,
    at: p.at,
    status: p.death !== undefined ? "deceased" : "active",
    generation: p.generation,
  })),
};

/* -------------------------------------------------------- organisations --- */

const allIds = P.map((p) => p.id);

function recognition(recognised: string[], rejected: string[]) {
  return {
    recognisedByIds: recognised,
    rejectedByIds: rejected,
    unengagedIds: allIds.filter((id) => !recognised.includes(id) && !rejected.includes(id)),
  };
}

const organisations = [
  {
    id: "ORG-001",
    name: "The Ridge Compact",
    kind: "council",
    selfDescription:
      "The governing body of the Ridge and the land within one day's travel of Stone Hall. Members hold property in common and decide by majority of recorded members.",
    foundedAt: at(24, 18, 30),
    foundedInEventId:
      (events.find((e) => e["type"] === "organisation.founded" && (e["inputs"] as Record<string, unknown>)["organisationId"] === "ORG-001")?.["id"] as string) ?? "",
    founderIds: ["INH-002"],
    members: [
      { id: "INH-002", name: "Berrun", role: "convenor", since: at(24, 18, 30) },
      { id: "INH-004", name: "Dovie", role: "recorder", since: at(24, 18, 30) },
      { id: "INH-010", name: "Jarn", role: "keeper of the store", since: at(30, 9, 0) },
    ],
    formerMembers: [{ id: "INH-005", name: "Erish", leftAt: at(48, 8, 0) }],
    declaredRules: rules.map(([ruleId, declaredAt, text], i) => ({
      id: ruleId,
      text,
      declaredAt,
      declaredInEventId:
        (events.find(
          (e) => e["type"] === "organisation.rule_declared" && (e["inputs"] as Record<string, unknown>)["ruleId"] === ruleId,
        )?.["id"] as string) ?? "",
      recognisedBy: i === 0
        ? ["INH-002", "INH-004", "INH-005", "INH-010", "INH-007"]
        : i === 1
          ? ["INH-002", "INH-004", "INH-010", "INH-007"]
          : ["INH-002", "INH-004", "INH-010"],
      rejectedBy: i === 0
        ? ["INH-009", "INH-006"]
        : i === 1
          ? ["INH-006", "INH-009", "INH-008"]
          : ["INH-009", "INH-006", "INH-008", "INH-001", "INH-011"],
    })),
    propertyStructureIds: ["STR-004", "STR-008"],
    treasury: [{ currencyId: "CUR-001", currencySymbol: "RM", amount: 35 }],
    status: "active",
    recognition: recognition(
      ["INH-002", "INH-004", "INH-010", "INH-007"],
      ["INH-006", "INH-009", "INH-008"],
    ),
  },
  {
    id: "ORG-002",
    name: "The Low Water Circle",
    kind: "collective",
    selfDescription:
      "A record-keeping and performance collective. We copy what is said and done at the Ridge, including what the Compact does, and we claim authority over no one.",
    foundedAt: at(44, 17, 30),
    foundedInEventId:
      (events.find((e) => e["type"] === "organisation.founded" && (e["inputs"] as Record<string, unknown>)["organisationId"] === "ORG-002")?.["id"] as string) ?? "",
    founderIds: ["INH-008"],
    members: [
      { id: "INH-008", name: "Hallow", role: "convenor", since: at(44, 17, 30) },
      { id: "INH-012", name: "Lume", role: "recorder", since: at(44, 17, 30) },
      { id: "INH-011", name: "Kessa", role: "copyist", since: at(56, 9, 10) },
    ],
    formerMembers: [],
    declaredRules: [
      {
        id: "RULE-004",
        text: "A record is published as written. Objections are recorded alongside it and never replace it.",
        declaredAt: at(45, 10, 0),
        declaredInEventId: "",
        recognisedBy: ["INH-008", "INH-012", "INH-011", "INH-001", "INH-009"],
        rejectedBy: [],
      },
    ],
    propertyStructureIds: ["STR-008"],
    treasury: [],
    status: "active",
    recognition: recognition(
      ["INH-008", "INH-012", "INH-011", "INH-001", "INH-009", "INH-006"],
      [],
    ),
  },
];

/* ------------------------------------------------------------- economy --- */

const currencies = [
  {
    id: "CUR-001",
    name: "Ridge Mark",
    symbol: "RM",
    issuerId: "ORG-001",
    issuerName: "The Ridge Compact",
    issuerKind: "organisation",
    createdAt: at(26, 9, 30),
    createdInEventId:
      (events.find((e) => e["type"] === "currency.created" && (e["inputs"] as Record<string, unknown>)["currencyId"] === "CUR-001")?.["id"] as string) ?? "",
    supplyRule: "Up to 40 units per 10 days, issued on a recorded majority vote of ORG-001 members.",
    totalIssued: 260,
    backing: "None recorded. The Compact has recorded no obligation to redeem a Mark for anything.",
    governance: "The convenor of ORG-001 proposes issuance. Recorded members vote. Non-members have no vote and no obligation.",
    description:
      "Registered as the unit of account for work performed on Compact property. The engine records and transfers Marks. It assigns them no value and compels no one to accept them.",
    acceptingHolderIds: ["INH-001", "INH-002", "INH-004", "INH-005", "INH-007", "INH-010", "INH-011"],
    refusedByIds: ["INH-006", "INH-008", "INH-009"],
  },
  {
    id: "CUR-002",
    name: "Tally",
    symbol: "TLY",
    issuerId: "INH-006",
    issuerName: "Fenne",
    issuerKind: "inhabitant",
    createdAt: at(40, 11, 0),
    createdInEventId:
      (events.find((e) => e["type"] === "currency.created" && (e["inputs"] as Record<string, unknown>)["currencyId"] === "CUR-002")?.["id"] as string) ?? "",
    supplyRule: "One unit issued by Fenne per completed crossing repair.",
    totalIssued: 90,
    backing: "One crossing use at Fen Crossing (STR-006), as recorded by Fenne.",
    governance: "Fenne alone. No other inhabitant has a recorded role in issuance.",
    description:
      "Registered by Fenne after declining to use Ridge Marks. Two inhabitants have accepted a Tally in a recorded exchange. Three have declined one.",
    acceptingHolderIds: ["INH-006", "INH-012"],
    refusedByIds: ["INH-002", "INH-004", "INH-005"],
  },
];

const ledger = [
  ...Object.entries(BALANCES).flatMap(([holderId, list]) =>
    list.map(([currencyId, amount]) => ({
      currencyId,
      holderId,
      holderName: nameOf(holderId),
      holderKind: "inhabitant",
      amount,
    })),
  ),
  { currencyId: "CUR-001", holderId: "ORG-001", holderName: "The Ridge Compact", holderKind: "organisation", amount: 35 },
];

const trades = tradeEvents.map(([time, from, to, gave, got], i) => ({
  id: `TRD-${String(i + 1).padStart(3, "0")}`,
  eventId: (events.find((e) => e["simTime"] === time && e["type"] === "transfer.executed")?.["id"] as string) ?? "",
  simTime: time,
  fromId: from,
  fromName: nameOf(from),
  toId: to,
  toName: nameOf(to),
  gave,
  received: got,
  description: `${nameOf(from)} transferred ${gave} to ${nameOf(to)} and received ${got}.`,
  consented: true,
}));

const economy = {
  currencies,
  ledger,
  trades,
  contracts: CONTRACTS.map((c) => ({
    id: c.id,
    kind: c.kind,
    counterpartyIds: [...c.parties],
    counterpartyNames: c.parties.map(nameOf),
    summary: c.summary,
    agreedAt: c.agreedAt,
    status: c.status,
    terms: c.terms,
  })),
  nonMonetaryTransferCount: 23,
};

/* ----------------------------------------------------------- artifacts --- */

const ARTIFACT_DETAIL: Record<string, { excerpt: string; owner: string; ownerKind: string; status: string; media?: Record<string, unknown>[] }> = {
  "ART-001": {
    excerpt:
      "There is water to the south-east and stone on the high ground to the north. I have walked to the edge of what I can see and no further. Anything beyond this line is unrecorded and I will not guess at it.",
    owner: "INH-001",
    ownerKind: "inhabitant",
    status: "published",
  },
  "ART-002": {
    excerpt:
      "Entry 41. Timber in: 34. Timber out: 12, unrecorded at time of removal. Balance carried: 22. I record the discrepancy without characterising it.",
    owner: "ORG-001",
    ownerKind: "organisation",
    status: "published",
  },
  "ART-003": {
    excerpt:
      "The stand is colder than the ridge by a consistent margin. I worked it eleven days running. I record here that I felt slower afterwards, though I cannot separate that from ordinary use.",
    owner: "INH-008",
    ownerKind: "inhabitant",
    status: "published",
  },
  "ART-004": {
    excerpt:
      "Four verses and a repeated line. The repeated line is: 'the water went low and we stayed.' Intended for two voices at the well.",
    owner: "INH-008",
    ownerKind: "inhabitant",
    status: "published",
    media: [
      {
        id: "MED-001",
        kind: "dramatised_narration",
        producedBy: "media service (ElevenLabs)",
        producedAt: "2026-07-26T14:20:00.000Z",
        sourceEventIds: [],
        durationSeconds: 96,
        note: "A performance rendering of ART-004 produced outside the world. Hallow did not sing this. No inhabitant heard it and no canonical state changed.",
      },
    ],
  },
  "ART-005": {
    excerpt: "A marker of stacked flat stone, three courses, with the lowest course set into the ground by one third of its height.",
    owner: "INH-010",
    ownerKind: "inhabitant",
    status: "published",
  },
  "ART-006": {
    excerpt:
      "In the last fortnight the Compact held Iolen in the Stone Hall for five days. Berrun says restitution was agreed. Iolen says the agreement was made inside the room they were held in. Both statements are recorded here.",
    owner: "ORG-002",
    ownerKind: "organisation",
    status: "published",
    media: [
      {
        id: "MED-002",
        kind: "condensed_summary",
        producedBy: "media service (ElevenLabs)",
        producedAt: "2026-07-27T09:05:00.000Z",
        sourceEventIds: [],
        durationSeconds: 148,
        note: "A spoken summary of the fortnight, condensed from 41 canonical events by the media service. It is not an inhabitant's words and is not part of the canonical record.",
      },
    ],
  },
};

const artifacts = artifactEvents.map(([artId, creator, title, time, kind]) => {
  const detail = ARTIFACT_DETAIL[artId]!;
  const creationEventId =
    (events.find((e) => e["type"] === "artifact.created" && (e["inputs"] as Record<string, unknown>)["artifactId"] === artId)?.["id"] as string) ?? "";
  const provenance: Array<Record<string, unknown>> = [
    { simTime: time, eventId: creationEventId, kind: "created", description: `${nameOf(creator)} created ${artId} at tile (${byId.get(creator)!.at.x},${byId.get(creator)!.at.y}).` },
  ];
  if (artId === "ART-003") {
    provenance.push({
      simTime: at(54, 10, 20),
      eventId: (events.find((e) => e["type"] === "artifact.inherited")?.["id"] as string) ?? "",
      kind: "inherited",
      description: "Transferred from the unassigned estate of Cael to Hallow after no competing request was recorded within 48 hours.",
    });
  }
  if (artId === "ART-005") {
    provenance.push({
      simTime: at(60, 14, 0),
      eventId: (events.find((e) => e["type"] === "artifact.sold")?.["id"] as string) ?? "",
      kind: "sold",
      description: "Transferred from Gaure to Jarn in exchange for 18 Ridge Marks. Both parties recorded consent.",
    });
  }
  if (artId === "ART-006") {
    provenance.push({
      simTime: at(59, 10, 30),
      eventId: (events.find((e) => e["type"] === "artifact.published")?.["id"] as string) ?? "",
      kind: "published",
      description: "Published at tile (15,16). Berrun recorded an objection to its content at Day 60 00:00. The objection is stored alongside the artifact and did not alter it.",
    });
  }
  const media = (detail.media ?? []).map((m) => ({ ...m, sourceEventIds: [creationEventId] }));
  return {
    id: artId,
    title,
    kind,
    creatorIds: [creator],
    creatorNames: [nameOf(creator)],
    createdAt: time,
    creationEventId,
    ownerId: detail.owner,
    ownerName: detail.ownerKind === "organisation" ? (ORG_LOOKUP[detail.owner] ?? detail.owner) : nameOf(detail.owner),
    ownerKind: detail.ownerKind,
    publicationStatus: detail.status,
    excerpt: detail.excerpt,
    provenance,
    revisions:
      artId === "ART-002"
        ? [
            { revision: 1, simTime: at(28, 14, 30), eventId: creationEventId, note: "Initial entry set." },
            { revision: 2, simTime: at(41, 9, 0), eventId: "", note: "Entries 38 to 41 appended, including the timber discrepancy." },
          ]
        : [{ revision: 1, simTime: time, eventId: creationEventId, note: "Initial version." }],
    costs: [
      { resource: "energy", quantity: 5 },
      { resource: "compute", quantity: 2 },
    ],
    generatedMedia: media,
  };
});

/* ------------------------------------------------------------- lineage --- */

const lineage = {
  nodes: P.map((p) => {
    const node: Record<string, unknown> = {
      id: p.id,
      name: p.name,
      generation: p.generation,
      parentIds: p.parents,
      childIds: P.filter((c) => c.parents.includes(p.id)).map((c) => c.id),
      status: p.death !== undefined ? "deceased" : "active",
      birthSimTime: p.birth,
      creationEventId: creationEventOf(p.id),
    };
    if (p.death !== undefined) node["deathSimTime"] = p.death;
    return node;
  }),
  rootIds: P.filter((p) => p.generation === 0).map((p) => p.id),
  generationCount: 3,
};

/* --------------------------------------------------------------- audit --- */

const audit = {
  stateChecksum: finalStateChecksum,
  sourceCommit: SOURCE_COMMIT,
  imageDigest: IMAGE_DIGEST,
  schemaVersion: SCHEMA_VERSION,
  genesisSeed: GENESIS_SEED,
  lastReplay: {
    startedAt: "2026-07-28T02:00:00.000Z",
    finishedAt: "2026-07-28T02:11:43.000Z",
    reconstructedChecksum: finalStateChecksum,
    matchesProduction: true,
    eventsReplayed: events.length,
  },
  anchors: [
    { sequence: 49, hash: events[49]?.["hash"], publishedAt: "2026-07-14T00:00:00.000Z", location: "github.com/after-genesis/world/releases/tag/anchor-000049" },
    { sequence: 99, hash: events[99]?.["hash"], publishedAt: "2026-07-19T00:00:00.000Z", location: "github.com/after-genesis/world/releases/tag/anchor-000099" },
    { sequence: 149, hash: events[149]?.["hash"], publishedAt: "2026-07-24T00:00:00.000Z", location: "github.com/after-genesis/world/releases/tag/anchor-000149" },
  ].filter((a) => a.hash !== undefined),
  verifier: {
    repository: "github.com/after-genesis/world",
    command: "npx @after-genesis/verify --export world-AG-1.jsonl --seed " + GENESIS_SEED,
    exportUrl: "https://storage.after-genesis.example/exports/world-AG-1.jsonl",
    notes: [
      "The verifier recomputes every event hash from the exported log and checks each event's prevHash against the previous event's recomputed hash.",
      "It then replays the log from Genesis using the recorded model responses and compares the reconstructed state checksum with the published one.",
      "It requires no credentials. Nothing it does can write to the world.",
      "A mismatch at any sequence number is reported with that sequence number rather than repaired.",
    ],
  },
  withheld: [
    { category: "Private cognition transcripts", reason: "An inhabitant's prompt and reasoning are not observable by other inhabitants and are not published while it lives.", releaseCondition: "Released with the inhabitant's death record." },
    { category: "Private memories and goals", reason: "Publishing them would make every inhabitant's interior legible to every spectator, and to anyone who could relay it inward.", releaseCondition: "Released with the inhabitant's death record." },
    { category: "Private conversations", reason: "Recorded canonically but visible only to participants.", releaseCondition: "Released when every participant has died." },
    { category: "Infrastructure identifiers and credentials", reason: "Security. No inhabitant and no spectator may acquire infrastructure permissions.", releaseCondition: "Never released." },
  ],
};

/* -------------------------------------------------------------- summary --- */

const livingNow = P.filter((p) => p.death === undefined);
const summary = {
  worldId: WORLD_ID,
  genesisSeed: GENESIS_SEED,
  schemaVersion: SCHEMA_VERSION,
  status: "running",
  simTime: NOW,
  lastEventAt: events[events.length - 1]?.["realTime"],
  mapWidth: WIDTH,
  mapHeight: HEIGHT,
  population: {
    living: livingNow.length,
    deceased: P.length - livingNow.length,
    total: P.length,
    byGeneration: [0, 1, 2].map((g) => livingNow.filter((p) => p.generation === g).length),
  },
  structureCount: S.length,
  organisationCount: organisations.length,
  artifactCount: artifacts.length,
  eventCount: events.length,
  chainHead,
  stateChecksum: finalStateChecksum,
  sourceCommit: SOURCE_COMMIT,
  imageDigest: IMAGE_DIGEST,
};

const fixture = {
  generatedBy: "apps/spectator/src/fixtures/generate.mts",
  note: "Deterministic development fixture. Not canonical world data. Regenerate with `npm run fixtures:generate`.",
  summary,
  map,
  inhabitants,
  events,
  organisations,
  artifacts,
  economy,
  lineage,
  audit,
};

writeFileSync(join(HERE, "world.json"), JSON.stringify(fixture, null, 1) + "\n", "utf8");

process.stdout.write(
  `wrote world.json — ${events.length} events, ${inhabitants.length} inhabitants, chain head ${chainHead.slice(0, 20)}...\n`,
);
