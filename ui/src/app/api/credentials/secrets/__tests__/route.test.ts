const mockCreateSecret = jest.fn();
const mockListSecrets = jest.fn();
const mockRequireResourcePermission = jest.fn(async () => undefined);

jest.mock("@/lib/api-middleware", () => {
  class ApiError extends Error {
    statusCode: number;
    code?: string;
    constructor(message: string, statusCode = 500, code?: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
    }
  }
  return {
    ApiError,
    getAuthFromBearerOrSession: jest.fn(async () => ({
      user: { email: "alice@example.test", name: "Alice", role: "user" },
      session: { sub: "alice-sub", user: { email: "alice@example.test", name: "Alice Example" } },
    })),
    successResponse: (data: unknown, status = 200) => ({
      status,
      json: async () => ({ success: true, data }),
    }),
    withErrorHandler: (handler: unknown) => handler,
  };
});

jest.mock("@/lib/credentials/secret-service-factory", () => ({
  getCredentialSecretService: () => ({
    createSecret: mockCreateSecret,
    listSecrets: mockListSecrets,
  }),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: mockRequireResourcePermission,
}));

function request(method: string, body?: unknown) {
  return {
    method,
    headers: new Headers(body ? { "content-type": "application/json" } : undefined),
    json: async () => body,
    url: "http://localhost/api/credentials/secrets",
  } as never;
}

describe("/api/credentials/secrets", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CAIPE_CREDENTIALS_ENABLED = "true";
  });

  it("lists masked credential metadata for the authenticated user owner", async () => {
    const { GET } = await import("../route");
    mockListSecrets.mockResolvedValue([
      {
        id: "secret-1",
        name: "GitHub token",
        owner: { type: "user", id: "alice-sub" },
        maskedPreview: "ghp_...abcd",
      },
    ]);

    const response = await GET(request("GET"));

    await expect(response.json()).resolves.toEqual({
      success: true,
      data: [
        {
          id: "secret-1",
          name: "GitHub token",
          owner: {
            type: "user",
            id: "alice-sub",
            email: "alice@example.test",
            name: "Alice Example",
          },
          maskedPreview: "ghp_...abcd",
        },
      ],
    });
    expect(mockListSecrets).toHaveBeenCalledWith({
      session: { sub: "alice-sub", user: { email: "alice@example.test", name: "Alice Example" } },
      owner: {
        type: "user",
        id: "alice-sub",
        email: "alice@example.test",
        name: "Alice Example",
      },
    });
  });

  it("creates a secret from raw input but returns only masked metadata", async () => {
    const { POST } = await import("../route");
    mockCreateSecret.mockResolvedValue({
      id: "secret-1",
      name: "GitHub token",
      maskedPreview: "ghp_...abcd",
    });

    const response = await POST(
      request("POST", {
        name: "GitHub token",
        type: "bearer_token",
        value: "ghp_raw_token_value",
      }),
    );

    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json).toEqual({
      success: true,
      data: {
        id: "secret-1",
        name: "GitHub token",
        maskedPreview: "ghp_...abcd",
      },
    });
    expect(JSON.stringify(mockCreateSecret.mock.calls)).toContain("ghp_raw_token_value");
    expect(mockCreateSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: expect.objectContaining({
          type: "user",
          id: "alice-sub",
          email: "alice@example.test",
          name: "Alice Example",
        }),
      }),
    );
    expect(JSON.stringify(json)).not.toContain("ghp_raw_token_value");
  });

  it("requires team manage permission before creating a team-owned secret", async () => {
    const { POST } = await import("../route");
    mockCreateSecret.mockResolvedValue({
      id: "secret-1",
      name: "Team token",
      maskedPreview: "team...alue",
    });

    await POST(
      request("POST", {
        name: "Team token",
        type: "bearer_token",
        value: "team-token-value",
        ownerType: "team",
        ownerId: "platform-team",
      }),
    );

    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "alice-sub", user: { email: "alice@example.test", name: "Alice Example" } },
      { type: "team", id: "platform-team", action: "manage" },
    );
  });

  it("requires organization manage permission before creating an organization-owned secret", async () => {
    const { POST } = await import("../route");
    mockCreateSecret.mockResolvedValue({
      id: "secret-1",
      name: "Organization token",
      maskedPreview: "org_...alue",
    });

    await POST(
      request("POST", {
        name: "Organization token",
        type: "bearer_token",
        value: "organization-token-value",
        ownerType: "organization",
        ownerId: "example-org",
      }),
    );

    expect(mockRequireResourcePermission).toHaveBeenCalledWith(
      { sub: "alice-sub", user: { email: "alice@example.test", name: "Alice Example" } },
      { type: "organization", id: "example-org", action: "manage" },
    );
    expect(mockCreateSecret).toHaveBeenCalledWith(
      expect.objectContaining({ owner: { type: "organization", id: "example-org" } }),
    );
  });

  it("does not create an organization-owned secret when organization manage is denied", async () => {
    const { POST } = await import("../route");
    mockRequireResourcePermission.mockRejectedValueOnce(
      new Error("Only organization admins can create organization secrets."),
    );

    await expect(
      POST(
        request("POST", {
          name: "Denied organization token",
          type: "bearer_token",
          value: "organization-token-value",
          ownerType: "organization",
          ownerId: "example-org",
        }),
      ),
    ).rejects.toThrow("Only organization admins can create organization secrets.");

    expect(mockCreateSecret).not.toHaveBeenCalled();
  });
});
