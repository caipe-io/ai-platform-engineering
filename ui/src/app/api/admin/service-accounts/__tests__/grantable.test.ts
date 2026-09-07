/**
 * @jest-environment node
 */
// assisted-by Codex Codex-sonnet-4-6

/**
 * T010 — GET /api/admin/service-accounts/grantable.
 *
 * FR-007/009: normal callers can grant only their own holdings — agents via
 * `user:<sub> can_use agent` and tools via `user:<sub> can_call tool`.
 * Platform admins can grant from the full enabled platform catalog.
 */

import { NextRequest } from "next/server";

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
jest.mock("@/lib/auth-config", () => ({ authOptions: {} }));

const mockListOpenFgaObjects = jest.fn();
jest.mock("@/lib/rbac/openfga", () => ({
  listOpenFgaObjects: (...args: unknown[]) => mockListOpenFgaObjects(...args),
}));

const mockListRebacCatalog = jest.fn();
jest.mock("@/lib/rbac/resource-catalog", () => ({
  listRebacCatalog: (...args: unknown[]) => mockListRebacCatalog(...args),
}));

const mockHasOrganizationAdmin = jest.fn();
jest.mock("@/lib/rbac/platform-admin", () => ({
  hasOrganizationAdmin: (...args: unknown[]) =>
    mockHasOrganizationAdmin(...args),
}));

const mockGetCollection = jest.fn();
jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

const mockAuthenticateRequest = jest.fn();
const mockBuildBackendHeaders = jest.fn();
jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  buildBackendHeaders: (...args: unknown[]) => mockBuildBackendHeaders(...args),
}));

import { GET } from "../grantable/route";

const SESSION = { sub: "caller-sub", user: { email: "caller@example.com" } };

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

function collectionReturning(rows: unknown[]) {
  const cursor = {
    sort: jest.fn(),
    toArray: jest.fn().mockResolvedValue(rows),
  };
  cursor.sort.mockReturnValue(cursor);
  return {
    find: jest.fn().mockReturnValue(cursor),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    bulkWrite: jest.fn().mockResolvedValue({}),
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockGetServerSession.mockResolvedValue(SESSION);
  mockListOpenFgaObjects.mockResolvedValue({ objects: [] });
  mockListRebacCatalog.mockResolvedValue({ resources: [] });
  mockHasOrganizationAdmin.mockResolvedValue(false);
  mockAuthenticateRequest.mockResolvedValue({
    subject: "caller-sub",
    bearerToken: "token",
  });
  mockBuildBackendHeaders.mockReturnValue({ Authorization: "Bearer token" });
  global.fetch = jest
    .fn()
    .mockRejectedValue(
      new Error("probe unavailable"),
    ) as unknown as typeof fetch;
});

describe("GET /api/admin/service-accounts/grantable", () => {
  it("keys on the CALLER's own holdings (FR-007/009) and shapes {ref,name}", async () => {
    mockListOpenFgaObjects
      .mockResolvedValueOnce({ objects: ["agent:incident-resolver"] }) // can_use agent
      .mockResolvedValueOnce({ objects: ["tool:jira/search", "tool:jira/*"] }); // can_call tool
    mockListRebacCatalog.mockResolvedValue({
      resources: [
        {
          type: "agent",
          id: "incident-resolver",
          display_name: "Incident Resolver",
        },
      ],
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // The two list-objects calls are keyed on the caller subject + correct relations.
    const calls = mockListOpenFgaObjects.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      { user: "user:caller-sub", relation: "can_use", type: "agent" },
      { user: "user:caller-sub", relation: "can_call", type: "tool" },
      { user: "user:caller-sub", relation: "can_read", type: "data_source" },
      {
        user: "user:caller-sub",
        relation: "can_read",
        type: "rag_collection",
      },
    ]);

    expect(body.data.agents).toEqual([
      { ref: "incident-resolver", name: "Incident Resolver" },
    ]);
    // Tools humanized; wildcard rendered as "all tools". Sorted by name.
    expect(body.data.tools).toEqual([
      { ref: "jira/*", name: "jira: all tools" },
      { ref: "jira/search", name: "jira: search" },
    ]);
  });

  it("returns readable RAG collections alongside individual datasources", async () => {
    mockListOpenFgaObjects.mockImplementation(
      async (input: { type: string }) => {
        if (input.type === "rag_collection") {
          return { objects: ["rag_collection:platform-rag"] };
        }
        return { objects: [] };
      },
    );
    mockGetCollection.mockImplementation((name: string) => {
      if (name === "rag_collections") {
        return Promise.resolve(
          collectionReturning([{ _id: "platform-rag", name: "Platform RAG" }]),
        );
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const res = await GET(request("/api/admin/service-accounts/grantable"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.collections).toEqual([
      { ref: "platform-rag", name: "Platform RAG" },
    ]);
  });

  it("falls back to the raw ref when the catalog has no display name", async () => {
    mockListOpenFgaObjects
      .mockResolvedValueOnce({ objects: ["agent:mystery-agent"] })
      .mockResolvedValueOnce({ objects: [] });

    const res = await GET();
    const body = await res.json();
    expect(body.data.agents).toEqual([
      { ref: "mystery-agent", name: "mystery-agent" },
    ]);
    expect(body.data.tools).toEqual([]);
  });

  it("still returns agents/tools when the name catalog throws (names are decorative)", async () => {
    mockListOpenFgaObjects
      .mockResolvedValueOnce({ objects: ["agent:a1"] })
      .mockResolvedValueOnce({ objects: ["tool:srv/do"] });
    mockListRebacCatalog.mockRejectedValue(new Error("catalog down"));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.agents).toEqual([{ ref: "a1", name: "a1" }]);
    expect(body.data.tools).toEqual([{ ref: "srv/do", name: "srv: do" }]);
  });

  it("returns only caller-readable datasources with friendly RAG labels", async () => {
    mockGetServerSession.mockResolvedValue({
      ...SESSION,
      accessToken: "access-token",
      org: "example-org",
    });
    mockListOpenFgaObjects
      .mockResolvedValueOnce({ objects: [] })
      .mockResolvedValueOnce({ objects: [] })
      .mockResolvedValueOnce({
        objects: ["data_source:source-a", "data_source:source-b"],
      });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        datasources: [
          { datasource_id: "source-a", name: "Primary handbook" },
          { datasource_id: "source-unheld", name: "Unheld source" },
        ],
      }),
    }) as unknown as typeof fetch;

    const res = await GET(request("/api/admin/service-accounts/grantable"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.datasources).toEqual([
      { ref: "source-a", name: "Primary handbook" },
      { ref: "source-b", name: "source-b" },
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:9446/v1/datasources",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer access-token",
          "Content-Type": "application/json",
          "X-Tenant-Id": "example-org",
        },
      },
    );
  });

  it("401 when unauthenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("503 when the OpenFGA list call fails", async () => {
    mockListOpenFgaObjects.mockRejectedValue(new Error("openfga down"));
    const res = await GET();
    expect(res.status).toBe(503);
  });

  it("returns the full platform catalog for the unlinked context when caller is a platform admin", async () => {
    mockHasOrganizationAdmin.mockResolvedValue(true);
    mockGetCollection.mockImplementation((name: string) => {
      if (name === "dynamic_agents") {
        return Promise.resolve(
          collectionReturning([
            {
              _id: "incident-resolver",
              name: "Incident Resolver",
              description: "",
            },
            { _id: "runbook-agent", name: "Runbook Agent", description: "" },
          ]),
        );
      }
      if (name === "mcp_servers") {
        return Promise.resolve(
          collectionReturning([
            { _id: "jira", name: "Jira", description: "" },
            { _id: "github", name: "GitHub", description: "" },
          ]),
        );
      }
      if (name === "mcp_tool_catalog") {
        return Promise.resolve(
          collectionReturning([
            {
              server_id: "jira",
              tool_id: "search",
              ref: "jira/search",
              display_name: "jira: search",
              description: "Search Jira issues",
              enabled: true,
            },
            {
              server_id: "jira",
              tool_id: "create_issue",
              ref: "jira/create_issue",
              display_name: "jira: create issue",
              enabled: true,
            },
          ]),
        );
      }
      if (name === "rag_collections") {
        return Promise.resolve(
          collectionReturning([{ _id: "platform-rag", name: "Platform RAG" }]),
        );
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const res = await GET(
      request("/api/admin/service-accounts/grantable?context=unlinked"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mockListOpenFgaObjects).toHaveBeenCalledTimes(1);
    expect(mockListOpenFgaObjects).toHaveBeenCalledWith({
      user: "user:caller-sub",
      relation: "can_read",
      type: "data_source",
    });
    expect(body.data.agents).toEqual([
      { ref: "incident-resolver", name: "Incident Resolver" },
      { ref: "runbook-agent", name: "Runbook Agent" },
    ]);
    expect(body.data.tools).toEqual([
      { ref: "github/*", name: "github: all tools" },
      { ref: "jira/*", name: "jira: all tools" },
      { ref: "jira/create_issue", name: "jira: create issue" },
      { ref: "jira/search", name: "jira: search" },
    ]);
    expect(body.data.collections).toEqual([
      { ref: "platform-rag", name: "Platform RAG" },
    ]);
  });

  it("returns the full platform MCP catalog for a platform admin in the normal service account picker", async () => {
    mockHasOrganizationAdmin.mockResolvedValue(true);
    mockGetCollection.mockImplementation((name: string) => {
      if (name === "dynamic_agents") {
        return Promise.resolve(
          collectionReturning([{ _id: "private", name: "Private Agent" }]),
        );
      }
      if (name === "mcp_servers") {
        return Promise.resolve(
          collectionReturning([
            { _id: "argocd", name: "Argocd" },
            { _id: "jira", name: "Jira" },
          ]),
        );
      }
      if (name === "mcp_tool_catalog") {
        return Promise.resolve(collectionReturning([]));
      }
      if (name === "rag_collections") {
        return Promise.resolve(collectionReturning([]));
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const res = await GET(request("/api/admin/service-accounts/grantable"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mockListOpenFgaObjects).toHaveBeenCalledTimes(1);
    expect(mockListOpenFgaObjects).toHaveBeenCalledWith({
      user: "user:caller-sub",
      relation: "can_read",
      type: "data_source",
    });
    expect(body.data.agents).toEqual([
      { ref: "private", name: "Private Agent" },
    ]);
    expect(body.data.tools).toEqual([
      { ref: "argocd/*", name: "argocd: all tools" },
      { ref: "jira/*", name: "jira: all tools" },
    ]);
  });

  it("includes every RAG-server datasource in an admin's full catalog", async () => {
    mockHasOrganizationAdmin.mockResolvedValue(true);
    mockGetServerSession.mockResolvedValue({
      ...SESSION,
      accessToken: "admin-token",
      org: "example-org",
    });
    mockGetCollection.mockImplementation((name: string) => {
      if (name === "dynamic_agents" || name === "mcp_servers") {
        return Promise.resolve(collectionReturning([]));
      }
      if (name === "mcp_tool_catalog") {
        return Promise.resolve(collectionReturning([]));
      }
      if (name === "rag_collections") {
        return Promise.resolve(collectionReturning([]));
      }
      throw new Error(`unexpected collection ${name}`);
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        datasources: [
          { datasource_id: "source-admin", name: "Organization handbook" },
        ],
      }),
    }) as unknown as typeof fetch;

    const res = await GET(request("/api/admin/service-accounts/grantable"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.datasources).toEqual([
      { ref: "source-admin", name: "Organization handbook" },
    ]);
  });

  it("hydrates and returns individual MCP tools for a platform admin when cache is empty", async () => {
    mockHasOrganizationAdmin.mockResolvedValue(true);
    mockGetCollection.mockImplementation((name: string) => {
      if (name === "dynamic_agents") {
        return Promise.resolve(collectionReturning([]));
      }
      if (name === "mcp_servers") {
        return Promise.resolve(
          collectionReturning([{ _id: "jira", name: "Jira" }]),
        );
      }
      if (name === "mcp_tool_catalog") {
        return Promise.resolve(collectionReturning([]));
      }
      if (name === "rag_collections") {
        return Promise.resolve(collectionReturning([]));
      }
      throw new Error(`unexpected collection ${name}`);
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        tools: [
          {
            name: "search",
            namespaced_name: "jira/search",
            description: "Search Jira",
          },
          { name: "create_issue", description: "Create Jira issue" },
        ],
      }),
    }) as unknown as typeof fetch;

    const res = await GET(request("/api/admin/service-accounts/grantable"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(global.fetch).toHaveBeenCalledWith(
      "http://localhost:8100/api/v1/mcp-servers/jira/probe",
      { method: "POST", headers: { Authorization: "Bearer token" } },
    );
    expect(body.data.tools).toEqual([
      { ref: "jira/*", name: "jira: all tools" },
      { ref: "jira/create_issue", name: "jira: create_issue" },
      { ref: "jira/search", name: "jira/search" },
    ]);
  });

  it("falls back to server wildcards for unlinked tools when no cached individual tools exist", async () => {
    mockHasOrganizationAdmin.mockResolvedValue(true);
    mockGetCollection.mockImplementation((name: string) => {
      if (name === "dynamic_agents") {
        return Promise.resolve(collectionReturning([]));
      }
      if (name === "mcp_servers") {
        return Promise.resolve(
          collectionReturning([{ _id: "jira", name: "Jira" }]),
        );
      }
      if (name === "mcp_tool_catalog") {
        return Promise.resolve(collectionReturning([]));
      }
      if (name === "rag_collections") {
        return Promise.resolve(collectionReturning([]));
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const res = await GET(
      request("/api/admin/service-accounts/grantable?context=unlinked"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.tools).toEqual([
      { ref: "jira/*", name: "jira: all tools" },
    ]);
  });

  it("falls back to a wildcard when a server was cataloged with no individual tools", async () => {
    mockHasOrganizationAdmin.mockResolvedValue(true);
    mockGetCollection.mockImplementation((name: string) => {
      if (name === "dynamic_agents") {
        return Promise.resolve(collectionReturning([]));
      }
      if (name === "mcp_servers") {
        return Promise.resolve(
          collectionReturning([{ _id: "jira", name: "Jira" }]),
        );
      }
      if (name === "mcp_tool_catalog") {
        return Promise.resolve(
          collectionReturning([
            {
              server_id: "jira",
              tool_id: "__catalog_marker__",
              ref: "jira/__catalog_marker__",
              display_name: "jira: catalog discovered",
              enabled: false,
              kind: "server_catalog",
            },
          ]),
        );
      }
      if (name === "rag_collections") {
        return Promise.resolve(collectionReturning([]));
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const res = await GET(
      request("/api/admin/service-accounts/grantable?context=unlinked"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.tools).toEqual([
      { ref: "jira/*", name: "jira: all tools" },
    ]);
  });

  it("403s the unlinked full-catalog context when the caller is not a platform admin", async () => {
    mockHasOrganizationAdmin.mockResolvedValue(false);

    const res = await GET(
      request("/api/admin/service-accounts/grantable?context=unlinked"),
    );
    expect(res.status).toBe(403);
    expect(mockGetCollection).not.toHaveBeenCalled();
    expect(mockListOpenFgaObjects).not.toHaveBeenCalled();
  });
});
