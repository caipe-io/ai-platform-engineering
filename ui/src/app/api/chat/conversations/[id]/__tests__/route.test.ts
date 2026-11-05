/** @jest-environment node */
import { NextRequest } from "next/server";
import { PUT } from "../route";

const mockFind = jest.fn();
const mockUpdate = jest.fn();
const mockPermission = jest.fn();
jest.mock("@/lib/mongodb", () => ({ isMongoDBConfigured: true,
  getCollection: async () => ({ findOne: mockFind, updateOne: mockUpdate }),
}));
jest.mock("@/lib/api-middleware", () => ({
  ApiError: jest.requireActual("@/lib/api-error").ApiError,
  withAuth: (request: NextRequest, handler: (...args: unknown[]) => unknown) => handler(request, { email: "viewer@example.test" }, { sub: "viewer" }),
  withErrorHandler: (handler: (...args: unknown[]) => Promise<Response>) => async (...args: unknown[]) => {
    try { return await handler(...args); }
    catch (error) { return Response.json({ error: (error as Error).message }, { status: (error as { statusCode: number }).statusCode }); }
  },
  validateConversationId: () => true,
  successResponse: (data: unknown) => Response.json({ success: true, data }),
}));
jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({
  requireConversationResourcePermission: (...args: unknown[]) => mockPermission(...args),
}));
jest.mock("../../delete-permanently", () => ({ deleteConversationsPermanently: jest.fn() }));

const original = { _id: "shared-chat", owner_id: "owner@example.test", participants: [{ type: "agent", id: "original-agent" }],
  sharing: { shared_with: ["viewer@example.test"] } };
const update = (body: unknown) => PUT(new NextRequest("https://example.test/api/chat/conversations/shared-chat", {
  method: "PUT", body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "shared-chat" }) });

beforeEach(() => { jest.clearAllMocks(); mockFind.mockResolvedValue(original); mockPermission.mockResolvedValue(undefined); });

it.each([
  { participants: [{ type: "agent", id: "other-agent" }] }, { participants: [] },
  { participants: [{ type: "agent", id: "original-agent" }, { type: "agent", id: "other-agent" }] },
])("rejects replacing or removing an existing conversation's agent (%j)", async ({ participants }) => {
  const response = await update({ participants, title: "replacement" });
  expect(response.status).toBe(409);
  expect(mockPermission).toHaveBeenCalledWith(expect.any(Object), "viewer@example.test", original, "write");
  expect(mockUpdate).not.toHaveBeenCalled();
});

it("preserves normal metadata editing without changing history, sharing, or agent", async () => {
  const response = await update({ title: "New title", is_pinned: true });
  expect(response.status).toBe(200);
  expect(mockUpdate).toHaveBeenCalledWith({ _id: "shared-chat" }, { $set: {
    title: "New title", is_pinned: true, updated_at: expect.any(Date),
  } });
});
