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

  it("offers auto-start only for a fresh enabled deployment", async () => {
    const { GET } = await import("../route");
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      auto_start: true,
      enabled: true,
      fresh_install: true,
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
      { _id: "platform_settings" },
      expect.objectContaining({
        $set: expect.objectContaining({
          "setup_wizard": expect.objectContaining({ status: "completed" }),
          "updated_by": "admin@example.com",
        }),
      }),
      { upsert: true },
    );
  });
});
