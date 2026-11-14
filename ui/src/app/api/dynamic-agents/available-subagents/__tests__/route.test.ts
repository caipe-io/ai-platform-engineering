/** @jest-environment node */
import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockCollection = jest.fn();
const mockPermission = jest.fn();
const mockFilter = jest.fn();
const mockAppStream = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ApiError: jest.requireActual("@/lib/api-error").ApiError,
  getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args),
  successResponse: (data: unknown) => Response.json({ success: true, data }),
  withErrorHandler: (handler: unknown) => handler,
}));
jest.mock("@/lib/mongodb", () => ({ getCollection: () => mockCollection() }));
jest.mock("@/lib/rbac/resource-authz", () => ({
  requireAgentPermission: (...args: unknown[]) => mockPermission(...args),
  filterResourcesByPermission: (...args: unknown[]) => mockFilter(...args),
}));
jest.mock("@/lib/agentic-apps/assistant-stream", () => ({ findAgenticAppAssistantStream: (...args: unknown[]) => mockAppStream(...args) }));
import { GET } from "../route";

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ session: { sub: "test-user" } });
  mockPermission.mockResolvedValue(undefined);
  mockFilter.mockImplementation(async (_session, candidates) => candidates);
  mockAppStream.mockReturnValue(null);
});

it("offers authorized runtime metadata for creation without requiring a child model", async () => {
  const items = [
    { _id: "native", name: "Native", enabled: true },
    { _id: "code", name: "Code", enabled: true, execution_harness_id: "claude_code_cli_acp" },
    { _id: "app", name: "App-owned", enabled: true },
  ];
  mockCollection.mockResolvedValue({ find: () => ({ toArray: async () => items }) });
  mockAppStream.mockImplementation(id => id === "app" ? { path: ["chat"] } : null);
  const response = await GET(new NextRequest("https://example.test/api/dynamic-agents/available-subagents?create=true"));
  expect((await response.json()).data.agents).toEqual([
    expect.objectContaining({ id: "native", execution_harness_id: "dynamic_agents" }),
    expect.objectContaining({ id: "code", execution_harness_id: "claude_code_cli_acp" }),
  ]);
  expect(mockPermission).not.toHaveBeenCalled();
  expect(mockFilter).toHaveBeenCalledWith(expect.anything(), [items[0], items[1]], expect.objectContaining({ action: "use" }));
});

it("checks parent write permission before listing edit candidates", async () => {
  const find = jest.fn();
  mockCollection.mockResolvedValue({ findOne: async () => ({ _id: "parent" }), find });
  mockPermission.mockRejectedValue(new Error("Forbidden"));
  await expect(GET(new NextRequest("https://example.test/api/dynamic-agents/available-subagents?id=parent"))).rejects.toThrow("Forbidden");
  expect(find).not.toHaveBeenCalled();
});

it("retains cycle exclusion and permission filtering", async () => {
  const items = [{ _id: "parent", name: "Parent" }, { _id: "ancestor", name: "Ancestor", subagents: [{ agent_id: "parent" }] }, { _id: "other", name: "Other" }];
  mockCollection.mockResolvedValue({ findOne: async () => items[0], find: () => ({ toArray: async () => items }) });
  mockFilter.mockResolvedValue([]);
  const response = await GET(new NextRequest("https://example.test/api/dynamic-agents/available-subagents?id=parent"));
  expect((await response.json()).data.agents).toEqual([]);
  expect(mockFilter.mock.calls[0][1]).toEqual([items[2]]);
});

it("requires authentication before loading any candidates", async () => {
  mockAuth.mockRejectedValue(new Error("Unauthorized"));
  await expect(GET(new NextRequest("https://example.test/api/dynamic-agents/available-subagents?create=true"))).rejects.toThrow("Unauthorized");
  expect(mockCollection).not.toHaveBeenCalled();
});
