/**
 * @jest-environment node
 */
/**
 * BFF tests for custom MCP tool enforcement (spec 2026-06-03, US6):
 *   - POST /v1/mcp/invoke is gated on `mcp_tool#can_call` for CUSTOM tools;
 *     built-in tool names are not gated. Org admins bypass.
 *   - DELETE /v1/mcp/custom-tools/<id> removes ALL mcp_tool:<id> grants so no
 *     orphan tuples remain (FR-028).
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
const mockDeleteAllMcpToolRelationshipTuples = jest.fn();

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
        {
          error: error instanceof Error ? error.message : "error",
          code: (error as { code?: string }).code,
        },
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
  deleteAllMcpToolRelationshipTuples: (...args: unknown[]) =>
    mockDeleteAllMcpToolRelationshipTuples(...args),
}));

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.RAG_ADMIN_BYPASS_DISABLED;
  mockRequireRbacPermission.mockResolvedValue(undefined);
  mockRequireResourcePermission.mockResolvedValue(undefined);
  // Default: not org admin, and can_call denied unless a test allows it.
  mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
  mockDeleteAllMcpToolRelationshipTuples.mockResolvedValue({
    enabled: true,
    writes: 0,
    deletes: 3,
  });
});

function ragRequest(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

async function asUser(sub = "alice-sub") {
  const nextAuth = await import("next-auth");
  jest.mocked(nextAuth.getServerSession).mockResolvedValue({
    sub,
    role: "user",
    org: "team-alpha",
    accessToken: "browser-token",
    user: { email: `${sub}@example.com` },
  } as never);
}

/** Mock the custom-tools list fetch (used to resolve which tool_names are custom). */
function mockCustomToolsList(toolIds: string[]) {
  global.fetch = jest.fn((url: string | URL) => {
    const u = String(url);
    if (u.includes("/v1/mcp/custom-tools")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => toolIds.map((id) => ({ tool_id: id })),
      } as Response);
    }
    // The downstream invoke forward.
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ tool_name: "x", success: true, result: {} }),
    } as Response);
  }) as jest.Mock;
}

describe("POST /v1/mcp/invoke — can_call gate", () => {
  const INVOKE = { params: Promise.resolve({ path: ["v1", "mcp", "invoke"] }) };

  it("denies a non-member invoking a custom tool with 403", async () => {
    await asUser("mallory-sub");
    mockCustomToolsList(["infra-search"]);
    // Holds the org search capability (so the search gate passes) but lacks
    // can_call on this specific tool → denied at the per-tool gate.
    mockCheckOpenFgaTuple.mockImplementation(
      async (tuple: { relation: string }) =>
        tuple.relation === "can_search"
          ? { allowed: true }
          : { allowed: false },
    );

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const res = await POST(
      ragRequest("/api/rag/v1/mcp/invoke", {
        method: "POST",
        body: JSON.stringify({ tool_name: "infra-search", arguments: {} }),
        headers: { "content-type": "application/json" },
      }),
      INVOKE,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("mcp_tool#call");
  });

  it("allows a member invoking a custom tool they can_call", async () => {
    await asUser("alice-sub");
    mockCustomToolsList(["infra-search"]);
    mockCheckOpenFgaTuple.mockImplementation(
      async (tuple: { relation: string; object: string }) =>
        tuple.relation === "can_search" ||
        (tuple.relation === "can_call" &&
          tuple.object === "mcp_tool:infra-search")
          ? { allowed: true }
          : { allowed: false },
    );

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const res = await POST(
      ragRequest("/api/rag/v1/mcp/invoke", {
        method: "POST",
        body: JSON.stringify({ tool_name: "infra-search", arguments: {} }),
        headers: { "content-type": "application/json" },
      }),
      INVOKE,
    );
    expect(res.status).toBe(200);
  });

  it("does NOT gate a built-in tool name (no mcp_tool object)", async () => {
    await asUser("alice-sub");
    mockCustomToolsList(["infra-search"]); // 'search' is NOT in the custom list
    // can_call would deny, but the built-in must not be gated by the per-tool
    // gate. The caller holds the org search capability so the search gate passes.
    mockCheckOpenFgaTuple.mockImplementation(
      async (tuple: { relation: string }) =>
        tuple.relation === "can_search"
          ? { allowed: true }
          : { allowed: false },
    );

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const res = await POST(
      ragRequest("/api/rag/v1/mcp/invoke", {
        method: "POST",
        body: JSON.stringify({ tool_name: "search", arguments: {} }),
        headers: { "content-type": "application/json" },
      }),
      INVOKE,
    );
    expect(res.status).toBe(200);
  });

  it("allows org admins to bypass the can_call gate", async () => {
    await asUser("admin-sub");
    mockCustomToolsList(["infra-search"]);
    // Org-admin check (can_manage on organization) returns true; can_call denied.
    mockCheckOpenFgaTuple.mockImplementation(
      async (tuple: { relation: string; object: string }) =>
        tuple.relation === "can_manage" && tuple.object === "organization:caipe"
          ? { allowed: true }
          : { allowed: false },
    );

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const res = await POST(
      ragRequest("/api/rag/v1/mcp/invoke", {
        method: "POST",
        body: JSON.stringify({ tool_name: "infra-search", arguments: {} }),
        headers: { "content-type": "application/json" },
      }),
      INVOKE,
    );
    expect(res.status).toBe(200);
  });

  it("fails CLOSED (503, no forward) when the custom-tools listing errors", async () => {
    await asUser("alice-sub");
    // The custom-tools listing fails — we cannot tell if `tool_name` is a
    // custom tool, so the gate must DENY rather than forward (deny-by-default),
    // so a transient error can't be used to bypass `can_call`.
    const forward = jest.fn();
    global.fetch = jest.fn((url: string | URL) => {
      const u = String(url);
      if (u.includes("/v1/mcp/custom-tools")) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({}),
        } as Response);
      }
      forward();
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as Response);
    }) as jest.Mock;
    // The caller HOLDS the org `can_search` capability (so we pass the outer
    // search-capability gate and actually reach the fail-closed path under test),
    // but every narrower grant is denied. The custom-tools listing error must
    // then DENY with 503 (call_unavailable) rather than forward — a transient
    // listing error cannot be used to bypass `can_call`.
    mockCheckOpenFgaTuple.mockImplementation(
      async (tuple: { relation: string }) =>
        tuple.relation === "can_search"
          ? { allowed: true }
          : { allowed: false },
    );

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const res = await POST(
      ragRequest("/api/rag/v1/mcp/invoke", {
        method: "POST",
        body: JSON.stringify({ tool_name: "infra-search", arguments: {} }),
        headers: { "content-type": "application/json" },
      }),
      INVOKE,
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("mcp_tool#call_unavailable");
    // Critically: the invocation was never forwarded to the RAG server.
    expect(forward).not.toHaveBeenCalled();
  });
});

describe("search capability gate (spec 2026-06-03-explicit-search-capability)", () => {
  const INVOKE = { params: Promise.resolve({ path: ["v1", "mcp", "invoke"] }) };
  const QUERY = { params: Promise.resolve({ path: ["v1", "query"] }) };

  it("denies /v1/mcp/invoke when caller lacks can_search EVEN WITH can_call (the violation)", async () => {
    await asUser("generic-sub");
    mockCustomToolsList(["caipe_kb"]);
    // The reported leak: caller can_call (e.g. org-wide share) but their team
    // has no search capability → must be denied at the search gate.
    mockCheckOpenFgaTuple.mockImplementation(
      async (tuple: { relation: string }) =>
        tuple.relation === "can_call" ? { allowed: true } : { allowed: false },
    );

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const res = await POST(
      ragRequest("/api/rag/v1/mcp/invoke", {
        method: "POST",
        body: JSON.stringify({ tool_name: "caipe_kb", arguments: {} }),
        headers: { "content-type": "application/json" },
      }),
      INVOKE,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("organization#can_search");
  });

  it("denies the built-in search tool when caller lacks can_search", async () => {
    await asUser("generic-sub");
    mockCustomToolsList(["caipe_kb"]); // 'search' is built-in
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const res = await POST(
      ragRequest("/api/rag/v1/mcp/invoke", {
        method: "POST",
        body: JSON.stringify({ tool_name: "search", arguments: {} }),
        headers: { "content-type": "application/json" },
      }),
      INVOKE,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("organization#can_search");
  });

  it("denies POST /v1/query when caller lacks can_search", async () => {
    await asUser("generic-sub");
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
      } as Response),
    ) as jest.Mock;

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const res = await POST(
      ragRequest("/api/rag/v1/query", {
        method: "POST",
        body: JSON.stringify({ query: "hello" }),
        headers: { "content-type": "application/json" },
      }),
      QUERY,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("organization#can_search");
  });

  it("org admins bypass the search gate on /v1/query", async () => {
    await asUser("admin-sub");
    mockCheckOpenFgaTuple.mockImplementation(
      async (tuple: { relation: string; object: string }) =>
        tuple.relation === "can_manage" && tuple.object === "organization:caipe"
          ? { allowed: true }
          : { allowed: false },
    );
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
      } as Response),
    ) as jest.Mock;

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const res = await POST(
      ragRequest("/api/rag/v1/query", {
        method: "POST",
        body: JSON.stringify({ query: "hello" }),
        headers: { "content-type": "application/json" },
      }),
      QUERY,
    );
    expect(res.status).toBe(200);
  });
});

describe("DELETE /v1/mcp/custom-tools/<id> — orphan tuple cleanup", () => {
  it("removes all mcp_tool:<id> grants after a successful upstream delete", async () => {
    await asUser("alice-sub");
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 204,
        json: async () => ({}),
      } as Response),
    ) as jest.Mock;

    const { DELETE } = await import("@/app/api/rag/[...path]/route");
    const res = await DELETE(
      ragRequest("/api/rag/v1/mcp/custom-tools/infra-search", {
        method: "DELETE",
      }),
      {
        params: Promise.resolve({
          path: ["v1", "mcp", "custom-tools", "infra-search"],
        }),
      },
    );
    expect(res.status).toBe(204);
    expect(mockDeleteAllMcpToolRelationshipTuples).toHaveBeenCalledWith(
      "infra-search",
    );
  });
});
