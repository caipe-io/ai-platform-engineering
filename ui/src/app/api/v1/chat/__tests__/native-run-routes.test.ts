/** @jest-environment node */

import { NextRequest, NextResponse } from "next/server";

import { GET as latestRun } from "../runs/route";
import { GET as replayRun } from "../runs/[runId]/stream/route";
import { GET as interruptState } from "../../../dynamic-agents/conversations/[id]/interrupt-state/route";

const mockAuthenticate = jest.fn();
const mockAgentPermission = jest.fn();
const mockConversationPermission = jest.fn();
const mockProxy = jest.fn();
const mockStreamProxy = jest.fn();
const mockFindConversation = jest.fn();

jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticate(...args),
  getDynamicAgentsConfig: () => ({ dynamicAgentsUrl: "http://example.test:8000" }),
  proxyRequest: (...args: unknown[]) => mockProxy(...args),
  proxySSEStream: (...args: unknown[]) => mockStreamProxy(...args),
}));
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({
  requireAgentUsePermission: (...args: unknown[]) => mockAgentPermission(...args),
}));
jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({
  requireConversationResourcePermission: (...args: unknown[]) => mockConversationPermission(...args),
}));
jest.mock("@/lib/mongodb", () => ({
  getCollection: async () => ({ findOne: (...args: unknown[]) => mockFindConversation(...args) }),
}));

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://example.test"));
}
const query = "conversation_id=conversation-1&agent_id=agent-1";

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthenticate.mockResolvedValue({
    subject: "example-service", email: "service@example.com", isServiceAccount: true,
  });
  mockAgentPermission.mockResolvedValue(null);
  mockConversationPermission.mockResolvedValue(undefined);
  mockFindConversation.mockResolvedValue({
    _id: "conversation-1", owner_subject: "example-owner", participants: [{ type: "agent", id: "agent-1" }],
  });
  mockProxy.mockResolvedValue(NextResponse.json({ run: null }));
  mockStreamProxy.mockResolvedValue(new Response("stream"));
});

it("checks agent use and conversation read before exposing run metadata", async () => {
  const response = await latestRun(request(`/api/v1/chat/runs?${query}`));
  expect(response.status).toBe(200);
  expect(mockAgentPermission).toHaveBeenCalledWith(expect.objectContaining({
    agentId: "agent-1", subject: "example-service", isServiceAccount: true,
  }));
  expect(mockConversationPermission).toHaveBeenCalledWith(
    expect.objectContaining({ sub: "example-service", isServiceAccount: true }),
    "service@example.com",
    expect.objectContaining({ _id: "conversation-1" }),
    "read",
  );
  expect(mockProxy).toHaveBeenCalledWith(
    "http://example.test:8000/api/v1/chat/runs?agent_id=agent-1&conversation_id=conversation-1",
    "GET", expect.anything(), "[runs/latest]",
  );
});

it("denies replay when the caller cannot read the conversation", async () => {
  mockConversationPermission.mockRejectedValue(Object.assign(new Error("Denied"), { statusCode: 403 }));
  const response = await replayRun(request(`/api/v1/chat/runs/run-1/stream?${query}`), { params: Promise.resolve({ runId: "run-1" }) });
  expect(response.status).toBe(403);
  expect(mockStreamProxy).not.toHaveBeenCalled();
});

it("does not proxy a mismatched agent or missing agent grant", async () => {
  const response = await latestRun(request("/api/v1/chat/runs?conversation_id=conversation-1&agent_id=agent-2"));
  expect(response.status).toBe(403);
  expect(mockProxy).not.toHaveBeenCalled();
  mockAgentPermission.mockResolvedValue(NextResponse.json({ error: "Denied" }, { status: 403 }));
  await latestRun(request(`/api/v1/chat/runs?${query}`));
  expect(mockProxy).not.toHaveBeenCalled();
});

it("uses the server-owned autonomous execution binding and GET cursor replay", async () => {
  mockFindConversation.mockResolvedValue({
    _id: "conversation-1", source: "autonomous", execution_context_id: "context-persisted",
    participants: [{ type: "agent", id: "agent-1" }],
  });
  await replayRun(request(`/api/v1/chat/runs/run-1/stream?${query}&after=7&execution_context_id=forged`), { params: Promise.resolve({ runId: "run-1" }) });
  expect(mockStreamProxy).toHaveBeenCalledWith(
    "http://example.test:8000/api/v1/chat/runs/run-1/stream?agent_id=agent-1&conversation_id=context-persisted&after=7",
    undefined, expect.anything(), "[runs/stream]", "GET",
  );
});

it.each(["-1", "1.5", "NaN", "9007199254740992"])("rejects invalid cursor %s", async (after) => {
  const response = await replayRun(request(`/api/v1/chat/runs/run-1/stream?${query}&after=${after}`), { params: Promise.resolve({ runId: "run-1" }) });
  expect(response.status).toBe(400);
  expect(mockStreamProxy).not.toHaveBeenCalled();
});

it("applies the same resource gates when restoring pending approvals", async () => {
  mockConversationPermission.mockRejectedValue(Object.assign(new Error("Denied"), { statusCode: 403 }));
  const response = await interruptState(request("/api/dynamic-agents/conversations/conversation-1/interrupt-state?agent_id=agent-1"), { params: Promise.resolve({ id: "conversation-1" }) });
  expect(response.status).toBe(403);
  expect(mockProxy).not.toHaveBeenCalled();
});
