/** @jest-environment node */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/chat/conversations/[id]/messages/route";
const mockUpdate = jest.fn();
const mockFindMessage = jest.fn();
const mockFindJob = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: async (name: string) => name === "messages" ? { findOne: mockFindMessage, updateOne: mockUpdate } : name === "chat_agent_handoffs" ? { findOne: mockFindJob } : {} }));
jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({ requireConversationResourcePermission: jest.fn() }));
jest.mock("@/lib/api-middleware", () => ({ ...jest.requireActual("@/lib/api-middleware"),
  getAuthFromBearerOrSession: async () => ({ user: { email: "owner@example.test" }, session: { sub: "test-owner" } }),
  requireConversationAccess: async () => ({ conversation: { _id: "12345678-1234-4123-8123-123456789abc", participants: [], owner_id: "owner@example.test" } }),
}));
const id = `handoff-${"a".repeat(64)}-assistant`;
const saved = { message_id: id, role: "assistant", content: "Authoritative completed response", metadata: { is_final: true, source: "coordination" } };
beforeEach(() => { jest.clearAllMocks(); mockFindJob.mockResolvedValue({ _id: "a".repeat(64) }); mockFindMessage.mockResolvedValue(saved); });
it("ignores a stale subscriber save for a server-owned handoff answer", async () => {
  const response = await POST(new NextRequest("https://example.test/api/messages", { method: "POST", body: JSON.stringify({ message_id: id, role: "assistant", content: "partial", metadata: { is_final: false } }) }), { params: Promise.resolve({ id: "12345678-1234-4123-8123-123456789abc" }) });
  expect(response.status).toBe(200);
  expect((await response.json()).data.content).toBe(saved.content);
  expect(mockUpdate).not.toHaveBeenCalled();
});
it("rejects an unknown handoff answer instead of creating a forged transcript row", async () => {
  mockFindJob.mockResolvedValue(null);
  const response = await POST(new NextRequest("https://example.test/api/messages", { method: "POST", body: JSON.stringify({ message_id: id, role: "assistant", content: "invented" }) }), { params: Promise.resolve({ id: "12345678-1234-4123-8123-123456789abc" }) });
  expect(response.status).toBe(409);
  expect(mockUpdate).not.toHaveBeenCalled();
});
