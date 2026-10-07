import { ApiError } from "@/lib/api-error";

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

const ADMIN_PATH_ALLOWLIST = /^\/[a-zA-Z0-9/_.-]*$/;

let tokenCache: TokenCache | null = null;

function assertAllowedAdminPath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!ADMIN_PATH_ALLOWLIST.test(normalized) || normalized.includes("..")) {
    throw new ApiError("Webex bot admin path is not allowed", 400);
  }
  return normalized;
}

function webexBotAdminBaseUrl(): string {
  return (process.env.WEBEX_BOT_ADMIN_URL || "http://webex-bot:3002").replace(
    /\/$/,
    ""
  );
}

function webexBotAdminTokenUrl(): string {
  const explicit = process.env.WEBEX_BOT_ADMIN_TOKEN_URL?.trim();
  if (explicit) return explicit;
  const issuer = (process.env.OIDC_DISCOVERY_URL || process.env.OIDC_ISSUER || "").replace(/\/$/, "");
  if (!issuer) {
    throw new ApiError("OIDC issuer is not configured for Webex bot admin calls", 503);
  }
  return `${issuer}/protocol/openid-connect/token`;
}

async function getWebexBotAdminToken(signal?: AbortSignal): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt > now + 30) {
    return tokenCache.accessToken;
  }

  const clientSecret =
    process.env.WEBEX_BOT_ADMIN_CLIENT_SECRET?.trim() ||
    process.env.OIDC_CLIENT_SECRET?.trim();
  if (!clientSecret) {
    throw new ApiError(
      "WEBEX_BOT_ADMIN_CLIENT_SECRET (or OIDC_CLIENT_SECRET) is not configured",
      503
    );
  }

  const clientId =
    process.env.WEBEX_BOT_ADMIN_CLIENT_ID?.trim() ||
    process.env.OIDC_CLIENT_ID?.trim() ||
    "caipe-ui";

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const audience = process.env.WEBEX_BOT_ADMIN_AUDIENCE || "caipe-webex-bot-admin";
  if (audience) body.set("audience", audience);
  const scope = process.env.WEBEX_BOT_ADMIN_SCOPE;
  if (scope) body.set("scope", scope);

  const response = await fetch(webexBotAdminTokenUrl(), {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new ApiError(`Webex bot admin token request failed: ${response.status}`, 502);
  }
  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new ApiError("Webex bot admin token response did not include access_token", 502);
  }
  tokenCache = {
    accessToken: payload.access_token,
    expiresAt: now + (payload.expires_in ?? 300),
  };
  return payload.access_token;
}

export async function callWebexBotAdmin<T>(
  path: string,
  options: {
    method?: "GET" | "POST";
    body?: unknown;
    query?: Record<string, string | number | boolean | undefined>;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  const safePath = assertAllowedAdminPath(path);
  const token = await getWebexBotAdminToken(options.signal);
  const method = options.method ?? "GET";
  const url = new URL(`${webexBotAdminBaseUrl()}${safePath}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    signal: options.signal,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      typeof payload?.error === "string"
        ? `Webex bot admin request failed: ${payload.error}`
        : `Webex bot admin request failed: ${response.status}`,
      response.status >= 400 && response.status < 500 ? response.status : 502
    );
  }
  return payload as T;
}

export function _resetWebexBotAdminTokenCacheForTests(): void {
  tokenCache = null;
}
