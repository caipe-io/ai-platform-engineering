/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetCollection = jest.fn();
const mockRequireAgentPermission = jest.fn();
const mockResolveAgentListPermissions = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public statusCode = 500,
    ) {
      super(message);
    }
  }

  return {
    ApiError,
    getAuthFromBearerOrSession: async () => ({
      session: { sub: "alice-sub", user: { email: "alice@example.com" } },
    }),
    successResponse: (data: unknown, status = 200) =>
      Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T,>(handler: (...args: unknown[]) => Promise<T>) =>
      async (...args: unknown[]) => {
        try {
          return await handler(...args);
        } catch (error) {
          return Response.json(
            { success: false, error: error instanceof Error ? error.message : "error" },
            { status: (error as { statusCode?: number }).statusCode ?? 500 },
          );
        }
      },
  };
});

jest.mock("@/lib/rbac/resource-authz", () => ({
  agentRowPermissionsOrDefault: (
    rows: Map<string, { can_manage: boolean; can_write: boolean; can_discover: boolean }>,
    id: string,
  ) => rows.get(id) ?? { can_manage: false, can_write: false, can_discover: false },
  requireAgentPermission: (...args: unknown[]) => mockRequireAgentPermission(...args),
  resolveAgentListPermissions: (...args: unknown[]) => mockResolveAgentListPermissions(...args),
}));

describe("GET /api/dynamic-agents/agents/[id]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireAgentPermission.mockResolvedValue(undefined);
    mockResolveAgentListPermissions.mockResolvedValue({
      rows: new Map([
        ["agent-ops", { can_manage: true, can_write: true, can_discover: true }],
      ]),
    });
  });

  it("returns the exact agent with permissions needed by a deep-linked editor", async () => {
    const agent = {
      _id: "agent-ops",
      name: "Ops Helper",
      system_prompt: "Help with operations.",
      model: { id: "gpt-4o", provider: "openai" },
    };
    const findOne = jest.fn().mockResolvedValue(agent);
    mockGetCollection.mockResolvedValue({ findOne });
    const { GET } = await import("../route");

    const response = await GET(
      new NextRequest("http://localhost/api/dynamic-agents/agents/agent-ops"),
      { params: Promise.resolve({ id: "agent-ops" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(findOne).toHaveBeenCalledWith({ _id: "agent-ops" });
    expect(mockRequireAgentPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      "agent-ops",
      "read",
    );
    expect(body.data).toEqual({
      ...agent,
      permissions: { can_manage: true, can_write: true, can_discover: true },
    });
  });

  it("does not expose another user's private agent through a direct admin-style read", async () => {
    const findOne = jest.fn().mockResolvedValue({
      _id: "private-agent",
      name: "Private Agent",
      visibility: "private",
      owner_id: "owner@example.test",
      owner_subject: "owner-sub",
    });
    mockGetCollection.mockResolvedValue({ findOne });
    const { GET } = await import("../route");

    const response = await GET(
      new NextRequest("http://localhost/api/dynamic-agents/agents/private-agent"),
      { params: Promise.resolve({ id: "private-agent" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Agent not found");
    expect(mockRequireAgentPermission).not.toHaveBeenCalled();
  });
});
