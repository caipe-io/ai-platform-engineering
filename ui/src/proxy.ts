import { NextRequest, NextResponse } from "next/server";

import { AGENTIC_APP_PUBLIC_BASE, AGENTIC_APP_RUNTIME_BASE } from "@/lib/agentic-apps/runtime";

const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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
export function proxy(request: NextRequest): NextResponse {
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
  matcher: ["/apps/:path*"],
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
