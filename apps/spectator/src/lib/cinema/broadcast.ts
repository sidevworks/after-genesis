// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import type { ActorSample } from "./types";

export const PROCESS_STAGES = ["Approach", "Prepare", "Work", "Assemble", "Complete"] as const;

export interface BroadcastStory {
  readonly actor: string;
  readonly action: string;
  readonly story: string;
  readonly progress: number;
  readonly processStage: string | null;
  readonly disclosed: boolean;
}

const PHYSICAL_ACTIONS = new Set([
  "build", "craft", "create_artifact", "artifact.created", "gather",
]);

export function readableAction(value: string): string {
  if (value === "unrecorded") return "No recorded action";
  return value
    .replaceAll(".", " ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function processStageAt(actionType: string, progress: number): string | null {
  if (!PHYSICAL_ACTIONS.has(actionType.toLowerCase())) return null;
  const bounded = Math.min(1, Math.max(0, progress));
  const index = Math.min(PROCESS_STAGES.length - 1, Math.floor(bounded * PROCESS_STAGES.length));
  return PROCESS_STAGES[index] ?? null;
}

export function broadcastStoryFor(actor: ActorSample | null): BroadcastStory {
  if (actor === null) {
    return {
      actor: "World record",
      action: "Between recorded actions",
      story: "Waiting for the next canonical story beat",
      progress: 0,
      processStage: null,
      disclosed: false,
    };
  }
  const disclosed = actor.disclosure === "disclosed";
  return {
    actor: actor.displayName,
    action: disclosed ? readableAction(actor.actionType) : "Occupied · details withheld",
    story: actor.segment.caption,
    progress: Math.min(1, Math.max(0, actor.progress)),
    processStage: disclosed ? processStageAt(actor.actionType, actor.progress) : null,
    disclosed,
  };
}

