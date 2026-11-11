/** @jest-environment node */
import { NextRequest } from "next/server";
import { ApiError } from "@/lib/api-middleware";
import { PUT } from "../route";

const mockUpdate = jest.fn();
const mockRunnable = jest.fn();
const mockReconcile = jest.fn();
const mockWriteAccess = jest.fn();
const mockSkillLookup = jest.fn();
const mockHubLookup = jest.fn();
let mockExisting: Record<string, unknown>;

jest.mock("@/lib/mongodb", () => ({
  isMongoDBConfigured: true,
  getCollection: async (name: string) => {
    if (name === "workflow_configs") return { findOne: async () => mockExisting, updateOne: mockUpdate };
    if (name === "skill_hubs") return { findOne: mockHubLookup };
    return { findOne: mockSkillLookup };
  },
}));
jest.mock("@/lib/agent-mutation-lock", () => ({
  withAgentMutationLock: async (_id: string, operation: () => Promise<unknown>) => operation(),
}));
jest.mock("@/lib/api-middleware", () => ({
  ApiError: class extends Error {
    constructor(message: string, public statusCode = 500) { super(message); }
  },
  successResponse: (data: unknown) => Response.json(data),
  withAuth: async (request: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    handler(request, { role: "user", email: "user@example.test" }, { sub: "test-user" }),
  withErrorHandler: (handler: (request: NextRequest) => Promise<Response>) => async (request: NextRequest) => {
    try { return await handler(request); }
    catch (error) {
      return Response.json({ error: (error as Error).message }, {
        status: (error as { statusCode?: number }).statusCode ?? 500,
      });
    }
  },
}));
jest.mock("@/lib/server/workflow-cas-authz", () => ({}));
jest.mock("@/lib/rbac/workflow-config-rebac", () => ({
  requireWorkflowConfigWriteAccess: (...args: unknown[]) => mockWriteAccess(...args),
  reconcileWorkflowConfigAccess: (...args: unknown[]) => mockReconcile(...args),
}));
jest.mock("@/lib/server/workflow-step-agents", () => ({
  assertWorkflowConfigRunnable: (...args: unknown[]) => mockRunnable(...args),
}));

function step(skills: string[]) {
  return { type: "step", display_text: "Check", agent_id: "agent-example", prompt: "Check", config_override: { skills } };
}
function update(body: unknown) {
  return PUT(new NextRequest("http://example.test/api/workflow-configs?id=workflow-example", {
    method: "PUT", body: JSON.stringify(body),
  }));
}
beforeEach(() => {
  jest.clearAllMocks();
  mockExisting = { _id: "workflow-example", name: "Example", owner_id: "user@example.test", visibility: "private", steps: [step(["skill-retired"])] };
  mockWriteAccess.mockResolvedValue(undefined);
  mockRunnable.mockResolvedValue(undefined);
  mockReconcile.mockResolvedValue(undefined);
  mockUpdate.mockResolvedValue({ modifiedCount: 1 });
  mockSkillLookup.mockResolvedValue(null);
});

it.each([{ name: "Renamed" }, { visibility: "global" }, { name: "Renamed", steps: [step(["skill-retired"])] }])(
  "preserves unchanged legacy references during metadata/full-form updates: %p", async body => {
    const response = await update(body);
    expect(response.status).toBe(200);
    expect(mockSkillLookup).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockWriteAccess).toHaveBeenCalledTimes(1);
    expect(mockReconcile).toHaveBeenCalledTimes(1);
  },
);
it("rejects a newly attached missing skill without persisting", async () => {
  const response = await update({ steps: [step(["skill-retired", "skill-missing"])] });
  expect(response.status).toBe(409);
  expect(mockSkillLookup).toHaveBeenCalledWith({ id: "skill-missing" });
  expect(mockSkillLookup).toHaveBeenCalledTimes(1);
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockReconcile).not.toHaveBeenCalled();
});
it("rejects a newly selected obsolete Hub cache without persisting", async () => {
  mockSkillLookup.mockResolvedValue({ cache_generation: "old" });
  mockHubLookup.mockResolvedValue({ enabled: true, cache_generation: "new" });
  const response = await update({ steps: [step([`hub-${"a".repeat(24)}-example`])] });
  expect(response.status).toBe(409);
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("validates the merged execution config before storing valid new skill references", async () => {
  mockSkillLookup.mockResolvedValue({ id: "skill-valid" });
  const response = await update({ steps: [step(["skill-valid"])] });
  expect(response.status).toBe(200);
  expect(mockRunnable.mock.invocationCallOrder[0]).toBeLessThan(mockUpdate.mock.invocationCallOrder[0]);
});
it("does not persist or reconcile when merged agent validation fails", async () => {
  mockRunnable.mockRejectedValue(new ApiError("Agent is unavailable", 400));
  const response = await update({ steps: [step([])] });
  expect(response.status).toBe(400);
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockReconcile).not.toHaveBeenCalled();
});
it("keeps workflow-write authorization ahead of metadata changes", async () => {
  mockWriteAccess.mockRejectedValue(new ApiError("Not allowed", 403));
  expect((await update({ name: "Renamed" })).status).toBe(403);
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("rejects null steps without persisting", async () => {
  expect((await update({ steps: null })).status).toBe(400);
  expect(mockUpdate).not.toHaveBeenCalled();
});
