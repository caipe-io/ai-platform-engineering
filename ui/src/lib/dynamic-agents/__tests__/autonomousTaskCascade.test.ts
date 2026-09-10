// Copyright CAIPE Contributors (https://caipe.io)
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the dynamic-agent <-> autonomous-task cascade helpers.
 *
 * The agent-deletion cascade is fail-fast: any failure must surface so the
 * caller can abort rather than leave an orphaned, still-live task behind.
 */

let mockAutonomousAgentsEnabled = true;

jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => {
    if (key === "autonomousAgentsEnabled") return mockAutonomousAgentsEnabled;
    return undefined;
  },
}));

const mockFetch = jest.fn();
beforeAll(() => {
  (globalThis as { fetch: unknown }).fetch = mockFetch;
});

import { cascadeDeleteAutonomousTasksForAgent } from "../autonomousTaskCascade";
import type { AutonomousTask } from "@/components/autonomous/types";

function task(overrides: Partial<AutonomousTask>): AutonomousTask {
  return {
    id: "task-1",
    name: "Task",
    agent: null,
    dynamic_agent_id: null,
    prompt: "do the thing",
    trigger: { type: "cron", schedule: "0 9 * * *" },
    enabled: true,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAutonomousAgentsEnabled = true;
  delete process.env.AUTONOMOUS_AGENTS_URL;
  delete process.env.NEXT_PUBLIC_AUTONOMOUS_AGENTS_URL;
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("cascadeDeleteAutonomousTasksForAgent", () => {
  it("no-ops without calling fetch when autonomous agents are disabled", async () => {
    mockAutonomousAgentsEnabled = false;
    const result = await cascadeDeleteAutonomousTasksForAgent("agent-a");
    expect(result).toEqual({ attempted: 0, deleted: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("deletes only tasks matching dynamic_agent_id or legacy agent field", async () => {
    const tasks = [
      task({ id: "t1", dynamic_agent_id: "agent-a" }),
      task({ id: "t2", agent: "agent-a", dynamic_agent_id: null }),
      task({ id: "t3", dynamic_agent_id: "agent-b" }),
    ];
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, tasks)) // GET /tasks
      .mockResolvedValueOnce(jsonResponse(204, null)) // DELETE t1
      .mockResolvedValueOnce(jsonResponse(204, null)); // DELETE t2

    const result = await cascadeDeleteAutonomousTasksForAgent("agent-a");

    expect(result).toEqual({ attempted: 2, deleted: 2 });
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "http://localhost:8002/api/v1/tasks",
      expect.objectContaining({ headers: expect.not.objectContaining({ "X-Authenticated-User-Email": expect.anything() }) }),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(2, "http://localhost:8002/api/v1/tasks/t1", expect.objectContaining({ method: "DELETE" }));
    expect(mockFetch).toHaveBeenNthCalledWith(3, "http://localhost:8002/api/v1/tasks/t2", expect.objectContaining({ method: "DELETE" }));
  });

  it("treats a 404 on an individual delete as already-gone success", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, [task({ id: "t1", dynamic_agent_id: "agent-a" })]))
      .mockResolvedValueOnce(jsonResponse(404, { detail: "not found" }));

    const result = await cascadeDeleteAutonomousTasksForAgent("agent-a");
    expect(result).toEqual({ attempted: 1, deleted: 1 });
  });

  it("throws when the list call fails", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(500, { detail: "boom" }));
    await expect(cascadeDeleteAutonomousTasksForAgent("agent-a")).rejects.toThrow();
  });

  it("throws when the list call rejects with a network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(cascadeDeleteAutonomousTasksForAgent("agent-a")).rejects.toThrow();
  });

  it("throws on a non-404 delete failure without swallowing it", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, [task({ id: "t1", dynamic_agent_id: "agent-a" })]))
      .mockResolvedValueOnce(jsonResponse(500, { detail: "boom" }));

    await expect(cascadeDeleteAutonomousTasksForAgent("agent-a")).rejects.toThrow();
  });

  it("returns zero attempted/deleted when nothing matches", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, [task({ id: "t1", dynamic_agent_id: "agent-other" })]));
    const result = await cascadeDeleteAutonomousTasksForAgent("agent-a");
    expect(result).toEqual({ attempted: 0, deleted: 0 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
