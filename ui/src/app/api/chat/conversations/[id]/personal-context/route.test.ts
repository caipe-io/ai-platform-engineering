/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
import { POST } from "./route";

const mockAuth = jest.fn();
const mockWrite = jest.fn();
const mockAgentUse = jest.fn();
const mockAdmit = jest.fn();
jest.mock("@/app/api/v1/chat/_stream-auth", () => ({ authenticateChatStreamRequest: (...args: unknown[]) => mockAuth(...args) }));
jest.mock("@/app/api/v1/chat/_conversation-authz", () => ({ authorizeConversationWriteAccess: (...args: unknown[]) => mockWrite(...args) }));
jest.mock("@/lib/rbac/openfga-agent-authz", () => ({ requireAgentUsePermission: (...args: unknown[]) => mockAgentUse(...args) }));
jest.mock("@/lib/conversation-evidence-privacy", () => ({ admitPersonalEvidenceConversation: (...args: unknown[]) => mockAdmit(...args) }));

const id = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id }) };
function request(body: unknown = { agent_id: "agent-primary" }) {
  return new NextRequest(`https://example.test/api/chat/conversations/${id}/personal-context`, {
    method: "POST", headers: { "content-type": "application/json", origin: "https://example.test" }, body: JSON.stringify(body),
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ subject: "subject-primary", email: "owner@example.test" });
  mockAgentUse.mockResolvedValue(null);
  mockWrite.mockResolvedValue({ conversation: { _id: id }, denial: null });
  mockAdmit.mockResolvedValue(undefined);
});

it("reserves private context using the current identity only after agent and conversation gates", async () => {
  const response = await POST(request(), context);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true, data: { conversation_id: id, personal_context: "private" } });
  expect(mockAdmit).toHaveBeenCalledWith(id, "subject-primary", "owner@example.test", "agent-primary");
  expect(mockAgentUse.mock.invocationCallOrder[0]).toBeLessThan(mockWrite.mock.invocationCallOrder[0]);
  expect(mockWrite.mock.invocationCallOrder[0]).toBeLessThan(mockAdmit.mock.invocationCallOrder[0]);
});

it.each(["auth", "service", "api-key", "agent", "write"])("rejects %s before private reservation", async (gate) => {
  const denial = NextResponse.json({ error: "Denied" }, { status: 403 });
  if (gate === "auth") mockAuth.mockResolvedValue(denial);
  if (gate === "service") mockAuth.mockResolvedValue({ subject: "example-service", isServiceAccount: true });
  if (gate === "api-key") mockAuth.mockResolvedValue({ subject: "subject-primary", authenticatedUser: { session: { principalType: "catalog_api_key" } } });
  if (gate === "agent") mockAgentUse.mockResolvedValue(denial);
  if (gate === "write") mockWrite.mockResolvedValue({ denial });
  expect((await POST(request(), context)).status).toBe(403);
  expect(mockAdmit).not.toHaveBeenCalled();
});

it.each([{}, null, { agent_id: 1 }])("rejects malformed admission payload %j", async (body) => {
  expect((await POST(request(body), context)).status).toBe(400);
  expect(mockAdmit).not.toHaveBeenCalled();
});
