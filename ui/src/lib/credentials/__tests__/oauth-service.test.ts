import { afterEach, describe, expect, it, jest } from "@jest/globals";

import {
  boundScopes,
  OAuthConnectorService,
  type OAuthConnectorDocument,
  ProviderConnectionService,
  type ProviderConnectionDocument,
  type ProviderConnectionServiceOptions,
} from "../oauth-service";

class MemoryCollection<T extends object> {
  docs: T[] = [];

  async insertOne(doc: T) {
    this.docs.push(doc);
    return { acknowledged: true };
  }

  async findOne(query: Record<string, unknown>) {
    return this.docs.find((doc) => {
      const record = doc as Record<string, unknown>;
      return Object.entries(query).every(([key, value]) => record[key] === value);
    }) ?? null;
  }

  find() {
    return {
      sort: () => ({
        toArray: async () => this.docs,
      }),
    };
  }

  async updateOne(
    query: Record<string, unknown>,
    update: { $set?: Record<string, unknown>; $unset?: Record<string, unknown> },
  ) {
    const doc = await this.findOne(query);
    if (!doc) return { matchedCount: 0 };
    const record = doc as Record<string, unknown>;
    Object.assign(record, update.$set ?? {});
    for (const key of Object.keys(update.$unset ?? {})) {
      delete record[key];
    }
    return { matchedCount: 1 };
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

function mockPutSecret() {
  return jest.fn<(input: { secretRefId: string; plaintext: string }) => Promise<void>>(async () => undefined);
}

function mockTokenClient(response: TokenResponse) {
  return jest.fn<(tokenUrl: string, body: Record<string, string>) => Promise<TokenResponse>>(
    async () => response,
  );
}

describe("OAuthConnectorService", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowLocalhostRedirects = process.env.CREDENTIAL_ALLOW_LOCALHOST_OAUTH_REDIRECTS;

  afterEach(() => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: originalNodeEnv,
      writable: true,
      configurable: true,
    });
    if (originalAllowLocalhostRedirects === undefined) {
      delete process.env.CREDENTIAL_ALLOW_LOCALHOST_OAUTH_REDIRECTS;
    } else {
      process.env.CREDENTIAL_ALLOW_LOCALHOST_OAUTH_REDIRECTS = originalAllowLocalhostRedirects;
    }
  });

  it("creates a dynamic standard OAuth connector with secret material in the encrypted store", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    const payloadStore = { putSecret: mockPutSecret() };
    const service = new OAuthConnectorService({
      connectorsCollection: connectors,
      payloadStore,
      idGenerator: () => "connector-1",
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    });

    const connector = await service.createConnector({
      name: "GitHub Enterprise",
      provider: "github",
      clientId: "client-id",
      clientSecret: "client-secret",
      authorizationUrl: "https://github.example.com/login/oauth/authorize",
      tokenUrl: "https://github.example.com/login/oauth/access_token",
      scopes: ["repo", "offline_access"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/callback",
    });

    expect(connector).toMatchObject({
      id: "connector-1",
      provider: "github",
      clientSecretConfigured: true,
    });
    expect(connector).not.toHaveProperty("clientSecretRef");
    expect(JSON.stringify(connectors.docs)).not.toContain("client-secret");
    expect(payloadStore.putSecret).toHaveBeenCalledWith({
      secretRefId: "oauth_connector:connector-1:client_secret",
      plaintext: "client-secret",
    });
  });

  it("creates a PKCE (public client) connector without persisting any client secret", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    const payloadStore = { putSecret: mockPutSecret() };
    const service = new OAuthConnectorService({
      connectorsCollection: connectors,
      payloadStore,
      idGenerator: () => "connector-1",
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    });

    const connector = await service.createConnector({
      name: "CO2",
      provider: "co2-dev",
      clientId: "co2-client",
      authorizationUrl: "https://idp.example.com/oauth/authorize",
      tokenUrl: "https://idp.example.com/oauth/token",
      scopes: ["read", "offline_access"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/co2-dev/callback",
      pkce: true,
    });

    expect(connector).toMatchObject({
      id: "connector-1",
      provider: "co2-dev",
      pkce: true,
      clientSecretConfigured: false,
    });
    expect(connectors.docs[0].pkce).toBe(true);
    // Public clients have no secret to store.
    expect(payloadStore.putSecret).not.toHaveBeenCalled();
  });

  it("rejects non-https OAuth endpoints and localhost SSRF targets", async () => {
    const service = new OAuthConnectorService({
      connectorsCollection: new MemoryCollection<OAuthConnectorDocument>(),
      payloadStore: { putSecret: mockPutSecret() },
      idGenerator: () => "connector-1",
    });

    await expect(
      service.createConnector({
        name: "Unsafe",
        provider: "unsafe",
        clientId: "client-id",
        clientSecret: "client-secret",
        authorizationUrl: "http://localhost:8080/auth",
        tokenUrl: "https://example.com/token",
        scopes: ["offline_access"],
        redirectUri: "https://caipe.example.com/callback",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("upserts an existing connector and rotates encrypted client secret material", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    connectors.docs.push({
      id: "connector-1",
      name: "GitHub",
      provider: "github",
      clientId: "old-client",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo"],
      redirectUri: "https://old.example.com/callback",
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const payloadStore = { putSecret: mockPutSecret() };
    const service = new OAuthConnectorService({
      connectorsCollection: connectors,
      payloadStore,
      idGenerator: () => "connector-new",
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    });

    const connector = await service.upsertConnector({
      name: "GitHub",
      provider: "github",
      clientId: "new-client",
      clientSecret: "new-client-secret",
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "read:user"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/github/callback",
    });

    expect(connector).toMatchObject({
      id: "connector-1",
      clientId: "new-client",
      clientSecretConfigured: true,
    });
    expect(connectors.docs).toHaveLength(1);
    expect(connectors.docs[0]).toMatchObject({
      id: "connector-1",
      provider: "github",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
    });
    expect(JSON.stringify(connectors.docs)).not.toContain("new-client-secret");
    expect(payloadStore.putSecret).toHaveBeenCalledWith({
      secretRefId: "oauth_connector:connector-1:client_secret",
      plaintext: "new-client-secret",
    });
  });

  it("upsertConnector clears a persisted pkce flag when an env bootstrap flips PKCE → confidential", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    connectors.docs.push({
      id: "connector-1",
      name: "CO2",
      provider: "co2-dev",
      clientId: "old-client",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://idp.example.com/oauth/authorize",
      tokenUrl: "https://idp.example.com/oauth/token",
      scopes: ["read"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/co2-dev/callback",
      enabled: true,
      pkce: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const payloadStore = { putSecret: mockPutSecret() };
    const service = new OAuthConnectorService({
      connectorsCollection: connectors,
      payloadStore,
      idGenerator: () => "unused",
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    });

    const connector = await service.upsertConnector({
      name: "CO2",
      provider: "co2-dev",
      clientId: "new-client",
      clientSecret: "bootstrap-secret",
      authorizationUrl: "https://idp.example.com/oauth/authorize",
      tokenUrl: "https://idp.example.com/oauth/token",
      scopes: ["read"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/co2-dev/callback",
    });

    expect(connector.pkce).toBeUndefined();
    expect(connector.clientSecretConfigured).toBe(true);
    // $unset must actually remove the stored flag (not leave pkce: undefined),
    // otherwise the runtime exchange would send an empty client secret.
    expect(connectors.docs[0]).not.toHaveProperty("pkce");
    expect(payloadStore.putSecret).toHaveBeenCalledWith({
      secretRefId: "oauth_connector:connector-1:client_secret",
      plaintext: "bootstrap-secret",
    });
  });

  it("allows localhost redirect URIs outside production and behind a production opt-in", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    const payloadStore = { putSecret: mockPutSecret() };
    const service = new OAuthConnectorService({
      connectorsCollection: connectors,
      payloadStore,
      idGenerator: () => "connector-1",
    });

    await expect(
      service.createConnector({
        name: "GitHub Local",
        provider: "github",
        clientId: "client-id",
        clientSecret: "client-secret",
        authorizationUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        scopes: ["repo"],
        redirectUri: "http://localhost:3000/api/credentials/oauth/github/callback",
      }),
    ).resolves.toMatchObject({ provider: "github" });

    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      writable: true,
      configurable: true,
    });
    const productionService = new OAuthConnectorService({
      connectorsCollection: new MemoryCollection<OAuthConnectorDocument>(),
      payloadStore,
      idGenerator: () => "connector-2",
    });

    await expect(
      productionService.createConnector({
        name: "GitHub Local",
        provider: "github",
        clientId: "client-id",
        clientSecret: "client-secret",
        authorizationUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        scopes: ["repo"],
        redirectUri: "http://localhost:3000/api/credentials/oauth/github/callback",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    process.env.CREDENTIAL_ALLOW_LOCALHOST_OAUTH_REDIRECTS = "true";
    const optedInProductionService = new OAuthConnectorService({
      connectorsCollection: new MemoryCollection<OAuthConnectorDocument>(),
      payloadStore,
      idGenerator: () => "connector-3",
    });

    await expect(
      optedInProductionService.createConnector({
        name: "GitHub Local",
        provider: "github",
        clientId: "client-id",
        clientSecret: "client-secret",
        authorizationUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        scopes: ["repo"],
        redirectUri: "http://localhost:3000/api/credentials/oauth/github/callback",
      }),
    ).resolves.toMatchObject({ provider: "github" });
  });

  function seededConnector(
    connectors: MemoryCollection<OAuthConnectorDocument>,
    overrides?: Partial<OAuthConnectorDocument>,
  ): OAuthConnectorDocument {
    const doc: OAuthConnectorDocument = {
      id: "connector-1",
      name: "CO2",
      provider: "co2-dev",
      clientId: "old-client",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://idp.example.com/oauth/authorize",
      tokenUrl: "https://idp.example.com/oauth/token",
      scopes: ["read"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/co2-dev/callback",
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    };
    connectors.docs.push(doc);
    return doc;
  }

  function updateInput(overrides?: Partial<Parameters<OAuthConnectorService["updateConnector"]>[1]>) {
    return {
      name: "CO2",
      provider: "co2-dev",
      clientId: "new-client",
      authorizationUrl: "https://idp.example.com/oauth/authorize",
      tokenUrl: "https://idp.example.com/oauth/token",
      scopes: ["read"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/co2-dev/callback",
      ...overrides,
    } as Parameters<OAuthConnectorService["updateConnector"]>[1];
  }

  it("updateConnector promotes a confidential connector to PKCE and clears the secret flag", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    seededConnector(connectors);
    const payloadStore = { putSecret: mockPutSecret() };
    const service = new OAuthConnectorService({
      connectorsCollection: connectors,
      payloadStore,
      idGenerator: () => "unused",
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    });

    const connector = await service.updateConnector("connector-1", updateInput({ pkce: true }));

    expect(connector.pkce).toBe(true);
    expect(connector.clientSecretConfigured).toBe(false);
    expect(connectors.docs[0].pkce).toBe(true);
    // No secret is written for a PKCE (public) client.
    expect(payloadStore.putSecret).not.toHaveBeenCalled();
  });

  it("updateConnector clears the persisted pkce flag when switching PKCE → confidential", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    seededConnector(connectors, { pkce: true });
    const payloadStore = { putSecret: mockPutSecret() };
    const service = new OAuthConnectorService({
      connectorsCollection: connectors,
      payloadStore,
      idGenerator: () => "unused",
    });

    const connector = await service.updateConnector(
      "connector-1",
      updateInput({ pkce: false, clientSecret: "rotated-secret" }),
    );

    expect(connector.pkce).toBeUndefined();
    // $unset must actually remove the stored flag (not leave pkce: undefined).
    expect(connectors.docs[0]).not.toHaveProperty("pkce");
    expect(payloadStore.putSecret).toHaveBeenCalledWith({
      secretRefId: "oauth_connector:connector-1:client_secret",
      plaintext: "rotated-secret",
    });
  });

  it("updateConnector rejects a PKCE → confidential switch with no client secret", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    seededConnector(connectors, { pkce: true });
    const service = new OAuthConnectorService({
      connectorsCollection: connectors,
      payloadStore: { putSecret: mockPutSecret() },
      idGenerator: () => "unused",
    });

    await expect(
      service.updateConnector("connector-1", updateInput({ pkce: false })),
    ).rejects.toMatchObject({ statusCode: 400 });
    // The connector must remain PKCE — the rejected write leaves no half-state.
    expect(connectors.docs[0].pkce).toBe(true);
  });

  it("updateConnector 404s for an unknown connector id", async () => {
    const service = new OAuthConnectorService({
      connectorsCollection: new MemoryCollection<OAuthConnectorDocument>(),
      payloadStore: { putSecret: mockPutSecret() },
      idGenerator: () => "unused",
    });

    await expect(
      service.updateConnector("missing", updateInput({ pkce: true })),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("updateConnector leaves a confidential connector's secret untouched when none is supplied", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    seededConnector(connectors);
    const payloadStore = { putSecret: mockPutSecret() };
    const service = new OAuthConnectorService({
      connectorsCollection: connectors,
      payloadStore,
      idGenerator: () => "unused",
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    });

    const connector = await service.updateConnector(
      "connector-1",
      updateInput({ name: "CO2 Renamed" }),
    );

    expect(connector.name).toBe("CO2 Renamed");
    expect(connector.pkce).toBeUndefined();
    expect(connector.clientSecretConfigured).toBe(true);
    // Editing other fields without providing a secret must not rotate it.
    expect(payloadStore.putSecret).not.toHaveBeenCalled();
    expect(connectors.docs[0]).not.toHaveProperty("pkce");
  });

  it("deleteConnector soft-disables the connector", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    seededConnector(connectors);
    const service = new OAuthConnectorService({
      connectorsCollection: connectors,
      payloadStore: { putSecret: mockPutSecret() },
      idGenerator: () => "unused",
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    });

    await service.deleteConnector("connector-1");

    expect(connectors.docs[0].enabled).toBe(false);
  });

  it("deleteConnector 404s for an unknown connector id", async () => {
    const service = new OAuthConnectorService({
      connectorsCollection: new MemoryCollection<OAuthConnectorDocument>(),
      payloadStore: { putSecret: mockPutSecret() },
      idGenerator: () => "unused",
    });

    await expect(service.deleteConnector("missing")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("boundScopes", () => {
  const connectorScopes = ["read:jira-work", "write:jira-work", "offline_access"];

  it("returns the full connector set when no selection is provided (legacy default)", () => {
    expect(boundScopes(connectorScopes, undefined)).toEqual(connectorScopes);
  });

  it("returns the chosen subset ordered by the connector set", () => {
    expect(boundScopes(connectorScopes, ["offline_access", "read:jira-work"])).toEqual([
      "read:jira-work",
      "offline_access",
    ]);
  });

  it("trims and de-duplicates the requested selection", () => {
    expect(boundScopes(connectorScopes, [" read:jira-work ", "read:jira-work"])).toEqual([
      "read:jira-work",
    ]);
  });

  it("rejects a scope outside the connector's allowed set", () => {
    expect(() => boundScopes(connectorScopes, ["read:jira-work", "admin:org"])).toThrow(
      /not permitted/,
    );
    try {
      boundScopes(connectorScopes, ["admin:org"]);
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 400 });
    }
  });

  it("rejects an empty selection (no zero-scope tokens)", () => {
    expect(() => boundScopes(connectorScopes, [])).toThrow();
    expect(() => boundScopes(connectorScopes, ["   "])).toThrow();
  });
});

describe("ProviderConnectionService", () => {
  it.each([
    { label: "valid OAuth token", connectorId: "connector-primary", remaining: 3_600_000, renewable: true },
    { label: "expired OAuth token", connectorId: "connector-primary", remaining: -1, renewable: true },
    { label: "OAuth token without expiry or refresh", connectorId: "connector-primary", remaining: undefined, renewable: false },
    { label: "static token", connectorId: "static:example", remaining: undefined, renewable: false },
  ])("does not use a revoked $label", async ({ connectorId, remaining, renewable }) => {
    const now = new Date("2026-01-01T00:00:00Z");
    const owner = { type: "user" as const, id: "user-primary" };
    const connections = new MemoryCollection<ProviderConnectionDocument>();
    connections.docs.push({
      id: "connection-primary", connectorId, owner, status: "connected",
      accessTokenRef: "access-primary",
      refreshTokenRef: renewable ? "refresh-primary" : "",
      ...(remaining !== undefined ? { expiresAt: new Date(now.getTime() + remaining) } : {}),
    });
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    connectors.docs.push({
      id: "connector-primary", name: "Example provider", provider: "example",
      clientId: "client-primary", clientSecretRef: "secret-primary",
      authorizationUrl: "https://idp.example.test/authorize",
      tokenUrl: "https://idp.example.test/token", scopes: ["read"],
      redirectUri: "https://app.example.test/callback", enabled: true,
      createdAt: now, updatedAt: now,
    });
    const connectorLookup = jest.spyOn(connectors, "findOne");
    const payloadStore = {
      getSecret: jest.fn(async (ref: string) => {
        if (!ref) throw new Error("not found");
        return `${ref}:value`;
      }),
      putSecret: mockPutSecret(),
    };
    const tokenClient = mockTokenClient({ access_token: "refreshed", expires_in: 3600 });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: connections, connectorsCollection: connectors,
      payloadStore, tokenClient, now: () => now,
    });
    await service.revokeConnection({ connectionId: "connection-primary", owner });
    const connectionUpdate = jest.spyOn(connections, "updateOne");

    await expect(service.refreshConnection("connection-primary")).rejects.toMatchObject({
      statusCode: 401,
      code: "CREDENTIAL_REAUTH_REQUIRED",
    });

    expect(payloadStore.getSecret).not.toHaveBeenCalled();
    expect(payloadStore.putSecret).not.toHaveBeenCalled();
    expect(connectorLookup).not.toHaveBeenCalled();
    expect(tokenClient).not.toHaveBeenCalled();
    expect(connectionUpdate).not.toHaveBeenCalled();
    expect(connections.docs[0].status).toBe("disabled");
  });

  it.each([
    { label: "outside the window", remaining: 300_001, reuse: true },
    { label: "at the boundary", remaining: 300_000, reuse: false },
    { label: "inside the window", remaining: 299_999, reuse: false },
    { label: "expired", remaining: -1, reuse: false },
    { label: "unknown expiry", remaining: undefined, reuse: false },
    { label: "invalid expiry", remaining: NaN, reuse: false },
    { label: "missing stored token", remaining: 3_600_000, missing: true, reuse: false },
  ])("refreshes only when necessary: $label", async ({ remaining, missing, reuse }) => {
    const now = new Date("2026-01-01T00:00:00Z");
    const connections = new MemoryCollection<ProviderConnectionDocument>();
    connections.docs.push({
      id: "connection-primary", connectorId: "connector-primary",
      owner: { type: "user", id: "user-primary" }, status: "connected",
      accessTokenRef: "access-primary", refreshTokenRef: "refresh-primary",
      ...(remaining !== undefined ? { expiresAt: new Date(now.getTime() + remaining) } : {}),
    });
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    connectors.docs.push({
      id: "connector-primary", name: "Example provider", provider: "example",
      clientId: "client-primary", clientSecretRef: "secret-primary",
      authorizationUrl: "https://idp.example.test/authorize",
      tokenUrl: "https://idp.example.test/token", scopes: ["read"],
      redirectUri: "https://app.example.test/callback", enabled: true,
      createdAt: now, updatedAt: now,
    });
    const connectorLookup = jest.spyOn(connectors, "findOne");
    const payloadStore = {
      getSecret: jest.fn(async (ref: string) => {
        if (missing && ref === "access-primary") throw new Error("not found");
        return `${ref}:value`;
      }),
      putSecret: mockPutSecret(),
    };
    const tokenClient = mockTokenClient({ access_token: "refreshed", expires_in: 3600 });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: connections, connectorsCollection: connectors,
      payloadStore, tokenClient, now: () => now,
    });

    const result = await service.refreshConnection("connection-primary");

    if (reuse) {
      expect(result).toEqual({ accessToken: "access-primary:value", expiresIn: 300 });
      expect(tokenClient).not.toHaveBeenCalled();
      expect(connectorLookup).not.toHaveBeenCalled();
      expect(payloadStore.putSecret).not.toHaveBeenCalled();
      // Repeated callers still consult the store; rotated/deleted credentials
      // must not be hidden behind a process-local token cache.
      await service.refreshConnection("connection-primary");
      expect(payloadStore.getSecret.mock.calls.filter(([ref]) => ref === "access-primary")).toHaveLength(2);
    } else {
      expect(result.accessToken).toBe("refreshed");
      expect(tokenClient).toHaveBeenCalledTimes(1);
      expect(payloadStore.putSecret).toHaveBeenCalled();
    }
  });

  it("refreshes provider tokens using connector metadata and stores rotated tokens encrypted", async () => {
    const providerConnections = new MemoryCollection<ProviderConnectionDocument>();
    providerConnections.docs.push({
      id: "conn-1",
      connectorId: "connector-1",
      owner: { type: "user", id: "alice-sub" },
      status: "connected",
      refreshTokenRef: "provider_connection:conn-1:refresh_token",
      accessTokenRef: "provider_connection:conn-1:access_token",
    });
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    connectors.docs.push({
      id: "connector-1",
      name: "GitHub",
      provider: "github",
      clientId: "client-id",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://github.example.com/login/oauth/authorize",
      tokenUrl: "https://github.example.com/login/oauth/access_token",
      scopes: ["repo", "offline_access"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/github/callback",
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const payloadStore = {
      getSecret: jest.fn(async (ref: string) => `${ref}:value`),
      putSecret: mockPutSecret(),
    };
    const tokenClient = mockTokenClient({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
    });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: providerConnections,
      connectorsCollection: connectors,
      payloadStore,
      tokenClient,
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    });

    const token = await service.refreshConnection("conn-1");

    expect(token).toEqual({ accessToken: "new-access-token", expiresIn: 3600 });
    expect(tokenClient).toHaveBeenCalledWith(
      "https://github.example.com/login/oauth/access_token",
      expect.objectContaining({
        client_id: "client-id",
        client_secret: "oauth_connector:connector-1:client_secret:value",
        grant_type: "refresh_token",
        refresh_token: "provider_connection:conn-1:refresh_token:value",
      }),
    );
    expect(payloadStore.putSecret).toHaveBeenCalledWith({
      secretRefId: "provider_connection:conn-1:access_token",
      plaintext: "new-access-token",
    });
    expect(payloadStore.putSecret).toHaveBeenCalledWith({
      secretRefId: "provider_connection:conn-1:refresh_token",
      plaintext: "new-refresh-token",
    });
  });

  it("keeps renewable=true on refresh when the provider omits refresh_token (non-rotating refresh)", async () => {
    const providerConnections = new MemoryCollection<ProviderConnectionDocument>();
    providerConnections.docs.push({
      id: "conn-1",
      connectorId: "connector-1",
      owner: { type: "user", id: "alice-sub" },
      status: "connected",
      refreshTokenRef: "provider_connection:conn-1:refresh_token",
      accessTokenRef: "provider_connection:conn-1:access_token",
      renewable: true,
    });
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    connectors.docs.push({
      id: "connector-1",
      name: "GitHub",
      provider: "github",
      clientId: "client-id",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://github.example.com/login/oauth/authorize",
      tokenUrl: "https://github.example.com/login/oauth/access_token",
      scopes: ["repo", "offline_access"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/github/callback",
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const payloadStore = {
      getSecret: jest.fn(async (ref: string) => `${ref}:value`),
      putSecret: mockPutSecret(),
    };
    const tokenClient = mockTokenClient({
      access_token: "new-access-token",
      expires_in: 3600,
    });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: providerConnections,
      connectorsCollection: connectors,
      payloadStore,
      tokenClient,
      now: () => new Date("2026-05-21T00:00:00.000Z"),
    });

    await service.refreshConnection("conn-1");

    expect(providerConnections.docs[0].renewable).toBe(true);
  });

  it("refreshes PagerDuty PKCE tokens without client_secret", async () => {
    const providerConnections = new MemoryCollection<ProviderConnectionDocument>();
    providerConnections.docs.push({
      id: "conn-1",
      connectorId: "connector-1",
      provider: "pagerduty",
      owner: { type: "user", id: "alice-sub" },
      status: "connected",
      refreshTokenRef: "provider_connection:conn-1:refresh_token",
      accessTokenRef: "provider_connection:conn-1:access_token",
    });
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    connectors.docs.push({
      id: "connector-1",
      name: "PagerDuty",
      provider: "pagerduty",
      clientId: "pagerduty-client-id",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://identity.pagerduty.com/oauth/authorize",
      tokenUrl: "https://identity.pagerduty.com/oauth/token",
      scopes: ["users.read", "incidents.read"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/pagerduty/callback",
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const payloadStore = {
      getSecret: jest.fn(async (ref: string) => `${ref}:value`),
      putSecret: mockPutSecret(),
    };
    const tokenClient = mockTokenClient({
      access_token: "pagerduty-access-token",
      refresh_token: "pagerduty-refresh-token",
      expires_in: 3600,
    });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: providerConnections,
      connectorsCollection: connectors,
      payloadStore,
      tokenClient,
    });

    await service.refreshConnection("conn-1");

    expect(tokenClient).toHaveBeenCalledWith(
      "https://identity.pagerduty.com/oauth/token",
      {
        grant_type: "refresh_token",
        client_id: "pagerduty-client-id",
        refresh_token: "provider_connection:conn-1:refresh_token:value",
      },
    );
    expect(tokenClient).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ client_secret: expect.any(String) }),
    );
  });

  it("reuses the stored access token when no refresh token was issued (GitHub OAuth App)", async () => {
    const providerConnections = new MemoryCollection<ProviderConnectionDocument>();
    providerConnections.docs.push({
      id: "conn-1",
      connectorId: "connector-1",
      provider: "github",
      owner: { type: "user", id: "alice-sub" },
      status: "connected",
      refreshTokenRef: "provider_connection:conn-1:refresh_token",
      accessTokenRef: "provider_connection:conn-1:access_token",
    });
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    connectors.docs.push({
      id: "connector-1",
      name: "GitHub",
      provider: "github",
      clientId: "client-id",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/github/callback",
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    // GitHub OAuth Apps never store a refresh token, so getSecret for the
    // refresh ref fails while the access token is present and long-lived.
    const payloadStore = {
      getSecret: jest.fn(async (ref: string) => {
        if (ref.endsWith(":refresh_token")) {
          throw new Error("Credential payload was not found");
        }
        return `${ref}:value`;
      }),
      putSecret: mockPutSecret(),
    };
    const tokenClient = mockTokenClient({ access_token: "should-not-be-used" });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: providerConnections,
      connectorsCollection: connectors,
      payloadStore,
      tokenClient,
    });

    const token = await service.refreshConnection("conn-1");

    expect(token.accessToken).toBe("provider_connection:conn-1:access_token:value");
    expect(token.expiresIn).toBeUndefined();
    expect(tokenClient).not.toHaveBeenCalled();
    expect(payloadStore.putSecret).not.toHaveBeenCalled();
  });

  it("refreshConnection returns the stored token for a static: connection WITHOUT querying the connector store", async () => {
    const providerConnections = new MemoryCollection<ProviderConnectionDocument>();
    providerConnections.docs.push({
      id: "conn-static",
      connectorId: "static:gitlab", // static token — no OAuth connector exists
      provider: "gitlab",
      owner: { type: "service_account", id: "sa-sub-abc" },
      status: "connected",
      refreshTokenRef: "",
      accessTokenRef: "provider_connection:conn-static:access_token",
    });
    const connectors = new MemoryCollection<OAuthConnectorDocument>(); // empty
    const findOneSpy = jest.spyOn(connectors, "findOne");
    const payloadStore = {
      getSecret: jest.fn(async (ref: string) => {
        if (!ref) throw new Error("Credential payload was not found");
        return `${ref}:value`;
      }),
      putSecret: mockPutSecret(),
    };
    const tokenClient = mockTokenClient({ access_token: "should-not-be-used" });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: providerConnections,
      connectorsCollection: connectors,
      payloadStore,
      tokenClient,
    });

    const token = await service.refreshConnection("conn-static");

    expect(token.accessToken).toBe("provider_connection:conn-static:access_token:value");
    // The static: short-circuit must NOT hit the connector store (which would
    // 404 and break every static-token exchange).
    expect(findOneSpy).not.toHaveBeenCalled();
    expect(tokenClient).not.toHaveBeenCalled();
  });

  it("refreshConnection reuses the stored token when a non-static OAuth connector was deleted", async () => {
    const providerConnections = new MemoryCollection<ProviderConnectionDocument>();
    providerConnections.docs.push({
      id: "conn-orphan",
      connectorId: "connector-deleted", // non-static, but no matching connector row
      provider: "github",
      owner: { type: "user", id: "alice-sub" },
      status: "connected",
      refreshTokenRef: "provider_connection:conn-orphan:refresh_token",
      accessTokenRef: "provider_connection:conn-orphan:access_token",
    });
    const connectors = new MemoryCollection<OAuthConnectorDocument>(); // connector deleted
    const payloadStore = {
      getSecret: jest.fn(async (ref: string) => `${ref}:value`),
      putSecret: mockPutSecret(),
    };
    const tokenClient = mockTokenClient({ access_token: "should-not-be-used" });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: providerConnections,
      connectorsCollection: connectors,
      payloadStore,
      tokenClient,
    });

    const token = await service.refreshConnection("conn-orphan");

    // Graceful degradation: reuse the stored token instead of 404'ing.
    expect(token.accessToken).toBe("provider_connection:conn-orphan:access_token:value");
    expect(tokenClient).not.toHaveBeenCalled();
  });

  it("reuses the stored access token when the provider rejects the refresh grant", async () => {
    const providerConnections = new MemoryCollection<ProviderConnectionDocument>();
    providerConnections.docs.push({
      id: "conn-1",
      connectorId: "connector-1",
      provider: "github",
      owner: { type: "user", id: "alice-sub" },
      status: "connected",
      refreshTokenRef: "provider_connection:conn-1:refresh_token",
      accessTokenRef: "provider_connection:conn-1:access_token",
    });
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    connectors.docs.push({
      id: "connector-1",
      name: "GitHub",
      provider: "github",
      clientId: "client-id",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/github/callback",
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const payloadStore = {
      getSecret: jest.fn(async (ref: string) => `${ref}:value`),
      putSecret: mockPutSecret(),
    };
    const tokenClient = jest.fn<(tokenUrl: string, body: Record<string, string>) => Promise<TokenResponse>>(
      async () => {
        throw new Error("OAuth token exchange failed with 400");
      },
    );
    const service = new ProviderConnectionService({
      providerConnectionsCollection: providerConnections,
      connectorsCollection: connectors,
      payloadStore,
      tokenClient,
    });

    const token = await service.refreshConnection("conn-1");

    expect(token.accessToken).toBe("provider_connection:conn-1:access_token:value");
    expect(tokenClient).toHaveBeenCalledTimes(1);
    expect(payloadStore.putSecret).not.toHaveBeenCalled();
  });

  it("starts and completes an OAuth connection without exposing provider tokens", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    const connections = new MemoryCollection<ProviderConnectionDocument>();
    const payloadStore = {
      getSecret: jest.fn(async (ref: string) => {
        if (ref === "oauth_connector:connector-1:client_secret") return "client-secret";
        return "stored";
      }),
      putSecret: mockPutSecret(),
    };
    connectors.docs.push({
      id: "connector-1",
      name: "GitHub",
      provider: "github",
      clientId: "client-id",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://github.example.com/login/oauth/authorize",
      tokenUrl: "https://github.example.com/login/oauth/access_token",
      scopes: ["repo", "offline_access"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/github/callback",
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const service = new ProviderConnectionService({
      providerConnectionsCollection: connections,
      connectorsCollection: connectors,
      payloadStore,
      tokenClient: mockTokenClient({
        access_token: "provider-access-token",
        refresh_token: "provider-refresh-token",
        expires_in: 3600,
      }),
      idGenerator: () => "provider-connection-1",
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const start = await service.startConnection({
      providerKey: "github",
      owner: { type: "user", id: "alice-sub" },
      state: "state-1",
      codeChallenge: "challenge-1",
    });
    expect(start.authorizationUrl).toContain("state=state-1");
    expect(start.authorizationUrl).toContain("code_challenge=challenge-1");
    expect(start.authorizationUrl).toContain("code_challenge_method=S256");
    expect(start.authorizationUrl).toContain("scope=repo");
    expect(start.authorizationUrl).not.toContain("offline_access");

    const completed = await service.completeConnection({
      providerKey: "github",
      owner: { type: "user", id: "alice-sub" },
      code: "provider-code",
      codeVerifier: "verifier-1",
    });

    expect(completed).toMatchObject({
      id: "provider-connection-1",
      provider: "github",
      status: "connected",
      // A refresh token was returned, so the connection is renewable.
      renewable: true,
    });
    expect(connections.docs[0].renewable).toBe(true);
    expect(JSON.stringify(completed)).not.toContain("provider-access-token");
    expect(JSON.stringify(completed)).not.toContain("provider-refresh-token");
    expect(payloadStore.putSecret).toHaveBeenCalledWith({
      secretRefId: "provider_connection:provider-connection-1:access_token",
      plaintext: "provider-access-token",
    });
    expect(payloadStore.putSecret).toHaveBeenCalledWith({
      secretRefId: "provider_connection:provider-connection-1:refresh_token",
      plaintext: "provider-refresh-token",
    });
  });

  it("requests only the user's chosen subset and persists requested + granted scopes", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    const connections = new MemoryCollection<ProviderConnectionDocument>();
    const payloadStore = {
      getSecret: jest.fn(async () => "client-secret"),
      putSecret: mockPutSecret(),
    };
    connectors.docs.push({
      id: "connector-1",
      name: "Atlassian",
      provider: "atlassian",
      clientId: "client-id",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      scopes: ["read:jira-work", "write:jira-work", "offline_access"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/atlassian/callback",
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: connections,
      connectorsCollection: connectors,
      payloadStore,
      tokenClient: mockTokenClient({
        access_token: "provider-access-token",
        refresh_token: "provider-refresh-token",
        expires_in: 3600,
        scope: "read:jira-work offline_access",
      }),
      idGenerator: () => "provider-connection-1",
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const start = await service.startConnection({
      providerKey: "atlassian",
      owner: { type: "user", id: "alice-sub" },
      state: "state-1",
      codeChallenge: "challenge-1",
      requestedScopes: ["read:jira-work", "offline_access"],
    });
    expect(start.requestedScopes).toEqual(["read:jira-work", "offline_access"]);
    expect(start.authorizationUrl).toContain("scope=read%3Ajira-work+offline_access");
    expect(start.authorizationUrl).not.toContain("write%3Ajira-work");

    const completed = await service.completeConnection({
      providerKey: "atlassian",
      owner: { type: "user", id: "alice-sub" },
      code: "provider-code",
      codeVerifier: "verifier-1",
      requestedScopes: ["read:jira-work", "offline_access"],
    });

    expect(completed.requestedScopes).toEqual(["read:jira-work", "offline_access"]);
    expect(completed.grantedScopes).toEqual(["read:jira-work", "offline_access"]);
    expect(connections.docs[0]).toMatchObject({
      requestedScopes: ["read:jira-work", "offline_access"],
      grantedScopes: ["read:jira-work", "offline_access"],
    });
  });

  it("strips GitHub offline_access from the authorization URL even within a chosen subset", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    const connections = new MemoryCollection<ProviderConnectionDocument>();
    connectors.docs.push({
      id: "connector-1",
      name: "GitHub",
      provider: "github",
      clientId: "client-id",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "read:user", "offline_access"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/github/callback",
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: connections,
      connectorsCollection: connectors,
      payloadStore: { getSecret: jest.fn(async () => "client-secret"), putSecret: mockPutSecret() },
      tokenClient: mockTokenClient({ access_token: "token" }),
    });

    const start = await service.startConnection({
      providerKey: "github",
      owner: { type: "user", id: "alice-sub" },
      state: "state-1",
      codeChallenge: "challenge-1",
      requestedScopes: ["repo", "offline_access"],
    });

    expect(start.requestedScopes).toEqual(["repo", "offline_access"]);
    expect(start.authorizationUrl).toContain("scope=repo");
    expect(start.authorizationUrl).not.toContain("offline_access");
  });

  it("rejects a connect request for a scope outside the connector's allowed set", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    connectors.docs.push({
      id: "connector-1",
      name: "Atlassian",
      provider: "atlassian",
      clientId: "client-id",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      scopes: ["read:jira-work"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/atlassian/callback",
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: new MemoryCollection<ProviderConnectionDocument>(),
      connectorsCollection: connectors,
      payloadStore: { getSecret: jest.fn(async () => "client-secret"), putSecret: mockPutSecret() },
      tokenClient: mockTokenClient({ access_token: "token" }),
    });

    await expect(
      service.startConnection({
        providerKey: "atlassian",
        owner: { type: "user", id: "alice-sub" },
        state: "state-1",
        codeChallenge: "challenge-1",
        requestedScopes: ["read:jira-work", "admin:org"],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("uses PagerDuty PKCE token exchange without client_secret", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    const connections = new MemoryCollection<ProviderConnectionDocument>();
    const payloadStore = {
      getSecret: jest.fn(async () => "pagerduty-client-secret"),
      putSecret: mockPutSecret(),
    };
    const tokenClient = mockTokenClient({
      access_token: "pagerduty-access-token",
      refresh_token: "pagerduty-refresh-token",
      expires_in: 3600,
    });
    connectors.docs.push({
      id: "connector-1",
      name: "PagerDuty",
      provider: "pagerduty",
      clientId: "pagerduty-client-id",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://identity.pagerduty.com/oauth/authorize",
      tokenUrl: "https://identity.pagerduty.com/oauth/token",
      scopes: ["users.read", "incidents.read"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/pagerduty/callback",
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: connections,
      connectorsCollection: connectors,
      payloadStore,
      tokenClient,
      idGenerator: () => "pagerduty-connection-1",
    });

    await service.completeConnection({
      providerKey: "pagerduty",
      owner: { type: "user", id: "alice-sub" },
      code: "pagerduty-code",
      codeVerifier: "pagerduty-verifier",
    });

    expect(tokenClient).toHaveBeenCalledWith(
      "https://identity.pagerduty.com/oauth/token",
      {
        grant_type: "authorization_code",
        client_id: "pagerduty-client-id",
        code: "pagerduty-code",
        code_verifier: "pagerduty-verifier",
        redirect_uri: "https://caipe.example.com/api/credentials/oauth/pagerduty/callback",
      },
    );
    expect(tokenClient).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ client_secret: expect.any(String) }),
    );
  });

  it("exchanges a connector-level PKCE code without reading or sending a client secret", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    const connections = new MemoryCollection<ProviderConnectionDocument>();
    const payloadStore = {
      getSecret: jest.fn(async () => "should-not-be-read"),
      putSecret: mockPutSecret(),
    };
    const tokenClient = mockTokenClient({
      access_token: "co2-access-token",
      expires_in: 3600,
    });
    connectors.docs.push({
      id: "connector-1",
      name: "CO2",
      provider: "co2-dev",
      clientId: "co2-client-id",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://idp.example.com/oauth/authorize",
      tokenUrl: "https://idp.example.com/oauth/token",
      scopes: ["read"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/co2-dev/callback",
      enabled: true,
      pkce: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: connections,
      connectorsCollection: connectors,
      payloadStore,
      tokenClient,
      idGenerator: () => "co2-connection-1",
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    await service.completeConnection({
      providerKey: "co2-dev",
      owner: { type: "user", id: "alice-sub" },
      code: "co2-code",
      codeVerifier: "co2-verifier",
    });

    // A public (PKCE) connector never reads its secret material...
    expect(payloadStore.getSecret).not.toHaveBeenCalled();
    // ...and never includes a client_secret in the token exchange body.
    expect(tokenClient).toHaveBeenCalledWith(
      "https://idp.example.com/oauth/token",
      {
        grant_type: "authorization_code",
        client_id: "co2-client-id",
        code: "co2-code",
        code_verifier: "co2-verifier",
        redirect_uri: "https://caipe.example.com/api/credentials/oauth/co2-dev/callback",
      },
    );
    expect(tokenClient).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ client_secret: expect.any(String) }),
    );
  });

  it("treats non-expiring OAuth tokens without refresh tokens as connected", async () => {
    const connectors = new MemoryCollection<OAuthConnectorDocument>();
    const connections = new MemoryCollection<ProviderConnectionDocument>();
    const payloadStore = {
      getSecret: jest.fn(async () => "client-secret"),
      putSecret: mockPutSecret(),
    };
    connectors.docs.push({
      id: "connector-1",
      name: "GitHub",
      provider: "github",
      clientId: "client-id",
      clientSecretRef: "oauth_connector:connector-1:client_secret",
      authorizationUrl: "https://github.example.com/login/oauth/authorize",
      tokenUrl: "https://github.example.com/login/oauth/access_token",
      scopes: ["repo", "read:user"],
      redirectUri: "https://caipe.example.com/api/credentials/oauth/github/callback",
      enabled: true,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: connections,
      connectorsCollection: connectors,
      payloadStore,
      tokenClient: mockTokenClient({ access_token: "provider-access-token" }),
      idGenerator: () => "provider-connection-1",
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    await expect(
      service.completeConnection({
        providerKey: "github",
        owner: { type: "user", id: "alice-sub" },
        code: "provider-code",
        codeVerifier: "verifier-1",
      }),
    ).resolves.toMatchObject({
      provider: "github",
      status: "connected",
      // No refresh token returned ⇒ not renewable, but still connected.
      renewable: false,
    });
    expect(connections.docs[0].renewable).toBe(false);

    expect(payloadStore.putSecret).toHaveBeenCalledWith({
      secretRefId: "provider_connection:provider-connection-1:access_token",
      plaintext: "provider-access-token",
    });
    expect(payloadStore.putSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ secretRefId: "provider_connection:provider-connection-1:refresh_token" }),
    );
  });

  describe("registerStaticToken", () => {
    function makeConnector(overrides?: Partial<OAuthConnectorDocument>): OAuthConnectorDocument {
      return {
        id: "connector-1",
        name: "GitLab",
        provider: "gitlab",
        clientId: "client-id",
        clientSecretRef: "oauth_connector:connector-1:client_secret",
        authorizationUrl: "https://gitlab.example.com/oauth/authorize",
        tokenUrl: "https://gitlab.example.com/oauth/token",
        scopes: ["api", "read_repository"],
        redirectUri: "https://caipe.example.com/api/credentials/oauth/gitlab/callback",
        enabled: true,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        ...overrides,
      };
    }

    function makeService(
      connectors: MemoryCollection<OAuthConnectorDocument>,
      connections: MemoryCollection<ProviderConnectionDocument>,
      overrides?: Partial<ProviderConnectionServiceOptions>,
    ) {
      return new ProviderConnectionService({
        providerConnectionsCollection: connections,
        connectorsCollection: connectors,
        payloadStore: {
          getSecret: jest.fn(async () => "secret"),
          putSecret: mockPutSecret(),
        },
        tokenClient: mockTokenClient({ access_token: "should-not-be-used" }),
        idGenerator: () => "static-conn-1",
        now: () => new Date("2026-06-08T00:00:00.000Z"),
        ...overrides,
      });
    }

    it("creates a connected, refresh-less connection for a service_account owner", async () => {
      const connectors = new MemoryCollection<OAuthConnectorDocument>();
      const connections = new MemoryCollection<ProviderConnectionDocument>();
      connectors.docs.push(makeConnector());
      const putSecret = mockPutSecret();
      const service = makeService(connectors, connections, {
        payloadStore: {
          getSecret: jest.fn(async () => "secret"),
          putSecret,
        },
      });

      const result = await service.registerStaticToken({
        providerKey: "gitlab",
        owner: { type: "service_account", id: "sa-sub-abc" },
        accessToken: "glpat-mysecrettoken",
      });

      expect(result).toMatchObject({
        id: "static-conn-1",
        provider: "gitlab",
        status: "connected",
        owner: { type: "service_account", id: "sa-sub-abc" },
      });
      // No token material in the returned metadata
      expect(JSON.stringify(result)).not.toContain("glpat-mysecrettoken");
      // No expiresAt on a static token
      expect(result.expiresAt).toBeUndefined();
    });

    it("stores the access token secret but writes no refresh token secret", async () => {
      const connectors = new MemoryCollection<OAuthConnectorDocument>();
      const connections = new MemoryCollection<ProviderConnectionDocument>();
      connectors.docs.push(makeConnector());
      const putSecret = mockPutSecret();
      const service = makeService(connectors, connections, {
        payloadStore: {
          getSecret: jest.fn(async () => "secret"),
          putSecret,
        },
      });

      await service.registerStaticToken({
        providerKey: "gitlab",
        owner: { type: "service_account", id: "sa-sub-abc" },
        accessToken: "glpat-mysecrettoken",
      });

      expect(putSecret).toHaveBeenCalledTimes(1);
      expect(putSecret).toHaveBeenCalledWith({
        secretRefId: "provider_connection:static-conn-1:access_token",
        plaintext: "glpat-mysecrettoken",
      });
      // Confirm no refresh_token secret was written
      const calls = putSecret.mock.calls as Array<[{ secretRefId: string; plaintext: string }]>;
      expect(calls.every(([{ secretRefId }]) => !secretRefId.includes("refresh_token"))).toBe(true);
    });

    it("persists the document with the correct shape (no refresh token ref set)", async () => {
      const connectors = new MemoryCollection<OAuthConnectorDocument>();
      const connections = new MemoryCollection<ProviderConnectionDocument>();
      connectors.docs.push(makeConnector());
      const service = makeService(connectors, connections);

      await service.registerStaticToken({
        providerKey: "gitlab",
        owner: { type: "service_account", id: "sa-sub-abc" },
        accessToken: "glpat-mysecrettoken",
      });

      expect(connections.docs).toHaveLength(1);
      const doc = connections.docs[0];
      expect(doc).toMatchObject({
        id: "static-conn-1",
        // Synthetic connectorId — a PAT has no OAuth connector. Derived from the
        // provider key, never used to resolve anything downstream.
        connectorId: "static:gitlab",
        provider: "gitlab",
        owner: { type: "service_account", id: "sa-sub-abc" },
        status: "connected",
        accessTokenRef: "provider_connection:static-conn-1:access_token",
      });
      // refreshTokenRef is set to empty string (not a real secret ref)
      expect(doc.refreshTokenRef).toBe("");
      expect(doc.expiresAt).toBeUndefined();
      // Raw token must never appear in the stored document
      expect(JSON.stringify(doc)).not.toContain("glpat-mysecrettoken");
    });

    it("accepts a user owner (owner-agnostic)", async () => {
      const connectors = new MemoryCollection<OAuthConnectorDocument>();
      const connections = new MemoryCollection<ProviderConnectionDocument>();
      connectors.docs.push(makeConnector());
      const service = makeService(connectors, connections);

      const result = await service.registerStaticToken({
        providerKey: "gitlab",
        owner: { type: "user", id: "alice-sub" },
        accessToken: "glpat-usertok",
      });

      expect(result.owner).toEqual({ type: "user", id: "alice-sub" });
      expect(result.status).toBe("connected");
    });

    it("stores requestedScopes verbatim (a PAT carries its own scopes; no bounding)", async () => {
      const connectors = new MemoryCollection<OAuthConnectorDocument>();
      const connections = new MemoryCollection<ProviderConnectionDocument>();
      const service = makeService(connectors, connections);

      const result = await service.registerStaticToken({
        providerKey: "gitlab",
        owner: { type: "service_account", id: "sa-sub-abc" },
        accessToken: "glpat-mysecrettoken",
        requestedScopes: ["api", "read_repository"],
      });

      // Not bounded to any connector scope list — stored as provided.
      expect(result.requestedScopes).toEqual(["api", "read_repository"]);
    });

    it("does NOT require an OAuth connector to exist (PATs need no OAuth app)", async () => {
      // Empty connector collection — the previous implementation 404'd here
      // ("OAuth connector was not found"); a PAT must succeed regardless.
      const connections = new MemoryCollection<ProviderConnectionDocument>();
      const service = makeService(
        new MemoryCollection<OAuthConnectorDocument>(),
        connections,
      );

      const result = await service.registerStaticToken({
        providerKey: "gitlab",
        owner: { type: "service_account", id: "sa-sub-abc" },
        accessToken: "glpat-mysecrettoken",
      });

      expect(result).toMatchObject({
        provider: "gitlab",
        status: "connected",
        connectorId: "static:gitlab",
      });
      expect(connections.docs).toHaveLength(1);
    });

    it("rejects an empty or blank accessToken", async () => {
      const service = makeService(
        new MemoryCollection<OAuthConnectorDocument>(),
        new MemoryCollection<ProviderConnectionDocument>(),
      );

      await expect(
        service.registerStaticToken({
          providerKey: "gitlab",
          owner: { type: "service_account", id: "sa-sub-abc" },
          accessToken: "   ",
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("rejects an empty or blank providerKey", async () => {
      const service = makeService(
        new MemoryCollection<OAuthConnectorDocument>(),
        new MemoryCollection<ProviderConnectionDocument>(),
      );

      await expect(
        service.registerStaticToken({
          providerKey: "  ",
          owner: { type: "service_account", id: "sa-sub-abc" },
          accessToken: "some-token",
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("does not call tokenClient (no OAuth exchange for static tokens)", async () => {
      const connectors = new MemoryCollection<OAuthConnectorDocument>();
      const connections = new MemoryCollection<ProviderConnectionDocument>();
      connectors.docs.push(makeConnector());
      const tokenClient = mockTokenClient({ access_token: "should-not-be-used" });
      const service = makeService(connectors, connections, { tokenClient });

      await service.registerStaticToken({
        providerKey: "gitlab",
        owner: { type: "service_account", id: "sa-sub-abc" },
        accessToken: "glpat-mysecrettoken",
      });

      expect(tokenClient).not.toHaveBeenCalled();
    });
  });

  it("lists provider connection metadata for an owner without token refs", async () => {
    const providerConnections = new MemoryCollection<ProviderConnectionDocument>();
    providerConnections.docs.push({
      id: "conn-1",
      connectorId: "connector-1",
      provider: "github",
      owner: { type: "user", id: "alice-sub" },
      status: "connected",
      refreshTokenRef: "provider_connection:conn-1:refresh_token",
      accessTokenRef: "provider_connection:conn-1:access_token",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const service = new ProviderConnectionService({
      providerConnectionsCollection: providerConnections,
      connectorsCollection: new MemoryCollection<OAuthConnectorDocument>(),
      payloadStore: {
        getSecret: jest.fn(async () => "secret"),
        putSecret: mockPutSecret(),
      },
      tokenClient: mockTokenClient({ access_token: "token" }),
    });

    await expect(service.listConnections({ type: "user", id: "alice-sub" })).resolves.toEqual([
      {
        id: "conn-1",
        connectorId: "connector-1",
        provider: "github",
        owner: { type: "user", id: "alice-sub" },
        status: "connected",
        connectedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
  });

  it("prunes duplicate active provider connections and keeps the newest", async () => {
    const providerConnections = new MemoryCollection<ProviderConnectionDocument>();
    providerConnections.docs.push(
      {
        id: "conn-old",
        connectorId: "connector-1",
        provider: "atlassian",
        owner: { type: "user", id: "alice-sub" },
        status: "connected",
        refreshTokenRef: "provider_connection:conn-old:refresh_token",
        accessTokenRef: "provider_connection:conn-old:access_token",
        connectedAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: "conn-new",
        connectorId: "connector-1",
        provider: "atlassian",
        owner: { type: "user", id: "alice-sub" },
        status: "connected",
        refreshTokenRef: "provider_connection:conn-new:refresh_token",
        accessTokenRef: "provider_connection:conn-new:access_token",
        connectedAt: new Date("2026-02-01T00:00:00Z"),
        updatedAt: new Date("2026-02-01T00:00:00Z"),
      },
    );
    const service = new ProviderConnectionService({
      providerConnectionsCollection: providerConnections,
      connectorsCollection: new MemoryCollection<OAuthConnectorDocument>(),
      payloadStore: {
        getSecret: jest.fn(async () => "secret"),
        putSecret: mockPutSecret(),
      },
      tokenClient: mockTokenClient({ access_token: "token" }),
    });

    await expect(service.listConnections({ type: "user", id: "alice-sub" })).resolves.toEqual([
      expect.objectContaining({ id: "conn-new", status: "connected" }),
    ]);
    expect(providerConnections.docs.find((doc) => doc.id === "conn-old")?.status).toBe("disabled");
  });
});
