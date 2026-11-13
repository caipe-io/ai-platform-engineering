import {
  exchangeOAuthToken,
  getOAuthConnectorService,
  getProviderConnectionService,
} from "@/lib/credentials/oauth-service-factory";
import { getCollection } from "@/lib/mongodb";

jest.mock("@/lib/mongodb", () => ({
  getCollection: jest.fn(),
}));

jest.mock("@aws-sdk/client-kms", () => ({
  KMSClient: jest.fn(),
}));

function tokenResponse(body: string, contentType = "application/json") {
  return {
    ok: true,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  } as Response;
}

describe("exchangeOAuthToken", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("requests JSON from GitHub-style token endpoints", async () => {
    const fetchMock = jest.fn(async () => tokenResponse(JSON.stringify({ access_token: "access-token" })));
    global.fetch = fetchMock as typeof fetch;

    await expect(
      exchangeOAuthToken("https://github.com/login/oauth/access_token", {
        grant_type: "authorization_code",
        code: "code-1",
      }),
    ).resolves.toEqual({ access_token: "access-token" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://github.com/login/oauth/access_token",
      expect.objectContaining({
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
      }),
    );
  });

  it("sends percent-encoded HTTP Basic client credentials when requested", async () => {
    const fetchMock = jest.fn(async () => tokenResponse(JSON.stringify({ access_token: "access-token" })));
    global.fetch = fetchMock as typeof fetch;

    await exchangeOAuthToken(
      "https://identity.example.com/oauth2/token",
      { grant_type: "refresh_token", refresh_token: "refresh-1" },
      { basicAuth: { clientId: "client id", clientSecret: "s3cr:et" } },
    );

    const credentials = Buffer.from("client%20id:s3cr%3Aet").toString("base64");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://identity.example.com/oauth2/token",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Basic ${credentials}` }),
      }),
    );
  });

  it("parses form-encoded token responses when a provider ignores the Accept header", async () => {
    global.fetch = jest.fn(async () =>
      tokenResponse("access_token=access-token&expires_in=3600", "application/x-www-form-urlencoded"),
    ) as typeof fetch;

    await expect(
      exchangeOAuthToken("https://github.com/login/oauth/access_token", {
        grant_type: "authorization_code",
        code: "code-1",
      }),
    ).resolves.toEqual({ access_token: "access-token", expires_in: 3600 });
  });
});

describe("getOAuthConnectorService", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalKeyProvider = process.env.CREDENTIAL_KEY_PROVIDER;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.CREDENTIAL_KEY_PROVIDER = originalKeyProvider;
    jest.clearAllMocks();
  });

  it("lists connector metadata in local prod compose without initializing secret key wrapping", async () => {
    process.env.NODE_ENV = "production";
    process.env.CREDENTIAL_KEY_PROVIDER = "local-cmk";
    (getCollection as jest.Mock).mockResolvedValue({
      find: () => ({
        sort: () => ({
          toArray: async () => [
            {
              id: "github-connector",
              name: "GitHub",
              provider: "github",
              clientId: "github-client",
              clientSecretRef: "oauth_connector:github-connector:client_secret",
              authorizationUrl: "https://github.com/login/oauth/authorize",
              tokenUrl: "https://github.com/login/oauth/access_token",
              scopes: ["repo", "read:user"],
              redirectUri: "http://localhost:3000/api/credentials/oauth/github/callback",
              enabled: true,
              createdAt: new Date("2026-05-27T00:00:00.000Z"),
              updatedAt: new Date("2026-05-27T00:00:00.000Z"),
            },
          ],
        }),
      }),
    });

    await expect((await getOAuthConnectorService()).listConnectors()).resolves.toEqual([
      expect.objectContaining({
        id: "github-connector",
        name: "GitHub",
        provider: "github",
        enabled: true,
        clientSecretConfigured: true,
      }),
    ]);
  });

  it("lists provider connection metadata in local prod compose without initializing secret key wrapping", async () => {
    process.env.NODE_ENV = "production";
    process.env.CREDENTIAL_KEY_PROVIDER = "local-cmk";
    (getCollection as jest.Mock).mockResolvedValue({
      find: () => ({
        sort: () => ({
          toArray: async () => [],
        }),
      }),
    });

    await expect(
      (await getProviderConnectionService()).listConnections({ type: "user", id: "alice-sub" }),
    ).resolves.toEqual([]);
  });
});
