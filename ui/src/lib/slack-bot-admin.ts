import { ApiError } from "@/lib/api-error";

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

function slackBotAdminBaseUrl(): string {
  return (process.env.SLACK_BOT_ADMIN_URL || "http://ai-platform-engineering-slack-bot:3001").replace(/\/$/, "");
}

function slackBotAdminTokenUrl(): string {
  const explicit = process.env.SLACK_BOT_ADMIN_TOKEN_URL?.trim();
  if (explicit) return explicit;
  const issuer = (process.env.OIDC_DISCOVERY_URL || process.env.OIDC_ISSUER || "").replace(/\/$/, "");
  if (!issuer) {
    throw new ApiError("OIDC issuer is not configured for Slack bot admin calls", 503);
  }
  return `${issuer}/protocol/openid-connect/token`;
}

function getSlackBotAdminDevToken(): string | null {
  if (process.env.SLACK_BOT_ADMIN_DEV_AUTH_ENABLED !== "true") {
    return null;
  }
  const token = process.env.SLACK_BOT_ADMIN_DEV_TOKEN?.trim();
  if (!token) {
    throw new ApiError("SLACK_BOT_ADMIN_DEV_TOKEN is required when dev Slack admin auth is enabled", 503);
  }
  return token;
}

async function getSlackBotAdminToken(signal?: AbortSignal): Promise<string> {
  const devToken = getSlackBotAdminDevToken();
  if (devToken) {
    return devToken;
  }

  const now = Math.floor(Date.now() / 1000);
  if (tokenCache && tokenCache.expiresAt > now + 30) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.OIDC_CLIENT_ID || "caipe-ui";
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  if (!clientSecret) {
    throw new ApiError("OIDC_CLIENT_SECRET is not configured for Slack bot admin calls", 503);
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const audience = process.env.SLACK_BOT_ADMIN_AUDIENCE || "caipe-slack-bot-admin";
  if (audience) body.set("audience", audience);
  const scope = process.env.SLACK_BOT_ADMIN_SCOPE;
  if (scope) body.set("scope", scope);

  const response = await fetch(slackBotAdminTokenUrl(), {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new ApiError(`Slack bot admin token request failed: ${response.status}`, 502);
  }
  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new ApiError("Slack bot admin token response did not include access_token", 502);
  }
  tokenCache = {
    accessToken: payload.access_token,
    expiresAt: now + (payload.expires_in ?? 300),
  };
  return payload.access_token;
}

export async function callSlackBotAdmin<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {}
): Promise<T> {
  const token = await getSlackBotAdminToken(options.signal);
  const method = options.method ?? "GET";
  const response = await fetch(`${slackBotAdminBaseUrl()}${path}`, {
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
        ? `Slack bot admin request failed: ${payload.error}`
        : `Slack bot admin request failed: ${response.status}`,
      response.status >= 400 && response.status < 500 ? response.status : 502
    );
  }
  return payload as T;
}

export function _resetSlackBotAdminTokenCacheForTests(): void {
  tokenCache = null;
}
