/**
 * @jest-environment node
 */

// assisted-by Codex Codex-sonnet-4-6

import { NextRequest } from "next/server";

import {
  _resetMcpCredentialHeaderTokenCacheForTests,
  readMcpToolApplicationSuccess,
  resolveMcpHeaderCredentials,
} from "@/lib/mcp-credential-headers";

const mockRetrieve = jest.fn();
const mockGetCredentialRetrievalService = jest.fn();
const mockGetProviderConnectionService = jest.fn();
const mockRefreshConnection = jest.fn();
const mockListConnections = jest.fn();
const mockGetConnection = jest.fn();
const mockIsCredentialFeatureEnabled = jest.fn();

jest.mock("@/lib/credentials/retrieval-service-factory", () => ({
  getCredentialRetrievalService: (...args: unknown[]) => mockGetCredentialRetrievalService(...args),
}));

jest.mock("@/lib/credentials/oauth-service-factory", () => ({
  getProviderConnectionService: (...args: unknown[]) => mockGetProviderConnectionService(...args),
}));

jest.mock("@/lib/feature-flags/credentials", () => ({
  isCredentialFeatureEnabled: (...args: unknown[]) => mockIsCredentialFeatureEnabled(...args),
}));

jest.mock("@/lib/rbac/resource-authz", () => ({
  requireResourcePermission: jest.fn(),
}));

describe("mcp-credential-headers", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = originalFetch;
    delete process.env.MCP_SERVICE_OIDC_TOKEN_URL;
    delete process.env.MCP_SERVICE_OIDC_CLIENT_ID;
    delete process.env.MCP_SERVICE_OIDC_CLIENT_SECRET;
    mockGetCredentialRetrievalService.mockResolvedValue({ retrieve: mockRetrieve });
    mockGetProviderConnectionService.mockResolvedValue({
      listConnections: mockListConnections,
      getConnection: mockGetConnection,
      refreshConnection: mockRefreshConnection,
    });
    mockIsCredentialFeatureEnabled.mockReturnValue(true);
    mockRetrieve.mockResolvedValue({ credential: "secret-token" });
    _resetMcpCredentialHeaderTokenCacheForTests();
    mockListConnections.mockResolvedValue([
      {
        id: "atlassian-conn-1",
        provider: "atlassian",
        status: "connected",
        owner: { type: "user", id: "user-sub" },
      },
    ]);
    mockRefreshConnection.mockResolvedValue({ accessToken: "atlassian-oauth-token", expiresIn: 3600 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.MCP_SERVICE_OIDC_TOKEN_URL;
    delete process.env.MCP_SERVICE_OIDC_CLIENT_ID;
    delete process.env.MCP_SERVICE_OIDC_CLIENT_SECRET;
  });

  it("exchanges provider_connection credentials onto X-CAIPE-Provider-Token for AgentGateway", async () => {
    const request = new NextRequest("http://localhost:3000/api/mcp-servers/test-tool", { method: "POST" });
    const resolution = await resolveMcpHeaderCredentials({
      request,
      session: { sub: "user-sub", accessToken: "user-jwt" },
      viaAgentGateway: true,
      server: {
        _id: "jira",
        id: "jira",
        name: "Jira",
        transport: "http",
        enabled: true,
        credential_sources: [
          {
            kind: "provider_connection",
            target: "header",
            name: "X-CAIPE-Provider-Token",
            provider: "atlassian",
          },
        ],
      },
    });

    expect(resolution.headers.Authorization).toBe("Bearer user-jwt");
    expect(resolution.headers["X-CAIPE-Provider-Token"]).toBe("atlassian-oauth-token");
    expect(resolution.sources).toEqual([
      expect.objectContaining({
        kind: "provider_connection",
        origin: "provider_connection",
        provider: "atlassian",
        provider_connection_id: "atlassian-conn-1",
      }),
    ]);
    expect(mockRefreshConnection).toHaveBeenCalledWith("atlassian-conn-1");
  });

  it("resolves with origin=none when caller-scoped provider connection is not connected and no fallback_env is set", async () => {
    mockListConnections.mockResolvedValue([]);
    const request = new NextRequest("http://localhost:3000/api/mcp-servers/test-tool", { method: "POST" });

    const result = await resolveMcpHeaderCredentials({
      request,
      session: { sub: "user-sub", accessToken: "user-jwt" },
      viaAgentGateway: true,
      server: {
        _id: "jira",
        id: "jira",
        name: "Jira",
        transport: "http",
        enabled: true,
        credential_sources: [
          {
            kind: "provider_connection",
            target: "header",
            name: "X-CAIPE-Provider-Token",
            provider: "atlassian",
            connection_scope: "caller",
          },
        ],
      },
    });

    expect(result.sources).toEqual([
      expect.objectContaining({ kind: "provider_connection", origin: "none", provider: "atlassian" }),
    ]);
  });

  it("forwards caller_token credentials as the provider token for AgentGateway-routed RAG", async () => {
    const request = new NextRequest("http://localhost:3000/api/mcp-servers/probe", { method: "POST" });
    const resolution = await resolveMcpHeaderCredentials({
      request,
      session: { sub: "user-sub", accessToken: "user-jwt" },
      viaAgentGateway: true,
      server: {
        _id: "knowledge-base",
        id: "knowledge-base",
        name: "Knowledge Base",
        transport: "http",
        enabled: true,
        credential_sources: [
          {
            kind: "caller_token",
            target: "header",
            name: "X-CAIPE-Provider-Token",
            fallback_client_credentials: true,
          },
        ],
      },
    });

    expect(resolution.headers.Authorization).toBe("Bearer user-jwt");
    expect(resolution.headers["X-CAIPE-Provider-Token"]).toBe("user-jwt");
    expect(resolution.sources).toEqual([
      expect.objectContaining({
        kind: "caller_token",
        origin: "user_jwt",
      }),
    ]);
  });

  it("preserves non-provider caller-token headers for direct upstreams", async () => {
    const request = new NextRequest("http://localhost:3000/api/mcp-servers/probe", { method: "POST" });
    const resolution = await resolveMcpHeaderCredentials({
      request,
      session: { sub: "user-sub", accessToken: "user-jwt" },
      viaAgentGateway: false,
      server: {
        _id: "scheduler",
        id: "scheduler",
        name: "Scheduler",
        transport: "http",
        enabled: true,
        credential_sources: [
          {
            kind: "caller_token",
            target: "header",
            name: "X-CAIPE-Caller-Token",
          },
        ],
      },
    });

    expect(resolution.headers).toEqual({ "X-CAIPE-Caller-Token": "Bearer user-jwt" });
  });

  it("uses caller_token client-credentials fallback when no user JWT is available", async () => {
    process.env.MCP_SERVICE_OIDC_TOKEN_URL = "http://keycloak/token";
    process.env.MCP_SERVICE_OIDC_CLIENT_ID = "caipe-platform";
    process.env.MCP_SERVICE_OIDC_CLIENT_SECRET = "secret";
    const fetchMock = jest.fn().mockResolvedValue(
      Response.json({ access_token: "service-jwt", expires_in: 300 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const request = new NextRequest("http://localhost:3000/api/mcp-servers/probe", { method: "POST" });
    const resolution = await resolveMcpHeaderCredentials({
      request,
      session: { sub: "system-probe" },
      viaAgentGateway: true,
      server: {
        _id: "knowledge-base",
        id: "knowledge-base",
        name: "Knowledge Base",
        transport: "http",
        enabled: true,
        credential_sources: [
          {
            kind: "caller_token",
            target: "header",
            name: "X-CAIPE-Provider-Token",
            fallback_client_credentials: true,
          },
        ],
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://keycloak/token",
      expect.objectContaining({
        method: "POST",
        body: expect.any(URLSearchParams),
      }),
    );
    expect(resolution.headers.Authorization).toBe("Bearer service-jwt");
    expect(resolution.headers["X-CAIPE-Provider-Token"]).toBe("service-jwt");
    expect(resolution.sources).toEqual([
      expect.objectContaining({
        kind: "caller_token",
        origin: "client_credentials",
      }),
    ]);
  });

  it("detects nested application failures in MCP tool payloads", () => {
    expect(
      readMcpToolApplicationSuccess({
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: "Failed to fetch Jira issue",
            }),
          },
        ],
      }),
    ).toBe(false);
  });
});
