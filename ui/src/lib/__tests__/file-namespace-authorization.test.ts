/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockAuthenticateRequest = jest.fn();
const mockGetCollection = jest.fn();
const mockRequireAgentPermission = jest.fn();
const mockRequireConversationPermission = jest.fn();
const mockRequireWorkflowRunAccess = jest.fn();

jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireAgentPermission: (...args: unknown[]) => mockRequireAgentPermission(...args),
}));

jest.mock("@/lib/rbac/conversation-implicit-authz", () => ({
  requireConversationResourcePermission: (...args: unknown[]) =>
    mockRequireConversationPermission(...args),
}));

jest.mock("@/lib/server/workflow-cas-authz", () => ({
  requireWorkflowRunAccess: (...args: unknown[]) => mockRequireWorkflowRunAccess(...args),
}));

const request = new NextRequest("http://localhost/api/files/list");
const authResult = {
  authzSession: { sub: "user-primary" },
  email: "owner@example.com",
  bearerToken: "token-primary",
};

describe("authorizeFileNamespace", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthenticateRequest.mockResolvedValue(authResult);
    mockRequireAgentPermission.mockResolvedValue(undefined);
    mockRequireConversationPermission.mockResolvedValue(undefined);
    mockRequireWorkflowRunAccess.mockResolvedValue(undefined);
  });

  it("checks the generic gate and conversation-scoped resources", async () => {
    const conversation = {
      _id: "conversation-primary",
      owner_id: "owner@example.com",
      participants: [{ type: "agent", id: "agent-primary" }],
    };
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(conversation),
    });
    const { authorizeFileNamespace } = await import("../file-namespace-authorization");

    const result = await authorizeFileNamespace(
      request,
      '["agent-primary","conversation-primary","filesystem"]',
      "read",
    );

    expect(result).toEqual({
      authResult,
      namespace: ["agent-primary", "conversation-primary", "filesystem"],
    });
    expect(mockAuthenticateRequest).toHaveBeenCalledWith(request, {
      resource: "dynamic_agent",
      scope: "invoke",
    });
    expect(mockRequireAgentPermission).toHaveBeenCalledWith(
      authResult.authzSession,
      "agent-primary",
      "use",
    );
    expect(mockRequireConversationPermission).toHaveBeenCalledWith(
      authResult.authzSession,
      authResult.email,
      conversation,
      "read",
    );
  });

  it("rejects a namespace whose agent does not match the conversation", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "conversation-primary",
        participants: [{ type: "agent", id: "agent-primary" }],
      }),
    });
    const { authorizeFileNamespace } = await import("../file-namespace-authorization");

    await expect(
      authorizeFileNamespace(
        request,
        ["agent-secondary", "conversation-primary", "filesystem"],
        "read",
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "NAMESPACE_FORBIDDEN" });
    expect(mockRequireAgentPermission).not.toHaveBeenCalled();
  });

  it("checks workflow run ownership and the stored config pairing", async () => {
    const workflowRun = {
      _id: "run-primary",
      workflow_config_id: "workflow-primary",
      owner_subject: { type: "user", id: "user-primary" },
    };
    mockGetCollection
      .mockResolvedValueOnce({ findOne: jest.fn().mockResolvedValue(null) })
      .mockResolvedValueOnce({ findOne: jest.fn().mockResolvedValue(workflowRun) });
    const { authorizeFileNamespace } = await import("../file-namespace-authorization");

    await authorizeFileNamespace(
      request,
      ["workflow-primary", "run-primary", "filesystem"],
      "write",
    );

    expect(mockRequireWorkflowRunAccess).toHaveBeenCalledWith(
      authResult.authzSession,
      workflowRun,
      "write",
    );
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["an object", {}],
    ["a short tuple", ["agent-primary", "run-primary"]],
    ["an empty identifier", ["", "run-primary", "filesystem"]],
    ["a different marker", ["agent-primary", "run-primary", "cache"]],
  ])("rejects %s before authentication", async (_label, namespace) => {
    const { authorizeFileNamespace } = await import("../file-namespace-authorization");

    await expect(authorizeFileNamespace(request, namespace, "read")).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_NAMESPACE",
    });
    expect(mockAuthenticateRequest).not.toHaveBeenCalled();
  });

  it("fails closed when authenticated identity context is incomplete", async () => {
    mockAuthenticateRequest.mockResolvedValue({ bearerToken: "token-primary" });
    const { authorizeFileNamespace } = await import("../file-namespace-authorization");

    await expect(
      authorizeFileNamespace(
        request,
        ["agent-primary", "conversation-primary", "filesystem"],
        "read",
      ),
    ).rejects.toMatchObject({ statusCode: 401, code: "NOT_SIGNED_IN" });
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("does not continue when the conversation PDP denies access", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "conversation-primary",
        participants: [{ type: "agent", id: "agent-primary" }],
      }),
    });
    mockRequireConversationPermission.mockRejectedValue(
      Object.assign(new Error("denied"), { statusCode: 403 }),
    );
    const { authorizeFileNamespace } = await import("../file-namespace-authorization");

    await expect(
      authorizeFileNamespace(
        request,
        ["agent-primary", "conversation-primary", "filesystem"],
        "write",
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mockRequireWorkflowRunAccess).not.toHaveBeenCalled();
  });

  it("rejects a missing workflow run without an authorization probe", async () => {
    mockGetCollection
      .mockResolvedValueOnce({ findOne: jest.fn().mockResolvedValue(null) })
      .mockResolvedValueOnce({ findOne: jest.fn().mockResolvedValue(null) });
    const { authorizeFileNamespace } = await import("../file-namespace-authorization");

    await expect(
      authorizeFileNamespace(
        request,
        ["workflow-primary", "run-primary", "filesystem"],
        "read",
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: "NAMESPACE_NOT_FOUND" });
    expect(mockRequireWorkflowRunAccess).not.toHaveBeenCalled();
  });
});
