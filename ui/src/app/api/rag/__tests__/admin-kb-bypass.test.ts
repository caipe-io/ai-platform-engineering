/**
 * @jest-environment node
 */

// The RAG proxy passes `bypassForOrgAdmin: true` to
// `filterResourcesByPermission` and `requireResourcePermission` so org
// admins are not silently denied on `GET /v1/datasources` and per-KB
// requests even when they hold no per-KB tuples. This test asserts the
// option is always forwarded.

jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: "",
}));

import { NextRequest } from "next/server";

const mockRequireRbacPermission = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockReconcileKnowledgeBaseRelationships = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();
const mockSourceConfigToArray = jest.fn();

jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(async () => ({
    find: jest.fn(() => ({ toArray: mockSourceConfigToArray })),
  })),
}));

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
          success: false,
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

jest.mock("@/lib/rbac/openfga-owned-resources-reconcile", () => ({
  reconcileKnowledgeBaseRelationships: (...args: unknown[]) =>
    mockReconcileKnowledgeBaseRelationships(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  checkOpenFgaTuple: (...args: unknown[]) => mockCheckOpenFgaTuple(...args),
}));

function ragRequest(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

describe("RAG org-admin bypass", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireRbacPermission.mockResolvedValue(undefined);
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockFilterResourcesByPermission.mockImplementation(
      async (_session, resources) => resources,
    );
    mockReconcileKnowledgeBaseRelationships.mockResolvedValue({
      enabled: true,
      writes: 0,
      deletes: 0,
    });
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    mockSourceConfigToArray.mockResolvedValue([]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    }) as unknown as typeof fetch;
  });

  it("GET /v1/datasources calls filterResourcesByPermission with bypassForOrgAdmin", async () => {
    const nextAuth = await import("next-auth");
    jest.mocked(nextAuth.getServerSession).mockResolvedValue({
      sub: "admin-sub",
      role: "admin",
      org: "caipe",
      accessToken: "admin-token",
      user: { email: "admin@example.com" },
    } as unknown);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        datasources: [
          { datasource_id: "kb-a", name: "A" },
          { datasource_id: "kb-b", name: "B" },
        ],
        count: 2,
      }),
    } as Response);

    const { GET } = await import("@/app/api/rag/[...path]/route");
    const response = await GET(ragRequest("/api/rag/v1/datasources"), {
      params: Promise.resolve({ path: ["v1", "datasources"] }),
    });

    expect(response.status).toBe(200);
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "admin-sub" }),
      expect.any(Array),
      expect.objectContaining({ type: "data_source", action: "read" }),
      expect.objectContaining({ bypassForOrgAdmin: true }),
    );
  });

  it("per-KB request forwards bypassForOrgAdmin: true to requireResourcePermission", async () => {
    const nextAuth = await import("next-auth");
    jest.mocked(nextAuth.getServerSession).mockResolvedValue({
      sub: "admin-sub",
      role: "admin",
      org: "caipe",
      accessToken: "admin-token",
      user: { email: "admin@example.com" },
    } as unknown);

    const { GET } = await import("@/app/api/rag/[...path]/route");
    await GET(ragRequest("/api/rag/v1/datasources?datasource_id=kb-x"), {
      params: Promise.resolve({ path: ["v1", "datasources"] }),
    });

    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "admin-sub" }),
      expect.objectContaining({ type: "data_source", id: "kb-x" }),
      expect.objectContaining({ bypassForOrgAdmin: true }),
    );
  });

  it("lets an Owner update datasource configuration without a coarse RAG admin grant", async () => {
    const nextAuth = await import("next-auth");
    jest.mocked(nextAuth.getServerSession).mockResolvedValue({
      sub: "owner-sub",
      role: "user",
      org: "caipe",
      accessToken: "owner-token",
      user: { email: "owner@example.com" },
    } as unknown);
    const { ApiError } = await import("@/lib/api-middleware");
    mockRequireResourcePermission
      .mockRejectedValueOnce(new ApiError("not a Search manager", 403))
      .mockResolvedValueOnce(undefined);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ datasource_id: "source-a", changed: true }),
    } as Response);

    const body = JSON.stringify({ name: "Updated source" });
    const { PATCH } = await import("@/app/api/rag/[...path]/route");
    const response = await PATCH(
      ragRequest("/api/rag/v1/datasource/source-a", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.length),
        },
        body,
      }),
      { params: Promise.resolve({ path: ["v1", "datasource", "source-a"] }) },
    );

    expect(response.status).toBe(200);
    expect(mockRequireRbacPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "owner-sub" }),
      "rag",
      "view",
    );
    expect(mockRequireResourcePermission).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sub: "owner-sub" }),
      { type: "data_source", id: "source-a", action: "admin" },
      { bypassForOrgAdmin: true },
    );
    expect(mockRequireResourcePermission).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sub: "owner-sub" }),
      { type: "ingestion_source", id: "source-a", action: "manage" },
      { bypassForOrgAdmin: true },
    );
  });

  it("lets the RAG server authorize job termination against its datasource Owner", async () => {
    const nextAuth = await import("next-auth");
    jest.mocked(nextAuth.getServerSession).mockResolvedValue({
      sub: "owner-sub",
      role: "user",
      org: "caipe",
      accessToken: "owner-token",
      user: { email: "owner@example.com" },
    } as unknown);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: "Job terminated" }),
    } as Response);

    const { POST } = await import("@/app/api/rag/[...path]/route");
    const response = await POST(
      ragRequest("/api/rag/v1/job/job-a/terminate", { method: "POST" }),
      {
        params: Promise.resolve({
          path: ["v1", "job", "job-a", "terminate"],
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(mockRequireRbacPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "owner-sub" }),
      "rag",
      "view",
    );
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
  });

  it("constrainSearchBody short-circuits when org-admin tuple is allowed", async () => {
    const nextAuth = await import("next-auth");
    jest.mocked(nextAuth.getServerSession).mockResolvedValue({
      sub: "admin-sub",
      role: "user", // role !== 'admin' so we hit the OpenFGA check path
      org: "caipe",
      accessToken: "admin-token",
      user: { email: "admin@example.com" },
    } as unknown);
    mockCheckOpenFgaTuple.mockImplementation(
      async (tuple: { object: string; relation: string }) => {
        if (
          tuple.object === "organization:caipe" &&
          tuple.relation === "can_manage"
        ) {
          return { allowed: true };
        }
        return { allowed: false };
      },
    );
    const upstreamFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    });
    global.fetch = upstreamFetch as unknown as typeof fetch;

    const body = { query: "hello" };
    const { POST } = await import("@/app/api/rag/[...path]/route");
    await POST(
      ragRequest("/api/rag/v1/query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "content-length": String(JSON.stringify(body).length),
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: ["v1", "query"] }) },
    );

    // No call was made to enumerate readable datasource ids — the
    // upstream `fetch` was invoked exactly once: the POST itself.
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
    // The unmodified body must have been forwarded.
    const forwardedBody = JSON.parse(upstreamFetch.mock.calls[0][1].body);
    expect(forwardedBody).toEqual(body);
  });

  it("does not treat a legacy coarse admin role as an org-admin search bypass", async () => {
    const nextAuth = await import("next-auth");
    jest.mocked(nextAuth.getServerSession).mockResolvedValue({
      sub: "legacy-admin-sub",
      role: "admin",
      org: "caipe",
      accessToken: "legacy-admin-token",
      user: { email: "legacy-admin@example.com" },
    } as unknown);
    mockCheckOpenFgaTuple.mockImplementation(
      async (tuple: { object: string; relation: string }) => ({
        allowed:
          tuple.object === "organization:caipe" &&
          tuple.relation === "can_search",
      }),
    );
    mockFilterResourcesByPermission.mockImplementation(
      async (_session, resources, target: { type: string }) =>
        target.type === "data_source" ? resources : [],
    );
    const upstreamFetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ datasources: [{ datasource_id: "kb-a" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      });
    global.fetch = upstreamFetch as unknown as typeof fetch;

    const body = { query: "hello" };
    const { POST } = await import("@/app/api/rag/[...path]/route");
    await POST(
      ragRequest("/api/rag/v1/query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "content-length": String(JSON.stringify(body).length),
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: ["v1", "query"] }) },
    );

    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    const forwardedBody = JSON.parse(upstreamFetch.mock.calls[1][1].body);
    expect(forwardedBody.filters.datasource_id).toBe("kb-a");
  });

  it("RAG_ADMIN_BYPASS_DISABLED forces per-resource filtering even for org admins", async () => {
    process.env.RAG_ADMIN_BYPASS_DISABLED = "true";
    const nextAuth = await import("next-auth");
    jest.mocked(nextAuth.getServerSession).mockResolvedValue({
      sub: "admin-sub",
      role: "user",
      org: "caipe",
      accessToken: "admin-token",
      user: { email: "admin@example.com" },
    } as unknown);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
    const upstreamFetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ datasources: [{ datasource_id: "kb-a" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      });
    global.fetch = upstreamFetch as unknown as typeof fetch;

    const body = { query: "hello" };
    const { POST } = await import("@/app/api/rag/[...path]/route");
    await POST(
      ragRequest("/api/rag/v1/query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "content-length": String(JSON.stringify(body).length),
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: ["v1", "query"] }) },
    );

    // With the kill switch on, the constrainSearchBody path must
    // enumerate the readable datasources before forwarding.
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    process.env.RAG_ADMIN_BYPASS_DISABLED = "";
  });
});
