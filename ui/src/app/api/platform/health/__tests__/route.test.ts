/**
 * @jest-environment node
 */

describe("/api/platform/health", () => {
  const originalEnv = process.env;
  const healthyAuditServiceStatus = {
    running: true,
    backend: "local",
    queue_size: 0,
    queue_max_size: 10000,
    rejected_events: 0,
    failed_flushes: 0,
    last_flush_at: "2026-06-25T12:00:00Z",
    last_error: null,
    storage: {
      backend: "local",
      status: "healthy",
      detail: "local disk 12.5% used (87.5 GiB free)",
      local_path: "/var/lib/caipe-audit-service",
      total_bytes: 100000000000,
      used_bytes: 12500000000,
      free_bytes: 87500000000,
      used_percent: 12.5,
      warning_percent: 85,
      critical_percent: 95,
    },
  };

  function request(): Request {
    return new Request("http://localhost/api/platform/health");
  }

  function jsonResponse(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      ...init,
    });
  }

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      NEXTAUTH_URL: "http://localhost:3000",
      A2A_BASE_URL: "http://chat-runtime:8001",
      DYNAMIC_AGENTS_ENABLED: "true",
      DYNAMIC_AGENTS_URL: "http://dynamic-agents:8001",
      RAG_ENABLED: "true",
      RAG_SERVER_URL: "http://rag-server:9446",
      SSO_ENABLED: "true",
      PROMETHEUS_URL: "http://prometheus:9090",
      PLATFORM_HEALTH_CACHE_TTL_MS: "0",
      COMPOSE_PROFILES: "",
      AUDIT_LOG_BACKEND: "service",
      AUDIT_SERVICE_URL: "http://audit-service:8010",
      SLACK_BOT_TOKEN: "",
      SLACK_INTEGRATION_BOT_TOKEN: "",
      SLACK_APP_TOKEN: "",
      SLACK_INTEGRATION_APP_TOKEN: "",
      SLACK_INTEGRATION_ENABLED: "",
      SLACK_ADMIN_API_ENABLED: "",
      SLACK_BOT_ADMIN_DEV_AUTH_ENABLED: "",
      SLACK_BOT_ADMIN_DEV_TOKEN: "",
      WEBEX_INTEGRATION_ENABLED: "",
      WEBEX_ADMIN_API_ENABLED: "",
      OIDC_CLIENT_SECRET: "",
      WEBEX_BOT_ADMIN_CLIENT_SECRET: "",
      KEYCLOAK_WEBEX_BOT_ADMIN_CLIENT_SECRET: "",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns healthy product capabilities when enabled checks pass", async () => {
    (global.fetch as jest.Mock) = jest.fn(async (url: string) => {
      if (url === "http://dynamic-agents:8001/healthz") return jsonResponse({ status: "healthy" });
      if (url.includes("/v1/audit/status")) return jsonResponse(healthyAuditServiceStatus);
      return jsonResponse({});
    });

    const { GET } = await import("../route");
    const response = await GET(request() as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.summary).toEqual({ total: 8, healthy: 6, degraded: 0, down: 0, disabled: 2 });
    expect(body.capabilities.map((capability: { id: string }) => capability.id)).toEqual([
      "chat-runtime",
      "dynamic-agents",
      "knowledge-bases",
      "authentication",
      "metrics",
      "audit-service",
      "slack-integration",
      "webex-integration",
    ]);
    expect(global.fetch).toHaveBeenCalledWith(
      "http://chat-runtime:8001/health",
      expect.objectContaining({ method: "GET" }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "http://dynamic-agents:8001/healthz",
      expect.objectContaining({ method: "GET" }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "http://rag-server:9446/healthz",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("marks disabled optional capabilities neutral", async () => {
    process.env.DYNAMIC_AGENTS_ENABLED = "false";
    process.env.RAG_ENABLED = "false";
    process.env.SSO_ENABLED = "false";
    delete process.env.PROMETHEUS_URL;
    (global.fetch as jest.Mock) = jest.fn(async (url: string) => {
      if (url.includes("/v1/audit/status")) return jsonResponse(healthyAuditServiceStatus);
      return jsonResponse({});
    });

    const { GET } = await import("../route");
    const response = await GET(request() as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.summary).toEqual({ total: 8, healthy: 2, degraded: 0, down: 0, disabled: 6 });
    expect(body.capabilities.find((capability: { id: string }) => capability.id === "knowledge-bases")).toMatchObject({
      status: "disabled",
      detail: "Disabled by RAG_ENABLED",
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("degrades when an enabled optional capability fails", async () => {
    process.env.DYNAMIC_AGENTS_ENABLED = "false";
    (global.fetch as jest.Mock) = jest.fn(async (url: string) => {
      if (url.includes("/v1/audit/status")) return jsonResponse(healthyAuditServiceStatus);
      return jsonResponse({}, { status: url === "http://rag-server:9446/healthz" ? 503 : 200 });
    });

    const { GET } = await import("../route");
    const response = await GET(request() as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.summary.degraded).toBe(1);
    expect(body.capabilities.find((capability: { id: string }) => capability.id === "knowledge-bases")).toMatchObject({
      status: "degraded",
      detail: "Knowledge Bases health check returned HTTP 503",
    });
  });

  it("returns 503 when the enabled dynamic agents capability fails", async () => {
    process.env.RAG_ENABLED = "false";
    (global.fetch as jest.Mock) = jest.fn(async (url: string) => {
      if (url === "http://dynamic-agents:8001/healthz") return jsonResponse({ status: "unhealthy" });
      if (url.includes("/v1/audit/status")) return jsonResponse(healthyAuditServiceStatus);
      return jsonResponse({});
    });

    const { GET } = await import("../route");
    const response = await GET(request() as never);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("down");
    expect(body.capabilities.find((capability: { id: string }) => capability.id === "dynamic-agents")).toMatchObject({
      status: "down",
      required: true,
      detail: "Dynamic Agents health check returned unhealthy status",
    });
  });

  it("includes enabled messaging integrations as degraded when their admin checks fail", async () => {
    process.env.SLACK_INTEGRATION_ENABLED = "true";
    process.env.WEBEX_INTEGRATION_ENABLED = "true";
    process.env.DYNAMIC_AGENTS_ENABLED = "false";
    (global.fetch as jest.Mock) = jest.fn(async (url: string) => {
      if (url.includes("/v1/audit/status")) return jsonResponse(healthyAuditServiceStatus);
      return jsonResponse({});
    });

    const { GET } = await import("../route");
    const response = await GET(request() as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.capabilities.find((capability: { id: string }) => capability.id === "slack-integration")).toMatchObject({
      status: "degraded",
      group: "messaging",
    });
    expect(body.capabilities.find((capability: { id: string }) => capability.id === "webex-integration")).toMatchObject({
      status: "degraded",
      group: "messaging",
    });
  });

  it("degrades when audit-service reports queue worker problems", async () => {
    (global.fetch as jest.Mock) = jest.fn(async (url: string) => {
      if (url === "http://dynamic-agents:8001/healthz") return jsonResponse({ status: "healthy" });
      if (url.includes("/v1/audit/status")) {
        return jsonResponse({
          ...healthyAuditServiceStatus,
          running: false,
          queue_size: 9000,
          failed_flushes: 2,
          last_error: "S3 write failed",
        });
      }
      return jsonResponse({});
    });

    const { GET } = await import("../route");
    const response = await GET(request() as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.capabilities.find((capability: { id: string }) => capability.id === "audit-service")).toMatchObject({
      status: "degraded",
      group: "observability",
      detail: expect.stringContaining("queue worker is not running"),
    });
  });

  it("degrades when audit-service reports local disk pressure", async () => {
    (global.fetch as jest.Mock) = jest.fn(async (url: string) => {
      if (url === "http://dynamic-agents:8001/healthz") return jsonResponse({ status: "healthy" });
      if (url.includes("/v1/audit/status")) {
        return jsonResponse({
          ...healthyAuditServiceStatus,
          storage: {
            backend: "local",
            status: "warning",
            detail: "local disk 92.0% used (8.0 GiB free)",
            local_path: "/var/lib/caipe-audit-service",
            used_percent: 92,
            free_bytes: 8589934592,
          },
        });
      }
      return jsonResponse({});
    });

    const { GET } = await import("../route");
    const response = await GET(request() as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.capabilities.find((capability: { id: string }) => capability.id === "audit-service")).toMatchObject({
      status: "degraded",
      detail: expect.stringContaining("storage warning: local disk 92.0% used"),
    });
  });

  it("returns 503 only when the required chat runtime fails", async () => {
    process.env.DYNAMIC_AGENTS_ENABLED = "false";
    process.env.RAG_ENABLED = "false";
    (global.fetch as jest.Mock) = jest.fn(async (url: string) => {
      if (url.includes("/v1/audit/status")) return jsonResponse(healthyAuditServiceStatus);
      return jsonResponse({}, { status: 503 });
    });

    const { GET } = await import("../route");
    const response = await GET(request() as never);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("down");
    expect(body.capabilities.find((capability: { id: string }) => capability.id === "chat-runtime")).toMatchObject({
      status: "down",
      required: true,
      detail: "Chat runtime health check returned HTTP 503",
    });
  });

  it("uses runtime language when the chat runtime cannot be reached", async () => {
    process.env.DYNAMIC_AGENTS_ENABLED = "false";
    process.env.RAG_ENABLED = "false";
    (global.fetch as jest.Mock) = jest.fn(async (url: string) => {
      if (url.includes("/v1/audit/status")) return jsonResponse(healthyAuditServiceStatus);
      throw new Error("fetch failed");
    });

    const { GET } = await import("../route");
    const response = await GET(request() as never);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.capabilities.find((capability: { id: string }) => capability.id === "chat-runtime")).toMatchObject({
      status: "down",
      detail: "Chat runtime health check is unreachable",
    });
  });

  it("falls back to the dynamic agents URL for chat runtime health", async () => {
    process.env.A2A_BASE_URL = "";
    (global.fetch as jest.Mock) = jest.fn(async (url: string) => {
      if (url === "http://dynamic-agents:8001/healthz") return jsonResponse({ status: "healthy" });
      if (url.includes("/v1/audit/status")) return jsonResponse(healthyAuditServiceStatus);
      return jsonResponse({});
    });

    const { GET } = await import("../route");
    const response = await GET(request() as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(global.fetch).toHaveBeenCalledWith(
      "http://dynamic-agents:8001/health",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
