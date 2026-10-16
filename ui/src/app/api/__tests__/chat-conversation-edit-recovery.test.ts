/** @jest-environment node */
import { NextRequest } from "next/server";

let mockConversation: Record<string, unknown>;
let mockAccessLevel = "owner";
let mockUser = { email: "owner@example.com" };
let mockSession = { sub: "owner-subject" };
const mockPermission = jest.fn().mockResolvedValue(undefined);

jest.mock("@/lib/api-middleware", () => ({
  ApiError: class extends Error {},
  requireConversationAccess: async () => ({ conversation: mockConversation, access_level: mockAccessLevel }),
  successResponse: (data: unknown) => Response.json({ success: true, data }),
  validateConversationId: () => true,
  withAuth: async (request: NextRequest, handler: (...args: unknown[]) => Promise<Response>) => handler(request, mockUser, mockSession),
  withErrorHandler: (handler: (...args: unknown[]) => Promise<Response>) => handler,
}));
jest.mock("@/lib/mongodb", () => ({ isMongoDBConfigured: true, getCollection: jest.fn() }));
jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({ requireConversationResourcePermission: (...args: unknown[]) => mockPermission(...args) }));
jest.mock("../chat/conversations/delete-permanently", () => ({ deleteConversationsPermanently: jest.fn() }));

import { GET } from "../chat/conversations/[id]/route";

beforeEach(() => {
  jest.clearAllMocks();
  mockAccessLevel = "owner";
  mockUser = { email: "owner@example.com" };
  mockSession = { sub: "owner-subject" };
  mockConversation = { _id: "example-conversation", owner_id: "owner@example.com", native_rewind_epoch: 2,
    native_rewind: { operation_id: "internal-operation", owner_subject: "owner-subject", owner_email: "owner@example.com",
      epoch: 2, agent_id: "example-agent", message_id: "removed-message", phase: "history_applied",
      message_content: "deleted-private-content", removed_ids: ["private-database-id"], checkpoint_id: "private-checkpoint" } };
});

function get() {
  return GET(new NextRequest("http://localhost/api/chat/conversations/example-conversation"), {
    params: Promise.resolve({ id: "example-conversation" }),
  });
}

it("returns only an owner action reference after refresh, without internal deleted content or IDs", async () => {
  const response = await get();
  const payload = await response.json();
  expect(payload.data.pending_edit).toEqual({ agent_id: "example-agent", message_id: "removed-message", phase: "history_applied" });
  expect(payload.data).not.toHaveProperty("native_rewind");
  expect(payload.data).not.toHaveProperty("native_rewind_epoch");
  expect(JSON.stringify(payload)).not.toContain("deleted-private-content");
  expect(JSON.stringify(payload)).not.toContain("private-database-id");
  expect(JSON.stringify(payload)).not.toContain("private-checkpoint");
});

it.each(["shared", "shared_readonly", "admin_audit"])("does not expose recovery state to %s viewers", async (accessLevel) => {
  mockAccessLevel = accessLevel;
  mockUser = { email: "viewer@example.com" };
  mockSession = { sub: "viewer-subject" };
  const payload = await (await get()).json();
  expect(payload.data).not.toHaveProperty("pending_edit");
  expect(payload.data).not.toHaveProperty("native_rewind");
  expect(JSON.stringify(payload)).not.toContain("deleted-private-content");
});

it("does not authorize edit recovery by matching email after the caller subject changes", async () => {
  mockSession = { sub: "different-subject" };
  expect((await (await get()).json()).data).not.toHaveProperty("pending_edit");
});

it.each(["completed", "stale"])("omits %s recovery operations", async (state) => {
  if (state === "completed") (mockConversation.native_rewind as Record<string, unknown>).phase = "completed";
  else mockConversation.native_rewind_epoch = 3;
  expect((await (await get()).json()).data).not.toHaveProperty("pending_edit");
});
