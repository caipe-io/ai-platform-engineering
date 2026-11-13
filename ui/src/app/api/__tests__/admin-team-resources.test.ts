/**
 * @jest-environment node
 */
/**
 * Spec 104 — tests for `PUT/GET /api/admin/teams/[id]/resources`.
 *
 * What we're guarding against:
 *   1. Non-admins cannot reassign team resources (auth gates fire before
 *      any tuple mutation).
 *   2. Add/remove diffs are reconciled to OpenFGA tuples, not Keycloak roles.
 *      Previous state is read from OpenFGA (via TeamResourceListingCache), not
 *      the dropped `team.resources` array — so revocations diff real grants.
 *   3. Resource grants are keyed on the `team:<slug>` userset, so this path
 *      never resolves member emails or writes per-member membership tuples —
 *      member access is transitive via membership owned by the members route.
 *   4. The Mongo `updated_at` touch + legacy `resources` $unset happens AFTER
 *      OpenFGA reconciliation so it never gets ahead of the PDP state.
 */

import { NextRequest } from "next/server";
import { ObjectId } from "mongodb";

// ── NextAuth + auth-config mocks (mirrors admin-teams.test.ts pattern) ──────
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
  checkPermission: jest.fn(),
}));
jest.mock("@/lib/rbac/audit", () => ({
  logAuthzDecision: jest.fn(),
}));
jest.mock("@/lib/config", () => ({
  getConfig: (key: string) => key === "ssoEnabled",
}));

// ── Mongo mock ──────────────────────────────────────────────────────────────
const mockCollections: Record<string, ReturnType<typeof createMockCollection>> = {};
const mockGetCollection = jest.fn((name: string) => {
  if (!mockCollections[name]) mockCollections[name] = createMockCollection();
  return Promise.resolve(mockCollections[name]);
});
jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
}));

const mockBuildTeamResourceTupleDiff = jest.fn();
const mockReconcileTupleDiff = jest.fn();
const mockCheckOpenFgaTuple = jest.fn();
jest.mock("@/lib/authz", () => ({
  reconcileTupleDiff: (...a: unknown[]) => mockReconcileTupleDiff(...a),
}));
jest.mock("@/lib/rbac/openfga", () => ({
  buildTeamResourceTupleDiff: (...a: unknown[]) => mockBuildTeamResourceTupleDiff(...a),
  checkOpenFgaTuple: (...a: unknown[]) => mockCheckOpenFgaTuple(...a),
  TEAM_TOOL_WILDCARD_SENTINEL_OBJECT: "tool:__all_mcp_servers_intent__",
  teamToolWildcardSentinelTuple: (slug: string) => ({
    user: `team:${slug}#member`,
    relation: "caller",
    object: "tool:__all_mcp_servers_intent__",
  }),
}));

// OpenFGA-derived previous/current state. Keyed `${relation} ${type}` (member)
// and `admin:${relation} ${type}` (team admins) so a test can seed the live
// grants the route reads back for GET echo + PUT revocation diffs.
const mockListTeamResourceObjectIds = jest.fn();
const mockListTeamAdminResourceObjectIds = jest.fn();
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

function setDefaultPermissionMock(allow: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { checkPermission } = require("@/lib/rbac/keycloak-authz") as {
    checkPermission: jest.Mock;
  };
  checkPermission.mockResolvedValue(
    allow ? { allowed: true } : { allowed: false, reason: "DENY_NO_CAPABILITY" }
  );
}

function createMockCollection() {
  // Cursor supports BOTH `find().toArray()` and `find().sort().toArray()`.
  // Post 2026-05-26 canonical-membership refactor, route handlers query
  // team_membership_sources via toArray() directly.
  return {
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
      toArray: jest.fn().mockResolvedValue([]),
    }),
    findOne: jest.fn().mockResolvedValue(null),
    insertOne: jest.fn().mockResolvedValue({ insertedId: new ObjectId() }),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
}

function makeRequest(url: string, options: RequestInit = {}): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), options);
}

function accessTokenWithRoles(roles: string[]): string {
  const payload = Buffer.from(
    JSON.stringify({ realm_access: { roles } }),
    "utf8"
  ).toString("base64url");
  return `h.${payload}.s`;
}

function adminSession() {
  return {
    user: { email: "admin@example.com", name: "Admin" },
    role: "admin",
    accessToken: accessTokenWithRoles(["admin"]),
    sub: "admin-sub",
  };
}

function userSession() {
  return {
    user: { email: "user@example.com", name: "User" },
    role: "user",
    accessToken: accessTokenWithRoles(["chat_user"]),
    sub: "user-sub",
  };
}

const TEAM_ID = new ObjectId();
const TEAM_SLUG = "demo-team";

function teamWith(resources: { agents: string[]; tools: string[] } | undefined) {
  return {
    _id: TEAM_ID,
    name: "Demo Team",
    slug: TEAM_SLUG,
    owner_id: "admin@example.com",
    // Note (2026-05-26): `members[]` is preserved here for tests that
    // still inspect it. The route reads from `team_membership_sources`
    // via the canonical helper; tests that exercise the read path must
    // seed `mockCollections.team_membership_sources` via
    // `seedCanonicalMembers()`.
    members: [
      { user_id: "alice@example.com", role: "owner", added_at: new Date(), added_by: "admin@example.com" },
      { user_id: "bob@example.com", role: "member", added_at: new Date(), added_by: "admin@example.com" },
    ],
    created_at: new Date(),
    updated_at: new Date(),
    ...(resources ? { resources } : {}),
  };
}

/**
 * Seed the canonical team_membership_sources mock with the standard
 * Demo Team roster (alice as admin, bob as member). Use this in tests
 * that exercise the route's membership read path so the route can
 * resolve email→Keycloak subject for OpenFGA tuple generation.
 */
function seedCanonicalMembers(
  rows: Array<{ user_email: string; relationship: "member" | "admin" }>,
  teamSlug = TEAM_SLUG
) {
  const sourcesCol = createMockCollection();
  const fixtureRows = rows.map((r) => ({
    team_id: TEAM_ID.toString(),
    team_slug: teamSlug,
    user_email: r.user_email,
    relationship: r.relationship,
    source_type: "manual",
    status: "active",
  }));
  sourcesCol.find = jest.fn((filter: Record<string, unknown> = {}) => {
    const filteredRows = fixtureRows.filter((row) => {
      if (filter.team_slug && row.team_slug !== filter.team_slug) return false;
      if (filter.status && row.status !== filter.status) return false;
      const clauses = Array.isArray(filter.$or) ? (filter.$or as Array<Record<string, unknown>>) : [];
      if (clauses.length === 0) return true;
      return clauses.some((clause) =>
        Object.entries(clause).every(([key, value]) => row[key as keyof typeof row] === value)
      );
    });
    return {
      sort: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue(filteredRows),
    };
  });
  mockCollections["team_membership_sources"] = sourcesCol;
}

/**
 * Seed the OpenFGA-derived "live grants" the route reads back. `agents` and
 * `tools` resolve via the member-relation listing; `agentAdmins` via the admin
 * (`manager`) listing. The route routes by (type, relation), so we dispatch on
 * `type`.
 */
function seedTeamGrants(grants: {
  agents?: string[];
  tools?: string[];
  workflows?: string[];
  agentAdmins?: string[];
}) {
  mockListTeamResourceObjectIds.mockImplementation(async ({ type }: { type: string }) => {
    if (type === "agent") return grants.agents ?? [];
    if (type === "tool") return grants.tools ?? [];
    if (type === "task") return grants.workflows ?? [];
    return [];
  });
  mockListTeamAdminResourceObjectIds.mockImplementation(async ({ type }: { type: string }) =>
    type === "agent" ? grants.agentAdmins ?? [] : []
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(mockCollections).forEach((k) => delete mockCollections[k]);
  setDefaultPermissionMock(false);
  mockCheckOpenFgaTuple.mockResolvedValue({ allowed: true });
  mockBuildTeamResourceTupleDiff.mockReturnValue({ writes: [], deletes: [] });
  mockReconcileTupleDiff.mockResolvedValue({ enabled: false, writes: 0, deletes: 0 });
  // Default: team holds no OpenFGA grants. Tests that exercise revocation seed
  // the live grants via seedTeamGrants().
  mockListTeamResourceObjectIds.mockResolvedValue([]);
  mockListTeamAdminResourceObjectIds.mockResolvedValue([]);
  // Default canonical roster matches teamWith()'s legacy `members[]` so
  // tests don't have to opt in. Tests that need a different roster
  // (e.g. empty team, single user) call seedCanonicalMembers([...]).
  seedCanonicalMembers([
    { user_email: "alice@example.com", relationship: "admin" },
    { user_email: "bob@example.com", relationship: "member" },
  ]);
});

async function loadRoute() {
  jest.resetModules();
  jest.doMock("@/lib/authz", () => ({
    reconcileTupleDiff: (...a: unknown[]) => mockReconcileTupleDiff(...a),
  }));
  jest.doMock("@/lib/rbac/openfga", () => ({
    buildTeamResourceTupleDiff: (...a: unknown[]) => mockBuildTeamResourceTupleDiff(...a),
    checkOpenFgaTuple: (...a: unknown[]) => mockCheckOpenFgaTuple(...a),
    TEAM_TOOL_WILDCARD_SENTINEL_OBJECT: "tool:__all_mcp_servers_intent__",
    teamToolWildcardSentinelTuple: (slug: string) => ({
      user: `team:${slug}#member`,
      relation: "caller",
      object: "tool:__all_mcp_servers_intent__",
    }),
  }));
  jest.doMock("@/lib/rbac/team-resource-listing", () => ({
    TeamResourceListingCache: MockTeamResourceListingCache,
  }));
  jest.doMock("@/lib/mongodb", () => ({
    getCollection: (...args: unknown[]) => mockGetCollection(...args),
    isMongoDBConfigured: true,
  }));
  const mod = await import("@/app/api/admin/teams/[id]/resources/route");
  return mod;
}

// ────────────────────────────────────────────────────────────────────────────
// Auth gates — these MUST fire before any Keycloak mutation
// ────────────────────────────────────────────────────────────────────────────

describe("PUT /api/admin/teams/[id]/resources — auth gating", () => {
  it("returns 401 when not authenticated and never touches Keycloak", async () => {
    setDefaultPermissionMock(true);
    mockGetServerSession.mockResolvedValue(null);
    const { PUT } = await loadRoute();

    const res = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({ agents: ["a"], tools: [] }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) }
    );

    expect(res.status).toBe(401);
    expect(mockReconcileTupleDiff).not.toHaveBeenCalled();
  });

  it("returns 403 when user lacks admin_ui#admin and is not a scoped team admin", async () => {
    // Issue #1509: the auth gate now runs AFTER the team document is loaded
    // so requireTeamMembershipManagementPermission can evaluate scoped team
    // admin membership. Seed a team where user@example.com is NOT an
    // owner/admin to assert the deny path. The test still proves resource
    // tuple mutations never fire before authz fails.
    setDefaultPermissionMock(false);
    mockCheckOpenFgaTuple.mockResolvedValue({ allowed: false });
    mockGetServerSession.mockResolvedValue(userSession());

    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(
      teamWith({ agents: [], tools: [] })
    );
    mockCollections["teams"] = teamsCol;

    const { PUT } = await loadRoute();
    setDefaultPermissionMock(false);

    const res = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({ agents: ["a"], tools: [] }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) }
    );

    expect(res.status).toBe(403);
    expect(mockReconcileTupleDiff).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Reconciliation — OpenFGA first, no Keycloak resource-role mirroring
// ────────────────────────────────────────────────────────────────────────────

describe("PUT /api/admin/teams/[id]/resources — reconciliation", () => {
  it("reconciles the diff vs live OpenFGA grants and unsets the legacy array", async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    setDefaultPermissionMock(true);

    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(teamWith(undefined));
    mockCollections["teams"] = teamsCol;
    // Live OpenFGA grants the route reads back as "previous state".
    seedTeamGrants({ agents: ["agent-keep", "agent-drop"], tools: ["jira/*"] });

    const { PUT } = await loadRoute();

    const res = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({
          // keep agent-keep, drop agent-drop, add agent-new
          agents: ["agent-keep", "agent-new"],
          // keep jira/*, add github/*
          tools: ["jira/*", "github/*"],
        }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) }
    );

    expect(res.status).toBe(200);

    // No `resources` array is written anymore; the route only touches
    // updated_at and unsets any legacy field.
    expect(teamsCol.updateOne).toHaveBeenCalledTimes(1);
    const update = teamsCol.updateOne.mock.calls[0][1];
    expect(update.$set.resources).toBeUndefined();
    expect(update.$set.updated_at).toBeInstanceOf(Date);
    expect(update.$unset).toEqual({ resources: "" });

    const body = await res.json();
    expect(body.data.diff).toMatchObject({
      agents_added: ["agent-new"],
      agents_removed: ["agent-drop"],
      tools_added: ["github/*"],
      tools_removed: [],
    });
    // Grants are keyed on the team userset, so saving resources reports only
    // the resource diff — no per-member resolution fields anymore.
    expect(body.data.members_resolved).toBeUndefined();
    expect(body.data.members_skipped).toBeUndefined();
  });

  it("does not resolve member emails or build membership tuples (team-userset grants)", async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    setDefaultPermissionMock(true);

    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(teamWith({ agents: [], tools: [] }));
    mockCollections["teams"] = teamsCol;

    const { PUT } = await loadRoute();

    const res = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({ agents: ["agent-1"], tools: [] }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) }
    );

    expect(res.status).toBe(200);

    // The tuple builder is invoked WITHOUT any memberUserIds — member access is
    // resolved transitively from membership tuples owned by the members route,
    // so this path must never re-resolve the roster against Keycloak.
    const builderArg = mockBuildTeamResourceTupleDiff.mock.calls[0][0];
    expect(builderArg).not.toHaveProperty("memberUserIds");

    const body = await res.json();
    expect(body.data.members_resolved).toBeUndefined();
    expect(body.data.members_skipped).toBeUndefined();

    // Mongo persistence still happens.
    expect(teamsCol.updateOne).toHaveBeenCalledTimes(1);
  });

  it("reconciles OpenFGA tuples from team resources before persisting Mongo", async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    setDefaultPermissionMock(true);

    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({
      ...teamWith(undefined),
      slug: "platform-engineering",
    });
    mockCollections["teams"] = teamsCol;
    seedCanonicalMembers([
      { user_email: "alice@example.com", relationship: "admin" },
      { user_email: "bob@example.com", relationship: "member" },
    ], "platform-engineering");
    // Live grant the route reads back: agent-old is currently granted and must
    // be revoked when the Save no longer includes it.
    seedTeamGrants({ agents: ["agent-old"] });
    const tupleDiff = {
      writes: [
        { user: "team:platform-engineering#member", relation: "user", object: "agent:agent-new" },
      ],
      deletes: [],
    };
    mockBuildTeamResourceTupleDiff.mockReturnValue(tupleDiff);

    const { PUT } = await loadRoute();

    const res = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({ agents: ["agent-new"], tools: ["jira/*"] }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) }
    );

    expect(res.status).toBe(200);
    expect(mockBuildTeamResourceTupleDiff).toHaveBeenCalledWith({
      teamSlug: "platform-engineering",
      agents: { added: ["agent-new"], removed: ["agent-old"] },
      agentAdmins: { added: [], removed: [] },
      tools: { added: ["jira/*"], removed: [] },
      toolWildcard: { added: false, removed: false },
      allMcpServerIds: [],
    });
    expect(mockReconcileTupleDiff).toHaveBeenCalledWith(
      tupleDiff,
      expect.objectContaining({
        caller: { type: "user", id: "admin-sub" },
        source: "team_resources",
      }),
    );
    expect(teamsCol.updateOne).toHaveBeenCalledTimes(1);
  });

  it("passes selected resources as desired writes so Save repairs OpenFGA drift", async () => {
    // assisted-by Codex Codex-sonnet-4-6
    mockGetServerSession.mockResolvedValue(adminSession());
    setDefaultPermissionMock(true);

    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({
      ...teamWith(undefined),
      slug: "platform-engineering",
    });
    mockCollections["teams"] = teamsCol;
    seedCanonicalMembers([
      { user_email: "alice@example.com", relationship: "admin" },
      { user_email: "bob@example.com", relationship: "member" },
    ], "platform-engineering");
    // Live grants identical to the Save → no removals; the writer dedups
    // already-present tuples so re-Save repairs drift without churn.
    seedTeamGrants({
      agents: ["agent-keep"],
      tools: ["mcp-confluence-mcp/*"],
      agentAdmins: ["agent-admin"],
    });

    const { PUT } = await loadRoute();

    const res = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({
          agents: ["agent-keep"],
          agent_admins: ["agent-admin"],
          tools: ["mcp-confluence-mcp/*"],
          tool_wildcard: false,
        }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) }
    );

    expect(res.status).toBe(200);
    expect(mockBuildTeamResourceTupleDiff).toHaveBeenCalledWith({
      teamSlug: "platform-engineering",
      agents: { added: ["agent-keep"], removed: [] },
      agentAdmins: { added: ["agent-admin"], removed: [] },
      tools: { added: ["mcp-confluence-mcp/*"], removed: [] },
      toolWildcard: { added: false, removed: false },
      allMcpServerIds: [],
    });
  });

  it("expands tool_wildcard into every enabled server prefix", async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    setDefaultPermissionMock(true);

    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({
      ...teamWith(undefined),
      slug: "platform-engineering",
    });
    mockCollections["teams"] = teamsCol;
    seedCanonicalMembers(
      [{ user_email: "alice@example.com", relationship: "admin" }],
      "platform-engineering"
    );

    const mcpCol = createMockCollection();
    mcpCol.find = jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue([{ _id: "jira" }, { _id: "github" }]),
    });
    mockCollections["mcp_servers"] = mcpCol;

    const { PUT } = await loadRoute();

    const res = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({ agents: [], tools: [], tool_wildcard: true }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) }
    );

    expect(res.status).toBe(200);
    // Wildcard becomes explicit per-server prefixes; toolWildcard stays off so
    // the dedicated wildcard tuple path never fires (it writes identical tuples).
    expect(mockBuildTeamResourceTupleDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: { added: ["jira/*", "github/*"], removed: [] },
        toolWildcard: { added: false, removed: false },
        allMcpServerIds: ["jira", "github"],
      })
    );
  });

  it("does not persist Mongo when OpenFGA reconciliation fails", async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    setDefaultPermissionMock(true);

    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue({
      ...teamWith({ agents: [], tools: [] }),
      slug: "platform-engineering",
    });
    mockCollections["teams"] = teamsCol;
    mockReconcileTupleDiff.mockRejectedValue(new Error("OpenFGA unavailable"));

    const { PUT } = await loadRoute();

    const res = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({ agents: ["agent-new"], tools: [] }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) }
    );

    expect(res.status).toBe(500);
    expect(teamsCol.updateOne).not.toHaveBeenCalled();
  });

  it("rejects malformed body (non-string array element)", async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    setDefaultPermissionMock(true);

    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(teamWith(undefined));
    mockCollections["teams"] = teamsCol;

    const { PUT } = await loadRoute();

    const res = await PUT(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`, {
        method: "PUT",
        body: JSON.stringify({ agents: ["ok", 42], tools: [] }),
      }),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) }
    );

    expect(res.status).toBe(400);
    expect(mockBuildTeamResourceTupleDiff).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GET — picker catalog shape
// ────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/teams/[id]/resources", () => {
  it("returns current selection plus available agents/tools", async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    setDefaultPermissionMock(true);

    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(teamWith(undefined));
    mockCollections["teams"] = teamsCol;
    // GET echoes the live OpenFGA grants, not a Mongo array.
    seedTeamGrants({ agents: ["agent-1"], tools: ["jira/*"] });

    const agentsCol = createMockCollection();
    agentsCol.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest
          .fn()
          .mockResolvedValue([
            { _id: "agent-1", name: "Test Agent", description: "", visibility: "global" },
            { _id: "agent-2", name: "Another", description: "", visibility: "global" },
          ]),
      }),
    });
    mockCollections["dynamic_agents"] = agentsCol;

    const mcpCol = createMockCollection();
    mcpCol.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          { _id: "jira", name: "Jira", description: "Jira MCP" },
          { _id: "github", name: "GitHub", description: "GitHub MCP" },
        ]),
      }),
    });
    mockCollections["mcp_servers"] = mcpCol;

    const { GET } = await loadRoute();

    const res = await GET(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.resources.agents).toEqual(["agent-1"]);
    expect(body.data.resources.tools).toEqual(["jira/*"]);

    expect(body.data.available.agents.map((a: { id: string }) => a.id)).toEqual([
      "agent-1",
      "agent-2",
    ]);
    // Tools are surfaced as `<server>/*` slash wildcards — the form the
    // AgentGateway bridge enforces (#43). (resources.tools above still echoes
    // the team's STORED value verbatim; only the available picker uses slash.)
    expect(body.data.available.tools.map((t: { id: string }) => t.id)).toEqual([
      "jira/*",
      "github/*",
    ]);
  });

  it("includes enabled Skill Hub skills in the skills picker using catalog ids", async () => {
    mockGetServerSession.mockResolvedValue(adminSession());
    setDefaultPermissionMock(true);

    const teamsCol = createMockCollection();
    teamsCol.findOne.mockResolvedValue(teamWith({ agents: [], tools: [] }));
    mockCollections["teams"] = teamsCol;

    const hubsCol = createMockCollection();
    hubsCol.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([{ id: "hub-1", enabled: true }]),
      }),
    });
    mockCollections["skill_hubs"] = hubsCol;

    const hubSkillsCol = createMockCollection();
    hubSkillsCol.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          {
            hub_id: "hub-1",
            skill_id: "incident-triage",
            name: "Incident Triage",
            description: "Triage incidents from a shared hub",
          },
        ]),
      }),
    });
    mockCollections["hub_skills"] = hubSkillsCol;

    const { GET } = await loadRoute();

    const res = await GET(
      makeRequest(`/api/admin/teams/${TEAM_ID}/resources`),
      { params: Promise.resolve({ id: TEAM_ID.toString() }) }
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.available.skills).toContainEqual({
      id: "hub-hub-1-incident-triage",
      name: "Incident Triage",
      description: "Triage incidents from a shared hub",
    });
  });
});
