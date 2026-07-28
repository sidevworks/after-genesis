import { CloudTasksClient } from "@google-cloud/tasks";
import { sha256Hex } from "@after-genesis/core";
import type { TurnQueue, TurnTask } from "./scheduler.js";

interface CloudTasksClientLike {
  queuePath(project: string, location: string, queue: string): string;
  taskPath(project: string, location: string, queue: string, task: string): string;
  createTask(request: {
    parent: string;
    task: {
      name: string;
      httpRequest: {
        httpMethod: "POST";
        url: string;
        headers: Record<string, string>;
        body: string;
        oidcToken?: { serviceAccountEmail: string; audience: string };
      };
    };
  }): Promise<unknown>;
}

export interface CloudTasksTurnQueueOptions {
  readonly projectId: string;
  readonly location: string;
  readonly queue: string;
  readonly workerUrl: string;
  readonly serviceAccountEmail?: string;
  readonly audience?: string;
  readonly client?: CloudTasksClientLike;
}

/**
 * Google Cloud Tasks adapter with deterministic task names.
 *
 * Cloud Tasks returns ALREADY_EXISTS when scheduling is retried; that is
 * success from the scheduler's perspective because the intended task exists.
 */
export class CloudTasksTurnQueue implements TurnQueue {
  readonly #options: CloudTasksTurnQueueOptions;
  readonly #client: CloudTasksClientLike;

  constructor(options: CloudTasksTurnQueueOptions) {
    for (const [name, value] of Object.entries({
      projectId: options.projectId,
      location: options.location,
      queue: options.queue,
      workerUrl: options.workerUrl,
    })) {
      if (value.trim() === "") throw new Error(`${name} must not be empty`);
    }
    const url = new URL(options.workerUrl);
    if (url.protocol !== "https:") throw new Error("workerUrl must use HTTPS");
    this.#options = options;
    this.#client = options.client ?? (new CloudTasksClient() as CloudTasksClientLike);
  }

  async enqueue(task: TurnTask): Promise<"created" | "already-exists"> {
    const parent = this.#client.queuePath(
      this.#options.projectId,
      this.#options.location,
      this.#options.queue,
    );
    // Task IDs cannot contain the colons in the canonical task id. Hashing also
    // prevents an inhabitant/world id from becoming an injection into a path.
    const cloudTaskId = `turn-${sha256Hex(task.taskId).slice(0, 40)}`;
    const name = this.#client.taskPath(
      this.#options.projectId,
      this.#options.location,
      this.#options.queue,
      cloudTaskId,
    );
    const body = Buffer.from(JSON.stringify(task), "utf8").toString("base64");
    const oidc =
      this.#options.serviceAccountEmail === undefined
        ? {}
        : {
            oidcToken: {
              serviceAccountEmail: this.#options.serviceAccountEmail,
              // Cloud Run validates the service origin as the OIDC audience,
              // not the route path that receives the task.
              audience:
                this.#options.audience ?? new URL(this.#options.workerUrl).origin,
            },
          };

    try {
      await this.#client.createTask({
        parent,
        task: {
          name,
          httpRequest: {
            httpMethod: "POST",
            url: this.#options.workerUrl,
            headers: { "Content-Type": "application/json" },
            body,
            ...oidc,
          },
        },
      });
      return "created";
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 6
      ) {
        return "already-exists";
      }
      throw error;
    }
  }
}
