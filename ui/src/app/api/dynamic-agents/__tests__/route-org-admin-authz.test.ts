/**
 * @jest-environment node
 *
 * Integration-style route tests for the per-agent permission contract used by
 * organization admins and regular members.
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockReconcileAgentRelationships = jest.fn();
const mockIsPlatformDefaultAgent = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    constructor(
      message: string,
      public statusCode = 500,
      public code?: string,
    ) {
      super(message);
    }
  }

  return {
    ApiError,
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuthFromBearerOrSession(...args),
    getPaginationParams: () => ({ page: 1, pageSize: 20, skip: 0 }),
    getUserTeamIds: jest.fn().mockResolvedValue([]),
    paginatedResponse: (items: unknown[], total: number, page: number, pageSize: number) =>
      Response.json({ success: true, data: items, pagination: { total, page, pageSize } }),
    requireRbacPermission: jest.fn().mockResolvedValue(undefined),
    successResponse: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T,>(handler: (request: NextRequest) => Promise<T>) =>
      async (request: NextRequest) => {
        try {
          return await handler(request);
        } catch (error) {
          return Response.json(
            {
              success: false,
              error: error instanceof Error ? error.message : "error",
              code: (error as { code?: string }).code,
            },
            { status: (error as { statusCode?: number }).statusCode ?? 500 },
          );
        }
      },
  };
});

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/openfga", () => {
  const actual = jest.requireActual<typeof import("@/lib/rbac/openfga")>("@/lib/rbac/openfga");
  return {
    ...actual,
    checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
  };
});

jest.mock("@/lib/rbac/resource-authz", () => {
  const actual = jest.requireActual<typeof import("@/lib/rbac/resource-authz")>("@/lib/rbac/resource-authz");
  return {
    ...actual,
    requireAgentPermission: async (
      session: { sub?: string },
      agentId: string,
      action: string,
    ) => {
      const subject = `user:${session.sub}`;
      const result = await mockCheckOpenFgaTuple({
        user: subject,
        relation: `can_${action}`,
        object: `agent:${agentId}`,
      });
      if (!result.allowed) {
        const error = new Error("You do not have permission to access this resource.") as Error & {
          statusCode: number;
          code: string;
        };
        error.statusCode = 403;
        error.code = `agent#${action}`;
        throw error;
      }
    },
  };
});

jest.mock("@/lib/rbac/openfga-agent-tools", () => ({
  allowedToolsFromAgent: (agent: { allowed_tools?: Record<string, string[]> }) =>
    agent.allowed_tools ?? {},
  reconcileAgentRelationships: (...args: unknown[]) => mockReconcileAgentRelationships(...args),
}));

jest.mock("@/lib/rbac/shareable-resource", () => ({
  resolveShareableOwnershipWrite: jest.fn(async (_input, previous) => ({
    ownerTeamSlug: previous.ownerTeamSlug,
    sharedTeamSlugs: previous.sharedTeamSlugs,
    transferred: false,
    previousOwnerTeamSlug: null,
  })),
}));

jest.mock("@/lib/rbac/platform-default", () => ({
  isPlatformDefaultAgent: (...args: unknown[]) => mockIsPlatformDefaultAgent(...args),
}));

function request(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

const orgAdminSession = { sub: "admin-sub", role: "admin" };
const memberSession = { sub: "alice-sub", role: "user" };

function mockOpenFgaAgentWrite(allowAgentWrite: boolean) {
  mockCheckOpenFgaTuple.mockImplementation(async (tuple: {
    user: string;
    relation: string;
    object: string;
  }) => {
    if (tuple.object === "agent:hello-world" && tuple.relation === "can_write") {
      return { allowed: allowAgentWrite };
    }
    return { allowed: false };
  });
}

describe("dynamic-agents PUT with real requireAgentPermission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CAIPE_ORG_KEY = "caipe";
    mockReconcileAgentRelationships.mockResolvedValue(undefined);
    mockIsPlatformDefaultAgent.mockResolvedValue(false);
  });

  it("allows org admins to update a team agent through its per-agent manager grant", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session: orgAdminSession });
    mockOpenFgaAgentWrite(true);

    const findOneAndUpdate = jest.fn().mockResolvedValue({
      _id: "hello-world",
      name: "Hello-world",
      visibility: "team",
      allowed_tools: {},
    });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "hello-world",
        name: "Hello-world",
        visibility: "team",
        owner_team_slug: "team-a",
        allowed_tools: {},
      }),
      findOneAndUpdate,
    });

    const { PUT } = await import("../route");
    const response = await PUT(
      request("/api/dynamic-agents?id=hello-world", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Updated by org admin" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalled();
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: "user:admin-sub",
      relation: "can_write",
      object: "agent:hello-world",
    });
  });

  it("denies non-org-admins without agent write access", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session: memberSession });
    mockOpenFgaAgentWrite(false);

    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "hello-world",
        name: "Hello-world",
        visibility: "team",
        allowed_tools: {},
      }),
      findOneAndUpdate: jest.fn(),
    });

    const { PUT } = await import("../route");
    const response = await PUT(
      request("/api/dynamic-agents?id=hello-world", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "Should fail" }),
      }),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain("You do not have permission");
    expect(mockCheckOpenFgaTuple).toHaveBeenCalledWith({
      user: "user:alice-sub",
      relation: "can_write",
      object: "agent:hello-world",
    });
  });
});
