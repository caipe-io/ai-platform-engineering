/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockGetCollection = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockResolveAgentListPermissions = jest.fn();
const mockAgentRowPermissionsOrDefault = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockRequireAgentPermission = jest.fn();
const mockGetPlatformDefaultAgentId = jest.fn();
const mockFilterAgentsByOwnershipScopeForSession = jest.fn();

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
    // Mirrors the real implementation closely enough to exercise
    // page/page_size-driven slicing behaviour in these tests (the
    // route-rbac.test.ts sibling file pins page/pageSize to fixed
    // literals, which isn't enough to test pagination itself).
    getPaginationParams: (request: NextRequest) => {
      const url = new URL(request.url);
      const page = parseInt(url.searchParams.get("page") || "1", 10);
      const pageSize = parseInt(url.searchParams.get("page_size") || "20", 10);
      return { page, pageSize, skip: (page - 1) * pageSize };
    },
    paginatedResponse: (items: unknown[], total: number, page: number, pageSize: number) =>
      Response.json({
        success: true,
        data: {
          items,
          total,
          page,
          page_size: pageSize,
          has_more: page * pageSize < total,
        },
      }),
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
  isMongoDBConfigured: true,
}));

jest.mock("@/lib/config", () => ({
  getServerConfig: () => ({}),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  filterResourcesByPermission: (...args: unknown[]) => mockFilterResourcesByPermission(...args),
  resolveAgentListPermissions: (...args: unknown[]) => mockResolveAgentListPermissions(...args),
  agentRowPermissionsOrDefault: (...args: unknown[]) => mockAgentRowPermissionsOrDefault(...args),
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
  requireAgentPermission: (...args: unknown[]) => mockRequireAgentPermission(...args),
  canTransferResourceOwnership: jest.fn(),
}));

jest.mock("@/lib/rbac/openfga-agent-tools", () => ({
  allowedToolsFromAgent: (agent: { allowed_tools?: Record<string, string[]> }) => agent.allowed_tools ?? {},
  deleteAllAgentToolTuples: jest.fn(),
  reconcileAgentRelationships: jest.fn(),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: jest.fn(),
}));

jest.mock("@/lib/rbac/platform-default", () => ({
  isPlatformDefaultAgent: jest.fn().mockResolvedValue(false),
  getPlatformDefaultAgentId: (...args: unknown[]) => mockGetPlatformDefaultAgentId(...args),
}));

jest.mock("@/lib/rbac/agent-ownership-scope", () => ({
  filterAgentsByOwnershipScopeForSession: (...args: unknown[]) =>
    mockFilterAgentsByOwnershipScopeForSession(...args),
}));

jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: jest.fn(),
  getDynamicAgentsConfig: jest.fn(),
  proxyRequest: jest.fn(),
}));

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

const session = { sub: "alice-sub", role: "admin" };
const user = { email: "alice@example.com" };

describe("GET /api/dynamic-agents search + pagination", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ user, session });
    // Identity passthroughs so the route's own filtering/pagination logic
    // (not RBAC) is what's under test here.
    mockFilterResourcesByPermission.mockImplementation(async (_session, items) => items);
    mockFilterAgentsByOwnershipScopeForSession.mockImplementation(async (_session, items) => items);
    mockResolveAgentListPermissions.mockResolvedValue({ rows: new Map() });
    mockAgentRowPermissionsOrDefault.mockReturnValue({
      can_manage: false,
      can_write: false,
      can_discover: true,
    });
    mockGetPlatformDefaultAgentId.mockResolvedValue(null);
  });

  function mockFind(items: unknown[]) {
    const findSpy = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue(items),
    });
    mockGetCollection.mockResolvedValue({ find: findSpy });
    return findSpy;
  }

  it("builds a case-insensitive name/description regex query for ?search=", async () => {
    const findSpy = mockFind([]);
    const { GET } = await import("../route");

    await GET(request("/api/dynamic-agents?search=foo"));

    expect(findSpy).toHaveBeenCalledWith({
      $or: [
        { name: { $regex: "foo", $options: "i" } },
        { description: { $regex: "foo", $options: "i" } },
      ],
    });
  });

  it("also matches by _id when the search string is a valid ObjectId", async () => {
    const findSpy = mockFind([]);
    const hexId = "507f1f77bcf86cd799439011";
    const { GET } = await import("../route");

    await GET(request(`/api/dynamic-agents?search=${hexId}`));

    const calledQuery = findSpy.mock.calls[0][0] as { $or: Record<string, unknown>[] };
    expect(calledQuery.$or).toHaveLength(3);
    expect(calledQuery.$or).toContainEqual({ name: { $regex: hexId, $options: "i" } });
    expect(calledQuery.$or).toContainEqual({ description: { $regex: hexId, $options: "i" } });
    const idClause = calledQuery.$or.find((clause) => "_id" in clause) as { _id: ObjectId };
    expect(idClause._id).toBeInstanceOf(ObjectId);
    expect(idClause._id.equals(new ObjectId(hexId))).toBe(true);
  });

  it("combines enabled_only and search into an $and of both clauses", async () => {
    const findSpy = mockFind([]);
    const { GET } = await import("../route");

    await GET(request("/api/dynamic-agents?enabled_only=true&search=bar"));

    expect(findSpy).toHaveBeenCalledWith({
      $and: [
        { $or: [{ enabled: true }, { enabled: { $exists: false } }] },
        {
          $or: [
            { name: { $regex: "bar", $options: "i" } },
            { description: { $regex: "bar", $options: "i" } },
          ],
        },
      ],
    });
  });

  it("filters the in-memory dataset by name/description matches (case-insensitive)", async () => {
    const agents = [
      { _id: "agent-1", name: "Jira Helper", description: "triage tickets", model: { id: "m", provider: "p" } },
      { _id: "agent-2", name: "Ops Bot", description: "handles JIRA escalations", model: { id: "m", provider: "p" } },
      { _id: "agent-3", name: "Unrelated", description: "nothing here", model: { id: "m", provider: "p" } },
    ];
    // The mock `find` must actually honor the constructed regex query so
    // this test exercises real filtering semantics rather than merely
    // asserting on the query shape.
    const findSpy = jest.fn().mockImplementation((query: { $or?: Array<Record<string, unknown>> }) => {
      const orClauses = query.$or ?? [];
      const nameRegex = orClauses.find((c) => "name" in c) as { name: { $regex: string; $options: string } } | undefined;
      const matched = nameRegex
        ? agents.filter((a) => new RegExp(nameRegex.name.$regex, nameRegex.name.$options).test(a.name) ||
            new RegExp(nameRegex.name.$regex, nameRegex.name.$options).test(a.description))
        : agents;
      return {
        sort: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue(matched),
      };
    });
    mockGetCollection.mockResolvedValue({ find: findSpy });
    const { GET } = await import("../route");

    const response = await GET(request("/api/dynamic-agents?search=jira"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.items.map((a: { _id: string }) => a._id).sort()).toEqual(["agent-1", "agent-2"]);
    expect(body.data.total).toBe(2);
  });

  it("paginates the RBAC-filtered result set and reports the full filtered total", async () => {
    const agents = Array.from({ length: 25 }, (_, i) => ({
      _id: `agent-${i}`,
      name: `Agent ${i}`,
      model: { id: "m", provider: "p" },
    }));
    mockFind(agents);
    // Simulate RBAC denying one agent so `total` must reflect the
    // post-permission-filter count, not the raw Mongo count.
    mockFilterResourcesByPermission.mockImplementation(async (_session, items) =>
      items.filter((a: { _id: string }) => a._id !== "agent-24"),
    );
    const { GET } = await import("../route");

    const page1 = await GET(request("/api/dynamic-agents?page=1&page_size=10"));
    const page1Body = await page1.json();
    expect(page1Body.data.items).toHaveLength(10);
    expect(page1Body.data.items[0]._id).toBe("agent-0");
    expect(page1Body.data.total).toBe(24);

    const page3 = await GET(request("/api/dynamic-agents?page=3&page_size=10"));
    const page3Body = await page3.json();
    // 24 visible items, page 3 of size 10 → items 20..23 (4 items)
    expect(page3Body.data.items).toHaveLength(4);
    expect(page3Body.data.items[0]._id).toBe("agent-20");
    expect(page3Body.data.total).toBe(24);
  });

  it.each([
    ["name", "asc", ["alpha", "bravo", "gamma"]],
    ["visibility", "asc", ["bravo", "gamma", "alpha"]],
    ["tools", "asc", ["bravo", "gamma", "alpha"]],
    ["grade", "asc", ["alpha", "gamma", "bravo"]],
    ["status", "asc", ["bravo", "alpha", "gamma"]],
    ["name", "desc", ["gamma", "bravo", "alpha"]],
  ])("sorts the full result set by %s %s before pagination", async (sortBy, sortOrder, expectedIds) => {
    mockFind([
      {
        _id: "gamma",
        name: "Gamma",
        visibility: "private",
        allowed_tools: { first: true },
        last_review: { score: 0.95 },
        enabled: true,
        model: { id: "m", provider: "p" },
      },
      {
        _id: "alpha",
        name: "Alpha",
        visibility: "team",
        allowed_tools: { first: true, second: true },
        last_review: { score: 0.8 },
        enabled: true,
        model: { id: "m", provider: "p" },
      },
      {
        _id: "bravo",
        name: "Bravo",
        visibility: "global",
        allowed_tools: {},
        enabled: false,
        model: { id: "m", provider: "p" },
      },
    ]);
    const { GET } = await import("../route");

    const response = await GET(request(
      `/api/dynamic-agents?sort_by=${sortBy}&sort_order=${sortOrder}`,
    ));
    const body = await response.json();

    expect(body.data.items.map((agent: { _id: string }) => agent._id)).toEqual(expectedIds);
  });

  it("sorts by name by default while keeping the platform-default agent pinned first", async () => {
    mockGetPlatformDefaultAgentId.mockResolvedValue("pinned");
    mockFind([
      { _id: "bravo", name: "Bravo", model: { id: "m", provider: "p" } },
      { _id: "pinned", name: "Zulu", model: { id: "m", provider: "p" } },
      { _id: "alpha", name: "Alpha", model: { id: "m", provider: "p" } },
    ]);
    const { GET } = await import("../route");

    const response = await GET(request("/api/dynamic-agents"));
    const body = await response.json();

    expect(body.data.items.map((agent: { _id: string }) => agent._id)).toEqual([
      "pinned",
      "alpha",
      "bravo",
    ]);
  });
});
