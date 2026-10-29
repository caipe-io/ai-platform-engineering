import { NextRequest, NextResponse } from "next/server";
import { RESERVED_HOST_PATHS } from "../app-sdk/reserved-paths.mjs";
import { isAgenticAppsEnabled, loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import { agenticAppForHostPath } from "@/lib/agentic-apps/host-routes";
import { RUNTIME_NEXT_URL_HEADER } from "@/lib/agentic-apps/request-headers";

import { AGENTIC_APP_PUBLIC_BASE, AGENTIC_APP_RUNTIME_BASE } from "@/lib/agentic-apps/runtime";
import {
  nativeExtensionForApiPath,
} from "@/native-extensions/runtime";

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
  // Only the public app rewrite may supply this transport header. In
  // particular, direct callers of the authenticated runtime route cannot.
  if (pathname.startsWith(`${AGENTIC_APP_RUNTIME_BASE}/`)) {
    const headers = new Headers(request.headers);
    headers.delete(RUNTIME_NEXT_URL_HEADER);
    return NextResponse.next({ request: { headers } });
  }
  const nativeApiExtension = nativeExtensionForApiPath(pathname);
  if (nativeApiExtension) {
    const runtimeUrl = request.nextUrl.clone();
    runtimeUrl.pathname = `${nativeApiExtension.api.basePath}${pathname}`;
    return NextResponse.rewrite(runtimeUrl);
  }

  // Runtime selection takes precedence over compiled native page claims.
  // Admission remains in the destination page and authenticated app gateway.
  // Reserved host routes never depend on optional app configuration.
  const isReservedHostPath = RESERVED_HOST_PATHS.some(root =>
    pathname === root || (root !== "/" && pathname.startsWith(`${root}/`)));
  if (!isReservedHostPath && isAgenticAppsEnabled()) {
    try {
      const owner = agenticAppForHostPath(loadConfiguredAgenticApps(), pathname);
      if (owner) {
        const profile = owner.manifest.ui.profiles.find(p => p.id === owner.installation.selectedUiProfile);
        const url = request.nextUrl.clone();
        url.pathname = profile?.mode === "iframe"
          ? `/agentic-app-routes/${owner.installation.appId}${pathname}`
          : `/native-extensions/${owner.installation.appId}${pathname}`;
        return NextResponse.rewrite(url);
      }
    } catch {
      return NextResponse.json({ error: "Application route configuration unavailable" }, { status: 503 });
    }
  }
  const appPath = parseAgenticAppPath(pathname);

  if (!appPath || isHostShellRequest(request)) {
    return NextResponse.next();
  }

  const runtimeUrl = request.nextUrl.clone();
  runtimeUrl.pathname = `${AGENTIC_APP_RUNTIME_BASE}${appPath}`;

  const headers = new Headers(request.headers);
  headers.delete(RUNTIME_NEXT_URL_HEADER);
  const nextUrl = headers.get("next-url");
  if (nextUrl !== null) headers.set(RUNTIME_NEXT_URL_HEADER, nextUrl);
  const response = NextResponse.rewrite(runtimeUrl, { request: { headers } });
  // The original request URL is /apps/*, whose host page is DENY-framed by
  // default. Replace that value only for traffic routed into the app iframe.
  response.headers.set("x-frame-options", "SAMEORIGIN");
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.ico|robots.txt|sitemap.xml).*)",
  ],
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
