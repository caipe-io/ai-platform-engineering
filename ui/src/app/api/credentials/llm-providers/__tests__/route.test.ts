/** @jest-environment node */
import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockGetCollection = jest.fn();
const mockMetadata = jest.fn();
const mockPermission = jest.fn();
const mockEnabled = jest.fn();
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
    getAuthFromBearerOrSession: (...args: unknown[]) => mockAuth(...args),
    successResponse: (data: unknown) => Response.json({ data }),
    withErrorHandler: (handler: unknown) => handler,
  };
});
jest.mock("@/lib/mongodb", () => ({
  getCollection: (...args: unknown[]) => mockGetCollection(...args),
}));
jest.mock("@/lib/credentials/secret-service-factory", () => ({
  getCredentialSecretService: async () => ({ getSecretMetadata: mockMetadata }),
}));
jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: (...args: unknown[]) => mockPermission(...args),
}));
jest.mock("@/lib/feature-flags/credentials", () => ({
  getCredentialFeatureConfig: () => ({ enabled: mockEnabled() }),
}));
function request(body?: unknown) {
  return new NextRequest(
    "https://app.example.test/api/credentials/llm-providers",
    body ? { method: "PATCH", body: JSON.stringify(body) } : undefined,
  );
}

describe("provider secret references", () => {
  const collection = { findOne: jest.fn(), updateOne: jest.fn() };
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnabled.mockReturnValue(true);
    mockAuth.mockResolvedValue({
      user: { email: "user@example.test" },
      session: { sub: "example-sub" },
    });
    mockGetCollection.mockResolvedValue(collection);
    collection.findOne.mockResolvedValue({
      preferences: {
        llm_provider_secrets: { openai: { api_key: "example-key" } },
      },
    });
    collection.updateOne.mockResolvedValue({ modifiedCount: 1 });
    mockMetadata.mockImplementation(async ({ secretId }) => ({
      id: secretId,
      name: "Example secret",
      type: secretId.includes("key") ? "api_key" : "custom",
    }));
    mockPermission.mockResolvedValue(undefined);
  });
  it("reads only the authenticated account’s reference configuration", async () => {
    const { GET } = await import("../route");
    const body = await (await GET(request())).json();
    expect(body.data.bindings.openai.api_key).toBe("example-key");
    expect(collection.findOne).toHaveBeenCalledWith({
      user_id: "user@example.test",
    });
  });
  it("authorizes references and stores only ids while preserving other settings", async () => {
    const { PATCH } = await import("../route");
    await PATCH(
      request({
        provider: "openai",
        fields: { endpoint: "example-endpoint", api_key: "example-key" },
        user_id: "other@example.test",
      }),
    );
    expect(mockPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sub: "example-sub" }),
      { type: "secret_ref", id: "example-key", action: "use" },
    );
    expect(collection.updateOne).toHaveBeenLastCalledWith(
      { user_id: "user@example.test" },
      {
        $set: {
          "preferences.llm_provider_secrets.openai": {
            endpoint: "example-endpoint",
            api_key: "example-key",
          },
          updated_at: expect.any(Date),
        },
      },
    );
  });
  it("does not bind a secret the caller cannot use", async () => {
    mockPermission.mockRejectedValue(new Error("Permission denied"));
    const { PATCH } = await import("../route");
    await expect(
      PATCH(
        request({
          provider: "anthropic-claude",
          fields: { api_key: "example-key" },
        }),
      ),
    ).rejects.toThrow("Permission denied");
    expect(collection.updateOne).not.toHaveBeenCalled();
  });
  it.each([
    { provider: "__proto__", fields: { api_key: "example-key" } },
    { provider: "openai", fields: { arbitrary: "example-key" } },
    { provider: "openai", fields: { endpoint: "example-endpoint" } },
    {
      provider: "anthropic-claude",
      fields: { api_key: { value: "example-value" } },
    },
    { provider: "aws-bedrock", fields: { secret_access_key: "example-key" } },
  ])("rejects invalid configuration without storing it", async (body) => {
    const { PATCH } = await import("../route");
    await expect(PATCH(request(body))).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(collection.updateOne).not.toHaveBeenCalled();
  });
  it("rejects the wrong secret type", async () => {
    mockMetadata.mockResolvedValue({ id: "example", type: "basic_auth" });
    const { PATCH } = await import("../route");
    await expect(
      PATCH(
        request({
          provider: "anthropic-claude",
          fields: { api_key: "example" },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
  it("supports deployment IAM without references", async () => {
    const { PATCH } = await import("../route");
    await PATCH(request({ provider: "aws-bedrock", fields: {} }));
    expect(mockMetadata).not.toHaveBeenCalled();
    expect(collection.updateOne).toHaveBeenLastCalledWith(expect.anything(), {
      $set: {
        "preferences.llm_provider_secrets.aws-bedrock": {},
        updated_at: expect.any(Date),
      },
    });
  });
  it("rejects scoped credentials and disabled credential features", async () => {
    const { GET } = await import("../route");
    mockAuth.mockResolvedValue({
      user: { email: "user@example.test" },
      session: { sub: "example", principalType: "skills_api_key" },
    });
    await expect(GET(request())).rejects.toMatchObject({ statusCode: 403 });
    mockEnabled.mockReturnValue(false);
    await expect(GET(request())).rejects.toMatchObject({ statusCode: 404 });
  });
});
