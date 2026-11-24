// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import type { EventStore, SimTime, StateStore, WorldState } from "@after-genesis/core";
import { simTime } from "@after-genesis/core";
import type { TimeScalingEngine } from "./time-scaling.js";

export interface TurnTask {
  readonly taskId: string;
  readonly worldId: string;
  readonly actorId: string;
  readonly expectedSequence: number;
  readonly simTime: SimTime;
}

export interface TurnQueue {
  /**
   * Enqueue by stable task id. Implementations must treat an already-existing
   * task with the same id as success, never create a second logical task.
   */
  enqueue(task: TurnTask, options?: { readonly notBeforeRealMs?: number }): Promise<"created" | "already-exists">;
}

export interface SchedulerDependencies {
  readonly eventStore: EventStore;
  readonly stateStore: StateStore<WorldState>;
  readonly queue: TurnQueue;
  /** Optional production pacing. Omit for deterministic/offline simulations. */
  readonly timeScaling?: TimeScalingEngine;
}

export type ScheduleResult =
  | { readonly status: "scheduled"; readonly task: TurnTask; readonly duplicate: boolean }
  | { readonly status: "idle"; readonly reason: string };

/**
 * Select exactly one next actor in a deterministic order and enqueue its turn.
 *
 * Scheduling changes no canonical state. If this process dies after enqueue,
 * the stable task id makes the retry converge on the same queue task.
 */
export async function scheduleNextTurn(
  deps: SchedulerDependencies,
  worldId: string,
): Promise<ScheduleResult> {
  const snapshot = await deps.stateStore.load(worldId);
  if (snapshot === null) return { status: "idle", reason: "world has no state" };
  const head = await deps.eventStore.headSequence(worldId);
  if (head !== snapshot.sequence) {
    return {
      status: "idle",
      reason: `state sequence ${snapshot.sequence} does not match event head ${head}`,
    };
  }

  const candidates = Object.values(snapshot.state.inhabitants)
    .filter((inhabitant) => inhabitant.status === "alive")
    .sort(
      (a, b) =>
        a.nextEligibleTime - b.nextEligibleTime ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const actor = candidates[0];
  if (actor === undefined) return { status: "idle", reason: "no living inhabitants" };

  const expectedSequence = head + 1;
  const scheduledTime = Math.max(snapshot.state.simTime, actor.nextEligibleTime);
  const task: TurnTask = {
    taskId: `${worldId}:${actor.id}:${expectedSequence}`,
    worldId,
    actorId: actor.id,
    expectedSequence,
    simTime: simTime(scheduledTime),
  };
  const result = await deps.queue.enqueue(
    task,
    deps.timeScaling === undefined
      ? undefined
      : { notBeforeRealMs: deps.timeScaling.realDueAt(task.simTime) },
  );
  return { status: "scheduled", task, duplicate: result === "already-exists" };
}

/** In-memory queue for mechanical simulation and scheduler contract tests. */
export class MemoryTurnQueue implements TurnQueue {
  readonly #tasks = new Map<string, TurnTask>();
  readonly #scheduleOptions = new Map<string, { readonly notBeforeRealMs?: number }>();

  async enqueue(task: TurnTask, options?: { readonly notBeforeRealMs?: number }): Promise<"created" | "already-exists"> {
    if (this.#tasks.has(task.taskId)) return "already-exists";
    this.#tasks.set(task.taskId, structuredClone(task));
    if (options !== undefined) this.#scheduleOptions.set(task.taskId, { ...options });
    return "created";
  }

  tasks(): TurnTask[] {
    return [...this.#tasks.values()].map((task) => structuredClone(task));
  }

  scheduleOptions(taskId: string): { readonly notBeforeRealMs?: number } | null {
    return this.#scheduleOptions.get(taskId) ?? null;
  }
}
