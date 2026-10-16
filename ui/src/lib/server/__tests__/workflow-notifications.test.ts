/** @jest-environment node */

import { notifyWorkflowEvent } from "../workflow-notifications";

const mockPublishRequest = jest.fn();

jest.mock("@/lib/notifications/fanout.server", () => ({
  publishNotificationRequest: (...args: unknown[]) => mockPublishRequest(...args),
}));

const owner = { type: "user" as const, id: "subject-example" };

beforeEach(() => {
  jest.clearAllMocks();
  mockPublishRequest.mockResolvedValue({ recipients: 1, skipped: 0, results: {} });
});

function lastRequest(): { base: Record<string, unknown> & { data: Record<string, string> }; recipients: unknown; includeOrgAdmins: boolean } {
  return mockPublishRequest.mock.calls.at(-1)?.[0];
}

describe("notifyWorkflowEvent", () => {
  it.each([
    ["started", "workflow.started", "Workflow started"],
    ["completed", "workflow.completed", "Workflow completed"],
    ["failed", "workflow.failed", "Workflow failed"],
    ["requires_input", "workflow.requires_input", "Workflow needs your input"],
  ] as const)("publishes %s to the run owner only", async (kind, type, title) => {
    await notifyWorkflowEvent({ kind, runId: "run-1", workflowName: "Nightly report", owner });

    const request = lastRequest();
    expect(request.base.type).toBe(type);
    expect(request.base.data.title).toBe(title);
    expect(request.base.data.summary).toContain("Nightly report");
    expect(request.base.resource).toEqual({ type: "workflow_run", id: "run-1" });
    expect(request.base.data.href).toBe("/workflows/run/run-1");
    expect(request.recipients).toEqual([{ subject: "subject-example" }]);
    expect(request.includeOrgAdmins).toBe(false);
  });

  it("gives each paused step its own attempt id, and the same step the same id", async () => {
    await notifyWorkflowEvent({ kind: "requires_input", runId: "run-1", owner, stepIndex: 0 });
    await notifyWorkflowEvent({ kind: "requires_input", runId: "run-1", owner, stepIndex: 2 });
    await notifyWorkflowEvent({ kind: "requires_input", runId: "run-1", owner, stepIndex: 2 });

    const attempts = mockPublishRequest.mock.calls.map(([r]) => r.base.attempt_id);
    expect(attempts).toEqual(["run-1:step-0", "run-1:step-2", "run-1:step-2"]);
  });

  it("uses the run id as the attempt id for lifecycle events", async () => {
    await notifyWorkflowEvent({ kind: "completed", runId: "run-9", owner });
    expect(lastRequest().base.attempt_id).toBe("run-9");
  });

  it("falls back to a generic name and accepts a summary override", async () => {
    await notifyWorkflowEvent({ kind: "failed", runId: "run-1", owner, summary: "Exceeded its time limit." });
    expect(lastRequest().base.data.summary).toBe("Exceeded its time limit.");

    await notifyWorkflowEvent({ kind: "completed", runId: "run-1", owner });
    expect(lastRequest().base.data.summary).toBe("A workflow finished.");
  });

  it("encodes the run id in the link", async () => {
    await notifyWorkflowEvent({ kind: "completed", runId: "run/with space", owner });
    expect(lastRequest().base.data.href).toBe("/workflows/run/run%2Fwith%20space");
  });

  it("skips runs with no owner and runs owned by service accounts", async () => {
    await notifyWorkflowEvent({ kind: "completed", runId: "run-1", owner: null });
    await notifyWorkflowEvent({ kind: "completed", runId: "run-1", owner: undefined });
    await notifyWorkflowEvent({ kind: "completed", runId: "run-1", owner: { type: "service_account", id: "svc" } });
    expect(mockPublishRequest).not.toHaveBeenCalled();
  });

  it("never throws, even if publishing throws", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    mockPublishRequest.mockRejectedValue(new Error("boom"));

    await expect(notifyWorkflowEvent({ kind: "completed", runId: "run-1", owner })).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
