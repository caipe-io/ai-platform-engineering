/** @jest-environment node */
import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";

const mockAuth = jest.fn();
const mockFind = jest.fn();
const mockPublish = jest.fn();
const mockQuota = jest.fn();
jest.mock("@/lib/api-middleware", () => ({
  ApiError: jest.requireActual("@/lib/api-error").ApiError,
  getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args),
  validateConversationId: (id: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id),
  successResponse: (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status }),
  withErrorHandler: (handler: (request: NextRequest) => Promise<Response>) => async (request: NextRequest) => {
    try { return await handler(request); }
    catch (error) {
      return NextResponse.json({ success: false }, { status: (error as { statusCode?: number }).statusCode ?? 500 });
    }
  },
}));
jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn(async () => ({ findOne: mockFind })) }));
jest.mock("@/lib/notifications/fanout.server", () => ({ publishNotificationRequest: (...args: unknown[]) => mockPublish(...args) }));
jest.mock("@/lib/notifications/limits.server", () => ({ consumeNotificationQuota: (...args: unknown[]) => mockQuota(...args) }));
// Exercise the canonical ownership helper; its explicit-permission functions
// are not used by this owner-only endpoint.
jest.mock("@/lib/rbac/resource-authz", () => ({}));

import { POST } from "./route";
import { parseNotificationEnvelope, notificationEventKey } from "@/lib/notifications/envelope";

const body = { conversation_id: "example-chat", event_id: "example-pause-1", event_type: "input_required" };
function post(input: unknown = body) {
  return POST(new NextRequest("https://example.test/api/notifications/agent-events", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }));
}
beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { email: "test-user@example.test" }, session: { sub: "example-user" } });
  mockFind.mockResolvedValue({ _id: "example-chat", owner_id: "test-user@example.test", owner_subject: "example-user" });
  mockQuota.mockResolvedValue(undefined);
  mockPublish.mockResolvedValue({ recipients: 1, skipped: 0, rejected: 0, results: { queued: 1 } });
});

it("publishes registered generic input-required copy to the authenticated user only", async () => {
  const response = await post();
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ data: { status: "queued", event_type: "agent.requires_input" } });
  const request = mockPublish.mock.calls[0][0];
  expect(request).toMatchObject({
    recipients: [{ subject: "example-user" }], includeOrgAdmins: false,
    base: { type: "agent.requires_input", resource: { type: "conversation", id: "example-chat" },
      attempt_id: "example-pause-1", data: { callbackUri: "/chat/example-chat" } },
  });
  expect(mockQuota).toHaveBeenCalledWith("recipient:example-user", 20);
  expect(parseNotificationEnvelope({ ...request.base, recipient_subject: "example-user", recipient_email: "test-user@example.test" }).ok).toBe(true);
});

it("keeps retries stable while separating later pauses and conversations", async () => {
  await post(); await post();
  await post({ ...body, event_id: "example-pause-2" });
  await post({ ...body, conversation_id: "another-chat" });
  const keys = mockPublish.mock.calls.map(([request]) => notificationEventKey(request.base, "example-user"));
  expect(keys[0]).toBe(keys[1]);
  expect(new Set(keys).size).toBe(3);
});

it.each(["completed", "failed"])("supports %s without letting agents supply notification content", async (event_type) => {
  expect((await post({ ...body, event_type })).status).toBe(202);
  expect(mockPublish.mock.calls[0][0].base.type).toBe(`agent.${event_type}`);
});

it.each([
  { recipientUserSubjects: ["other-user"] }, { callbackUri: "https://other.example.test" },
  { title: "An arbitrary alert" }, { message: "private content" }, { sourceId: "app:example" },
  { channels: ["webex"] }, { event_type: "service.degraded" }, { event_type: "constructor" },
  { event_id: "" }, { event_id: "x".repeat(129) }, { conversation_id: "../other" },
])("rejects unknown or unsafe arguments: %j", async (extra) => {
  expect((await post({ ...body, ...extra })).status).toBe(400);
  expect(mockFind).not.toHaveBeenCalled();
  expect(mockPublish).not.toHaveBeenCalled();
});

it.each([{ isServiceAccount: true, sub: "example-service" }, {}])("rejects non-user identity %j", async (session) => {
  mockAuth.mockResolvedValue({ user: { email: "test-user@example.test" }, session });
  expect((await post()).status).toBe(403);
  expect(mockPublish).not.toHaveBeenCalled();
});

it("preserves authentication failure", async () => {
  mockAuth.mockRejectedValue(new ApiError("Sign in", 401));
  expect((await post()).status).toBe(401);
});

it.each([null, { owner_id: "other@example.test", owner_subject: "other-user" },
  { owner_id: "test-user@example.test", deleted_at: new Date() }])("denies missing, foreign or deleted conversations", async (conversation) => {
  mockFind.mockResolvedValue(conversation);
  expect((await post()).status).toBe(404);
  expect(mockPublish).not.toHaveBeenCalled();
  expect(mockQuota).not.toHaveBeenCalled();
});

it("does not use the org-admin role as a publication grant", async () => {
  mockAuth.mockResolvedValue({ user: { email: "test-user@example.test", role: "admin" }, session: { sub: "example-admin", role: "admin" } });
  mockFind.mockResolvedValue({ owner_id: "other@example.test", owner_subject: "other-user" });
  expect((await post()).status).toBe(404);
});

it("honors legacy email ownership using the existing chat policy", async () => {
  mockFind.mockResolvedValue({ owner_id: "TEST-USER@example.test" });
  expect((await post()).status).toBe(202);
});

it("reports disabled preferences without claiming delivery", async () => {
  mockPublish.mockResolvedValue({ recipients: 1, results: { disabled: 1 } });
  const response = await post();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ data: { status: "disabled" } });
});

it.each([{ recipients: 1, results: { failed: 1 } }, { recipients: 0, results: {} },
  { recipients: 1, results: { invalid: 1 } }])("reports unavailable publication %j as retryable", async (result) => {
  mockPublish.mockResolvedValue(result);
  expect((await post()).status).toBe(503);
});

it("stops at the shared recipient quota", async () => {
  mockQuota.mockRejectedValue(new ApiError("Rate limited", 429));
  expect((await post()).status).toBe(429);
  expect(mockPublish).not.toHaveBeenCalled();
});

it("fails closed on conversation storage errors", async () => {
  mockFind.mockRejectedValue(new Error("Unavailable"));
  expect((await post()).status).toBe(500);
  expect(mockPublish).not.toHaveBeenCalled();
});
