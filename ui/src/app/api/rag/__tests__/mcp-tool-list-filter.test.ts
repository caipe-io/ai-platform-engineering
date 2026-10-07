/**
 * @jest-environment node
 */
/**
 * Integration tests for the BFF-side `GET /v1/mcp/custom-tools` filter.
 *
 * The RAG server returns every custom MCP tool today; the BFF filters
 * the response down to the rows the caller has `mcp_tool:<tool_id>#can_read`
 * on, with the documented org-admin bypass enabled. The kill-switch
 * `RAG_ADMIN_BYPASS_DISABLED` forces admins through per-tool checks
 * for incident response.
 *
 * assisted-by Cursor claude-opus-4-7
 */

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: "",
}));

import { NextRequest } from "next/server";

const mockRequireResourcePermission = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockRequireRbacPermission = jest.fn();
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
    getAuthFromBearerOrSession: async () => {
      const { getServerSession } = jest.requireMock("next-auth") as {
        getServerSession: jest.Mock;
      };
      const session = await getServerSession();
      return { session, user: session?.user };
    },
    requireRbacPermission: (...args: unknown[]) =>
      mockRequireRbacPermission(...args),
    handleApiError: (error: unknown) =>
      Response.json(
        { error: error instanceof Error ? error.message : "error" },
        { status: (error as { statusCode?: number }).statusCode ?? 500 },
      ),
  };
});

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
  filterResourcesByPermission: (...args: unknown[]) =>
    mockFilterResourcesByPermission(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

jest.mock("@/lib/rbac/organization", () => ({
  organizationObjectId: () => "organization:caipe",
}));

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileKnowledgeBaseRelationships: jest.fn(),
  reconcileDataSourceRelationships: jest.fn(),
  reconcileMcpToolRelationships: jest.fn(),
  deleteAllMcpToolRelationshipTuples: jest.fn(),
}));

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.RAG_ADMIN_BYPASS_DISABLED;
  mockRequireRbacPermission.mockResolvedValue(undefined);
  mockRequireResourcePermission.mockResolvedValue(undefined);
  mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
  mockFilterResourcesByPermission.mockImplementation(
    async (_session: unknown, resources: unknown[]) => resources,
  );
});

function ragRequest(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

const PATH_PARAMS = {
  params: Promise.resolve({ path: ["v1", "mcp", "custom-tools"] }),
};

describe("GET /v1/mcp/custom-tools BFF filter", () => {
  it("filters the bare JSON array using mcp_tool#can_read with bypassForOrgAdmin: true", async () => {
    const nextAuth = await import("next-auth");
    jest.mocked(nextAuth.getServerSession).mockResolvedValue({
      sub: "alice-sub",
      role: "user",
      org: "team-alpha",
      accessToken: "browser-token",
      user: { email: "alice@example.com" },
    } as never);

    const upstreamTools = [
      { tool_id: "search", description: "Built-in search" },
      { tool_id: "infra-search", description: "Team infra search" },
      { tool_id: "secrets", description: "Sensitive" },
    ];
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => upstreamTools,
      } as Response),
    ) as jest.Mock;

    // simulate non-admin who can only read `infra-search`
    mockFilterResourcesByPermission.mockImplementation(
      async (_session: unknown, resources: unknown[]) =>
        (resources as Array<{ tool_id: string }>).filter(
          (r) => r.tool_id === "infra-search",
        ),
    );

    const { GET } = await import("@/app/api/rag/[...path]/route");
    const response = await GET(
      ragRequest("/api/rag/v1/mcp/custom-tools", { method: "GET" }),
      PATH_PARAMS,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([
      { tool_id: "infra-search", description: "Team infra search" },
    ]);
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      expect.any(Array),
      expect.objectContaining({ type: "mcp_tool", action: "read" }),
      expect.objectContaining({ bypassForOrgAdmin: true }),
    );
  });

  it("returns an empty array when the caller has no readable tools", async () => {
    const nextAuth = await import("next-auth");
    jest.mocked(nextAuth.getServerSession).mockResolvedValue({
      sub: "bob-sub",
      role: "user",
      accessToken: "browser-token",
      user: { email: "bob@example.com" },
    } as never);

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [{ tool_id: "search" }, { tool_id: "infra-search" }],
      } as Response),
    ) as jest.Mock;

    mockFilterResourcesByPermission.mockResolvedValue([]);

    const { GET } = await import("@/app/api/rag/[...path]/route");
    const response = await GET(
      ragRequest("/api/rag/v1/mcp/custom-tools", { method: "GET" }),
      PATH_PARAMS,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("passes through non-array upstream responses unchanged", async () => {
    const nextAuth = await import("next-auth");
    jest.mocked(nextAuth.getServerSession).mockResolvedValue({
      sub: "alice-sub",
      role: "user",
      accessToken: "browser-token",
      user: { email: "alice@example.com" },
    } as never);

    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: async () => ({ error: "boom" }),
      } as Response),
    ) as jest.Mock;

    const { GET } = await import("@/app/api/rag/[...path]/route");
    const response = await GET(
      ragRequest("/api/rag/v1/mcp/custom-tools", { method: "GET" }),
      PATH_PARAMS,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "boom" });
    expect(mockFilterResourcesByPermission).not.toHaveBeenCalled();
  });
});
