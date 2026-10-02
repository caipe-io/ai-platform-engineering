describe("getAuditBackend", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.AUDIT_LOG_BACKEND;
    delete process.env.AUDIT_SERVICE_URL;
    delete process.env.AUDIT_LOG_SERVICE_URL;
    delete process.env.AUDIT_SERVICE_FLUSH_INTERVAL_MS;
    delete process.env.AUDIT_SERVICE_FLUSH_BATCH_SIZE;
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("defaults to ServiceBackend when AUDIT_LOG_BACKEND is not set", async () => {
    const mockWrite = jest.fn();
    const MockServiceBackend = jest.fn().mockImplementation(() => ({ write: mockWrite }));
    jest.doMock("../backends/service-backend", () => ({ ServiceBackend: MockServiceBackend }));

    const { getAuditBackend } = await import("../backend");
    getAuditBackend();

    expect(MockServiceBackend).toHaveBeenCalledTimes(1);
    expect(MockServiceBackend).toHaveBeenCalledWith("http://audit-service:8010", 1000, 100);
  });

  it("AUDIT_LOG_BACKEND is case-insensitive and trims whitespace", async () => {
    process.env.AUDIT_LOG_BACKEND = "  SERVICE  ";

    const MockServiceBackend = jest.fn().mockImplementation(() => ({ write: jest.fn() }));
    jest.doMock("../backends/service-backend", () => ({ ServiceBackend: MockServiceBackend }));

    const { getAuditBackend } = await import("../backend");
    getAuditBackend();

    expect(MockServiceBackend).toHaveBeenCalledTimes(1);
  });

  it("creates ServiceBackend with custom runtime service settings", async () => {
    process.env.AUDIT_LOG_BACKEND = "service";
    process.env.AUDIT_SERVICE_URL = "http://audit-service:8010";
    process.env.AUDIT_SERVICE_FLUSH_INTERVAL_MS = "250";
    process.env.AUDIT_SERVICE_FLUSH_BATCH_SIZE = "50";

    const MockServiceBackend = jest.fn().mockImplementation(() => ({ write: jest.fn() }));
    jest.doMock("../backends/service-backend", () => ({ ServiceBackend: MockServiceBackend }));

    const { getAuditBackend } = await import("../backend");
    getAuditBackend();

    expect(MockServiceBackend).toHaveBeenCalledWith("http://audit-service:8010", 250, 50);
  });

  it("drops audit events for storage backends that moved out of the UI", async () => {
    process.env.AUDIT_LOG_BACKEND = "s3";

    const MockServiceBackend = jest.fn();
    jest.doMock("../backends/service-backend", () => ({ ServiceBackend: MockServiceBackend }));

    const { getAuditBackend } = await import("../backend");
    const backend = getAuditBackend();

    expect(() => backend.write({ type: "auth" })).not.toThrow();
    expect(MockServiceBackend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unsupported AUDIT_LOG_BACKEND"));
  });

  it("supports AUDIT_LOG_BACKEND=off as an explicit no-op", async () => {
    process.env.AUDIT_LOG_BACKEND = "off";

    const MockServiceBackend = jest.fn();
    jest.doMock("../backends/service-backend", () => ({ ServiceBackend: MockServiceBackend }));

    const { getAuditBackend } = await import("../backend");
    const backend = getAuditBackend();

    expect(() => backend.write({ type: "auth" })).not.toThrow();
    expect(MockServiceBackend).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith("[audit] backend=off; audit events will be dropped");
  });

  it("returns the same instance on repeated calls", async () => {
    const MockServiceBackend = jest.fn().mockImplementation(() => ({ write: jest.fn() }));
    jest.doMock("../backends/service-backend", () => ({ ServiceBackend: MockServiceBackend }));

    const { getAuditBackend } = await import("../backend");

    const first = getAuditBackend();
    const second = getAuditBackend();

    expect(first).toBe(second);
    expect(MockServiceBackend).toHaveBeenCalledTimes(1);
  });

  it("write() on returned backend calls through to the service implementation", async () => {
    const mockWrite = jest.fn();
    const MockServiceBackend = jest.fn().mockImplementation(() => ({ write: mockWrite }));
    jest.doMock("../backends/service-backend", () => ({ ServiceBackend: MockServiceBackend }));

    const { getAuditBackend } = await import("../backend");
    const backend = getAuditBackend();
    const event = { type: "auth", ts: "2026-06-18T00:00:00.000Z", userId: "u1" };
    backend.write(event);

    expect(mockWrite).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalledWith(event);
  });

  it("attributes events to the administrator during impersonation", async () => {
    const mockWrite = jest.fn();
    const MockServiceBackend = jest.fn().mockImplementation(() => ({ write: mockWrite }));
    jest.doMock("../backends/service-backend", () => ({ ServiceBackend: MockServiceBackend }));

    const { getAuditBackend } = await import("../backend");
    const { setAuditImpersonationContext } = await import("../impersonation-context");
    setAuditImpersonationContext({
      actorSub: "admin-sub",
      startedAt: "2026-09-23T12:00:00.000Z",
    });

    getAuditBackend().write({
      type: "auth",
      subject_ref: "user:target-sub",
    });
    setAuditImpersonationContext(undefined);

    expect(mockWrite).toHaveBeenCalledWith(expect.objectContaining({
      subject_ref: "user:target-sub",
      actor_ref: "user:admin-sub",
      actor_hash: expect.stringMatching(/^sha256:/),
      impersonation: true,
      impersonation_started_at: "2026-09-23T12:00:00.000Z",
    }));
  });
});
