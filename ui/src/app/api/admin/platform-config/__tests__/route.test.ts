/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockWithAuth = jest.fn();
const mockRequireAdmin = jest.fn();
const mockRequireResourcePermission = jest.fn();
const mockGetCollection = jest.fn();
const mockWriteOpenFgaTuples = jest.fn();

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
    withAuth: (...args: unknown[]) => mockWithAuth(...args),
    // Plain passthrough — pre-existing tests assert via `.rejects.toThrow`,
    // and the new ack-rejection test catches the error explicitly below.
    withErrorHandler:
      <T,>(handler: (request: NextRequest) => Promise<T>) =>
      (request: NextRequest) =>
        handler(request),
    requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
    requireRbacPermission: (...args: unknown[]) => mockRequireAdmin(...args),
  };
});

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockRequireResourcePermission(...args),
}));

jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));

jest.mock("@/lib/rbac/openfga", () => ({
  writeOpenFgaTuples: (...args: unknown[]) => mockWriteOpenFgaTuples(...args),
}));

function request(path: string, init?: RequestInit): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), init);
}

describe("admin platform-config route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DEFAULT_AGENT_ID;
    mockWithAuth.mockImplementation((_request, handler) =>
      handler(_request, { email: "admin@example.com" }, { sub: "admin-sub", role: "admin" }),
    );
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "platform_settings",
        default_agent_id: "agent-default",
        release_notes: {
          enabled: true,
        },
      }),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    });
    mockRequireAdmin.mockResolvedValue(undefined);
    mockRequireResourcePermission.mockResolvedValue(undefined);
    mockWriteOpenFgaTuples.mockResolvedValue({ enabled: true, writes: 1, deletes: 0 });
  });

  it("requires system_config read access before returning platform config", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/platform-config"));

    expect(response.status).toBe(200);
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "admin-sub", role: "admin" },
      { type: "system_config", id: "platform_settings", action: "read" },
    );
  });

  it("does not read platform config when system_config read is denied", async () => {
    mockRequireResourcePermission.mockRejectedValue(new Error("no read"));
    const { GET } = await import("../route");

    await expect(GET(request("/api/admin/platform-config"))).rejects.toThrow("no read");

    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("returns the env fallback when no DB default agent is configured", async () => {
    process.env.DEFAULT_AGENT_ID = "agent-env-default";
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn(),
    });
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/platform-config"));
    const body = await response.json();

    expect(body).toMatchObject({
      success: true,
      data: { default_agent_id: "agent-env-default", source: "env" },
    });

    delete process.env.DEFAULT_AGENT_ID;
  });

  it("returns release notes notification config with platform settings", async () => {
    const { GET } = await import("../route");

    const response = await GET(request("/api/admin/platform-config"));
    const body = await response.json();

    expect(body.data.release_notes).toEqual({
      enabled: true,
      repository_url: null,
      previous_commit: null,
      latest_commit: null,
    });
  });

  it("requires admin and system_config manage access before updating platform config", async () => {
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          default_agent_id: "agent-next",
          acknowledge_public_access: true,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockRequireAdmin).toHaveBeenCalledWith(
      { sub: "admin-sub", role: "admin" },
      "admin_ui",
      "admin",
    );
    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "admin-sub", role: "admin" },
      { type: "system_config", id: "platform_settings", action: "admin" },
    );
  });

  it("grants all authenticated users access to the configured default dynamic agent", async () => {
    const collection = {
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings", default_agent_id: "agent-old" }),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    };
    mockGetCollection.mockResolvedValue(collection);
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          default_agent_id: "agent-next",
          acknowledge_public_access: true,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [{ user: "user:*", relation: "user", object: "agent:agent-next" }],
      deletes: [{ user: "user:*", relation: "user", object: "agent:agent-old" }],
    });
  });

  it("rejects setting a new default agent without acknowledge_public_access", async () => {
    const collection = {
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings", default_agent_id: "agent-old" }),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    };
    mockGetCollection.mockResolvedValue(collection);
    const { PATCH } = await import("../route");

    const call = PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_agent_id: "agent-next" }),
      }),
    );

    await expect(call).rejects.toThrow(
      /Setting a platform default agent makes it available to all signed-in users/,
    );
    await expect(call).rejects.toMatchObject({ code: "PUBLIC_ACCESS_NOT_ACKNOWLEDGED" });
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  it("does not require acknowledge_public_access when the default agent is unchanged", async () => {
    const collection = {
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings", default_agent_id: "agent-same" }),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    };
    mockGetCollection.mockResolvedValue(collection);
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { PATCH } = await import("../route");

      const response = await PATCH(
        request("/api/admin/platform-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          // No acknowledge_public_access — must still pass because the
          // default isn't actually changing.
          body: JSON.stringify({ default_agent_id: "agent-same" }),
        }),
      );

      expect(response.status).toBe(200);
      // And no AUDIT line should be emitted when previous === next.
      expect(infoSpy).not.toHaveBeenCalledWith(
        "[AUDIT] platform_default_agent_changed",
        expect.anything(),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("emits an [AUDIT] line when the platform default agent changes", async () => {
    const collection = {
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings", default_agent_id: "agent-old" }),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    };
    mockGetCollection.mockResolvedValue(collection);
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    try {
      const { PATCH } = await import("../route");
      const response = await PATCH(
        request("/api/admin/platform-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            default_agent_id: "agent-next",
            acknowledge_public_access: true,
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(infoSpy).toHaveBeenCalledWith(
        "[AUDIT] platform_default_agent_changed",
        expect.stringContaining('"actor":"admin@example.com"'),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        "[AUDIT] platform_default_agent_changed",
        expect.stringContaining('"previous":"agent-old"'),
      );
      expect(infoSpy).toHaveBeenCalledWith(
        "[AUDIT] platform_default_agent_changed",
        expect.stringContaining('"next":"agent-next"'),
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("revokes the previous all-users default-agent grant when clearing the default", async () => {
    const collection = {
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings", default_agent_id: "agent-old" }),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    };
    mockGetCollection.mockResolvedValue(collection);
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_agent_id: null }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mockWriteOpenFgaTuples).toHaveBeenCalledWith({
      writes: [],
      deletes: [{ user: "user:*", relation: "user", object: "agent:agent-old" }],
    });
  });

  it("updates release notes config without clearing default agent", async () => {
    const collection = {
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    };
    mockGetCollection.mockResolvedValue(collection);
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          release_notes: {
            enabled: false,
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: "platform_settings" },
      expect.objectContaining({
        $set: expect.objectContaining({
          release_notes: {
            enabled: false,
            repository_url: null,
            previous_commit: null,
            latest_commit: null,
          },
        }),
      }),
      { upsert: true },
    );
    expect(collection.updateOne.mock.calls[0][1].$set).not.toHaveProperty("default_agent_id");
    expect(body.data.release_notes).toEqual({
      enabled: false,
      repository_url: null,
      previous_commit: null,
      latest_commit: null,
    });
  });

  it("persists a GitHub commit range for release notes", async () => {
    const collection = {
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    };
    mockGetCollection.mockResolvedValue(collection);
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          release_notes: {
            enabled: true,
            repository_url: "https://github.com/example/repository",
            previous_commit: "1111111",
            latest_commit: "2222222",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.release_notes).toEqual({
      enabled: true,
      repository_url: "https://github.com/example/repository",
      previous_commit: "1111111",
      latest_commit: "2222222",
    });
  });

  it("rejects an incomplete release notes commit range", async () => {
    const { PATCH } = await import("../route");

    await expect(
      PATCH(
        request("/api/admin/platform-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            release_notes: { previous_commit: "1111111" },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "INCOMPLETE_RELEASE_NOTES_COMPARE" });
  });

  it("checks coarse admin before system_config manage on updates", async () => {
    mockRequireAdmin.mockRejectedValue(new Error("not admin"));
    const { PATCH } = await import("../route");

    await expect(
      PATCH(
        request("/api/admin/platform-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            default_agent_id: "agent-next",
            acknowledge_public_access: true,
          }),
        }),
      ),
    ).rejects.toThrow("not admin");

    expect(mockRequireResourcePermission).not.toHaveBeenCalled();
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("does not update platform config when system_config manage is denied", async () => {
    mockRequireResourcePermission.mockRejectedValue(new Error("no manage"));
    const { PATCH } = await import("../route");

    await expect(
      PATCH(
        request("/api/admin/platform-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            default_agent_id: "agent-next",
            acknowledge_public_access: true,
          }),
        }),
      ),
    ).rejects.toThrow("no manage");

    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Connector discovery cache TTLs
  //
  // Slack and Webex keep independent snapshots and settings.
  // ---------------------------------------------------------------------

  it("returns separate Slack and Webex TTLs from Mongo", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "platform_settings",
        slack_discovery_cache_ttl_minutes: 30,
        webex_discovery_cache_ttl_minutes: 90,
      }),
      updateOne: jest.fn(),
    });
    const { GET } = await import("../route");

    const body = await (await GET(request("/api/admin/platform-config"))).json();

    expect(body.data.slack_discovery_cache_ttl_minutes).toBe(30);
    expect(body.data.webex_discovery_cache_ttl_minutes).toBe(90);
  });

  it("defaults each connector TTL to 60 when nothing is configured", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn(),
    });
    const { GET } = await import("../route");

    const body = await (await GET(request("/api/admin/platform-config"))).json();

    expect(body.data.slack_discovery_cache_ttl_minutes).toBe(60);
    expect(body.data.webex_discovery_cache_ttl_minutes).toBe(60);
  });

  it.each([
    "slack_discovery_cache_ttl_minutes",
    "webex_discovery_cache_ttl_minutes",
  ] as const)("persists %s without changing the other connector", async (field) => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings" }),
      updateOne,
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: 30 }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data[field]).toBe(30);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "platform_settings" },
      expect.objectContaining({
        $set: expect.objectContaining({ [field]: 30 }),
      }),
      { upsert: true },
    );
  });

  it("accepts 0 to mean 'caching disabled'", async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings" }),
      updateOne,
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slack_discovery_cache_ttl_minutes: 0 }),
      }),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data.slack_discovery_cache_ttl_minutes).toBe(0);
  });

  it("rejects invalid connector TTLs with a 400", async () => {
    const { PATCH } = await import("../route");

    for (const bad of [-1, 7.5, "ten", 100_000] as unknown[]) {
      await expect(
        PATCH(
          request("/api/admin/platform-config", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ webex_discovery_cache_ttl_minutes: bad }),
          }),
        ),
      ).rejects.toThrow(/webex_discovery_cache_ttl_minutes/);
    }
  });

  it("allows clearing one connector TTL", async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings" }),
      updateOne,
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webex_discovery_cache_ttl_minutes: null }),
      }),
    );

    expect(response.status).toBe(200);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "platform_settings" },
      expect.objectContaining({
        $set: expect.objectContaining({ webex_discovery_cache_ttl_minutes: null }),
      }),
      { upsert: true },
    );
  });

  // ---------------------------------------------------------------------
  // slack_victorops_escalation_agent_id
  //
  // The agent the Slack bot queries for VictorOps on-call lookups. Set in
  // Admin → Integrations → Slack → Advanced. Unlike default_agent_id it does
  // NOT grant any user access, so there's no OpenFGA tuple to reconcile and
  // no public-access ack to require.
  // ---------------------------------------------------------------------

  it("returns slack_victorops_escalation_agent_id from Mongo with source", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "platform_settings",
        slack_victorops_escalation_agent_id: "oncall-agent",
      }),
      updateOne: jest.fn(),
    });
    const { GET } = await import("../route");

    const body = await (await GET(request("/api/admin/platform-config"))).json();

    expect(body.data.slack_victorops_escalation_agent_id).toBe("oncall-agent");
    expect(body.data.slack_victorops_escalation_agent_source).toBe("db");
  });

  it("falls back to SLACK_INTEGRATION_VICTOROPS_AGENT_ID env for the victorops agent", async () => {
    process.env.SLACK_INTEGRATION_VICTOROPS_AGENT_ID = "env-oncall";
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn(),
    });
    try {
      const { GET } = await import("../route");
      const body = await (await GET(request("/api/admin/platform-config"))).json();
      expect(body.data.slack_victorops_escalation_agent_id).toBe("env-oncall");
      expect(body.data.slack_victorops_escalation_agent_source).toBe("env");
    } finally {
      delete process.env.SLACK_INTEGRATION_VICTOROPS_AGENT_ID;
    }
  });

  it("persists slack_victorops_escalation_agent_id on PATCH without writing OpenFGA tuples", async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings" }),
      updateOne,
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // No acknowledge_public_access required for this field.
        body: JSON.stringify({ slack_victorops_escalation_agent_id: "oncall-agent" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.slack_victorops_escalation_agent_id).toBe("oncall-agent");
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "platform_settings" },
      expect.objectContaining({
        $set: expect.objectContaining({ slack_victorops_escalation_agent_id: "oncall-agent" }),
      }),
      { upsert: true },
    );
    expect(mockWriteOpenFgaTuples).not.toHaveBeenCalled();
  });

  it("allows clearing the victorops agent with null", async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings", slack_victorops_escalation_agent_id: "oncall-agent" }),
      updateOne,
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slack_victorops_escalation_agent_id: null }),
      }),
    );

    expect(response.status).toBe(200);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "platform_settings" },
      expect.objectContaining({
        $set: expect.objectContaining({ slack_victorops_escalation_agent_id: null }),
      }),
      { upsert: true },
    );
  });

  it("rejects an invalid victorops agent id with a 400", async () => {
    const { PATCH } = await import("../route");

    await expect(
      PATCH(
        request("/api/admin/platform-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slack_victorops_escalation_agent_id: "bad id with spaces" }),
        }),
      ),
    ).rejects.toThrow(/slack_victorops_escalation_agent_id/);
  });

  // ---------------------------------------------------------------------
  // remote_mcp_catalog
  //
  // Controls which built-in provider tiles the Add Server catalog dialog
  // shows. Default (no config document, or a document that has never
  // touched this field) must be "disable all" — operators opt in per
  // provider rather than every built-in appearing unconfigured. An
  // explicit `enabled_providers: null` is a distinct, deliberate "Enable
  // all" admin action and must keep meaning "show every provider".
  // ---------------------------------------------------------------------

  it("defaults remote_mcp_catalog.enabled_providers to [] (disable all) when no config document exists", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn(),
    });
    const { GET } = await import("../route");

    const body = await (await GET(request("/api/admin/platform-config"))).json();

    expect(body.data.remote_mcp_catalog).toEqual({ enabled_providers: [], custom_entries: [] });
  });

  it("defaults remote_mcp_catalog.enabled_providers to [] when the document exists but never set this field", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings", default_agent_id: "agent-default" }),
      updateOne: jest.fn(),
    });
    const { GET } = await import("../route");

    const body = await (await GET(request("/api/admin/platform-config"))).json();

    expect(body.data.remote_mcp_catalog).toEqual({ enabled_providers: [], custom_entries: [] });
  });

  it("persists an explicit 'Enable all' (enabled_providers: null) and echoes it back on PATCH", async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings" }),
      updateOne,
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remote_mcp_catalog: { enabled_providers: null, custom_entries: [] },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.remote_mcp_catalog).toEqual({ enabled_providers: null, custom_entries: [] });
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "platform_settings" },
      expect.objectContaining({
        $set: expect.objectContaining({
          remote_mcp_catalog: { enabled_providers: null, custom_entries: [] },
        }),
      }),
      { upsert: true },
    );
  });

  it("GET reflects a previously-saved 'Enable all' as null, not the disable-all default", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "platform_settings",
        remote_mcp_catalog: { enabled_providers: null, custom_entries: [] },
      }),
      updateOne: jest.fn(),
    });
    const { GET } = await import("../route");

    const body = await (await GET(request("/api/admin/platform-config"))).json();

    expect(body.data.remote_mcp_catalog.enabled_providers).toBeNull();
  });

  it("persists a specific enabled_providers allowlist on PATCH and echoes it back on GET", async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings" }),
      updateOne,
    });
    const { PATCH } = await import("../route");

    const patchResponse = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remote_mcp_catalog: { enabled_providers: ["amplitude", "linear"], custom_entries: [] },
        }),
      }),
    );

    expect((await patchResponse.json()).data.remote_mcp_catalog.enabled_providers).toEqual([
      "amplitude",
      "linear",
    ]);

    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({
        _id: "platform_settings",
        remote_mcp_catalog: { enabled_providers: ["amplitude", "linear"], custom_entries: [] },
      }),
      updateOne,
    });
    const { GET } = await import("../route");
    const getBody = await (await GET(request("/api/admin/platform-config"))).json();

    expect(getBody.data.remote_mcp_catalog.enabled_providers).toEqual(["amplitude", "linear"]);
  });

  it("returns backwards-compatible RAG ingestor policy defaults when none are stored", async () => {
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings" }),
      updateOne: jest.fn(),
    });
    const { GET } = await import("../route");

    const body = await (await GET(request("/api/admin/platform-config"))).json();

    expect(body.data.rag_ingestor_limits).toMatchObject({
      slack: { max_lookback_days: 365, allow_full_history: true },
      web: { max_pages: 5000, allow_non_public_urls: true },
      file: { max_file_size_mb: 10, max_total_upload_size_mb: 25 },
    });
  });

  it("validates and persists a partial RAG ingestor policy as a complete policy", async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings" }),
      updateOne,
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rag_ingestor_limits: { slack: { max_lookback_days: 90 } },
        }),
      }),
    );
    const body = await response.json();

    expect(body.data.rag_ingestor_limits.slack.max_lookback_days).toBe(90);
    expect(body.data.rag_ingestor_limits.web.max_pages).toBe(5000);
    expect(updateOne).toHaveBeenCalledWith(
      { _id: "platform_settings" },
      expect.objectContaining({
        $set: expect.objectContaining({
          rag_ingestor_limits: expect.objectContaining({
            slack: expect.objectContaining({ max_lookback_days: 90 }),
          }),
        }),
      }),
      { upsert: true },
    );
  });

  it("rejects invalid RAG ingestor policy limits", async () => {
    const { PATCH } = await import("../route");

    await expect(
      PATCH(
        request("/api/admin/platform-config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rag_ingestor_limits: { web: { max_concurrent_requests: 51 } },
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_RAG_INGESTOR_LIMITS" });
  });

  it("clears the default search team when Search Access teams are disabled", async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockGetCollection.mockResolvedValue({
      findOne: jest.fn().mockResolvedValue({ _id: "platform_settings" }),
      updateOne,
    });
    const { PATCH } = await import("../route");

    const response = await PATCH(
      request("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rag_ingestor_limits: { shared: { max_search_teams: 0 } },
        }),
      }),
    );
    const body = await response.json();

    expect(body.data.rag_default_search_team_slug).toBeNull();
    expect(updateOne.mock.calls[0][1].$set.rag_default_search_team_slug).toBeNull();
  });
});
