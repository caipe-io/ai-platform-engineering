/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
import { GET, POST, PATCH } from "./route";

const mockFeatures = jest.fn();
jest.mock("@/lib/coordination/features.server", () => ({ getCoordinationFeatures: () => mockFeatures() }));
const mockSetPolicy = jest.fn();
jest.mock("@/lib/coordination/policy.server", () => ({ coordinationPolicy: async () => null, setCoordinationPolicy: (...args: unknown[]) => mockSetPolicy(...args) }));
jest.mock("@/lib/coordination/handoffs.server", () => ({ listHandoffs: async () => [] }));
const mockRead = jest.fn();
const mockUse = jest.fn();
const mockOwner = jest.fn();
const mockFindAgent = jest.fn();
const mockUpdate = jest.fn();
const mockApp = jest.fn();
const mockRuntime = jest.fn();
const mockStatus = jest.fn();
jest.mock("@/app/api/v1/chat/_stream-auth", () => ({ authenticateChatStreamRequest: async () => ({ subject: "owner", email: "owner@example.test" }) }));
jest.mock("@/app/api/v1/chat/_conversation-authz", () => ({ authorizeConversationReadAccess: (...args: unknown[]) => mockRead(...args) }));
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({ requireAgentUsePermission: (...args: unknown[]) => mockUse(...args) }));
jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({ isImplicitConversationOwner: (...args: unknown[]) => mockOwner(...args) }));
jest.mock("@/lib/harness-engine-proxy", () => ({ isHarnessEngineConfigured: () => true }));
jest.mock("@/lib/harness-gateway", () => ({ resolveHarnessGatewayTarget: (...args: unknown[]) => mockRuntime(...args), getHarnessConversationStatus: (...args: unknown[]) => mockStatus(...args) }));
jest.mock("@/lib/agentic-apps/assistant-stream", () => ({ findAgenticAppAssistantStream: (...args: unknown[]) => mockApp(...args) }));
jest.mock("@/lib/mongodb", () => ({ getCollection: async (name: string) => name === "dynamic_agents" ? { findOne: mockFindAgent } : { updateOne: mockUpdate } }));
jest.mock("@/lib/api-middleware", () => {
  const { ApiError } = jest.requireActual("@/lib/api-error");
  const { NextResponse } = jest.requireActual("next/server");
  return { ApiError, validateConversationId: () => true, withErrorHandler: (handler: (...args: unknown[]) => Promise<Response>) => async (...args: unknown[]) => {
    try { return await handler(...args); } catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: (error as { statusCode: number }).statusCode || 500 }); }
  } };
});
const conversation = { _id: "chat-example", owner_id: "owner@example.test", client_type: "webui", participants: [{ type: "agent", id: "agent-primary" }] };
const context = { params: Promise.resolve({ id: conversation._id }) };
const request = (body: unknown = { agent_id: "agent-helper", handle: "reviewer" }) => new NextRequest("https://example.test/api/chat/conversations/chat-example/agents", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  jest.resetAllMocks();
  mockFeatures.mockResolvedValue({ enabled: true, team: true });
  mockRead.mockResolvedValue({ conversation, denial: null });
  mockOwner.mockReturnValue(true);
  mockUse.mockResolvedValue(null);
  mockFindAgent.mockResolvedValue({ _id: "agent-helper", name: "Helper", enabled: true });
  mockUpdate.mockResolvedValue({ modifiedCount: 1 });
  mockRuntime.mockResolvedValue({ kind: "harness_engine" });
  mockStatus.mockResolvedValue(null);
});
it("adds a member atomically without replacing the primary or granting permissions", async () => {
  const response = await POST(request(), context);
  expect(response.status).toBe(201);
  expect(mockUse).toHaveBeenCalledWith(expect.objectContaining({ subject: "owner", agentId: "agent-helper" }));
  expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
    "coordination_agents.7": { $exists: false },
    coordination_agents: { $not: { $elemMatch: { $or: [{ agent_id: "agent-helper" }, { handle: "reviewer" }] } } },
  }), { $push: { coordination_agents: expect.objectContaining({ agent_id: "agent-helper", handle: "reviewer", added_by: "owner" }) }, $set: { updated_at: expect.any(Date) } });
  expect(conversation.participants).toEqual([{ type: "agent", id: "agent-primary" }]);
});
it("allows a shared viewer to read membership, but not attach agents", async () => {
  mockOwner.mockReturnValue(false);
  const read = await GET(new NextRequest("https://example.test/api/chat/conversations/chat-example/agents"), context);
  expect((await read.json()).data.can_manage).toBe(false);
  expect((await POST(request(), context)).status).toBe(403);
  expect(mockUse).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("honors the current caller's Use denial", async () => {
  mockUse.mockResolvedValue(NextResponse.json({ error: "Denied" }, { status: 403 }));
  expect((await POST(request(), context)).status).toBe(403);
  expect(mockFindAgent).not.toHaveBeenCalled();
  expect(mockUpdate).not.toHaveBeenCalled();
});
it.each(["primary", "UPPER", "bad handle", "$operator", "x"])("rejects an invalid/reserved handle %s", async handle => {
  expect((await POST(request({ agent_id: "agent-helper", handle }), context)).status).toBe(400);
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("reports a raced duplicate/full list rather than claiming it joined", async () => {
  mockUpdate.mockResolvedValue({ modifiedCount: 0 });
  expect((await POST(request(), context)).status).toBe(409);
});
it("does not change a native primary session when attachment requires migration", async () => {
  mockRuntime.mockResolvedValue({ kind: "dynamic_agents" });
  expect((await POST(request(), context)).status).toBe(409);
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("rejects disabled agents and app-owned assistants", async () => {
  mockFindAgent.mockResolvedValueOnce({ enabled: false });
  expect((await POST(request(), context)).status).toBe(409);
  mockApp.mockImplementation(id => id === "agent-helper" ? {} : null);
  expect((await POST(request(), context)).status).toBe(409);
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("keeps shared viewers from authorizing background handoffs", async () => {
  mockOwner.mockReturnValue(false);
  expect((await PATCH(request({ mode: "team" }), context)).status).toBe(403);
  expect(mockSetPolicy).not.toHaveBeenCalled();
});
it("requires a joined agent before team mode and rejects unknown modes", async () => {
  expect((await PATCH(request({ mode: "team" }), context)).status).toBe(409);
  expect((await PATCH(request({ mode: "unknown" }), context)).status).toBe(400);
  expect(mockSetPolicy).not.toHaveBeenCalled();
});
it("binds team authorization to the authenticated owner instead of request identity", async () => {
  mockRead.mockResolvedValue({ conversation: { ...conversation, coordination_agents: [{ agent_id: "agent-helper", handle: "helper" }] }, denial: null });
  const change = request({ mode: "team", owner: "other-user" });
  expect((await PATCH(change, context)).status).toBe(200);
  expect(mockSetPolicy).toHaveBeenCalledWith(change, "chat-example", "owner", "team");
});

it("keeps history readable but blocks attachment when coordination is disabled", async () => {
  mockFeatures.mockResolvedValue({ enabled: false, team: false });
  const response = await GET(request(), context);
  expect((await response.json()).data).toMatchObject({ enabled: false, team_available: false, can_manage: false, available: false });
  expect((await POST(request(), context)).status).toBe(403);
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("rejects enabling team handoffs independently of manual agent attachment", async () => {
  mockFeatures.mockResolvedValue({ enabled: true, team: false });
  expect((await POST(request(), context)).status).toBe(201);
  expect((await PATCH(request({ mode: "team" }), context)).status).toBe(403);
  expect(mockSetPolicy).not.toHaveBeenCalled();
  expect((await PATCH(request({ mode: "mentions" }), context)).status).toBe(200);
});
