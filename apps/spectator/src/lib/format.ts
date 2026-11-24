// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { MINUTES_PER_DAY, type SimTime, type Terrain } from "./world-types";

/** `Day 42 09:00` — the world's own clock format (claude.md §11G example). */
export function formatSimTime(t: SimTime): string {
  const day = Math.floor(t / MINUTES_PER_DAY) + 1;
  const minuteOfDay = ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const mm = String(minuteOfDay % 60).padStart(2, "0");
  return `Day ${day} ${hh}:${mm}`;
}

export function simDay(t: SimTime): number {
  return Math.floor(t / MINUTES_PER_DAY) + 1;
}

/** `4d 06:00` — a duration, not a point in time. */
export function formatDuration(minutes: number): string {
  const days = Math.floor(minutes / MINUTES_PER_DAY);
  const rest = minutes % MINUTES_PER_DAY;
  const hh = String(Math.floor(rest / 60)).padStart(2, "0");
  const mm = String(rest % 60).padStart(2, "0");
  return days > 0 ? `${days}d ${hh}:${mm}` : `${hh}:${mm}`;
}

/**
 * Before Genesis there is no chain, no state and therefore no hash. Callers
 * render whatever the world actually has, so absence has to survive formatting
 * rather than crash it — and it must not be dressed up as a value that exists.
 */
export function shortHash(hash: string | null | undefined, length = 12): string {
  if (hash === null || hash === undefined || hash.length === 0) return "—";
  const bare = hash.startsWith("sha256:") ? hash.slice(7) : hash;
  return bare.slice(0, length);
}

export function formatRealTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function titleCase(value: string): string {
  return value
    .replace(/[_.]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Cartographic terrain palette. Muted, low-chroma, legible against the dark
 * page; distinguishable without relying on hue alone (each terrain also carries
 * a distinct pattern key in the map legend).
 */
export const TERRAIN_COLOUR: Record<Terrain, string> = {
  water: "#1b3a55",
  plains: "#4e5f42",
  fertile: "#6f8a4a",
  forest: "#2c452f",
  stone: "#565b62",
  barren: "#6a5c48",
};

export const TERRAIN_LABEL: Record<Terrain, string> = {
  water: "Water",
  plains: "Plains",
  fertile: "Fertile land",
  forest: "Forest",
  stone: "Stone deposits",
  barren: "Barren land",
};

export const GENERATION_COLOUR = [
  "#e8c46a",
  "#7fb3d5",
  "#c79ad6",
  "#8fcfa8",
  "#e09a76",
];

export function generationColour(generation: number): string {
  return GENERATION_COLOUR[generation % GENERATION_COLOUR.length] ?? "#e8c46a";
}
