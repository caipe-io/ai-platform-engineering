/**
 * @jest-environment node
 *
 * Checks which notification events the workflow engine emits for each run
 * outcome, using a fake run collection and a mocked agent stream.
 */
const mockNotify = jest.fn();
const mockConsume = jest.fn();
const mockAuthorize = jest.fn();
const mockCollection = {
  insertOne: jest.fn(),
  updateOne: jest.fn(),
  findOne: jest.fn(),
};

jest.mock("@/lib/mongodb", () => ({ getCollection: async () => mockCollection }));
jest.mock("@/lib/streaming/clients/server-agui-consumer", () => ({
  consumeAgentStream: (...args: unknown[]) => mockConsume(...args),
}));
jest.mock("@/lib/server/event-store", () => ({ readEvents: jest.fn().mockResolvedValue([]) }));
jest.mock("@/lib/authz", () => ({ authorize: (...args: unknown[]) => mockAuthorize(...args) }));
jest.mock("@/lib/server/workflow-notifications", () => ({
  notifyWorkflowEvent: (...args: unknown[]) => mockNotify(...args),
}));

import { detectStaleRun, startWorkflowRun } from "../workflow-engine";
import type { WorkflowConfig } from "@/types/workflow-config";

const owner = { type: "user" as const, id: "subject-example" };

function config(onError: "abort" | "skip" = "abort"): WorkflowConfig {
  return {
    _id: "workflow-example",
    name: "Example workflow",
    description: "Example",
    steps: [
      { type: "step", display_text: "First", agent_id: "agent-example", prompt: "Do it", on_error: onError },
    ],
  } as unknown as WorkflowConfig;
}

function kinds(): string[] {
  return mockNotify.mock.calls.map(([input]) => (input as { kind: string }).kind);
}

async function waitForKinds(expected: string[], timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (JSON.stringify(kinds()) !== JSON.stringify(expected)) {
    if (Date.now() > deadline) {
      throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(kinds())}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockNotify.mockResolvedValue(undefined);
  mockAuthorize.mockResolvedValue({ decision: "ALLOW", reason: "ok" });
  mockCollection.insertOne.mockResolvedValue({});
  mockCollection.updateOne.mockResolvedValue({});
  mockCollection.findOne.mockResolvedValue(null);
  // Artifact writes (PUT) succeed. Reading agent error.txt (GET) is a 404, so a
  // normal step is not treated as having reported its own failure.
  global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) =>
    init?.method === "PUT"
      ? { ok: true, status: 200, json: async () => ({}) }
      : { ok: false, status: 404, json: async () => ({}) },
  ) as unknown as typeof fetch;
});

describe("workflow engine notifications", () => {
  it("emits started then completed when every step succeeds", async () => {
    mockConsume.mockResolvedValue({ text: "done", interrupted: false });

    await startWorkflowRun(config(), null, {}, null, owner);

    await waitForKinds(["started", "completed"]);
    expect(mockNotify).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "completed", workflowName: "Example workflow", owner }),
    );
  });

  it("emits started then failed when a step errors and the policy is abort", async () => {
    mockConsume.mockResolvedValue({ text: "", interrupted: false, error: "agent unreachable" });

    await startWorkflowRun(config("abort"), null, {}, null, owner);

    await waitForKinds(["started", "failed"]);
  });

  it("does not emit failed when a failing step is skipped and the run completes", async () => {
    mockConsume.mockResolvedValue({ text: "", interrupted: false, error: "agent unreachable" });

    await startWorkflowRun(config("skip"), null, {}, null, owner);

    await waitForKinds(["started", "completed"]);
  });

  it("emits started then failed when the owner is not allowed to use the agent", async () => {
    mockAuthorize.mockResolvedValue({ decision: "DENY", reason: "no grant" });

    await startWorkflowRun(config(), null, {}, null, owner);

    await waitForKinds(["started", "failed"]);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it("emits started then requires_input, and no completion, when a step pauses for input", async () => {
    mockConsume.mockResolvedValue({
      text: "Which environment?",
      interrupted: true,
      interrupt: { type: "input_required", interruptId: "interrupt-example", prompt: "Which environment?" },
    });

    await startWorkflowRun(config(), null, {}, null, owner);

    await waitForKinds(["started", "requires_input"]);
    expect(mockNotify).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "requires_input", stepIndex: 0 }),
    );
  });

  it("never puts step errors, prompts or agent output into a notification", async () => {
    mockConsume.mockResolvedValue({ text: "", interrupted: false, error: "token=super-secret-value" });

    await startWorkflowRun(config(), "private user context", {}, null, owner);

    await waitForKinds(["started", "failed"]);
    expect(JSON.stringify(mockNotify.mock.calls)).not.toContain("super-secret-value");
    expect(JSON.stringify(mockNotify.mock.calls)).not.toContain("private user context");
  });

  it("still starts the run when the notification call rejects", async () => {
    mockNotify.mockRejectedValue(new Error("notifications down"));
    mockConsume.mockResolvedValue({ text: "done", interrupted: false });

    await expect(startWorkflowRun(config(), null, {}, null, owner)).resolves.toMatch(/\S/);
  });

  it("emits failed once for a run that exceeded its maximum duration", async () => {
    const stale = {
      _id: "run-stale",
      status: "running",
      started_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7),
      current_step_index: 0,
      owner_subject: owner,
    };

    const result = await detectStaleRun(stale as never);

    expect(result).toBe(true);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "failed", runId: "run-stale", owner }),
    );
  });

  it("does not notify for a run that is still within its time limit", async () => {
    const fresh = {
      _id: "run-fresh",
      status: "running",
      started_at: new Date(),
      current_step_index: 0,
      owner_subject: owner,
    };

    expect(await detectStaleRun(fresh as never)).toBe(false);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
