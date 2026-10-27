/**
 * @jest-environment node
 */

// assisted-by Codex Codex-sonnet-4-6

describe("GET /api/audit/config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.AUDIT_LOG_BACKEND = "service";
    process.env.AUDIT_SERVICE_URL = "http://audit-service:8010";
    global.fetch = jest.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it("reports S3 storage when audit-service is backed by S3", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      new Response(JSON.stringify({ backend: "s3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { GET } = await import("../route");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      backend: "service",
      readsAvailable: true,
      storageBackend: "s3",
      storageLabel: "Queries: MongoDB · Archive: S3",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "http://audit-service:8010/readyz",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("reports local disk storage when audit-service is backed by local storage", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      new Response(JSON.stringify({ backend: "local" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { GET } = await import("../route");

    const response = await GET();
    const body = await response.json();

    expect(body).toMatchObject({
      readsAvailable: true,
      storageBackend: "local",
      storageLabel: "Queries: MongoDB · Archive: local disk",
    });
  });

  it("marks storage unavailable when audit-service status is not reachable", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(new Response("unavailable", { status: 503 }));
    const { GET } = await import("../route");

    const response = await GET();
    const body = await response.json();

    expect(body).toMatchObject({
      backend: "service",
      readsAvailable: false,
      storageLabel: "Storage: audit-service unavailable",
    });
    expect(body.readsWarning).toContain("HTTP 503");
  });

  it("reports disabled storage when audit collection is off", async () => {
    process.env.AUDIT_LOG_BACKEND = "off";
    const { GET } = await import("../route");

    const response = await GET();
    const body = await response.json();

    expect(body).toMatchObject({
      backend: "off",
      readsAvailable: false,
      storageBackend: "off",
      storageLabel: "Storage: disabled",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
