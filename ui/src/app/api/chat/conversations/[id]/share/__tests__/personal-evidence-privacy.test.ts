/** @jest-environment node */
import { NextRequest } from "next/server";
import { POST, PATCH } from "../route";

const mockGetCollection = jest.fn();
const mockPermission = jest.fn();
const mockWriteTuples = jest.fn();
jest.mock("@/lib/mongodb", () => ({ getCollection: (...args: unknown[]) => mockGetCollection(...args) }));
jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({
  requireConversationResourcePermission: (...args: unknown[]) => mockPermission(...args),
}));
jest.mock("@/lib/rbac/openfga", () => ({ writeOpenFgaTuples: (...args: unknown[]) => mockWriteTuples(...args) }));
jest.mock("@/lib/api-middleware", () => ({
  ...jest.requireActual("@/lib/api-error"),
  withAuth: async (request: Request, handler: (...args: unknown[]) => Promise<Response>) =>
    handler(request, { email: "owner@example.com" }, { sub: "subject-primary" }),
  withErrorHandler: (handler: (...args: unknown[]) => Promise<Response>) => async (...args: unknown[]) => {
    try { return await handler(...args); } catch (error) {
      const failure = error as { statusCode?: number; code?: string };
      return Response.json({ code: failure.code }, { status: failure.statusCode ?? 500 });
    }
  },
  successResponse: (data: unknown) => Response.json({ data }),
  validateConversationId: () => true,
  validateUUID: () => true,
  validateEmail: (value: string) => value.includes("@"),
}));

let visibility: unknown;
const updates = jest.fn();
const insertShares = jest.fn();
const updateShares = jest.fn();
const revokeShares = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  visibility = "private";
  mockPermission.mockResolvedValue(undefined);
  mockWriteTuples.mockResolvedValue(undefined);
  updates.mockImplementation(async (filter: Record<string, unknown>) => {
    if (filter.$or && visibility !== undefined && visibility !== "shareable") return { matchedCount: 0 };
    if (filter.$or) visibility = "shareable";
    return { matchedCount: 1, modifiedCount: 1 };
  });
  mockGetCollection.mockImplementation(async (name: string) => {
    if (name === "conversations") return {
      findOne: jest.fn(async () => ({ _id: "conversation-primary", owner_id: "owner@example.com",
        personal_context: visibility,
        sharing: { is_public: false, shared_with: [], shared_with_teams: [], share_link_enabled: false } })),
      updateOne: updates,
    };
    if (name === "sharing_access") return { insertMany: insertShares, updateOne: updateShares, updateMany: revokeShares };
    if (name === "teams") return { findOne: jest.fn(async () => ({ _id: "team-primary", slug: "team-primary" })) };
    if (name === "users") return { find: jest.fn(() => ({ project: jest.fn(() => ({
      toArray: jest.fn(async () => [{ email: "reader@example.com", keycloak_sub: "subject-secondary" }]),
    })) })) };
    throw new Error(`Unexpected collection ${name}`);
  });
});

function request(method: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest("https://example.test/api/chat/conversations/conversation-primary/share", {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
const context = { params: Promise.resolve({ id: "conversation-primary" }) };

it.each([
  ["POST", { user_emails: ["reader@example.com"], permission: "view" }],
  ["POST", { team_ids: ["team-primary"], permission: "view" }],
  ["POST", { enable_link: true }],
  ["POST", { is_public: false, enable_link: true }],
  ["PATCH", { email: "reader@example.com", permission: "comment" }],
  ["PATCH", { team_id: "team-primary", permission: "comment" }],
])("blocks %s access grants before any records or OpenFGA writes: %j", async (method, body) => {
  const response = await (method === "POST" ? POST : PATCH)(request(method, body), context);
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("PERSONAL_CONTEXT_PRIVATE");
  expect(insertShares).not.toHaveBeenCalled();
  expect(updateShares).not.toHaveBeenCalled();
  expect(mockWriteTuples).not.toHaveBeenCalled();
  expect(updates).toHaveBeenCalledTimes(1);
});

it("claims shareable before a direct grant or OpenFGA write", async () => {
  visibility = undefined;
  insertShares.mockImplementation(async () => {
    expect(visibility).toBe("shareable");
    return { insertedCount: 1 };
  });
  const response = await POST(request("POST", { user_emails: ["reader@example.com"], permission: "view" }), context);
  expect(response.status).toBe(200);
  expect(insertShares).toHaveBeenCalledTimes(1);
  expect(mockWriteTuples).toHaveBeenCalledTimes(1);
  expect(updates.mock.invocationCallOrder[0]).toBeLessThan(insertShares.mock.invocationCallOrder[0]);
});

it("honors a concurrent private admission after the share route's initial read", async () => {
  visibility = undefined;
  mockPermission.mockImplementationOnce(async () => { visibility = "private"; });
  const response = await POST(request("POST", { user_emails: ["reader@example.com"], permission: "view" }), context);
  expect(response.status).toBe(409);
  expect(insertShares).not.toHaveBeenCalled();
  expect(mockWriteTuples).not.toHaveBeenCalled();
});

it("does not lock visibility for a malformed share request", async () => {
  visibility = undefined;
  const response = await POST(request("POST", { user_emails: ["invalid"], permission: "view" }), context);
  expect(response.status).toBe(400);
  expect(updates).not.toHaveBeenCalled();
  expect(insertShares).not.toHaveBeenCalled();
});

it("allows public and link cleanup without unlocking personal evidence", async () => {
  const response = await POST(request("POST", { is_public: false, enable_link: false }), context);
  expect(response.status).toBe(200);
  expect(visibility).toBe("private");
  expect(updates).toHaveBeenCalledWith({ _id: "conversation-primary" }, { $set: {
    "sharing.is_public": false, "sharing.share_link_enabled": false,
  } });
});
