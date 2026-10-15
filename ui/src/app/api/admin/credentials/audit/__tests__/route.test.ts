/**
 * @jest-environment node
 */

const mockGetAuthFromBearerOrSession = jest.fn();
const mockQuery = jest.fn();
const mockRequireBaselineAdminSurfaceRead = jest.fn(async () => undefined);

jest.mock("@/lib/api-middleware", () => {
  const actual = jest.requireActual("@/lib/api-middleware");
  return {
    ...actual,
    getAuthFromBearerOrSession: mockGetAuthFromBearerOrSession,
  };
});

jest.mock("@/lib/feature-flags/credentials", () => ({
  getCredentialFeatureConfig: jest.fn(() => ({ enabled: true })),
}));

jest.mock("@/lib/audit", () => ({
  getAuditClient: () => ({ queryPage: async (...args: unknown[]) => ({ records: await mockQuery(...args) }) }),
}));

jest.mock("@/lib/rbac/require-openfga", () => ({
  requireBaselineAdminSurfaceRead: mockRequireBaselineAdminSurfaceRead,
}));

describe("/api/admin/credentials/audit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session: { sub: "admin-sub" } });
    mockQuery.mockResolvedValue([
      {
        action: "secret.retrieve",
        actor: { type: "service", id: "dynamic-agents" },
        resource: { type: "secret_ref", id: "secret-1" },
        result: "denied",
        details: { value: "***REDACTED***" },
      },
    ]);
  });

  it("lists global credential audit events behind the credentials admin surface", async () => {
    const { GET } = await import("../route");
    const response = await GET({
      headers: new Headers(),
      url: "http://localhost/api/admin/credentials/audit",
    } as never);

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [{ action: "secret.retrieve", result: "denied" }],
    });
    expect(mockRequireBaselineAdminSurfaceRead).toHaveBeenCalledWith(
      { sub: "admin-sub" },
      "credentials",
    );
    expect(mockQuery).toHaveBeenCalledWith({ type: "credential_action", limit: 100 });
  });

  it("does not turn an unavailable service into an empty successful history", async () => {
    const { AuditServiceError } = jest.requireActual("@/lib/audit/client");
    mockQuery.mockRejectedValueOnce(new AuditServiceError());
    const { GET } = await import("../route");
    const response = await GET({ headers: new Headers(), url: "http://localhost/api/admin/credentials/audit" } as never);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ success: false });
  });
});
