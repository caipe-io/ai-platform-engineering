import { _resetIngestorServiceAccountsCacheForTests } from "@/lib/rbac/ingestor-service-accounts";
import { CredentialRetrievalService } from "@/lib/credentials/retrieval-service";

const INGESTOR_SUB = "ingestor-service-account-sub";

function service() {
  return new CredentialRetrievalService({
    expectedAudience: "caipe-credential-service",
    payloadStore: {
      getSecret: jest.fn(async () => "github-token-value"),
    },
    authorize: jest.fn(async () => undefined),
  });
}

function denyingService(authorizeByUsage: jest.Mock) {
  return new CredentialRetrievalService({
    expectedAudience: "caipe-credential-service",
    payloadStore: {
      getSecret: jest.fn(async () => "github-token-value"),
    },
    authorize: jest.fn(async () => {
      throw Object.assign(new Error("no direct grant"), { statusCode: 403 });
    }),
    authorizeByUsage,
  });
}

describe("CredentialRetrievalService", () => {
  it("retrieves a secret for a non-browser service caller after use authorization", async () => {
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
          intended_use: "mcp_server",
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
    afterEach(() => {
      delete process.env.RAG_INGESTOR_SERVICE_ACCOUNTS;
      _resetIngestorServiceAccountsCacheForTests();
    });

    it("denies the fallback for a caller that is not a recognized ingestor service account, even when authorizeByUsage would allow it", async () => {
      process.env.RAG_INGESTOR_SERVICE_ACCOUNTS = JSON.stringify({ [INGESTOR_SUB]: ["web_url"] });
      _resetIngestorServiceAccountsCacheForTests();
      const authorizeByUsage = jest.fn(async () => true);
      const retrieval = denyingService(authorizeByUsage);

      await expect(
        retrieval.retrieve({
          headers: new Headers({
            authorization: "Bearer stolen-or-own-token",
            "x-caipe-credential-caller": "internal_service",
            "x-caipe-credential-audience": "caipe-credential-service",
          }),
          body: { secret_ref: "someone-elses-secret", intended_use: "internal_service" },
          // A regular authenticated user, not a service account, and not in
          // the allow-list even if it were one.
          session: { sub: "human-user-sub", isServiceAccount: false },
        }),
      ).rejects.toThrow("no direct grant");

      expect(authorizeByUsage).not.toHaveBeenCalled();
    });

    it("denies the fallback for an unrecognized service account", async () => {
      process.env.RAG_INGESTOR_SERVICE_ACCOUNTS = JSON.stringify({ [INGESTOR_SUB]: ["web_url"] });
      _resetIngestorServiceAccountsCacheForTests();
      const authorizeByUsage = jest.fn(async () => true);
      const retrieval = denyingService(authorizeByUsage);

      await expect(
        retrieval.retrieve({
          headers: new Headers({
            authorization: "Bearer some-other-services-token",
            "x-caipe-credential-caller": "internal_service",
            "x-caipe-credential-audience": "caipe-credential-service",
          }),
          body: { secret_ref: "someone-elses-secret", intended_use: "internal_service" },
          session: { sub: "some-other-service-sub", isServiceAccount: true },
        }),
      ).rejects.toThrow("no direct grant");

      expect(authorizeByUsage).not.toHaveBeenCalled();
    });

    it("allows a recognized ingestor service account through the fallback", async () => {
      process.env.RAG_INGESTOR_SERVICE_ACCOUNTS = JSON.stringify({ [INGESTOR_SUB]: ["web_url"] });
      _resetIngestorServiceAccountsCacheForTests();
      const authorizeByUsage = jest.fn(async () => true);
      const retrieval = denyingService(authorizeByUsage);

      await expect(
        retrieval.retrieve({
          headers: new Headers({
            authorization: "Bearer ingestor-token",
            "x-caipe-credential-caller": "internal_service",
            "x-caipe-credential-audience": "caipe-credential-service",
          }),
          body: { secret_ref: "referenced-secret", intended_use: "internal_service" },
          session: { sub: INGESTOR_SUB, isServiceAccount: true },
        }),
      ).resolves.toEqual({ credential: "github-token-value", secret_ref: "referenced-secret" });

      expect(authorizeByUsage).toHaveBeenCalledWith("referenced-secret");
    });
  });
});
