import { NextRequest, NextResponse } from "next/server";

import { getRequestOrigin } from "@/app/api/skills/_lib/request-origin";
import {
  ApiError,
  getAuthFromBearerOrSession,
  withErrorHandler,
} from "@/lib/api-middleware";
import { BUILT_IN_OAUTH_CONNECTORS } from "@/lib/credentials/built-in-oauth-connectors";
import {
  createOAuthStateCookie,
  oauthStateCookieName,
  pkceChallenge,
  randomOAuthValue,
} from "@/lib/credentials/oauth-state";
import { getWebexLinkScopes, isWebexIdentityLinkingEnabled } from "@/lib/integration-config";

const WEBEX_LINK_PROVIDER_KEY = "webex-link";

function assertConfigured(): void {
  if (!isWebexIdentityLinkingEnabled()) {
    throw new ApiError("Webex identity linking is not configured", 404, "WEBEX_LINK_NOT_CONFIGURED");
  }
}

// This route is meant to be opened via a full browser navigation (a link
// shared in a Webex DM or by an admin), not called via background fetch()
// like other API routes. A bare JSON 401 is the wrong response shape here —
// send the browser through the normal sign-in page instead, with a
// callbackUrl that lands it right back on this same request once signed in.
function signInRedirect(request: NextRequest): NextResponse {
  const requestUrl = new URL(request.url);
  const loginUrl = new URL("/login", getRequestOrigin(request));
  loginUrl.searchParams.set("callbackUrl", `${requestUrl.pathname}${requestUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

function webexAuthorizationUrl(): string {
  const descriptor = BUILT_IN_OAUTH_CONNECTORS.find((connector) => connector.provider === "webex");
  if (!descriptor) {
    throw new ApiError("Webex OAuth descriptor is missing", 500, "WEBEX_DESCRIPTOR_MISSING");
  }
  return descriptor.authorizationUrl;
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  assertConfigured();
  const auth = await getAuthFromBearerOrSession(request).catch((error: unknown) => {
    if (error instanceof ApiError && error.code === "NOT_SIGNED_IN") {
      return null;
    }
    throw error;
  });
  if (!auth) {
    return signInRedirect(request);
  }
  const { session } = auth;
  const ownerId = typeof session.sub === "string" ? session.sub : "";
  if (!ownerId) {
    throw new ApiError("Authenticated subject is required", 401, "UNAUTHORIZED");
  }

  const state = randomOAuthValue(24);
  const codeVerifier = randomOAuthValue(48);

  const authorizeUrl = new URL(webexAuthorizationUrl());
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", process.env.WEBEX_LINK_CLIENT_ID ?? "");
  authorizeUrl.searchParams.set("redirect_uri", process.env.WEBEX_LINK_REDIRECT_URI ?? "");
  authorizeUrl.searchParams.set("scope", getWebexLinkScopes());
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const requestUrl = new URL(request.url);
  const secureCookie = process.env.NODE_ENV === "production" || requestUrl.protocol === "https:";
  const cookie = `${oauthStateCookieName(WEBEX_LINK_PROVIDER_KEY)}=${createOAuthStateCookie({
    providerKey: WEBEX_LINK_PROVIDER_KEY,
    ownerId,
    state,
    codeVerifier,
  })}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secureCookie ? "; Secure" : ""}`;

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl.toString(),
      "set-cookie": cookie,
    },
  });
});
