/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetCollection = jest.fn();
const mockGetUserTeamIds = jest.fn();
const mockRequireWorkflowAccess = jest.fn();
const mockWorkflowAccessAllowed = jest.fn();
const mockFilterAccessibleWorkflowConfigs = jest.fn();
const mockRequireWorkflowRunAccess = jest.fn();
const mockRequireWorkflowConfigRunAccess = jest.fn();
const mockRequireWorkflowConfigRunViewAccess = jest.fn();
const mockResolveUserTeamSlugsForWorkflow = jest.fn();
const mockBuildTeamRefToSlugMap = jest.fn();
const mockFilterWorkflowConfigsByRunAccess = jest.fn();
const mockMergeWorkflowConfigsById = jest.fn();
const mockStartWorkflowRun = jest.fn();
const mockGetAuth = jest.fn();
const mockAuthUser = { email: "alice@example.com", role: "user", name: "Alice" };
const mockAuthSession: Record<string, unknown> = { sub: "alice-sub", role: "user" };

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
  isMongoDBConfigured: true,
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
    getAuthFromBearerOrSession: (...args: unknown[]) => mockGetAuth(...args),
    getUserTeamIds: (...args: unknown[]) => mockGetUserTeamIds(...args),
    successResponse: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
    withAuth: async (_request: NextRequest, handler: (...args: unknown[]) => Promise<Response>) =>
      handler(_request, mockAuthUser, mockAuthSession),
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

jest.mock("@/lib/server/workflow-cas-authz", () => ({
  filterAccessibleWorkflowConfigs: (...args: unknown[]) => mockFilterAccessibleWorkflowConfigs(...args),
  requireWorkflowAccess: (...args: unknown[]) => mockRequireWorkflowAccess(...args),
  requireWorkflowRunAccess: (...args: unknown[]) => mockRequireWorkflowRunAccess(...args),
  workflowAccessAllowed: (...args: unknown[]) => mockWorkflowAccessAllowed(...args),
  workflowSubjectFromSession: (session: { sub?: string; isServiceAccount?: boolean }) =>
    session.sub ? { type: session.isServiceAccount === true ? "service_account" : "user", id: session.sub } : null,
}));

jest.mock("@/lib/server/workflow-engine", () => ({
  detectStaleRun: jest.fn().mockResolvedValue(false),
  startWorkflowRun: (...args: unknown[]) => mockStartWorkflowRun(...args),
}));

jest.mock("@/lib/rbac/workflow-config-rebac", () => ({
  buildTeamRefToSlugMap: (...args: unknown[]) => mockBuildTeamRefToSlugMap(...args),
  filterWorkflowConfigsByRunAccess: (...args: unknown[]) => mockFilterWorkflowConfigsByRunAccess(...args),
  mergeWorkflowConfigsById: (...args: unknown[]) => mockMergeWorkflowConfigsById(...args),
  requireWorkflowConfigRunAccess: (...args: unknown[]) => mockRequireWorkflowConfigRunAccess(...args),
  requireWorkflowConfigRunViewAccess: (...args: unknown[]) => mockRequireWorkflowConfigRunViewAccess(...args),
  resolveUserTeamSlugsForWorkflow: (...args: unknown[]) => mockResolveUserTeamSlugsForWorkflow(...args),
}));

jest.mock("@/lib/server/event-store", () => ({
  deleteEventsByRun: jest.fn(),
  readEventsByRun: jest.fn().mockResolvedValue(new Map()),
}));

function request(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

function cursor(items: unknown[]) {
  const limit = jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(items) });
  const sort = jest.fn().mockReturnValue({ limit });
  const project = jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue(items) });
  return { sort, limit, project, toArray: jest.fn().mockResolvedValue(items) };
}

describe("workflow runs OpenFGA config access", () => {
  afterEach(() => {
    delete process.env.DA_USER_CONTEXT_HMAC_SECRET;
  });

  beforeEach(() => {
    process.env.DA_USER_CONTEXT_HMAC_SECRET = "test-context-secret";
    jest.clearAllMocks();
    mockGetUserTeamIds.mockResolvedValue(["legacy-team"]);
    mockRequireWorkflowAccess.mockResolvedValue(undefined);
    mockRequireWorkflowRunAccess.mockResolvedValue(undefined);
    mockWorkflowAccessAllowed.mockResolvedValue(true);
    mockRequireWorkflowConfigRunAccess.mockResolvedValue(undefined);
    mockRequireWorkflowConfigRunViewAccess.mockResolvedValue(undefined);
    mockResolveUserTeamSlugsForWorkflow.mockResolvedValue(["eng"]);
    mockBuildTeamRefToSlugMap.mockResolvedValue(new Map([["eng", "eng"]]));
    mockFilterWorkflowConfigsByRunAccess.mockImplementation((configs) =>
      configs.filter((config: { _id?: string }) => config._id === "wf-global"),
    );
    mockFilterAccessibleWorkflowConfigs.mockImplementation(async (_session, resources) =>
      resources.filter((resource: { _id?: string }) => resource._id === "wf-visible"),
    );
    mockMergeWorkflowConfigsById.mockImplementation((...groups) => {
      const byId = new Map<string, unknown>();
      for (const group of groups) {
        for (const item of group as Array<{ _id: string }>) byId.set(item._id, item);
      }
      return [...byId.values()];
    });
    mockStartWorkflowRun.mockResolvedValue("run-new");
    mockGetAuth.mockResolvedValue({ user: mockAuthUser, session: mockAuthSession });
  });

  it("marks individual run polling responses as no-store", async () => {
    const run = { _id: "run-1", workflow_config_id: "wf-visible", status: "running" };
    const runCollection = {
      findOne: jest.fn().mockResolvedValue(run),
    };
    mockGetCollection.mockResolvedValue(runCollection);
    const { GET } = await import("../workflow-runs/route");

    const response = await GET(request("/api/workflow-runs?run_id=run-1"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store, max-age=0");
    expect(await response.json()).toMatchObject(run);
  });

  it("lists runs for OpenFGA-readable workflow configs without legacy team prefiltering", async () => {
    const runCollection = {
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      find: jest.fn().mockReturnValue(cursor([{ _id: "run-1", workflow_config_id: "wf-visible" }])),
    };
    const configCollection = {
      find: jest.fn().mockReturnValue(cursor([{ _id: "wf-visible" }, { _id: "wf-hidden" }])),
    };
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "workflow_runs" ? runCollection : configCollection,
    );
    const { GET } = await import("../workflow-runs/route");

    const response = await GET(request("/api/workflow-runs"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockGetUserTeamIds).not.toHaveBeenCalled();
    expect(configCollection.find).toHaveBeenCalledWith({});
    expect(mockFilterAccessibleWorkflowConfigs).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      [{ _id: "wf-visible" }, { _id: "wf-hidden" }],
      expect.any(Function),
      "read",
    );
    expect(runCollection.find).toHaveBeenCalledWith({ workflow_config_id: { $in: ["wf-visible"] } });
    expect(body).toEqual([{ _id: "run-1", workflow_config_id: "wf-visible" }]);
  });

  it("surfaces CAS outage when listing runs for a specific workflow config", async () => {
    const config = { _id: "wf-visible", visibility: "private", owner_id: "bob@example.com" };
    const runCollection = {
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    };
    const configCollection = {
      findOne: jest.fn().mockResolvedValue(config),
    };
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "workflow_runs" ? runCollection : configCollection,
    );
    mockRequireWorkflowConfigRunViewAccess.mockRejectedValueOnce(
      Object.assign(new Error("Authorization service temporarily unavailable."), { statusCode: 503 }),
    );
    const { GET } = await import("../workflow-runs/route");

    const response = await GET(request("/api/workflow-runs?workflow_config_id=wf-visible"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({ success: false, error: "Authorization service temporarily unavailable." });
  });

  it("lists runs for a workflow config allowed by Mongo visibility even without a direct CAS read grant", async () => {
    const config = { _id: "wf-global", visibility: "global", owner_id: "system" };
    const runCollection = {
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      find: jest.fn().mockReturnValue(cursor([{ _id: "run-global", workflow_config_id: "wf-global" }])),
    };
    const configCollection = {
      findOne: jest.fn().mockResolvedValue(config),
    };
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "workflow_runs" ? runCollection : configCollection,
    );
    mockRequireWorkflowAccess.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    const { GET } = await import("../workflow-runs/route");

    const response = await GET(request("/api/workflow-runs?workflow_config_id=wf-global"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRequireWorkflowConfigRunViewAccess).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      config,
      "alice@example.com",
      ["eng"],
    );
    expect(body).toEqual([{ _id: "run-global", workflow_config_id: "wf-global" }]);
  });

  it("merges Mongo-visible workflow configs into the all-runs list", async () => {
    const configCandidates = [
      { _id: "wf-global", visibility: "global", owner_id: "system" },
      { _id: "wf-visible", visibility: "private", owner_id: "bob@example.com" },
    ];
    const runCollection = {
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
      find: jest.fn().mockReturnValue(cursor([
        { _id: "run-global", workflow_config_id: "wf-global" },
        { _id: "run-fga", workflow_config_id: "wf-visible" },
      ])),
    };
    const configCollection = { find: jest.fn().mockReturnValue(cursor(configCandidates)) };
    mockGetCollection.mockImplementation(async (name: string) =>
      name === "workflow_runs" ? runCollection : configCollection,
    );
    mockFilterWorkflowConfigsByRunAccess.mockReturnValue([configCandidates[0]]);
    mockFilterAccessibleWorkflowConfigs.mockResolvedValue([configCandidates[1]]);
    const { GET } = await import("../workflow-runs/route");

    const response = await GET(request("/api/workflow-runs"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockFilterWorkflowConfigsByRunAccess).toHaveBeenCalledWith(
      configCandidates,
      "alice@example.com",
      ["eng"],
      expect.any(Map),
    );
    expect(runCollection.find).toHaveBeenCalledWith({ workflow_config_id: { $in: ["wf-global", "wf-visible"] } });
    expect(body).toEqual([
      { _id: "run-global", workflow_config_id: "wf-global" },
      { _id: "run-fga", workflow_config_id: "wf-visible" },
    ]);
  });

  it("requires workflow run access before starting a workflow run", async () => {
    const config = { _id: "wf-visible", name: "Workflow" };
    const configCollection = { findOne: jest.fn().mockResolvedValue(config) };
    mockGetCollection.mockResolvedValue(configCollection);
    const { POST } = await import("../workflow-runs/route");

    const response = await POST(
      request("/api/workflow-runs", {
        method: "POST",
        body: JSON.stringify({ workflow_config_id: "wf-visible" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockGetUserTeamIds).not.toHaveBeenCalled();
    expect(mockRequireWorkflowConfigRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      expect.objectContaining({ _id: "wf-visible" }),
      "alice@example.com",
      ["eng"],
    );
    expect(mockStartWorkflowRun).toHaveBeenCalledWith(
      config,
      null,
      expect.any(Object),
      expect.objectContaining({ user: { email: "alice@example.com", name: "Alice" } }),
      { type: "user", id: "alice-sub" },
    );
  });

  it("starts a workflow config allowed by Mongo visibility even without a direct CAS read grant", async () => {
    const config = { _id: "wf-global", name: "Global Workflow", visibility: "global", owner_id: "system" };
    const configCollection = { findOne: jest.fn().mockResolvedValue(config) };
    mockGetCollection.mockResolvedValue(configCollection);
    mockRequireWorkflowAccess.mockRejectedValueOnce(Object.assign(new Error("forbidden"), { statusCode: 403 }));
    const { POST } = await import("../workflow-runs/route");

    const response = await POST(
      request("/api/workflow-runs", {
        method: "POST",
        body: JSON.stringify({ workflow_config_id: "wf-global" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mockRequireWorkflowConfigRunAccess).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "alice-sub" }),
      expect.objectContaining({ _id: "wf-global", owner_id: "system", visibility: "global" }),
      "alice@example.com",
      ["eng"],
    );
    expect(mockStartWorkflowRun).toHaveBeenCalled();
  });

  it("forwards the incoming Bearer to the DA call when present", async () => {
    const config = { _id: "wf-visible", name: "Workflow" };
    mockGetCollection.mockResolvedValue({ findOne: jest.fn().mockResolvedValue(config) });
    const { POST } = await import("../workflow-runs/route");

    await POST(
      request("/api/workflow-runs", {
        method: "POST",
        headers: { Authorization: "Bearer incoming-tok" },
        body: JSON.stringify({ workflow_config_id: "wf-visible" }),
      }),
    );

    expect(mockStartWorkflowRun).toHaveBeenCalledWith(
      config,
      null,
      expect.objectContaining({ Authorization: "Bearer incoming-tok" }),
      expect.any(Object),
      { type: "user", id: "alice-sub" },
    );
  });

  it("falls back to the session accessToken when no Bearer is forwarded (cookie session)", async () => {
    // The regression: cookie-session starts sent no Authorization header, so the
    // DA call 401'd with missing_bearer. The route now forwards session.accessToken.
    mockGetAuth.mockResolvedValueOnce({
      user: mockAuthUser,
      session: { ...mockAuthSession, accessToken: "sess-tok" },
    });
    const config = { _id: "wf-visible", name: "Workflow" };
    mockGetCollection.mockResolvedValue({ findOne: jest.fn().mockResolvedValue(config) });
    const { POST } = await import("../workflow-runs/route");

    await POST(
      request("/api/workflow-runs", {
        method: "POST",
        body: JSON.stringify({ workflow_config_id: "wf-visible" }),
      }),
    );

    expect(mockStartWorkflowRun).toHaveBeenCalledWith(
      config,
      null,
      expect.objectContaining({ Authorization: "Bearer sess-tok" }),
      expect.any(Object),
      { type: "user", id: "alice-sub" },
    );
  });
});
