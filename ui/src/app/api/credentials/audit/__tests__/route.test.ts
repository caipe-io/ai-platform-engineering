/**
 * @jest-environment node
 */

const mockGetAuthFromBearerOrSession = jest.fn();
const mockQuery = jest.fn();

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

describe("/api/credentials/audit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthFromBearerOrSession.mockResolvedValue({ session: { sub: "alice-sub" } });
    mockQuery.mockResolvedValue([
      {
        action: "secret.create",
        actor: { type: "user", id: "alice-sub" },
        resource: { type: "secret_ref", id: "secret-1" },
        result: "success",
        details: { value: "***REDACTED***" },
      },
    ]);
  });

  it("returns redacted audit events for the authenticated actor", async () => {
    const { GET } = await import("../route");
    const response = await GET({ headers: new Headers(), url: "http://localhost/api/credentials/audit" } as never);

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [{ action: "secret.create", details: { value: "***REDACTED***" } }],
    });
    expect(mockQuery).toHaveBeenCalledWith({ type: "credential_action", limit: 500 });
  });

  it("returns unavailable rather than an empty history on a query failure", async () => {
    const { AuditServiceError } = jest.requireActual("@/lib/audit/client");
    mockQuery.mockRejectedValueOnce(new AuditServiceError());
    const { GET } = await import("../route");
    const response = await GET({ headers: new Headers(), url: "http://localhost/api/credentials/audit" } as never);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ success: false });
  });
});
