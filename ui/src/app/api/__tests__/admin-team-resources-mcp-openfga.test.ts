/**
 * @jest-environment node
 *
 * Team Resources route integration for MCP OpenFGA tuples — uses the real
 * `buildTeamResourceTupleDiff` builder (not a mock) and asserts the reconciler
 * receives gateway/BFF-aligned tuples.
 */

import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";
import { TEAM_TOOL_WILDCARD_SENTINEL_OBJECT } from "@/lib/rbac/team-tool-wildcard";

const mockGetServerSession = jest.fn();
jest.mock("next-auth", () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));
jest.mock("@/lib/auth-config", () => ({
  authOptions: {},
  isBootstrapAdmin: jest.fn().mockReturnValue(false),
  REQUIRED_ADMIN_GROUP: "",
}));
jest.mock("@/lib/rbac/keycloak-authz", () => ({
  checkPermission: jest.fn().mockResolvedValue({ allowed: true }),
}));
jest.mock("@/lib/rbac/audit", () => ({
  logAuthzDecision: jest.fn(),
}));
jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => key === "ssoEnabled",
}));

const mockCollections: Record<string, ReturnType<typeof createMockCollection>> = {};
const mockGetCollection = jest.fn((name: string) => {
  if (!mockCollections[name]) mockCollections[name] = createMockCollection();
  return Promise.resolve(mockCollections[name]);
});
jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

const mockFindUserIdByEmail = jest.fn();
jest.mock("@/lib/rbac/keycloak-admin", () => ({
  findUserIdByEmail: (...a: unknown[]) => mockFindUserIdByEmail(...a),
}));

const mockReconcileTupleDiff = jest.fn();
jest.mock("@/lib/authz", () => ({
  reconcileTupleDiff: (...a: unknown[]) => mockReconcileTupleDiff(...a),
}));

// Previous-state reads now come from OpenFGA (single source of truth). These
// integration tests assert the WRITE tuples, so default to no prior grants
// (every selection is an add); the writer dedups already-present tuples.
const mockListTeamResourceObjectIds = jest.fn().mockResolvedValue([]);
const mockListTeamAdminResourceObjectIds = jest.fn().mockResolvedValue([]);
class MockTeamResourceListingCache {
  listTeamResourceObjectIds(...a: unknown[]) {
    return mockListTeamResourceObjectIds(...a);
  }
  listTeamAdminResourceObjectIds(...a: unknown[]) {
    return mockListTeamAdminResourceObjectIds(...a);
  }
}
jest.mock("@/lib/rbac/team-resource-listing", () => ({
  TeamResourceListingCache: MockTeamResourceListingCache,
}));

function createMockCollection() {
  return {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
      toArray: jest.fn().mockResolvedValue([]),
    }),
    findOne: jest.fn().mockResolvedValue(null),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
}

function makeRequest(url: string, options: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), options);
}

const TEAM_ID = new ObjectId();

function seedCanonicalMembers(
  rows: Array<{ user_email: string; relationship: "member" | "admin" }>,
  teamSlug = "platform-engineering",
) {
  const sourcesCol = createMockCollection();
  const fixtureRows = rows.map((row) => ({
    team_id: TEAM_ID.toString(),
    team_slug: teamSlug,
    user_email: row.user_email,
    relationship: row.relationship,
    source_type: "manual",
    status: "active",
  }));
  sourcesCol.find = jest.fn((filter: Record<string, unknown> = {}) => {
    const filteredRows = fixtureRows.filter((row) => {
      if (filter.team_slug && row.team_slug !== filter.team_slug) return false;
      if (filter.status && row.status !== filter.status) return false;
      return true;
    });
    return {
      sort: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue(filteredRows),
    };
  });
  mockCollections.team_membership_sources = sourcesCol;
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockCollections).forEach((key) => delete mockCollections[key]);
  mockGetServerSession.mockResolvedValue({
    user: { email: "admin@example.com", name: "Admin" },
    role: "admin",
    sub: "admin-sub",
  });
  mockFindUserIdByEmail.mockImplementation(async (email: string) => `kc-${email}`);
  mockReconcileTupleDiff.mockResolvedValue({ enabled: true, writes: 4, deletes: 0 });
  mockListTeamResourceObjectIds.mockResolvedValue([]);
  mockListTeamAdminResourceObjectIds.mockResolvedValue([]);
  seedCanonicalMembers([{ user_email: "alice@example.com", relationship: "admin" }]);
});

describe("PUT /api/admin/teams/[id]/resources — MCP OpenFGA tuple integration", () => {
  it("reconciles mcp_server and tool:<id>/* tuples for MCP server assignments", async () => {
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({
      _id: TEAM_ID,
      slug: "platform-engineering",
      resources: { agents: [], tools: [], tool_wildcard: false },
    });
    mockCollections.teams = teamsCol;

    const { PUT } = await import("@/app/api/admin/teams/[id]/resources/route");
    const response = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({
          agents: [],
          tools: ["mcp-confluence-mcp_*"],
          tool_wildcard: false,
        }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) },
    );

    expect(response.status).toBe(200);
    expect(mockReconcileTupleDiff).toHaveBeenCalledTimes(1);

    const [tupleDiff] = mockReconcileTupleDiff.mock.calls[0] as [
      { writes: Array<{ user: string; relation: string; object: string }> },
      unknown,
    ];

    expect(tupleDiff.writes).toEqual(
      expect.arrayContaining([
        {
          user: "team:platform-engineering#member",
          relation: "caller",
          object: "tool:mcp-confluence-mcp/*",
        },
        {
          user: "team:platform-engineering#admin",
          relation: "manager",
          object: "mcp_server:mcp-confluence-mcp",
        },
        {
          user: "organization:caipe#admin",
          relation: "manager",
          object: "mcp_server:mcp-confluence-mcp",
        },
      ]),
    );
    expect(tupleDiff.writes).not.toEqual(
      expect.arrayContaining([
        { object: "mcp_tool:mcp-confluence-mcp_*" },
        { object: "tool:mcp-confluence-mcp_*" },
      ]),
    );
    expect(teamsCol.updateOne).toHaveBeenCalledTimes(1);
  });

  it("reconciles slash-form MCP server selections from the picker", async () => {
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({
      _id: TEAM_ID,
      slug: "platform-engineering",
      resources: { agents: [], tools: [], tool_wildcard: false },
    });
    mockCollections.teams = teamsCol;

    const { PUT } = await import("@/app/api/admin/teams/[id]/resources/route");
    const response = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({
          agents: [],
          tools: ["mcp-confluence-mcp/*"],
          tool_wildcard: false,
        }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) },
    );

    expect(response.status).toBe(200);
    const [tupleDiff] = mockReconcileTupleDiff.mock.calls[0] as [
      { writes: Array<{ user: string; relation: string; object: string }> },
      unknown,
    ];

    expect(tupleDiff.writes).toEqual(
      expect.arrayContaining([
        {
          user: "team:platform-engineering#member",
          relation: "caller",
          object: "tool:mcp-confluence-mcp/*",
        },
        {
          user: "team:platform-engineering#member",
          relation: "reader",
          object: "mcp_server:mcp-confluence-mcp",
        },
      ]),
    );
    expect(tupleDiff.writes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ object: "tool:mcp-confluence-mcp_*" }),
      ]),
    );
    expect(tupleDiff.writes).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ object: "mcp_tool:mcp-confluence-mcp_*" }),
      ]),
    );
  });

  it("expands all-server MCP wildcard without writing invalid tool:* tuples", async () => {
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({
      _id: TEAM_ID,
      slug: "platform-engineering",
      resources: { agents: ["agent-platform-helper"], tools: [], tool_wildcard: false },
    });
    mockCollections.teams = teamsCol;

    const mcpCol = createMockCollection();
    mcpCol.find = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([{ _id: "mcp-jira" }, { _id: "mcp-rag" }]),
    });
    mockCollections.mcp_servers = mcpCol;

    const { PUT } = await import("@/app/api/admin/teams/[id]/resources/route");
    const response = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({
          agents: ["agent-platform-helper"],
          tools: [],
          tool_wildcard: true,
        }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) },
    );

    expect(response.status).toBe(200);
    const [tupleDiff] = mockReconcileTupleDiff.mock.calls[0] as [
      { writes: Array<{ user: string; relation: string; object: string }> },
      unknown,
    ];

    expect(tupleDiff.writes).toEqual(
      expect.arrayContaining([
        {
          user: "team:platform-engineering#member",
          relation: "caller",
          object: "tool:mcp-jira/*",
        },
        {
          user: "team:platform-engineering#member",
          relation: "caller",
          object: "tool:mcp-rag/*",
        },
        {
          user: "agent:agent-platform-helper",
          relation: "caller",
          object: "tool:mcp-jira/*",
        },
        {
          user: "agent:agent-platform-helper",
          relation: "caller",
          object: "tool:mcp-rag/*",
        },
      ]),
    );
    expect(tupleDiff.writes).toContainEqual({
      user: "team:platform-engineering#member",
      relation: "caller",
      object: TEAM_TOOL_WILDCARD_SENTINEL_OBJECT,
    });
    expect(tupleDiff.writes.some((tuple) => /^[^:]+:\*$/.test(tuple.object))).toBe(false);
  });

  it("round-trips wildcard intent with no servers and revokes only the marker", async () => {
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({ _id: TEAM_ID, slug: "primary" });
    mockCollections.teams = teamsCol;
    const { PUT, GET } = await import("@/app/api/admin/teams/[id]/resources/route");
    const context = { params: Promise.resolve({ id: TEAM_ID.toString() }) };
    const url = `/api/admin/teams/${TEAM_ID}/resources`;

    const enabled = await PUT(makeRequest(url, {
      method: "PUT",
      body: JSON.stringify({ tool_wildcard: true }),
    }), context);
    expect(enabled.status).toBe(200);
    expect(mockReconcileTupleDiff.mock.calls[0][0].writes).toEqual([
      { user: "team:primary#member", relation: "caller", object: TEAM_TOOL_WILDCARD_SENTINEL_OBJECT },
    ]);

    mockListTeamResourceObjectIds.mockImplementation(async ({ type }: { type: string }) =>
      type === "tool" ? [TEAM_TOOL_WILDCARD_SENTINEL_OBJECT.slice("tool:".length)] : [],
    );
    const listed = await GET(makeRequest(url), context);
    expect((await listed.json()).data.resources).toMatchObject({ tools: [], tool_wildcard: true });

    const disabled = await PUT(makeRequest(url, {
      method: "PUT",
      body: JSON.stringify({ tool_wildcard: false }),
    }), context);
    expect(disabled.status).toBe(200);
    expect(mockReconcileTupleDiff.mock.calls[1][0]).toEqual({
      writes: [],
      deletes: [{ user: "team:primary#member", relation: "caller", object: TEAM_TOOL_WILDCARD_SENTINEL_OBJECT }],
    });
  });

  it("re-saves unchanged MCP selections to repair OpenFGA drift", async () => {
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({
      _id: TEAM_ID,
      slug: "platform-engineering",
      resources: {
        agents: ["hello-world"],
        tools: ["mcp-confluence-mcp_*"],
        tool_wildcard: false,
      },
    });
    mockCollections.teams = teamsCol;

    const { PUT } = await import("@/app/api/admin/teams/[id]/resources/route");
    const response = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({
          agents: ["hello-world"],
          tools: ["mcp-confluence-mcp_*"],
          tool_wildcard: false,
        }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) },
    );

    expect(response.status).toBe(200);
    expect(mockReconcileTupleDiff).toHaveBeenCalledTimes(1);

    const [tupleDiff] = mockReconcileTupleDiff.mock.calls[0] as [
      { writes: Array<{ user: string; relation: string; object: string }>; deletes: unknown[] },
      unknown,
    ];

    expect(tupleDiff.writes).toEqual(
      expect.arrayContaining([
        {
          user: "team:platform-engineering#member",
          relation: "caller",
          object: "tool:mcp-confluence-mcp/*",
        },
        {
          user: "team:platform-engineering#member",
          relation: "reader",
          object: "mcp_server:mcp-confluence-mcp",
        },
        {
          user: "agent:hello-world",
          relation: "caller",
          object: "tool:mcp-confluence-mcp/*",
        },
      ]),
    );
    expect(tupleDiff.deletes).toEqual([]);
    expect(teamsCol.updateOne).toHaveBeenCalledTimes(1);
  });

  it("does not persist Mongo when reconcileTupleDiff rejects the MCP tuple write", async () => {
    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({
      _id: TEAM_ID,
      slug: "platform-engineering",
      resources: { agents: [], tools: [], tool_wildcard: false },
    });
    mockCollections.teams = teamsCol;

    mockReconcileTupleDiff.mockRejectedValue(
      new Error("OpenFGA reconciliation is required for this mutation"),
    );

    const { PUT } = await import("@/app/api/admin/teams/[id]/resources/route");
    const response = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({
          agents: [],
          tools: ["mcp-confluence-mcp_*"],
          tool_wildcard: false,
        }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) },
    );

    expect(response.status).toBe(500);
    expect(teamsCol.updateOne).not.toHaveBeenCalled();
  });
});
