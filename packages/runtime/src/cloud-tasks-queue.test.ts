// Copyright (c) 2026 SI Enterprise Labs (Sary Majdi Ismail). Business Source License 1.1; see LICENSE.
// SPDX-License-Identifier: BUSL-1.1
import { describe, expect, it, vi } from "vitest";
import { CloudTasksTurnQueue } from "./cloud-tasks-queue.js";

function fakeClient() {
  return {
    queuePath: (project: string, location: string, queue: string) =>
      `projects/${project}/locations/${location}/queues/${queue}`,
    taskPath: (project: string, location: string, queue: string, task: string) =>
      `projects/${project}/locations/${location}/queues/${queue}/tasks/${task}`,
    createTask: vi.fn(async (_request: unknown) => [{}]),
  };
}

const task = {
  taskId: "world:inh_founder:1",
  worldId: "world",
  actorId: "inh_founder",
  expectedSequence: 1,
  simTime: 120 as never,
};

describe("CloudTasksTurnQueue", () => {
  it("uses a deterministic safe task name and authenticated JSON request", async () => {
    const client = fakeClient();
    const queue = new CloudTasksTurnQueue({
      projectId: "project",
      location: "us-central1",
      queue: "turns",
      workerUrl: "https://worker.example/turn",
      serviceAccountEmail: "tasks@project.iam.gserviceaccount.com",
      client,
    });
    expect(await queue.enqueue(task)).toBe("created");
    expect(await queue.enqueue(task)).toBe("created");

    type Request = {
      task: {
        name: string;
        httpRequest: {
          body: string;
          oidcToken?: { serviceAccountEmail: string; audience: string };
        };
      };
    };
    const first = client.createTask.mock.calls[0]?.[0] as Request | undefined;
    const second = client.createTask.mock.calls[1]?.[0] as Request | undefined;
    expect(first?.task.name).toBe(second?.task.name);
    expect(first?.task.name).toMatch(/\/tasks\/turn-[0-9a-f]{40}$/);
    expect(first?.task.httpRequest.oidcToken?.serviceAccountEmail).toContain("@project");
    expect(first?.task.httpRequest.oidcToken?.audience).toBe("https://worker.example");
    expect(
      JSON.parse(Buffer.from(first?.task.httpRequest.body ?? "", "base64").toString("utf8")),
    ).toEqual(task);
  });

  it("treats Cloud Tasks ALREADY_EXISTS as idempotent success", async () => {
    const client = fakeClient();
    client.createTask.mockRejectedValueOnce(Object.assign(new Error("exists"), { code: 6 }));
    const queue = new CloudTasksTurnQueue({
      projectId: "project",
      location: "us-central1",
      queue: "turns",
      workerUrl: "https://worker.example/turn",
      client,
    });
    await expect(queue.enqueue(task)).resolves.toBe("already-exists");
  });

  it("refuses a non-TLS worker endpoint", () => {
    expect(
      () =>
        new CloudTasksTurnQueue({
          projectId: "project",
          location: "us-central1",
          queue: "turns",
          workerUrl: "http://worker.example/turn",
          client: fakeClient(),
        }),
    ).toThrow("HTTPS");
  });
});
