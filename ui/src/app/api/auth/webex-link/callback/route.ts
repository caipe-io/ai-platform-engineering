import { NextRequest, NextResponse } from "next/server";

import { getRequestOrigin } from "@/app/api/skills/_lib/request-origin";
import { ApiError, getAuthFromBearerOrSession, withErrorHandler } from "@/lib/api-middleware";
import { BUILT_IN_OAUTH_CONNECTORS } from "@/lib/credentials/built-in-oauth-connectors";
import { exchangeOAuthToken } from "@/lib/credentials/oauth-service-factory";
import { oauthStateCookieName, parseOAuthStateCookie } from "@/lib/credentials/oauth-state";
import { getWebexLinkAllowedOrgId, isWebexIdentityLinkingEnabled } from "@/lib/integration-config";
import { claimWebexIdentity } from "@/lib/rbac/webex-identity-link";

const WEBEX_LINK_PROVIDER_KEY = "webex-link";
const SETTINGS_PATH = "/settings/account-and-access";

function assertConfigured(): void {
  if (!isWebexIdentityLinkingEnabled()) {
    throw new ApiError("Webex identity linking is not configured", 404, "WEBEX_LINK_NOT_CONFIGURED");
  }
}

function webexTokenUrl(): string {
  const descriptor = BUILT_IN_OAUTH_CONNECTORS.find((connector) => connector.provider === "webex");
  if (!descriptor) {
    throw new ApiError("Webex OAuth descriptor is missing", 500, "WEBEX_DESCRIPTOR_MISSING");
  }
  return descriptor.tokenUrl;
}

// Webex's /v1/people/me returns orgId as a base64 global ID
// (ciscospark://<cluster>/ORGANIZATION/<uuid>), not the raw UUID used
// elsewhere (e.g. WEBEX_LINK_ALLOWED_ORG_ID). Decode it before comparing.
function decodeWebexOrgId(rawOrgId: string): string {
  try {
    const decoded = Buffer.from(rawOrgId, "base64").toString("utf8");
    const match = /\/ORGANIZATION\/([^/]+)$/.exec(decoded);
    if (match) return match[1];
  } catch {
    // fall through to the raw value below
  }
  return rawOrgId;
}

function readCookie(request: NextRequest, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return rawValue.join("=");
  }
  return undefined;
}

function settingsRedirect(request: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL(SETTINGS_PATH, getRequestOrigin(request));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextResponse(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "set-cookie": `${oauthStateCookieName(WEBEX_LINK_PROVIDER_KEY)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
}

function errorRedirect(request: NextRequest, reason: string): NextResponse {
  return settingsRedirect(request, { webex_link: "error", reason });
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  assertConfigured();

  const { session } = await getAuthFromBearerOrSession(request);
  const ownerId = typeof session.sub === "string" ? session.sub : "";
  if (!ownerId) {
    throw new ApiError("Authenticated subject is required", 401, "UNAUTHORIZED");
  }

  return await completeLink(request, ownerId);
});

async function completeLink(request: NextRequest, ownerId: string): Promise<NextResponse> {
  const searchParams = new URL(request.url).searchParams;
  const providerError = searchParams.get("error");
  if (providerError) {
    return errorRedirect(request, providerError);
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !state) {
    return errorRedirect(request, "MISSING_CODE_OR_STATE");
  }

  const stateCookie = readCookie(request, oauthStateCookieName(WEBEX_LINK_PROVIDER_KEY));
  if (!stateCookie) {
    return errorRedirect(request, "INVALID_OAUTH_STATE");
  }

  let parsedState;
  try {
    parsedState = parseOAuthStateCookie(stateCookie);
  } catch {
    return errorRedirect(request, "INVALID_OAUTH_STATE");
  }

  if (parsedState.state !== state || parsedState.ownerId !== ownerId) {
    return errorRedirect(request, "INVALID_OAUTH_STATE");
  }

  let accessToken: string;
  try {
    const tokenResponse = await exchangeOAuthToken(webexTokenUrl(), {
      grant_type: "authorization_code",
      client_id: process.env.WEBEX_LINK_CLIENT_ID ?? "",
      client_secret: process.env.WEBEX_LINK_CLIENT_SECRET ?? "",
      redirect_uri: process.env.WEBEX_LINK_REDIRECT_URI ?? "",
      code,
      code_verifier: parsedState.codeVerifier,
    });
    accessToken = tokenResponse.access_token;
  } catch {
    return errorRedirect(request, "TOKEN_EXCHANGE_FAILED");
  }

  if (!accessToken) {
    return errorRedirect(request, "TOKEN_EXCHANGE_FAILED");
  }

  let person: { id?: string; orgId?: string; emails?: string[] };
  try {
    const meResponse = await fetch("https://webexapis.com/v1/people/me", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!meResponse.ok) {
      return errorRedirect(request, "WEBEX_PROFILE_FETCH_FAILED");
    }
    person = (await meResponse.json()) as { id?: string; orgId?: string; emails?: string[] };
  } catch {
    return errorRedirect(request, "WEBEX_PROFILE_FETCH_FAILED");
  }

  if (!person.id) {
    return errorRedirect(request, "WEBEX_PROFILE_FETCH_FAILED");
  }

  const decodedOrgId = person.orgId ? decodeWebexOrgId(person.orgId) : undefined;
  if (decodedOrgId !== getWebexLinkAllowedOrgId()) {
    console.error(
      "[webex-link] org mismatch",
      { gotOrgId: person.orgId, decodedOrgId, allowedOrgId: getWebexLinkAllowedOrgId() },
    );
    return errorRedirect(request, "WEBEX_ORG_MISMATCH");
  }

  const webexEmail = person.emails?.[0]?.trim();
  try {
    await claimWebexIdentity(person.id, ownerId, {
      webex_user_id: [person.id],
      webex_user_email: webexEmail ? [webexEmail] : undefined,
    });
  } catch {
    return errorRedirect(request, "WEBEX_ID_ALREADY_LINKED");
  }

  return settingsRedirect(request, { webex_link: "success" });
}
