/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetAuthFromBearerOrSession = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockGetCollection = jest.fn();
const mockGetUserTeamIds = jest.fn();
const mockFilterResourcesByPermission = jest.fn();
const mockResolveAgentListPermissions = jest.fn();
const mockAgentRowPermissionsOrDefault = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockRequireAgentPermission = jest.fn();
const mockCanTransferResourceOwnership = jest.fn();
const mockReconcileAgentRelationships = jest.fn();
const mockDeleteAllAgentToolTuples = jest.fn();
const mockCascadeDeleteAutonomousTasksForAgent = jest.fn();
const mockAuthenticateRequest = jest.fn();
const mockGetDynamicAgentsConfig = jest.fn();
const mockProxyRequest = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();
const mockIsPlatformDefaultAgent = jest.fn();
const mockGetPlatformDefaultAgentId = jest.fn();
const mockFilterAgentsByOwnershipScopeForSession = jest.fn();
const mockResolveUnlinkedServiceAccountSub = jest.fn();
const mockResolveUnlinkedServiceAccountGrantState = jest.fn();

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
    getAuthFromBearerOrSession: (...args: unknown[]) =>
      mockGetAuthFromBearerOrSession(...args),
    getPaginationParams: () => ({ page: 1, pageSize: 20, skip: 0 }),
    getUserTeamIds: (...args: unknown[]) => mockGetUserTeamIds(...args),
    paginatedResponse: (
      items: unknown[],
      total: number,
      page: number,
      pageSize: number,
    ) =>
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
    requireRbacPermission: (...args: unknown[]) =>
      mockRequireRbacPermission(...args),
    successResponse: (data: unknown, status = 200) =>
      Response.json({ success: true, data }, { status }),
    withErrorHandler:
      <T>(handler: (request: NextRequest) => Promise<T>) =>
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
  filterResourcesByPermission: (...args: unknown[]) =>
    mockFilterResourcesByPermission(...args),
  resolveAgentListPermissions: (...args: unknown[]) =>
    mockResolveAgentListPermissions(...args),
  agentRowPermissionsOrDefault: (...args: unknown[]) =>
    mockAgentRowPermissionsOrDefault(...args),
  requireResourcePermission: (...args: unknown[]) =>
    mockRequireResourcePermission(...args),
  requireAgentPermission: (...args: unknown[]) =>
    mockRequireAgentPermission(...args),
  canTransferResourceOwnership: (...args: unknown[]) =>
    mockCanTransferResourceOwnership(...args),
}));

jest.mock("@/lib/rbac/openfga-agent-tools", () => ({
  allowedToolsFromAgent: (agent: {
    allowed_tools?: Record<string, string[]>;
  }) => agent.allowed_tools ?? {},
  deleteAllAgentToolTuples: (...args: unknown[]) =>
    mockDeleteAllAgentToolTuples(...args),
  reconcileAgentRelationships: (...args: unknown[]) =>
    mockReconcileAgentRelationships(...args),
}));

jest.mock("@/lib/dynamic-agents/autonomousTaskCascade", () => ({
  cascadeDeleteAutonomousTasksForAgent: (...args: unknown[]) =>
    mockCascadeDeleteAutonomousTasksForAgent(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

jest.mock("@/lib/rbac/platform-default", () => ({
  isPlatformDefaultAgent: (...args: unknown[]) =>
    mockIsPlatformDefaultAgent(...args),
  getPlatformDefaultAgentId: (...args: unknown[]) =>
    mockGetPlatformDefaultAgentId(...args),
}));

jest.mock("@/lib/rbac/agent-ownership-scope", () => ({
  filterAgentsByOwnershipScopeForSession: (...args: unknown[]) =>
    mockFilterAgentsByOwnershipScopeForSession(...args),
}));

jest.mock("@/lib/rbac/unlinked-service-account", () => ({
  resolveUnlinkedServiceAccountSub: (...args: unknown[]) =>
    mockResolveUnlinkedServiceAccountSub(...args),
  resolveUnlinkedServiceAccountGrantState: (...args: unknown[]) =>
    mockResolveUnlinkedServiceAccountGrantState(...args),
}));

jest.mock("@/lib/da-proxy", () => ({
  authenticateRequest: (...args: unknown[]) => mockAuthenticateRequest(...args),
  getDynamicAgentsConfig: (...args: unknown[]) =>
    mockGetDynamicAgentsConfig(...args),
  proxyRequest: (...args: unknown[]) => mockProxyRequest(...args),
}));

function request(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

const session = { sub: "alice-sub", role: "admin" };
const user = { email: "alice@example.com" };

describe("dynamic agents RBAC routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ user, session });
    mockRequireRbacPermission.mockResolvedValue(undefined);
    mockGetUserTeamIds.mockResolvedValue(["team-a"]);
    mockFilterResourcesByPermission.mockImplementation(
      async (_session, items) => items,
    );
    mockResolveAgentListPermissions.mockResolvedValue({ rows: new Map() });
    mockAgentRowPermissionsOrDefault.mockReturnValue({
      can_manage: false,
      can_write: false,
      can_discover: true,
    });
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockRequireAgentPermission.mockResolvedValue(undefined);
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    mockReconcileAgentRelationships.mockResolvedValue(undefined);
    mockDeleteAllAgentToolTuples.mockResolvedValue(undefined);
    mockCascadeDeleteAutonomousTasksForAgent.mockResolvedValue({ attempted: 0, deleted: 0 });
    mockWriteOpenFgaTuples.mockResolvedValue({
      enabled: true,
      writes: 1,
      deletes: 0,
    });
    mockIsPlatformDefaultAgent.mockResolvedValue(false);
    mockGetPlatformDefaultAgentId.mockResolvedValue(null);
    mockFilterAgentsByOwnershipScopeForSession.mockImplementation(
      async (_session, items) => items,
    );
    mockResolveUnlinkedServiceAccountSub.mockResolvedValue("sa-unlinked-999");
    mockResolveUnlinkedServiceAccountGrantState.mockResolvedValue({
      sub: "sa-unlinked-999",
      explicitAgentIds: new Set<string>(),
    });
    mockAuthenticateRequest.mockResolvedValue({
      subject: "alice-sub",
      email: "alice@example.com",
      role: "admin",
      bearerToken: "token",
    });
    mockGetDynamicAgentsConfig.mockReturnValue({
      dynamicAgentsUrl: "http://dynamic-agents:8000",
    });
    mockProxyRequest.mockResolvedValue(Response.json({ tools: [] }));
  });

  it("filters agent listings through can_discover by default", async () => {
    const agents = [
      {
        _id: "agent-visible",
        name: "Visible",
        model: { id: "m", provider: "p" },
      },
      {
        _id: "agent-hidden",
        name: "Hidden",
        model: { id: "m", provider: "p" },
      },
    ];
    mockFilterResourcesByPermission.mockResolvedValue([agents[0]]);
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue(agents),
      }),
    });
    const { GET } = await import("../route");

    const response = await GET(request("/api/dynamic-agents"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      session,
      agents,
      { type: "agent", action: "discover", id: expect.any(Function) },
    );
    expect(body).toMatchObject({
      success: true,
      data: {
        items: [{ _id: "agent-visible" }],
        total: 1,
        page: 1,
        page_size: 20,
      },
    });
  });

  it("filters enabled-only agent listings through can_use", async () => {
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        toArray: jest
          .fn()
          .mockResolvedValue([{ _id: "agent-runtime", enabled: true }]),
      }),
    });
    const { GET } = await import("../route");

    await GET(request("/api/dynamic-agents?enabled_only=true"));

    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      session,
      [{ _id: "agent-runtime", enabled: true }],
      { type: "agent", action: "use", id: expect.any(Function) },
    );
  });

  it("allows org-admin bypass for Dynamic Agent conversation audit listing", async () => {
    const conversationCollection = {
      countDocuments: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue([]),
      }),
    };
    mockGetCollection.mockResolvedValue(conversationCollection);
    const { GET } = await import("../conversations/route");

    const response = await GET(request("/api/dynamic-agents/conversations"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      session,
      { type: "audit_log", id: "dynamic_agent_conversations", action: "read" },
      { bypassForOrgAdmin: true },
    );
    expect(body).toMatchObject({
      success: true,
      data: { items: [], total: 0, page: 1, page_size: 20 },
    });
  });

  it("filters chat-available agents through OpenFGA can_use instead of legacy visibility", async () => {
    const agents = [
      {
        _id: "foo-bar",
        name: "Foo Bar",
        enabled: true,
        visibility: "team",
        shared_with_teams: ["team-a"],
      },
      {
        _id: "incident-agent",
        name: "Incident Agent",
        enabled: true,
        visibility: "global",
      },
    ];
    const scopedAgents = [agents[1]];
    mockFilterAgentsByOwnershipScopeForSession.mockResolvedValue(scopedAgents);
    mockFilterResourcesByPermission.mockResolvedValue([agents[1]]);
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue(agents),
      }),
    });
    const { GET } = await import("../available/route");

    const response = await GET(request("/api/dynamic-agents/available"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetUserTeamIds).not.toHaveBeenCalled();
    expect(mockGetCollection).toHaveBeenCalledWith("dynamic_agents");
    expect(mockFilterAgentsByOwnershipScopeForSession).toHaveBeenCalledWith(
      session,
      agents,
      null,
    );
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      session,
      scopedAgents,
      { type: "agent", action: "use", id: expect.any(Function) },
    );
    expect(body.data).toEqual([
      expect.objectContaining({ _id: "incident-agent" }),
    ]);
  });

  it("repairs the all-users default-agent OpenFGA grant before filtering chat-available agents", async () => {
    const agents = [
      { _id: "agent-default", name: "Default Agent", enabled: true },
    ];
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "platform_config") {
        return {
          findOne: jest
            .fn()
            .mockResolvedValue({ default_agent_id: "agent-default" }),
        };
      }
      if (name === "dynamic_agents") {
        return {
          find: jest.fn().mockReturnValue({
            sort: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue(agents),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    const { GET } = await import("../available/route");

    const response = await GET(request("/api/dynamic-agents/available"));

    expect(response.status).toBe(200);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [
        { user: "user:*", relation: "user", object: "agent:agent-default" },
      ],
      deletes: [],
    });
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      session,
      agents,
      { type: "agent", action: "use", id: expect.any(Function) },
    );
  });

  it("repairs baseline member OpenFGA tuples before requiring chat-available agent view access", async () => {
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "platform_config") {
        return {
          findOne: jest.fn().mockResolvedValue({ default_agent_id: null }),
        };
      }
      if (name === "dynamic_agents") {
        return {
          find: jest.fn().mockReturnValue({
            sort: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue([]),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    const { GET } = await import("../available/route");

    const response = await GET(request("/api/dynamic-agents/available"));

    expect(response.status).toBe(200);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: expect.arrayContaining([
        {
          user: "user:alice-sub",
          relation: "member",
          object: "organization:caipe",
        },
        {
          user: "user:alice-sub",
          relation: "reader",
          object: "admin_surface:users",
        },
      ]),
      deletes: [],
    });
    expect(mockRequireRbacPermission).not.toHaveBeenCalledWith(
      session,
      "dynamic_agent",
      "view",
    );
  });

  it("repairs all-users grants for enabled global agents before chat availability filtering", async () => {
    const agents = [
      {
        _id: "global-agent",
        name: "Global Agent",
        enabled: true,
        visibility: "global",
      },
      {
        _id: "team-agent",
        name: "Team Agent",
        enabled: true,
        visibility: "team",
      },
    ];
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "platform_config") {
        return {
          findOne: jest.fn().mockResolvedValue({ default_agent_id: null }),
        };
      }
      if (name === "dynamic_agents") {
        return {
          find: jest.fn().mockReturnValue({
            sort: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue(agents),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    const { GET } = await import("../available/route");

    const response = await GET(request("/api/dynamic-agents/available"));

    expect(response.status).toBe(200);
    // Global agents get the wildcard written; non-global, non-default
    // agents get any stale wildcard revoked (self-healing sweep for the
    // global → team demote leak — spec 2026-06-04).
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [
        { user: "user:*", relation: "user", object: "agent:global-agent" },
      ],
      deletes: [
        { user: "user:*", relation: "user", object: "agent:team-agent" },
      ],
    });
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      session,
      agents,
      { type: "agent", action: "use", id: expect.any(Function) },
    );
  });

  it("does NOT revoke the wildcard for a non-global agent that is the platform default", async () => {
    const agents = [
      {
        _id: "team-default",
        name: "Team Default",
        enabled: true,
        visibility: "team",
      },
      {
        _id: "team-other",
        name: "Team Other",
        enabled: true,
        visibility: "team",
      },
    ];
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "platform_config") {
        return {
          findOne: jest
            .fn()
            .mockResolvedValue({ default_agent_id: "team-default" }),
        };
      }
      if (name === "dynamic_agents") {
        return {
          find: jest.fn().mockReturnValue({
            sort: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue(agents),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    const { GET } = await import("../available/route");

    const response = await GET(request("/api/dynamic-agents/available"));

    expect(response.status).toBe(200);
    // The platform default keeps its wildcard (written by the default-grant
    // step) even though it is `team` visibility; only the *other* non-global
    // agent is swept.
    const sweepCall = mockWriteOpenFgaTuples.mock.calls.find(
      ([arg]) =>
        Array.isArray(arg?.deletes) &&
        arg.deletes.some(
          (t: { object?: string }) => t.object === "agent:team-other",
        ),
    );
    expect(sweepCall).toBeDefined();
    const deletedObjects = (
      sweepCall![0].deletes as Array<{ object: string }>
    ).map((t) => t.object);
    expect(deletedObjects).toContain("agent:team-other");
    expect(deletedObjects).not.toContain("agent:team-default");
  });

  it("filters agent editor LLM models through OpenFGA llm_model read checks", async () => {
    const models = [
      {
        _id: "openai/gpt-4o",
        model_id: "openai/gpt-4o",
        name: "GPT-4o",
        provider: "openai",
      },
      {
        _id: "hidden/model",
        model_id: "hidden/model",
        name: "Hidden",
        provider: "test",
      },
    ];
    mockFilterResourcesByPermission.mockResolvedValue([models[0]]);
    mockGetCollection.mockResolvedValue({
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue(models),
      }),
    });
    const { GET } = await import("../models/route");

    const response = await GET(request("/api/dynamic-agents/models"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireRbacPermission).not.toHaveBeenCalledWith(
      session,
      "dynamic_agent",
      "view",
    );
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      session,
      models,
      { type: "llm_model", action: "read", id: expect.any(Function) },
    );
    expect(body.data).toEqual([
      expect.objectContaining({ model_id: "openai/gpt-4o", name: "GPT-4o" }),
    ]);
  });

  it("filters configurable subagents through OpenFGA can_use after cycle checks", async () => {
    const agents = [
      { _id: "parent", name: "Parent", enabled: true },
      { _id: "allowed-child", name: "Allowed Child", enabled: true },
      { _id: "denied-child", name: "Denied Child", enabled: true },
      {
        _id: "ancestor",
        name: "Ancestor",
        enabled: true,
        subagents: [
          { agent_id: "parent", name: "parent", description: "parent" },
        ],
      },
    ];
    mockFilterResourcesByPermission.mockResolvedValue([agents[1]]);
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(agents[0]),
      find: jest.fn().mockReturnValue({
        toArray: jest.fn().mockResolvedValue(agents),
      }),
    });
    const { GET } = await import("../available-subagents/route");

    const response = await GET(
      request("/api/dynamic-agents/available-subagents?id=parent"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireAgentPermission).toHaveBeenCalledWith(
      session,
      "parent",
      "write",
    );
    expect(mockFilterResourcesByPermission).toHaveBeenCalledWith(
      session,
      [agents[1], agents[2]],
      { type: "agent", action: "use", id: expect.any(Function) },
    );
    expect(body.data.agents).toEqual([
      expect.objectContaining({ id: "allowed-child", name: "Allowed Child" }),
    ]);
  });

  it("requires owner team and writes agent relationship tuples before creating an agent", async () => {
    const insertOne = jest.fn();
    const dynamicAgents = {
      findOne: jest.fn().mockResolvedValue(null),
      insertOne,
    };
    const teams = {
      findOne: jest.fn().mockResolvedValue({
        _id: "team-id",
        slug: "platform",
        members: [{ user_id: "alice@example.com", role: "admin" }],
      }),
    };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "dynamic_agents") return dynamicAgents;
      if (name === "teams") return teams;
      throw new Error(`unexpected collection ${name}`);
    });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Operations Helper",
          system_prompt: "Help ops",
          model: { id: "gpt-4.1", provider: "openai" },
          allowed_tools: { rag: ["query"] },
          owner_team_slug: "platform",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-operations-helper",
        ownerSubject: "alice-sub",
        ownerTeamSlug: "platform",
        organizationId: "caipe",
      }),
    );
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        owner_team_slug: "platform",
        owner_team_id: "team-id",
        owner_subject: "alice-sub",
      }),
    );
  });

  it("creating a global agent resolves and grants the unlinked SA sub", async () => {
    const insertOne = jest.fn();
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      insertOne,
    });
    // `canManageOrganization` (route.ts) delegates to `requireResourcePermission`,
    // which resolves successfully by default in beforeEach — i.e. this session
    // is treated as a platform admin, allowed to create a global agent.
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Everyone Agent",
          system_prompt: "Help everyone",
          model: { id: "gpt-4.1", provider: "openai" },
          visibility: "global",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockResolveUnlinkedServiceAccountSub).toHaveBeenCalled();
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        globalUserAccess: true,
        unlinkedServiceAccountSub: "sa-unlinked-999",
      }),
    );
  });

  // Regression test for the May-27-2026 silent shared_with_teams bug.
  // Before this fix, the editor's "Share with Teams" multi-select
  // persisted to Mongo only — the canonical OpenFGA tuples
  // (`team:<slug>#member can_use agent:<id>`) were never written, so the
  // shared teams' members were denied in DM access checks and the
  // multi-select was effectively decorative. The route must now resolve
  // each shared entry to a canonical slug, drop the owner-team
  // duplicate, persist slugs in Mongo, and propagate the slug set to
  // the reconciler under `nextSharedTeamSlugs`.
  // assisted-by Cursor Claude:claude-opus-4-7
  it("resolves shared_with_teams entries to slugs and passes them to the reconciler on POST", async () => {
    const insertOne = jest.fn();
    const dynamicAgents = {
      findOne: jest.fn().mockResolvedValue(null),
      insertOne,
    };
    // The teams collection is consulted twice on POST:
    //  1) `loadOwnerTeam` calls findOne for the owner slug
    //  2) `resolveSharedTeamSlugs` calls find/project/toArray for
    //     shared_with_teams resolution
    const teams = {
      findOne: jest.fn().mockResolvedValue({
        _id: "platform-id",
        slug: "platform",
        members: [{ user_id: "alice@example.com", role: "admin" }],
      }),
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([
          { _id: "platform-id", slug: "platform" },
          { _id: "sre-id", slug: "sre" },
          { _id: "ops-id", slug: "ops" },
        ]),
      }),
    };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "dynamic_agents") return dynamicAgents;
      if (name === "teams") return teams;
      throw new Error(`unexpected collection ${name}`);
    });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Shared Agent",
          system_prompt: "Help",
          model: { id: "gpt-4.1", provider: "openai" },
          owner_team_slug: "platform",
          visibility: "team",
          // Mixed input: an _id (legacy editor shape), a canonical
          // slug (post-fix editor shape), the owner team duplicate
          // (must be dropped), and a bogus entry (must be ignored
          // with a warning, never silently granted).
          shared_with_teams: ["sre-id", "ops", "platform", "bogus"],
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-shared-agent",
        ownerTeamSlug: "platform",
        // Canonical slug set, owner stripped, bogus dropped.
        nextSharedTeamSlugs: ["sre", "ops"],
        previousSharedTeamSlugs: [],
      }),
    );
    // Mongo is persisted with the canonical slug form so the editor
    // round-trips correctly on the next load.
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        shared_with_teams: ["sre", "ops"],
      }),
    );
  });

  it("defaults a new RAG-enabled agent to Platform RAG when migration created it", async () => {
    const insertOne = jest.fn();
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "teams") {
        return {
          findOne: jest
            .fn()
            .mockResolvedValue({ _id: "primary-id", slug: "primary" }),
        };
      }
      if (name === "dynamic_agents") {
        return {
          findOne: jest.fn().mockResolvedValue(null),
          insertOne,
        };
      }
      if (name === "rag_collections") {
        return {
          findOne: jest.fn().mockResolvedValue({ _id: "platform-rag" }),
          find: jest.fn().mockReturnValue({
            project: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue([{ _id: "platform-rag" }]),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const { POST } = await import("../route");
    const response = await POST(
      request("/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Knowledge Helper",
          system_prompt: "Answer from trusted knowledge.",
          model: { id: "example-model", provider: "example-provider" },
          owner_team_slug: "primary",
          allowed_tools: { "knowledge-base": true },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        datasource_ids: [],
        rag_collection_ids: ["platform-rag"],
      }),
    );
  });

  it("starts with an explicit empty hand when Platform RAG exists but is not readable", async () => {
    const insertOne = jest.fn();
    mockFilterResourcesByPermission.mockResolvedValue([]);
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "teams") {
        return {
          findOne: jest
            .fn()
            .mockResolvedValue({ _id: "primary-id", slug: "primary" }),
        };
      }
      if (name === "dynamic_agents") {
        return {
          findOne: jest.fn().mockResolvedValue(null),
          insertOne,
        };
      }
      if (name === "rag_collections") {
        return {
          findOne: jest.fn().mockResolvedValue({ _id: "platform-rag" }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const { POST } = await import("../route");
    const response = await POST(
      request("/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Private Knowledge Helper",
          system_prompt: "Use only explicitly assigned knowledge.",
          model: { id: "example-model", provider: "example-provider" },
          owner_team_slug: "primary",
          allowed_tools: { "knowledge-base": true },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ datasource_ids: [], rag_collection_ids: [] }),
    );
  });

  it("preserves an explicit empty RAG hand for a new agent", async () => {
    const insertOne = jest.fn();
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "teams") {
        return {
          findOne: jest
            .fn()
            .mockResolvedValue({ _id: "primary-id", slug: "primary" }),
        };
      }
      if (name === "dynamic_agents") {
        return {
          findOne: jest.fn().mockResolvedValue(null),
          insertOne,
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const { POST } = await import("../route");
    const response = await POST(
      request("/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Scoped Knowledge Helper",
          system_prompt: "Use only selected knowledge.",
          model: { id: "example-model", provider: "example-provider" },
          owner_team_slug: "primary",
          allowed_tools: { "knowledge-base": true },
          datasource_ids: [],
          rag_collection_ids: [],
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ datasource_ids: [], rag_collection_ids: [] }),
    );
    expect(mockGetCollection).not.toHaveBeenCalledWith("rag_collections");
  });

  it("stores both knowledge selections as arrays when one is provided", async () => {
    const insertOne = jest.fn();
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "teams") {
        return {
          findOne: jest
            .fn()
            .mockResolvedValue({ _id: "primary-id", slug: "primary" }),
        };
      }
      if (name === "dynamic_agents") {
        return {
          findOne: jest.fn().mockResolvedValue(null),
          insertOne,
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const { POST } = await import("../route");
    const response = await POST(
      request("/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Empty Knowledge Helper",
          system_prompt: "Use only selected knowledge.",
          model: { id: "example-model", provider: "example-provider" },
          owner_team_slug: "primary",
          allowed_tools: { "knowledge-base": true },
          datasource_ids: [],
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ datasource_ids: [], rag_collection_ids: [] }),
    );
  });

  it.each(["datasource_ids", "rag_collection_ids"])(
    "rejects null %s instead of creating a legacy-unrestricted agent",
    async (field) => {
      const insertOne = jest.fn();
      mockGetCollection.mockImplementation(async (name: string) => {
        if (name === "teams") {
          return {
            findOne: jest
              .fn()
              .mockResolvedValue({ _id: "primary-id", slug: "primary" }),
          };
        }
        if (name === "dynamic_agents") {
          return {
            findOne: jest.fn().mockResolvedValue(null),
            insertOne,
          };
        }
        throw new Error(`unexpected collection ${name}`);
      });

      const { POST } = await import("../route");
      const response = await POST(
        request("/api/dynamic-agents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `Null ${field}`,
            system_prompt: "Use trusted knowledge.",
            model: { id: "example-model", provider: "example-provider" },
            owner_team_slug: "primary",
            allowed_tools: { "knowledge-base": true },
            [field]: null,
          }),
        }),
      );

      expect(response.status).toBe(400);
      expect(insertOne).not.toHaveBeenCalled();
    },
  );

  it("pins an existing unscoped agent when RAG is enabled after Platform migration", async () => {
    const existingAgent = {
      _id: "agent-existing",
      name: "Existing agent",
      owner_team_slug: "primary",
      owner_subject: "alice-sub",
      shared_with_teams: [],
      allowed_tools: { jira: true },
      visibility: "team",
    };
    const findOneAndUpdate = jest.fn().mockResolvedValue({
      ...existingAgent,
      allowed_tools: { "knowledge-base": true },
      datasource_ids: [],
      rag_collection_ids: ["platform-rag"],
    });
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "dynamic_agents") {
        return {
          findOne: jest.fn().mockResolvedValue(existingAgent),
          findOneAndUpdate,
        };
      }
      if (name === "teams") {
        return {
          find: jest.fn().mockReturnValue({
            project: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue([]),
          }),
        };
      }
      if (name === "rag_collections") {
        return {
          findOne: jest.fn().mockResolvedValue({ _id: "platform-rag" }),
          find: jest.fn().mockReturnValue({
            project: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue([{ _id: "platform-rag" }]),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const { PUT } = await import("../route");
    const response = await PUT(
      request("/api/dynamic-agents?id=agent-existing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowed_tools: { "knowledge-base": true } }),
      }),
    );

    expect(response.status).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "agent-existing" },
      expect.objectContaining({
        $set: expect.objectContaining({
          datasource_ids: [],
          rag_collection_ids: ["platform-rag"],
        }),
      }),
      expect.any(Object),
    );
  });

  it("clears a datasource when its stored collection selection is null", async () => {
    const existingAgent = {
      _id: "agent-existing",
      name: "Existing agent",
      owner_team_slug: "primary",
      owner_subject: "alice-sub",
      shared_with_teams: [],
      allowed_tools: { "knowledge-base": true },
      visibility: "team",
      datasource_ids: ["source-a"],
      rag_collection_ids: null,
    };
    const findOneAndUpdate = jest.fn().mockResolvedValue({
      ...existingAgent,
      datasource_ids: [],
      rag_collection_ids: [],
    });
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "dynamic_agents") {
        return {
          findOne: jest.fn().mockResolvedValue(existingAgent),
          findOneAndUpdate,
        };
      }
      if (name === "teams") {
        return {
          find: jest.fn().mockReturnValue({
            project: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue([]),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const { PUT } = await import("../route");
    const response = await PUT(
      request("/api/dynamic-agents?id=agent-existing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasource_ids: [] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "agent-existing" },
      expect.objectContaining({
        $set: expect.objectContaining({
          datasource_ids: [],
          rag_collection_ids: [],
        }),
      }),
      expect.any(Object),
    );
  });

  it("emits previousSharedTeamSlugs so removing a team from the editor revokes its OpenFGA grant", async () => {
    // PUT path: existing agent had ["sre", "ops"] shared. Admin
    // unchecks "ops" in the editor and saves. The reconciler must
    // receive both the new ["sre"] set AND the previous ["sre", "ops"]
    // set so the diff produces a delete tuple for `team:ops#...`.
    // Without `previousSharedTeamSlugs`, the unchecked team would keep
    // its grant forever — which is the old (buggy) silent-Mongo
    // behaviour we are fixing.
    // assisted-by Cursor Claude:claude-opus-4-7
    const existingAgent = {
      _id: "agent-shared-agent",
      name: "Shared Agent",
      owner_team_slug: "platform",
      owner_subject: "alice-sub",
      shared_with_teams: ["sre", "ops"],
      allowed_tools: {},
      visibility: "team",
    };
    const findOneAndUpdate = jest.fn().mockResolvedValue({
      ...existingAgent,
      shared_with_teams: ["sre"],
    });
    const dynamicAgents = {
      findOne: jest.fn().mockResolvedValue(existingAgent),
      findOneAndUpdate,
    };
    const teams = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([
          { _id: "sre-id", slug: "sre" },
          { _id: "ops-id", slug: "ops" },
        ]),
      }),
    };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "dynamic_agents") return dynamicAgents;
      if (name === "teams") return teams;
      throw new Error(`unexpected collection ${name}`);
    });
    // Platform-default guard short-circuit (this agent isn't default).
    mockIsPlatformDefaultAgent.mockResolvedValue(false);

    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/dynamic-agents?id=agent-shared-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shared_with_teams: ["sre"] }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-shared-agent",
        ownerTeamSlug: "platform",
        nextSharedTeamSlugs: ["sre"],
        previousSharedTeamSlugs: ["sre", "ops"],
      }),
    );
    // The persisted shared_with_teams should be canonical slugs only.
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "agent-shared-agent" },
      expect.objectContaining({
        $set: expect.objectContaining({ shared_with_teams: ["sre"] }),
      }),
      expect.any(Object),
    );
  });

  it("transfers ownership to a new team, revoking the old owner's grants (US3)", async () => {
    // The editor sends owner_team_slug=data-eng (≠ stored platform) +
    // confirm_not_member. The route guards via canTransferResourceOwnership,
    // then reconciles with previousOwnerTeamSlug so the old owner is revoked.
    const existingAgent = {
      _id: "agent-xfer",
      name: "Xfer Agent",
      owner_team_slug: "platform",
      owner_subject: "alice-sub",
      shared_with_teams: [],
      allowed_tools: {},
      visibility: "team",
    };
    const dynamicAgents = {
      findOne: jest.fn().mockResolvedValue(existingAgent),
      findOneAndUpdate: jest
        .fn()
        .mockResolvedValue({ ...existingAgent, owner_team_slug: "data-eng" }),
    };
    const teams = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([]),
      }),
      findOne: jest
        .fn()
        .mockResolvedValue({ _id: "data-eng-id", slug: "data-eng" }),
    };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "dynamic_agents") return dynamicAgents;
      if (name === "teams") return teams;
      throw new Error(`unexpected collection ${name}`);
    });
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    // Caller IS a member of the destination → no confirm needed.
    mockRequireResourcePermission.mockResolvedValue(undefined);

    const { PUT } = await import("../route");
    const response = await PUT(
      request("/api/dynamic-agents?id=agent-xfer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner_team_slug: "data-eng" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockCanTransferResourceOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      { type: "agent", id: "agent-xfer" },
    );
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-xfer",
        ownerTeamSlug: "data-eng",
        previousOwnerTeamSlug: "platform",
      }),
    );
  });

  it("treats destination team admins as members during ownership transfer", async () => {
    // Some upgraded installs have team-admin manage tuples without a matching
    // can_use projection. The transfer prompt must not block those users as
    // "not a member" when they can manage the destination team.
    // assisted-by Codex Codex-sonnet-4-6
    const existingAgent = {
      _id: "agent-xfer",
      name: "Xfer Agent",
      owner_team_slug: "platform",
      owner_subject: "alice-sub",
      shared_with_teams: [],
      allowed_tools: {},
      visibility: "team",
    };
    const dynamicAgents = {
      findOne: jest.fn().mockResolvedValue(existingAgent),
      findOneAndUpdate: jest
        .fn()
        .mockResolvedValue({ ...existingAgent, owner_team_slug: "data-eng" }),
    };
    const teams = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([]),
      }),
      findOne: jest
        .fn()
        .mockResolvedValue({ _id: "data-eng-id", slug: "data-eng" }),
    };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "dynamic_agents") return dynamicAgents;
      if (name === "teams") return teams;
      throw new Error(`unexpected collection ${name}`);
    });
    mockCanTransferResourceOwnership.mockResolvedValue(true);
    mockRequireResourcePermission.mockImplementation(
      async (_session, resource: { type?: string; action?: string }) => {
        if (resource.type === "team" && resource.action === "use") {
          throw Object.assign(new Error("not team member"), {
            statusCode: 403,
          });
        }
        return undefined;
      },
    );

    const { PUT } = await import("../route");
    const response = await PUT(
      request("/api/dynamic-agents?id=agent-xfer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner_team_slug: "data-eng" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(session, {
      type: "team",
      id: "data-eng",
      action: "manage",
    });
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-xfer",
        ownerTeamSlug: "data-eng",
        previousOwnerTeamSlug: "platform",
      }),
    );
  });

  it("denies an ownership transfer when the caller can neither manage nor admin (US3)", async () => {
    const existingAgent = {
      _id: "agent-xfer",
      name: "Xfer Agent",
      owner_team_slug: "platform",
      owner_subject: "alice-sub",
      shared_with_teams: [],
      allowed_tools: {},
      visibility: "team",
    };
    const dynamicAgents = {
      findOne: jest.fn().mockResolvedValue(existingAgent),
      findOneAndUpdate: jest.fn(),
    };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "dynamic_agents") return dynamicAgents;
      if (name === "teams")
        return {
          find: jest.fn().mockReturnValue({
            project: jest.fn().mockReturnThis(),
            toArray: jest.fn().mockResolvedValue([]),
          }),
          findOne: jest.fn(),
        };
      throw new Error(`unexpected collection ${name}`);
    });
    // requireResourcePermission (agent#write) passes, but the transfer guard denies.
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockCanTransferResourceOwnership.mockResolvedValue(false);

    const { PUT } = await import("../route");
    const response = await PUT(
      request("/api/dynamic-agents?id=agent-xfer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner_team_slug: "data-eng" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(dynamicAgents.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockReconcileAgentRelationships).not.toHaveBeenCalled();
  });

  it("leaves shared_with_teams alone on PUT updates that don't include the field", async () => {
    // Metadata-only edits (rename, prompt tweak, etc.) must NOT
    // silently clear shared teams: the absence of `shared_with_teams`
    // in the patch means "no change" — the previous slug set is passed
    // as both `next` and `previous`, producing zero diff in the
    // reconciler (idempotent).
    // assisted-by Cursor Claude:claude-opus-4-7
    const existingAgent = {
      _id: "agent-shared-agent",
      name: "Shared Agent",
      owner_team_slug: "platform",
      owner_subject: "alice-sub",
      shared_with_teams: ["sre"],
      allowed_tools: {},
      visibility: "team",
    };
    const findOneAndUpdate = jest
      .fn()
      .mockResolvedValue({ ...existingAgent, name: "Renamed Agent" });
    const dynamicAgents = {
      findOne: jest.fn().mockResolvedValue(existingAgent),
      findOneAndUpdate,
    };
    const teams = {
      find: jest.fn().mockReturnValue({
        project: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([{ _id: "sre-id", slug: "sre" }]),
      }),
    };
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "dynamic_agents") return dynamicAgents;
      if (name === "teams") return teams;
      throw new Error(`unexpected collection ${name}`);
    });
    mockIsPlatformDefaultAgent.mockResolvedValue(false);

    const { PUT } = await import("../route");
    const response = await PUT(
      request("/api/dynamic-agents?id=agent-shared-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed Agent" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        nextSharedTeamSlugs: ["sre"],
        previousSharedTeamSlugs: ["sre"],
      }),
    );
    // The update document must not touch shared_with_teams since the
    // patch didn't include it — only `name` and `updated_at`.
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: "agent-shared-agent" },
      expect.objectContaining({
        $set: expect.not.objectContaining({
          shared_with_teams: expect.anything(),
        }),
      }),
      expect.any(Object),
    );
  });

  it("rejects creation when 'private' visibility is sent without an owner team (private retired)", async () => {
    // Post-2026-05-22 'private' visibility was retired: the API coerces the
    // legacy value to 'team', which then requires an explicit owner team.
    const insertOne = jest.fn();
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "dynamic_agents") {
        return {
          findOne: jest.fn().mockResolvedValue(null),
          insertOne,
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Operations Helper",
          system_prompt: "Help ops",
          model: { id: "gpt-4.1", provider: "openai" },
          visibility: "private",
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "OWNER_TEAM_REQUIRED",
    });
    expect(mockReconcileAgentRelationships).not.toHaveBeenCalled();
    expect(insertOne).not.toHaveBeenCalled();
  });

  it("returns 404 when the requested owner team does not exist", async () => {
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "teams")
        return { findOne: jest.fn().mockResolvedValue(null) };
      if (name === "dynamic_agents")
        return {
          findOne: jest.fn().mockResolvedValue(null),
          insertOne: jest.fn(),
        };
      throw new Error(`unexpected collection ${name}`);
    });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Operations Helper",
          system_prompt: "Help ops",
          model: { id: "gpt-4.1", provider: "openai" },
          owner_team_slug: "missing",
        }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: "OWNER_TEAM_NOT_FOUND",
    });
    expect(mockReconcileAgentRelationships).not.toHaveBeenCalled();
  });

  it("allows a scoped owner-team member to create an agent for that team", async () => {
    const insertOne = jest.fn();
    mockRequireResourcePermission.mockImplementation(
      async (_session, resource: { type?: string }) => {
        if (resource.type === "organization")
          throw new Error("not platform admin");
      },
    );
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "teams") {
        return {
          findOne: jest.fn().mockResolvedValue({
            _id: "team-id",
            slug: "platform",
            members: [{ user_id: "alice@example.com", role: "member" }],
          }),
        };
      }
      if (name === "dynamic_agents")
        return { findOne: jest.fn().mockResolvedValue(null), insertOne };
      throw new Error(`unexpected collection ${name}`);
    });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Operations Helper",
          system_prompt: "Help ops",
          model: { id: "gpt-4.1", provider: "openai" },
          owner_team_slug: "platform",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(session, {
      type: "team",
      id: "platform",
      action: "use",
    });
    expect(insertOne).toHaveBeenCalled();
  });

  it("requires a stable subject before writing dynamic agent owner tuples", async () => {
    mockGetAuthFromBearerOrSession.mockResolvedValue({
      user,
      session: { ...session, sub: "" },
    });
    const insertOne = jest.fn();
    mockRequireResourcePermission.mockImplementation(
      async (_session, resource: { type?: string }) => {
        if (resource.type === "organization")
          throw new Error("not platform admin");
      },
    );
    mockGetCollection.mockImplementation(async (name: string) => {
      // Provide a valid owner team so we reach the subject check rather than
      // bailing out earlier on OWNER_TEAM_REQUIRED. Private visibility was
      // retired 2026-05-22; every agent now requires a team.
      if (name === "teams") {
        return {
          findOne: jest.fn().mockResolvedValue({
            _id: "team-id",
            slug: "platform",
            members: [{ user_id: "alice@example.com", role: "member" }],
          }),
        };
      }
      if (name === "dynamic_agents")
        return { findOne: jest.fn().mockResolvedValue(null), insertOne };
      throw new Error(`unexpected collection ${name}`);
    });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Operations Helper",
          system_prompt: "Help ops",
          model: { id: "gpt-4.1", provider: "openai" },
          owner_team_slug: "platform",
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(mockReconcileAgentRelationships).not.toHaveBeenCalled();
    expect(insertOne).not.toHaveBeenCalled();
  });

  it("returns 403 when a non-admin selects an owner team they do not belong to", async () => {
    const insertOne = jest.fn();
    mockRequireResourcePermission.mockImplementation(
      async (_session, resource: { type?: string }) => {
        if (resource.type === "organization")
          throw new Error("not platform admin");
        if (resource.type === "team")
          throw Object.assign(new Error("not team member"), {
            statusCode: 403,
          });
      },
    );
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "teams") {
        return {
          findOne: jest.fn().mockResolvedValue({
            _id: "team-id",
            slug: "platform",
            members: [{ user_id: "bob@example.com", role: "member" }],
          }),
        };
      }
      if (name === "dynamic_agents")
        return { findOne: jest.fn().mockResolvedValue(null), insertOne };
      throw new Error(`unexpected collection ${name}`);
    });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Operations Helper",
          system_prompt: "Help ops",
          model: { id: "gpt-4.1", provider: "openai" },
          owner_team_slug: "platform",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "OWNER_TEAM_FORBIDDEN",
    });
    expect(insertOne).not.toHaveBeenCalled();
    expect(mockReconcileAgentRelationships).not.toHaveBeenCalled();
  });

  it("does not fall back to Mongo membership when OpenFGA denies owner-team use", async () => {
    const insertOne = jest.fn();
    mockRequireResourcePermission.mockImplementation(
      async (_session, resource: { type?: string }) => {
        if (resource.type === "organization")
          throw new Error("not platform admin");
        if (resource.type === "team")
          throw Object.assign(new Error("not team member"), {
            statusCode: 403,
          });
      },
    );
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "teams") {
        return {
          findOne: jest.fn().mockResolvedValue({
            _id: "team-id",
            slug: "platform",
            members: [{ user_id: "alice@example.com", role: "member" }],
          }),
        };
      }
      if (name === "dynamic_agents")
        return { findOne: jest.fn().mockResolvedValue(null), insertOne };
      throw new Error(`unexpected collection ${name}`);
    });
    const { POST } = await import("../route");

    const response = await POST(
      request("/api/dynamic-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Operations Helper",
          system_prompt: "Help ops",
          model: { id: "gpt-4.1", provider: "openai" },
          owner_team_slug: "platform",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "OWNER_TEAM_FORBIDDEN",
    });
    expect(insertOne).not.toHaveBeenCalled();
    expect(mockReconcileAgentRelationships).not.toHaveBeenCalled();
  });

  it("requires agent write access before updating an agent document", async () => {
    const findOneAndUpdate = jest
      .fn()
      .mockResolvedValue({ _id: "agent-1", name: "Renamed" });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "agent-1",
        name: "Original",
        allowed_tools: {},
      }),
      findOneAndUpdate,
    });
    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/dynamic-agents?id=agent-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockRequireAgentPermission).toHaveBeenCalledWith(
      session,
      "agent-1",
      "write",
    );
    expect(findOneAndUpdate).toHaveBeenCalled();
  });

  it("denies owner-team members without agent write permission", async () => {
    const authzError = Object.assign(new Error("missing agent write"), {
      statusCode: 403,
      code: "agent#write",
    });
    mockRequireAgentPermission.mockRejectedValue(authzError);

    const existingAgent = {
      _id: "agent-1",
      name: "Original",
      owner_team_slug: "platform",
      shared_with_teams: [],
      allowed_tools: {},
      visibility: "team",
    };
    const findOneAndUpdate = jest.fn();
    mockGetCollection.mockImplementation(async (name: string) => {
      if (name === "dynamic_agents") {
        return {
          findOne: jest.fn().mockResolvedValue(existingAgent),
          findOneAndUpdate,
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });

    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/dynamic-agents?id=agent-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      }),
    );

    expect(response.status).toBe(403);
    expect(mockRequireAgentPermission).toHaveBeenCalledWith(
      session,
      "agent-1",
      "write",
    );
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockReconcileAgentRelationships).not.toHaveBeenCalled();
  });

  it("requires agent delete access before deleting an agent document", async () => {
    const deleteOne = jest.fn();
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "agent-1",
        is_system: false,
        config_driven: false,
      }),
      deleteOne,
    });
    const { DELETE } = await import("../route");

    const response = await DELETE(
      request("/api/dynamic-agents?id=agent-1", { method: "DELETE" }),
    );

    expect(response.status).toBe(200);
    expect(mockRequireAgentPermission).toHaveBeenCalledWith(
      session,
      "agent-1",
      "delete",
    );
    // Autonomous-task cleanup must run, and must run before the agent doc /
    // OpenFGA tuples are removed, so a cascade failure (next test) can
    // safely abort with everything still intact.
    expect(mockCascadeDeleteAutonomousTasksForAgent).toHaveBeenCalledWith("agent-1");
    expect(mockDeleteAllAgentToolTuples).toHaveBeenCalledWith("agent-1");
    expect(deleteOne).toHaveBeenCalledWith({ _id: "agent-1" });
    const cascadeOrder = mockCascadeDeleteAutonomousTasksForAgent.mock.invocationCallOrder[0];
    const tupleDeleteOrder = mockDeleteAllAgentToolTuples.mock.invocationCallOrder[0];
    const docDeleteOrder = deleteOne.mock.invocationCallOrder[0];
    expect(cascadeOrder).toBeLessThan(tupleDeleteOrder);
    expect(cascadeOrder).toBeLessThan(docDeleteOrder);
  });

  it("aborts agent deletion when autonomous-task cascade cleanup fails", async () => {
    const deleteOne = jest.fn();
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ _id: "agent-1", is_system: false, config_driven: false }),
      deleteOne,
    });
    mockCascadeDeleteAutonomousTasksForAgent.mockRejectedValue(new Error("upstream down"));
    const { DELETE } = await import("../route");

    const response = await DELETE(request("/api/dynamic-agents?id=agent-1", { method: "DELETE" }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "AUTONOMOUS_TASK_CASCADE_FAILED",
    });
    expect(mockDeleteAllAgentToolTuples).not.toHaveBeenCalled();
    expect(deleteOne).not.toHaveBeenCalled();
  });

  // Platform-default agent invariant: an admin can pick an agent in
  // Settings → Platform settings → Defaults to be the "default for new chats", which writes a
  // wildcard `user:* user agent:<id>` tuple so every signed-in user can
  // chat with it. We must not let the same admin demote `visibility:
  // global → team` from the per-agent edit page or delete the agent
  // outright while that wildcard is still in place — both would silently
  // strip new-user access. The PUT/DELETE handlers therefore reject
  // those mutations with 409 / `AGENT_IS_PLATFORM_DEFAULT` and steer the
  // admin back to Settings → Platform settings → Defaults to change the platform default
  // first.
  it("blocks demoting the current platform default from global to team", async () => {
    const findOneAndUpdate = jest.fn();
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "agent-default",
        name: "Default",
        visibility: "global",
        allowed_tools: {},
      }),
      findOneAndUpdate,
    });
    mockIsPlatformDefaultAgent.mockResolvedValue(true);
    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/dynamic-agents?id=agent-default", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "team" }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "AGENT_IS_PLATFORM_DEFAULT",
    });
    expect(mockIsPlatformDefaultAgent).toHaveBeenCalledWith("agent-default");
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockReconcileAgentRelationships).not.toHaveBeenCalled();
  });

  it("allows demoting an agent that is not the platform default and revokes the user:* wildcard", async () => {
    const findOneAndUpdate = jest
      .fn()
      .mockResolvedValue({ _id: "agent-1", visibility: "team" });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "agent-1",
        name: "Other",
        visibility: "global",
        // Already owned by team-a so the demote is a pure visibility change
        // (no ownership transfer / first-set), isolating the wildcard-revoke
        // behaviour under test from the post-#1726 transfer guard.
        owner_team_slug: "team-a",
        allowed_tools: {},
      }),
      findOneAndUpdate,
    });
    mockIsPlatformDefaultAgent.mockResolvedValue(false);
    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/dynamic-agents?id=agent-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "team" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(findOneAndUpdate).toHaveBeenCalled();
    // Regression (2026-06-04): a global → team demote MUST revoke the
    // everyone-can-use wildcard, otherwise non-owner-team members keep
    // `can_use` (the SRE-agent leak). The reconciler is told the agent
    // WAS global and is NOT anymore.
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        globalUserAccess: false,
        previousGlobalUserAccess: true,
        // D4S-5378: the demote (delete) path needs the unlinked SA sub too,
        // so its grant is revoked in lockstep with user:*.
        unlinkedServiceAccountSub: "sa-unlinked-999",
      }),
    );
  });

  it("promoting team → global writes the user:* wildcard", async () => {
    const findOneAndUpdate = jest
      .fn()
      .mockResolvedValue({ _id: "agent-2", visibility: "global" });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "agent-2",
        name: "Promote Me",
        visibility: "team",
        owner_team_slug: "team-a",
        allowed_tools: {},
      }),
      findOneAndUpdate,
    });
    mockIsPlatformDefaultAgent.mockResolvedValue(false);
    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/dynamic-agents?id=agent-2", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "global" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-2",
        globalUserAccess: true,
        previousGlobalUserAccess: false,
        // D4S-5378: promoting to global also grants the unlinked SA so
        // Slack/Webex bot callers are treated as "everyone" immediately.
        unlinkedServiceAccountSub: "sa-unlinked-999",
      }),
    );
  });

  it("promoting team → global passes a null unlinked SA sub when it isn't bootstrapped yet", async () => {
    mockResolveUnlinkedServiceAccountGrantState.mockResolvedValue({
      sub: null,
      explicitAgentIds: new Set<string>(),
    });
    const findOneAndUpdate = jest
      .fn()
      .mockResolvedValue({ _id: "agent-2", visibility: "global" });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "agent-2",
        name: "Promote Me",
        visibility: "team",
        owner_team_slug: "team-a",
        allowed_tools: {},
      }),
      findOneAndUpdate,
    });
    mockIsPlatformDefaultAgent.mockResolvedValue(false);
    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/dynamic-agents?id=agent-2", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility: "global" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-2",
        globalUserAccess: true,
        unlinkedServiceAccountSub: null,
      }),
    );
  });

  it("does not resolve the unlinked SA sub when visibility stays team-scoped", async () => {
    const findOneAndUpdate = jest
      .fn()
      .mockResolvedValue({ _id: "agent-3", visibility: "team" });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "agent-3",
        name: "Team Agent",
        visibility: "team",
        owner_team_slug: "team-a",
        allowed_tools: {},
      }),
      findOneAndUpdate,
    });
    mockIsPlatformDefaultAgent.mockResolvedValue(false);
    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/dynamic-agents?id=agent-3", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Team Agent Renamed" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockResolveUnlinkedServiceAccountSub).not.toHaveBeenCalled();
    expect(mockReconcileAgentRelationships).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-3",
        unlinkedServiceAccountSub: null,
      }),
    );
  });

  it("does not invoke the platform-default guard when visibility is unchanged", async () => {
    const findOneAndUpdate = jest
      .fn()
      .mockResolvedValue({ _id: "agent-default", name: "Renamed" });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "agent-default",
        name: "Default",
        visibility: "global",
        allowed_tools: {},
      }),
      findOneAndUpdate,
    });
    // Even if the agent IS the platform default, an unrelated edit
    // (renaming, system prompt change) must go through — we only block
    // the demote path.
    mockIsPlatformDefaultAgent.mockResolvedValue(true);
    const { PUT } = await import("../route");

    const response = await PUT(
      request("/api/dynamic-agents?id=agent-default", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Renamed" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockIsPlatformDefaultAgent).not.toHaveBeenCalled();
    expect(findOneAndUpdate).toHaveBeenCalled();
  });

  it("blocks deleting the current platform default agent", async () => {
    const deleteOne = jest.fn();
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "agent-default",
        is_system: false,
        config_driven: false,
      }),
      deleteOne,
    });
    mockIsPlatformDefaultAgent.mockResolvedValue(true);
    const { DELETE } = await import("../route");

    const response = await DELETE(
      request("/api/dynamic-agents?id=agent-default", { method: "DELETE" }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "AGENT_IS_PLATFORM_DEFAULT",
    });
    expect(mockIsPlatformDefaultAgent).toHaveBeenCalledWith("agent-default");
    expect(mockCascadeDeleteAutonomousTasksForAgent).not.toHaveBeenCalled();
    expect(mockDeleteAllAgentToolTuples).not.toHaveBeenCalled();
    expect(deleteOne).not.toHaveBeenCalled();
  });

  // Built-in tool metadata is the same kind of static, system-wide
  // catalog as the AI Assist task list: every signed-in user who can
  // open the Create Agent wizard needs to render the picker, regardless
  // of organization role or per-tool grants. Gating it on a
  // `tool:dynamic-agents-builtin#can_discover` tuple that nothing ever
  // seeds is what produced "Failed to load tools: Failed to fetch: 403"
  // for admins on the agent builder screen. Pin the new contract here:
  // authenticate the caller, do NOT call OpenFGA, and proxy through.
  it("proxies built-in tool metadata for any authenticated caller without an OpenFGA gate", async () => {
    const { GET } = await import("../builtin-tools/route");

    const response = await GET(request("/api/dynamic-agents/builtin-tools"));

    expect(response.status).toBe(200);
    // Authentication still required — the route must not silently allow
    // anonymous traffic to enumerate the supported built-in tools list.
    expect(mockAuthenticateRequest).toHaveBeenCalledTimes(1);
    // No per-tool OpenFGA check for the built-in catalog. The route only
    // hands off to DA with the caller's bearer token.
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
    expect(mockProxyRequest).toHaveBeenCalledWith(
      "http://dynamic-agents:8000/api/v1/builtin-tools",
      "GET",
      expect.objectContaining({ subject: "alice-sub" }),
      "[builtin-tools]",
    );
  });

  it("rejects unauthenticated callers on built-in tool metadata", async () => {
    // Real-world denial path from `authenticateRequest`: returns a
    // NextResponse (not a plain Response). The route uses `instanceof`
    // to short-circuit, so the mock must match the real type.
    const { NextResponse } = await import("next/server");
    mockAuthenticateRequest.mockResolvedValueOnce(
      NextResponse.json(
        { success: false, error: "not signed in", code: "NOT_SIGNED_IN" },
        { status: 401 },
      ),
    );
    const { GET } = await import("../builtin-tools/route");

    const response = await GET(request("/api/dynamic-agents/builtin-tools"));

    expect(response.status).toBe(401);
    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
    expect(mockProxyRequest).not.toHaveBeenCalled();
  });
});
