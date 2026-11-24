// Copyright (c) 2026 Sary Ismail. Licensed under the Apache License, Version 2.0; see LICENSE.
// SPDX-License-Identifier: Apache-2.0
import { sha256Hex, simTime } from "@after-genesis/core";
import { scheduleNextTurn, type SchedulerDependencies, type TurnTask } from "./scheduler.js";
import { executeTurn, type TurnDependencies, type TurnResult } from "./turn.js";

export interface TurnWorkerHttpRequest {
  readonly method: string;
  readonly headers: {
    get(name: string): string | null;
  };
  json(): Promise<unknown>;
}

export interface TurnWorkerHttpResponse {
  readonly status: number;
  readonly body: {
    readonly ok: boolean;
    readonly status: string;
    readonly reason?: string;
    readonly next?: string;
  };
}

export interface TurnWorkerDependencies {
  readonly turn: TurnDependencies;
  readonly scheduler: SchedulerDependencies;
  /** Short Cloud Tasks queue name supplied in X-CloudTasks-QueueName. */
  readonly expectedQueueName: string;
}

/**
 * Framework-neutral Cloud Tasks worker.
 *
 * Cloud Run IAM is the authentication boundary and must reject unauthenticated
 * traffic before this function runs. The queue and deterministic task-name
 * checks below are defence in depth: a different trusted task identity cannot
 * smuggle arbitrary work into this endpoint.
 */
export function createTurnWorker(deps: TurnWorkerDependencies) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(deps.expectedQueueName)) {
    throw new Error("expectedQueueName must be a valid short Cloud Tasks queue name");
  }

  return async (request: TurnWorkerHttpRequest): Promise<TurnWorkerHttpResponse> => {
    if (request.method !== "POST") {
      return response(405, "method-not-allowed", "turn worker accepts POST only");
    }

    const queueName = request.headers.get("x-cloudtasks-queuename");
    if (queueName !== deps.expectedQueueName) {
      return response(403, "forbidden", "request did not originate from the configured queue");
    }

    let task: TurnTask;
    try {
      task = parseTurnTask(await request.json());
    } catch (error) {
      return response(
        400,
        "invalid-task",
        error instanceof Error ? error.message : "invalid task payload",
      );
    }

    const deliveredTaskName = request.headers.get("x-cloudtasks-taskname");
    const expectedTaskName = `turn-${sha256Hex(task.taskId).slice(0, 40)}`;
    if (
      deliveredTaskName === null ||
      deliveredTaskName.split("/").at(-1) !== expectedTaskName
    ) {
      return response(403, "forbidden", "task name does not match its canonical task id");
    }

    let result: TurnResult;
    try {
      result = await executeTurn(deps.turn, {
        worldId: task.worldId,
        actorId: task.actorId,
        expectedSequence: task.expectedSequence,
        simTime: task.simTime,
        taskId: task.taskId,
      });
    } catch {
      // Never reflect internal errors or credentials into a Cloud Tasks response.
      return response(500, "failed", "turn execution failed");
    }

    if (result.status === "deferred") {
      // A non-2xx status asks Cloud Tasks to retry the exact immutable task.
      return response(503, "deferred", result.reason);
    }

    try {
      const next = await scheduleNextTurn(deps.scheduler, task.worldId);
      return {
        status: 200,
        body: {
          ok: true,
          status: result.status,
          ...(next.status === "scheduled" ? { next: next.task.taskId } : {}),
        },
      };
    } catch {
      // The canonical turn may already be durable. Returning 500 is intentional:
      // the retry sees it as a duplicate and repairs the missing schedule step.
      return response(500, "schedule-failed", "turn committed but scheduling failed");
    }
  };
}

function response(
  status: number,
  resultStatus: string,
  reason: string,
): TurnWorkerHttpResponse {
  return { status, body: { ok: false, status: resultStatus, reason } };
}

function parseTurnTask(value: unknown): TurnTask {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("task body must be a JSON object");
  }
  const task = value as Record<string, unknown>;
  const keys = Object.keys(task).sort();
  const expectedKeys = ["actorId", "expectedSequence", "simTime", "taskId", "worldId"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("task body has missing or unexpected fields");
  }
  for (const name of ["taskId", "worldId", "actorId"] as const) {
    if (
      typeof task[name] !== "string" ||
      task[name].trim() === "" ||
      task[name].length > 256
    ) {
      throw new Error(`${name} must be a non-empty string of at most 256 characters`);
    }
  }
  const taskId = task.taskId as string;
  const worldId = task.worldId as string;
  const actorId = task.actorId as string;
  if (
    typeof task.expectedSequence !== "number" ||
    !Number.isSafeInteger(task.expectedSequence) ||
    task.expectedSequence < 1
  ) {
    throw new Error("expectedSequence must be a positive safe integer");
  }
  if (
    typeof task.simTime !== "number" ||
    !Number.isSafeInteger(task.simTime) ||
    task.simTime < 0
  ) {
    throw new Error("simTime must be a non-negative safe integer");
  }
  const expectedTaskId = `${worldId}:${actorId}:${task.expectedSequence}`;
  if (taskId !== expectedTaskId) {
    throw new Error("taskId does not match worldId, actorId, and expectedSequence");
  }
  return {
    taskId,
    worldId,
    actorId,
    expectedSequence: task.expectedSequence,
    simTime: simTime(task.simTime),
  };
}
