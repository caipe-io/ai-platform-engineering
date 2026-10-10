import { ApiError } from "@/lib/api-error";
import { CredentialRetrievalService } from "@/lib/credentials/retrieval-service";

const INGESTOR_SUB = "ingestor-service-account-sub";
const PLATFORM_CLIENT = "example-platform";

function service() {
  return new CredentialRetrievalService({
    expectedAudience: "caipe-credential-service",
    payloadStore: {
      getSecret: jest.fn(async () => "github-token-value"),
    },
    authorize: jest.fn(async () => undefined),
  });
}

function denyingService(
  authorizeByUsage: jest.Mock,
  getSecret = jest.fn(async () => "example-token-value"),
  error = new ApiError("no direct grant", 403, "secret_ref#use", "pdp_denied"),
) {
  return new CredentialRetrievalService({
    expectedAudience: "caipe-credential-service",
    payloadStore: {
      getSecret,
    },
    authorize: jest.fn(async () => {
      throw error;
    }),
    authorizeByUsage,
    internalServiceClientId: PLATFORM_CLIENT,
  });
}

describe("CredentialRetrievalService", () => {
  it.each(["mcp_server", "a2a_agent"])("retrieves a secret for %s after use authorization", async (intended_use) => {
    const retrieval = service();

    await expect(
      retrieval.retrieve({
        headers: new Headers({
          authorization: "Bearer service-token",
          "x-caipe-credential-caller": "dynamic_agent",
          "x-caipe-credential-audience": "caipe-credential-service",
        }),
        body: {
          secret_ref: "secret-1",
          intended_use,
        },
        session: { sub: "service-sub" },
      }),
    ).resolves.toEqual({
      credential: "github-token-value",
      secret_ref: "secret-1",
    });
  });

  it("denies browser-origin retrieval before decrypting", async () => {
    const payloadStore = { getSecret: jest.fn(async () => "github-token-value") };
    const retrieval = new CredentialRetrievalService({
      expectedAudience: "caipe-credential-service",
      payloadStore,
      authorize: jest.fn(async () => undefined),
    });

    await expect(
      retrieval.retrieve({
        headers: new Headers({
          authorization: "Bearer browser-token",
          origin: "http://localhost:3000",
          "x-caipe-credential-caller": "dynamic_agent",
          "x-caipe-credential-audience": "caipe-credential-service",
        }),
        body: {
          secret_ref: "secret-1",
          intended_use: "mcp_server",
        },
        session: { sub: "service-sub" },
      }),
    ).rejects.toMatchObject({ reasonCode: "browser_request_denied" });
    expect(payloadStore.getSecret).not.toHaveBeenCalled();
  });

  it("validates secret ref, caller audience, and intended use", async () => {
    const retrieval = service();

    await expect(
      retrieval.retrieve({
        headers: new Headers({
          authorization: "Bearer service-token",
          "x-caipe-credential-caller": "dynamic_agent",
          "x-caipe-credential-audience": "wrong-audience",
        }),
        body: {
          secret_ref: "secret-1",
          intended_use: "mcp_server",
        },
        session: { sub: "service-sub" },
      }),
    ).rejects.toMatchObject({ reasonCode: "wrong_audience" });

    await expect(
      retrieval.retrieve({
        headers: new Headers({
          authorization: "Bearer service-token",
          "x-caipe-credential-caller": "dynamic_agent",
          "x-caipe-credential-audience": "caipe-credential-service",
        }),
        body: {
          secret_ref: "",
          intended_use: "browser",
        },
        session: { sub: "service-sub" },
      }),
    ).rejects.toMatchObject({ reasonCode: "invalid_retrieval_request" });
  });

  describe("internal_service usage fallback", () => {
    const headers = () => new Headers({
      authorization: "Bearer service-token",
      "x-caipe-credential-caller": "internal_service",
      "x-caipe-credential-audience": "caipe-credential-service",
    });
    const body = { secret_ref: "referenced-secret", intended_use: "internal_service" };
    const platformSession = {
      sub: INGESTOR_SUB,
      isServiceAccount: true,
      serviceAccountClientId: PLATFORM_CLIENT,
    };

    it.each([
      ["a human with a matching client claim", { ...platformSession, isServiceAccount: false }],
      ["a caller without a service-account marker", { ...platformSession, isServiceAccount: undefined }],
      ["another service account", { ...platformSession, serviceAccountClientId: "external-client" }],
      ["a service account without a client claim", { ...platformSession, serviceAccountClientId: undefined }],
      ["a service account without a subject", { ...platformSession, sub: undefined }],
      ["a service account with an empty subject", { ...platformSession, sub: " " }],
    ])("denies %s even with spoofed internal-service headers", async (_label, session) => {
      const authorizeByUsage = jest.fn(async () => true);
      const getSecret = jest.fn(async () => "example-token-value");
      const retrieval = denyingService(authorizeByUsage, getSecret);

      await expect(retrieval.retrieve({ headers: headers(), body, session }))
        .rejects.toThrow("no direct grant");
      expect(authorizeByUsage).not.toHaveBeenCalled();
      expect(getSecret).not.toHaveBeenCalled();
    });

    it("allows the verified platform service without a subject allow-list", async () => {
      const previous = process.env.RAG_INGESTOR_SERVICE_ACCOUNTS;
      delete process.env.RAG_INGESTOR_SERVICE_ACCOUNTS;
      try {
        const authorizeByUsage = jest.fn(async () => true);
        const retrieval = denyingService(authorizeByUsage);

        await expect(retrieval.retrieve({ headers: headers(), body, session: platformSession }))
          .resolves.toEqual({ credential: "example-token-value", secret_ref: "referenced-secret" });
        expect(authorizeByUsage).toHaveBeenCalledWith("referenced-secret");
      } finally {
        if (previous === undefined) delete process.env.RAG_INGESTOR_SERVICE_ACCOUNTS;
        else process.env.RAG_INGESTOR_SERVICE_ACCOUNTS = previous;
      }
    });

    it("denies a credential without source usage or an active preview grant", async () => {
      const authorizeByUsage = jest.fn(async () => false);
      const getSecret = jest.fn(async () => "example-token-value");
      const retrieval = denyingService(authorizeByUsage, getSecret);

      await expect(retrieval.retrieve({ headers: headers(), body, session: platformSession }))
        .rejects.toThrow("no direct grant");
      expect(authorizeByUsage).toHaveBeenCalledWith("referenced-secret");
      expect(getSecret).not.toHaveBeenCalled();
    });

    it.each(["mcp_server", "a2a_agent", "provider_exchange"])("denies usage fallback for %s", async (intended_use) => {
      const authorizeByUsage = jest.fn(async () => true);
      const retrieval = denyingService(authorizeByUsage);

      await expect(retrieval.retrieve({
        headers: headers(), body: { ...body, intended_use }, session: platformSession,
      })).rejects.toThrow("no direct grant");
      expect(authorizeByUsage).not.toHaveBeenCalled();
    });

    it("fails closed when the policy service is unavailable", async () => {
      const authorizeByUsage = jest.fn(async () => true);
      const error = new ApiError("policy unavailable", 503, "AUTHZ_UNAVAILABLE");
      const getSecret = jest.fn(async () => "example-token-value");
      const retrieval = denyingService(authorizeByUsage, getSecret, error);

      await expect(retrieval.retrieve({ headers: headers(), body, session: platformSession }))
        .rejects.toBe(error);
      expect(authorizeByUsage).not.toHaveBeenCalled();
      expect(getSecret).not.toHaveBeenCalled();
    });

    it("denies usage fallback when no internal-service client is configured", async () => {
      const authorizeByUsage = jest.fn(async () => true);
      const getSecret = jest.fn(async () => "example-token-value");
      const retrieval = new CredentialRetrievalService({
        expectedAudience: "caipe-credential-service",
        payloadStore: { getSecret },
        authorize: async () => { throw new ApiError("no direct grant", 403); },
        authorizeByUsage,
      });

      await expect(retrieval.retrieve({ headers: headers(), body, session: platformSession }))
        .rejects.toThrow("no direct grant");
      expect(authorizeByUsage).not.toHaveBeenCalled();
      expect(getSecret).not.toHaveBeenCalled();
    });
  });
});
