/** @jest-environment node */

import { NextRequest } from "next/server";

const mockWithAuth = jest.fn();
const mockRequireRbacPermission = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockGetCollection = jest.fn();
const mockGetServerConfig = jest.fn();

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
    requireRbacPermission: (...args: unknown[]) => mockRequireRbacPermission(...args),
    successResponse: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
    withAuth: (...args: unknown[]) => mockWithAuth(...args),
    withErrorHandler: <T,>(handler: (request: NextRequest) => Promise<T>) => handler,
  };
});

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/config", () => ({
  getServerConfig: () => mockGetServerConfig(),
}));

function request(init?: RequestInit): NextRequest {
  return new NextRequest("http://localhost:3000/api/admin/setup-wizard", init);
}

describe("admin setup wizard route", () => {
  const platformConfig = {
    findOne: jest.fn(),
    updateOne: jest.fn(),
  };
  const counts: Record<string, number[]> = {
    dynamic_agents: [1, 0],
    conversations: [0],
    provider_connections: [2],
    oauth_connectors: [3],
    rag_ingestion_sources: [0],
    mcp_servers: [1],
    llm_models: [1],
    users: [1],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.assign(counts, {
      dynamic_agents: [1, 0],
      conversations: [0],
      provider_connections: [2],
      oauth_connectors: [3],
      rag_ingestion_sources: [0],
      mcp_servers: [1],
      llm_models: [1],
      users: [1],
    });
    platformConfig.findOne.mockResolvedValue(null);
    platformConfig.updateOne.mockResolvedValue({ acknowledged: true });
    mockGetServerConfig.mockReturnValue({ setupWizardEnabled: true });
    mockRequireRbacPermission.mockResolvedValue(undefined);
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockWithAuth.mockImplementation((_request, handler) => handler(
      _request,
      { email: "admin@example.com" },
      { sub: "admin-sub", role: "admin", user: { email: "admin@example.com" } },
    ));
    mockGetCollection.mockImplementation((name: string) => {
      if (name === "platform_config") return platformConfig;
      const values = [...(counts[name] ?? [0])];
      return { countDocuments: jest.fn().mockImplementation(() => Promise.resolve(values.shift() ?? 0)) };
    });
  });

  it("persists exit without completing setup or losing choices", async () => {
    platformConfig.findOne.mockResolvedValue({ setup_wizard: {
      status: "in_progress", current_step: 2, selection: { model_id: "example-model" },
    } });
    const { PATCH } = await import("../route");
    const body = await (await PATCH(request({
      method: "PATCH", body: JSON.stringify({ action: "dismiss", current_step: 2 }),
    }))).json();
    expect(body.data.state).toMatchObject({
      status: "dismissed", checklist_hidden: true, current_step: 2,
      selection: { model_id: "example-model" },
    });
    expect(body.data.state.completed_at).toBeUndefined();
    expect(platformConfig.updateOne).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ $set: expect.objectContaining({
        setup_wizard: expect.objectContaining({ status: "dismissed", checklist_hidden: true }),
      }) }), expect.anything(),
    );
  });

  it("offers auto-start only for a fresh enabled deployment", async () => {
    const { GET } = await import("../route");
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      auto_start: true,
      enabled: true,
      fresh_install: true,
      inventory: {
        connected_credentials: 2,
        available_oauth_connectors: 3,
      },
      state: { status: "not_started", current_step: 1 },
    });
    expect(mockRequireRbacPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "admin-sub" }),
      "admin_ui",
      "admin",
    );
  });

  it("does not auto-start when setup is disabled", async () => {
    mockGetServerConfig.mockReturnValue({ setupWizardEnabled: false });
    const { GET } = await import("../route");
    const response = await GET(request());
    const body = await response.json();

    expect(body.data.auto_start).toBe(false);
    expect(body.data.enabled).toBe(false);
  });

  it("does not treat an existing installation as fresh", async () => {
    counts.dynamic_agents = [3, 2];
    counts.conversations = [4];
    counts.users = [3];
    const { GET } = await import("../route");
    const response = await GET(request());
    const body = await response.json();

    expect(body.data).toMatchObject({
      auto_start: false,
      fresh_install: false,
      inventory: { custom_agents: 2, conversations: 4, users: 3 },
    });
  });

  it("resumes persisted in-progress setup across sessions", async () => {
    platformConfig.findOne.mockResolvedValue({
      _id: "platform_settings",
      setup_wizard: { status: "in_progress", current_step: 4, run_count: 1 },
    });
    const { GET } = await import("../route");
    const response = await GET(request());
    const body = await response.json();

    expect(body.data).toMatchObject({
      auto_start: true,
      fresh_install: false,
      state: { status: "in_progress", current_step: 4 },
    });
  });

  it("rejects a stale save after another admin changes setup", async () => {
    platformConfig.findOne.mockResolvedValue({ setup_wizard: { status: "in_progress" } });
    platformConfig.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    const { PATCH } = await import("../route");
    await expect(PATCH(request({ method: "PATCH", body: JSON.stringify({ action: "hide_checklist" }) })))
      .rejects.toMatchObject({ statusCode: 409, code: "SETUP_CONFLICT" });
  });

  it("rejects setup writes with View as parameters before reading or changing state", async () => {
    const { PATCH } = await import("../route");
    await expect(PATCH(new NextRequest("http://example.test/api/admin/setup-wizard?simulate_type=user&simulate_id=example-user", {
      method: "PATCH", body: JSON.stringify({ action: "reset" }),
    }))).rejects.toMatchObject({ statusCode: 403, code: "SIMULATION_READ_ONLY" });
    expect(platformConfig.updateOne).not.toHaveBeenCalled();
  });

  it("clears completion evidence when a saved selection changes", async () => {
    platformConfig.findOne.mockResolvedValue({ setup_wizard: {
      status: "completed", current_step: 5, completed_steps: [1, 2, 3, 4, 5],
      selection: { model_id: "model-primary" }, created_agent_id: "example-agent",
      completed_at: "2026-01-01T00:00:00Z",
      last_smoke_test: { status: "passed", detail: "Ready", tested_at: "2026-01-01T00:00:00Z" },
    } });
    platformConfig.updateOne.mockResolvedValueOnce({ matchedCount: 1 });
    const { PATCH } = await import("../route");
    const body = await (await PATCH(request({ method: "PATCH", body: JSON.stringify({
      action: "progress", selection: { model_id: "model-secondary" },
    }) }))).json();
    expect(body.data.state.status).toBe("in_progress");
    expect(body.data.state.completed_steps).not.toContain(5);
    for (const key of ["created_agent_id", "last_smoke_test", "completed_at"]) expect(body.data.state[key]).toBeUndefined();
  });

  it("rejects completion that reuses another selection's evidence", async () => {
    platformConfig.findOne.mockResolvedValue({ setup_wizard: {
      status: "completed", selection: { model_id: "model-primary" }, created_agent_id: "example-agent",
      last_smoke_test: { status: "passed", detail: "Ready", tested_at: "2026-01-01T00:00:00Z" },
    } });
    const { PATCH } = await import("../route");
    await expect(PATCH(request({ method: "PATCH", body: JSON.stringify({
      action: "complete", selection: { model_id: "model-secondary" },
    }) }))).rejects.toMatchObject({ statusCode: 400, code: "SETUP_TEST_REQUIRED" });
    expect(platformConfig.updateOne).not.toHaveBeenCalled();
  });

  it("accepts fresh evidence for a changed selection and retains its completion timestamp", async () => {
    platformConfig.findOne.mockResolvedValue({ setup_wizard: {
      status: "completed", selection: { model_id: "model-primary" }, created_agent_id: "old-agent",
      last_smoke_test: { status: "passed", detail: "Old reply", tested_at: "2026-01-01T00:00:00Z" },
    } });
    platformConfig.updateOne.mockResolvedValueOnce({ matchedCount: 1 });
    const { PATCH } = await import("../route");
    const body = await (await PATCH(request({ method: "PATCH", body: JSON.stringify({
      action: "complete", selection: { model_id: "model-secondary" }, completed_steps: [1, 2, 3, 4, 5],
      created_agent_id: "new-agent", smoke_test: { status: "passed", detail: "New reply" },
    }) }))).json();
    expect(body.data.state).toMatchObject({ status: "completed", created_agent_id: "new-agent", last_smoke_test: { status: "passed", detail: "New reply" } });
    expect(body.data.state.completed_at).toEqual(expect.any(String));
    expect(body.data.state.completed_steps).toContain(5);
  });

  it("preserves evidence when only tool ordering or KB representation changes", async () => {
    platformConfig.findOne.mockResolvedValue({ setup_wizard: {
      status: "completed", selection: { model_id: "example-model", mcp_server_ids: ["secondary", "knowledge-base", "primary"] },
      created_agent_id: "example-agent", completed_steps: [1, 2, 3, 4, 5],
      last_smoke_test: { status: "passed", detail: "Ready", tested_at: "2026-01-01T00:00:00Z" },
    } });
    platformConfig.updateOne.mockResolvedValueOnce({ matchedCount: 1 });
    const { PATCH } = await import("../route");
    const body = await (await PATCH(request({ method: "PATCH", body: JSON.stringify({
      action: "complete", selection: { model_id: "example-model", mcp_server_ids: ["primary", "secondary"], enable_knowledge_base: true },
    }) }))).json();
    expect(body.data.state).toMatchObject({ status: "completed", created_agent_id: "example-agent", last_smoke_test: { status: "passed" } });
    expect(body.data.state.completed_steps).toContain(5);
  });

  it("persists completion and smoke-test evidence", async () => {
    platformConfig.findOne.mockResolvedValue({
      _id: "platform_settings",
      setup_wizard: { status: "in_progress", current_step: 5, run_count: 1 },
    });
    const { PATCH } = await import("../route");
    const response = await PATCH(request({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "complete",
        current_step: 5,
        completed_steps: [1, 2, 3, 4, 5],
        created_agent_id: "agent-sre-starter",
        smoke_test: { status: "passed", detail: "Ready" },
      }),
    }));
    const body = await response.json();

    expect(body.data.state).toMatchObject({
      status: "completed",
      created_agent_id: "agent-sre-starter",
      completed_steps: [1, 2, 3, 4, 5],
      last_smoke_test: { status: "passed", detail: "Ready" },
    });
    expect(platformConfig.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "platform_settings", setup_wizard: expect.any(Object) }),
      expect.objectContaining({
        $set: expect.objectContaining({
          "setup_wizard": expect.objectContaining({ status: "completed" }),
          "updated_by": "admin@example.com",
        }),
      }),
      { upsert: false },
    );
  });
});
