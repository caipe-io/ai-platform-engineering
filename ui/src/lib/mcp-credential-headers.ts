/**
 * Resolve MCP server credential_sources into outbound HTTP headers for probe/test paths.
 */

// assisted-by Codex Codex-sonnet-4-6

import { getCredentialRetrievalService } from "@/lib/credentials/retrieval-service-factory";
import {
  effectiveConnectionScope,
  isMcpCredentialUnavailableError,
  resolveProviderConnectionCredential,
} from "@/lib/mcp-credential-resolution";
import { isDevAnonymousAuthEnabled } from "@/lib/auth/dev-auth-provider";
import type { MCPCredentialSource, MCPServerConfig } from "@/types/dynamic-agent";
import type { NextRequest } from "next/server";
import type { ResourceAuthzSession } from "@/lib/rbac/resource-authz";

export type McpCredentialOrigin =
  | "secret_ref"
  | "provider_connection"
  | "fallback_env"
  | "user_jwt"
  | "client_credentials"
  | "none";

export interface McpCredentialSourceDebug {
  name: string;
  kind: MCPCredentialSource["kind"];
  origin: McpCredentialOrigin;
  provider?: string;
  provider_connection_id?: string;
  connection_scope?: MCPCredentialSource["connection_scope"];
}

export interface McpCredentialResolution {
  headers: Record<string, string>;
  sources: McpCredentialSourceDebug[];
  authorizationSubject?: {
    type: "service_account";
    id: string;
  };
}

interface ServiceTokenCacheEntry {
  accessToken: string;
  expiresAtMs: number;
}

const serviceTokenCache = new Map<string, ServiceTokenCacheEntry>();

export {
  MCP_CREDENTIAL_UNAVAILABLE,
  McpCredentialUnavailableError,
  isMcpCredentialUnavailableError,
} from "@/lib/mcp-credential-resolution";

function isProviderBearerSource(headerName: string): boolean {
  const normalized = headerName.trim().toLowerCase();
  return (
    normalized === "authorization" ||
    normalized === "x-caipe-token" ||
    normalized === "x-caipe-provider-token"
  );
}

export function providerCredentialHeader(sourceName: string, viaAgentGateway: boolean): string {
  return viaAgentGateway && isProviderBearerSource(sourceName) ? "X-CAIPE-Provider-Token" : sourceName;
}

export function providerCredentialValue(
  credential: string,
  sourceName: string,
  headerName: string,
  viaAgentGateway: boolean,
): string {
  if (viaAgentGateway && headerName.toLowerCase() === "x-caipe-provider-token") {
    return credential.replace(/^Bearer\s+/i, "");
  }
  if (sourceName.toLowerCase() === "authorization" && !credential.toLowerCase().startsWith("bearer ")) {
    return `Bearer ${credential}`;
  }
  return credential;
}

function credentialServiceHeaders(caller: string): Headers {
  return new Headers({
    authorization: `Bearer ${caller}`,
    "x-caipe-credential-caller": "mcp_runtime",
    "x-caipe-credential-audience": process.env.CREDENTIAL_SERVICE_AUDIENCE || "caipe-credential-service",
  });
}

function tokenEndpointFromIssuer(value: string | undefined): string | null {
  const issuer = value?.trim().replace(/\/+$/, "");
  if (!issuer) return null;
  if (issuer.endsWith("/protocol/openid-connect/token")) return issuer;
  const withoutDiscovery = issuer.replace(/\/\.well-known\/openid-configuration$/, "");
  return `${withoutDiscovery}/protocol/openid-connect/token`;
}

function serviceTokenConfig(): { tokenUrl: string; clientId: string; clientSecret: string } | null {
  const tokenUrl =
    process.env.MCP_SERVICE_OIDC_TOKEN_URL?.trim() ||
    process.env.OAUTH2_TOKEN_URL?.trim() ||
    tokenEndpointFromIssuer(process.env.INGESTOR_OIDC_DISCOVERY_URL) ||
    tokenEndpointFromIssuer(process.env.INGESTOR_OIDC_ISSUER) ||
    tokenEndpointFromIssuer(process.env.OIDC_DISCOVERY_URL) ||
    tokenEndpointFromIssuer(process.env.OIDC_ISSUER) ||
    tokenEndpointFromIssuer(
      process.env.KEYCLOAK_URL
        ? `${process.env.KEYCLOAK_URL.replace(/\/+$/, "")}/realms/${process.env.KEYCLOAK_REALM || "caipe"}`
        : undefined,
    );
  const clientId =
    process.env.MCP_SERVICE_OIDC_CLIENT_ID?.trim() ||
    process.env.INGESTOR_OIDC_CLIENT_ID?.trim() ||
    process.env.OAUTH2_CLIENT_ID?.trim() ||
    process.env.OIDC_CLIENT_ID?.trim() ||
    process.env.KEYCLOAK_RESOURCE_SERVER_ID?.trim() ||
    "caipe-platform";
  const clientSecret =
    process.env.MCP_SERVICE_OIDC_CLIENT_SECRET?.trim() ||
    process.env.INGESTOR_OIDC_CLIENT_SECRET?.trim() ||
    process.env.OAUTH2_CLIENT_SECRET?.trim() ||
    process.env.OIDC_CLIENT_SECRET?.trim() ||
    process.env.KEYCLOAK_CLIENT_SECRET?.trim();

  if (!tokenUrl || !clientId || !clientSecret) return null;
  return { tokenUrl, clientId, clientSecret };
}

async function mintServiceClientCredentialsToken(): Promise<string | null> {
  const config = serviceTokenConfig();
  if (!config) return null;

  const cacheKey = `${config.tokenUrl}|${config.clientId}`;
  const now = Date.now();
  const cached = serviceTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs - 30_000 > now) return cached.accessToken;

  try {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      console.warn(`[mcp-credential-headers] service token request failed: ${response.status}`);
      return null;
    }
    const payload = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== "string" || !payload.access_token.trim()) return null;
    const expiresInSeconds = typeof payload.expires_in === "number" ? payload.expires_in : 300;
    serviceTokenCache.set(cacheKey, {
      accessToken: payload.access_token,
      expiresAtMs: now + expiresInSeconds * 1000,
    });
    return payload.access_token;
  } catch (error) {
    console.warn(
      `[mcp-credential-headers] service token request failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
    return null;
  }
}

function asBearerToken(value: string): string {
  return value.toLowerCase().startsWith("bearer ") ? value : `Bearer ${value}`;
}

function serviceAccountSubjectFromToken(value: string): string | null {
  const token = value.replace(/^Bearer\s+/i, "");
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown };
    return typeof claims.sub === "string" && claims.sub.trim() ? claims.sub.trim() : null;
  } catch {
    return null;
  }
}

async function resolveSourceCredential(
  session: ResourceAuthzSession,
  source: MCPCredentialSource,
  server: MCPServerConfig,
  viaAgentGateway: boolean,
  retrievalCaller: string,
  callerAuthorization: string | null,
): Promise<{ credential: string; origin: McpCredentialOrigin; debug: McpCredentialSourceDebug } | null> {
  if (source.target !== "header") return null;

  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name) return null;

  const scope = effectiveConnectionScope(source);
  const baseDebug: McpCredentialSourceDebug = {
    name,
    kind: source.kind,
    origin: "none",
    connection_scope: scope,
    ...(source.provider ? { provider: source.provider } : {}),
    ...(source.provider_connection_id ? { provider_connection_id: source.provider_connection_id } : {}),
  };

  if (source.kind === "secret_ref" && source.secret_ref) {
    const service = await getCredentialRetrievalService();
    const result = await service.retrieve({
      headers: credentialServiceHeaders(retrievalCaller),
      body: { secret_ref: source.secret_ref, intended_use: "mcp_server" },
      session,
    });
    return {
      credential: result.credential,
      origin: "secret_ref",
      debug: { ...baseDebug, origin: "secret_ref" },
    };
  }

  if (source.kind === "provider_connection") {
    try {
      const exchanged = await resolveProviderConnectionCredential({
        session,
        source,
        mcpServer: server,
      });
      if (exchanged) {
        return {
          credential: exchanged.token,
          origin: "provider_connection",
          debug: {
            ...baseDebug,
            origin: "provider_connection",
            provider: exchanged.provider,
            provider_connection_id: exchanged.providerConnectionId,
            connection_scope: scope,
          },
        };
      }
    } catch (error) {
      // A missing/unconnected provider connection is expected when the caller
      // hasn't registered a credential yet — fall through to fallback_env.
      if (!isMcpCredentialUnavailableError(error)) {
        throw error;
      }
    }

    const fallbackEnv = source.fallback_env?.trim();
    if (fallbackEnv) {
      const envValue = process.env[fallbackEnv]?.trim();
      if (envValue) {
        return {
          credential: envValue,
          origin: "fallback_env",
          debug: { ...baseDebug, origin: "fallback_env" },
        };
      }
    }

    return {
      credential: "",
      origin: "none",
      debug: { ...baseDebug, origin: "none" },
    };
  }

  if (source.kind === "caller_token") {
    if (callerAuthorization) {
      return {
        credential: callerAuthorization,
        origin: "user_jwt",
        debug: { ...baseDebug, origin: "user_jwt" },
      };
    }

    if (source.fallback_client_credentials) {
      const minted = await mintServiceClientCredentialsToken();
      if (minted) {
        return {
          credential: minted,
          origin: "client_credentials",
          debug: { ...baseDebug, origin: "client_credentials" },
        };
      }
    }

    return {
      credential: "",
      origin: "none",
      debug: { ...baseDebug, origin: "none" },
    };
  }

  return null;
}

export function userAuthorizationHeader(
  request: NextRequest,
  session: ResourceAuthzSession & { accessToken?: string },
): string | null {
  const sessionToken = typeof session.accessToken === "string" ? session.accessToken.trim() : "";
  if (sessionToken) {
    return sessionToken.toLowerCase().startsWith("bearer ") ? sessionToken : `Bearer ${sessionToken}`;
  }

  const requestAuthorization = request.headers.get("authorization")?.trim();
  return requestAuthorization?.toLowerCase().startsWith("bearer ") ? requestAuthorization : null;
}

export async function resolveMcpHeaderCredentials(input: {
  request: NextRequest;
  session: ResourceAuthzSession & { accessToken?: string };
  server: MCPServerConfig;
  viaAgentGateway: boolean;
  retrievalCaller?: string;
}): Promise<McpCredentialResolution> {
  const headers: Record<string, string> = {};
  const sources: McpCredentialSourceDebug[] = [];
  const retrievalCaller = input.retrievalCaller ?? "mcp-http-server-client";
  const callerAuthorization = userAuthorizationHeader(input.request, input.session);
  let agentGatewayServiceAuthorization: string | null = null;
  let agentGatewayServiceSubject: string | null = null;

  for (const source of input.server.credential_sources ?? []) {
    const resolved = await resolveSourceCredential(
      input.session,
      source,
      input.server,
      input.viaAgentGateway,
      retrievalCaller,
      callerAuthorization,
    );
    if (!resolved) continue;

    sources.push(resolved.debug);
    if (resolved.origin === "none" || !resolved.credential) {
      continue;
    }

    const headerName = providerCredentialHeader(source.name, input.viaAgentGateway);
    headers[headerName] = providerCredentialValue(
      resolved.credential,
      source.name,
      headerName,
      input.viaAgentGateway,
    );
    if (source.kind === "caller_token" && resolved.origin === "client_credentials") {
      agentGatewayServiceAuthorization = asBearerToken(resolved.credential);
      agentGatewayServiceSubject = serviceAccountSubjectFromToken(resolved.credential);
    }
  }

  if (input.viaAgentGateway) {
    // Local no-SSO mode still exercises AgentGateway's real JWT validation
    // path. Use the configured platform client only for that explicit dev
    // mode; production callers must continue to supply their own user token.
    if (!callerAuthorization && !agentGatewayServiceAuthorization && isDevAnonymousAuthEnabled()) {
      const minted = await mintServiceClientCredentialsToken();
      if (minted) {
        agentGatewayServiceAuthorization = asBearerToken(minted);
        agentGatewayServiceSubject = serviceAccountSubjectFromToken(minted);
      }
    }

    const authorization = callerAuthorization ?? agentGatewayServiceAuthorization;
    if (!authorization) {
      throw new Error("MCP_AUTH_REQUIRED");
    }
    headers.Authorization = authorization;
  }

  return {
    headers,
    sources,
    ...(agentGatewayServiceSubject
      ? { authorizationSubject: { type: "service_account" as const, id: agentGatewayServiceSubject } }
      : {}),
  };
}

export function _resetMcpCredentialHeaderTokenCacheForTests(): void {
  serviceTokenCache.clear();
}

export function readMcpToolApplicationSuccess(toolResult: unknown): boolean | undefined {
  if (!toolResult || typeof toolResult !== "object") return undefined;
  const record = toolResult as Record<string, unknown>;
  if (record.isError === true) return false;

  const structured = record.structuredContent;
  if (structured && typeof structured === "object") {
    const fromStructured = parseEmbeddedToolSuccess((structured as { result?: unknown }).result);
    if (fromStructured !== undefined) return fromStructured;
  }

  if (Array.isArray(record.content)) {
    for (const item of record.content) {
      if (!item || typeof item !== "object") continue;
      if ((item as { type?: unknown }).type !== "text") continue;
      const fromText = parseEmbeddedToolSuccess((item as { text?: unknown }).text);
      if (fromText !== undefined) return fromText;
    }
  }

  return undefined;
}

function parseEmbeddedToolSuccess(value: unknown): boolean | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as { success?: unknown };
    return typeof parsed.success === "boolean" ? parsed.success : undefined;
  } catch {
    return undefined;
  }
}
