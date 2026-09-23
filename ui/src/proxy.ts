import { NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";

import { AGENTIC_APP_PUBLIC_BASE, AGENTIC_APP_RUNTIME_BASE } from "@/lib/agentic-apps/runtime";

const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const SESSION_COOKIE_NAME = "next-auth.session-token";
const IMPERSONATION_EXIT_PATHS = new Set([
  "/api/auth/session",
  "/api/auth/signout",
]);

function isCredentialPath(pathname: string): boolean {
  return pathname.startsWith("/api/credentials")
    || pathname.startsWith("/api/auth/webex-link");
}

function isReadOnlyMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

async function blockImpersonatedMutation(
  request: NextRequest,
): Promise<NextResponse | null> {
  const { pathname } = request.nextUrl;
  const method = request.method.toUpperCase();
  if (isReadOnlyMethod(method) && !isCredentialPath(pathname)) return null;
  if (IMPERSONATION_EXIT_PATHS.has(pathname)) return null;

  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME)
    || request.cookies.has(`__Secure-${SESSION_COOKIE_NAME}`);
  if (!hasSessionCookie) return null;

  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
    cookieName: request.cookies.has(SESSION_COOKIE_NAME)
      ? SESSION_COOKIE_NAME
      : `__Secure-${SESSION_COOKIE_NAME}`,
  });
  if (!token?.impersonation) return null;

  return NextResponse.json(
    {
      success: false,
      error: "Impersonation is read-only. Exit impersonation and sign in as yourself to perform this action.",
      code: "IMPERSONATION_READ_ONLY",
    },
    { status: 403 },
  );
}

/**
 * Keep the canonical browser URL at /apps/<id> while routing the embedded
 * application's own HTML, assets, and API calls through the private BFF.
 *
 * A top-level document reaches the host shell. Browser requests made by the
 * shell's iframe use the same public prefix and are rewritten to the
 * authenticated runtime route. Host launch links intentionally use normal
 * document navigation, rather than client-side routing, so applications can
 * build once for /apps/<id>/ without exposing their private origin.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const blocked = await blockImpersonatedMutation(request);
  if (blocked) return blocked;

  const { pathname } = request.nextUrl;
  const appPath = parseAgenticAppPath(pathname);

  if (!appPath || isHostShellRequest(request)) {
    return NextResponse.next();
  }

  const runtimeUrl = request.nextUrl.clone();
  runtimeUrl.pathname = `${AGENTIC_APP_RUNTIME_BASE}${appPath}`;

  const response = NextResponse.rewrite(runtimeUrl);
  // The original request URL is /apps/*, whose host page is DENY-framed by
  // default. Replace that value only for traffic routed into the app iframe.
  response.headers.set("x-frame-options", "SAMEORIGIN");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function parseAgenticAppPath(pathname: string): string | null {
  if (!pathname.startsWith(`${AGENTIC_APP_PUBLIC_BASE}/`)) return null;

  const appPath = pathname.slice(AGENTIC_APP_PUBLIC_BASE.length);
  const encodedAppId = appPath.split("/", 2)[1];
  if (!encodedAppId) return null;

  let appId: string;
  try {
    appId = decodeURIComponent(encodedAppId);
  } catch {
    return null;
  }

  if (appId === "embed" || !APP_ID_PATTERN.test(appId)) return null;
  return appPath;
}

function isHostShellRequest(request: NextRequest): boolean {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  return request.headers.get("sec-fetch-dest")?.toLowerCase() === "document";
}
