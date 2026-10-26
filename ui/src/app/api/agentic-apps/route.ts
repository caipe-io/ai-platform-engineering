import { NextRequest } from "next/server";

import {
  agenticAppUserContextFromSession,
  canLaunchAgenticApp,
} from "@/lib/agentic-apps/access";
import {
  isAgenticAppsEnabled,
  loadConfiguredAgenticApps,
} from "@/lib/agentic-apps/config";
import { deriveAgenticAppSubjectId } from "@/lib/agentic-apps/identity";
import { agenticAppHostPaths } from "@/lib/agentic-apps/host-routes";
import { buildPublicAgenticApp } from "@/lib/agentic-apps/public-app";
import { ApiError, getAuthenticatedUser } from "@/lib/api-middleware";

export async function GET(request: NextRequest): Promise<Response> {
  const navigationOnly = request.nextUrl.searchParams.get("surface") === "navigation";
  if (!isAgenticAppsEnabled()) {
    return Response.json({ items: [] });
  }

  let auth: Awaited<ReturnType<typeof getAuthenticatedUser>>;
  try {
    auth = await getAuthenticatedUser(request, { allowAnonymous: false });
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.statusCode },
      );
    }
    throw error;
  }
  if (!deriveAgenticAppSubjectId(auth.session as Record<string, unknown>)) {
    return Response.json(
      { error: "A stable user subject is required", code: "NO_SUBJECT" },
      { status: 401 },
    );
  }

  const userContext = agenticAppUserContextFromSession(
    auth.session as Record<string, unknown>,
    auth.user.role,
  );
  const configuredApps = loadConfiguredAgenticApps();
  const items = configuredApps
    .filter(
      (app) =>
        app.installation.installed
        && app.installation.enabled
        && app.installation.visible
        && app.manifest.ui.profiles.length > 0
        && (navigationOnly ? Boolean(app.manifest.ui.navigation) : app.manifest.surfaces.showInHub),
    )
    .map((app) => buildPublicAgenticApp(app, canLaunchAgenticApp(app, userContext)))
    .filter(app => !navigationOnly || (app.canLaunch && Boolean(app.navigation)))
    .sort((a, b) => (a.navigation?.order ?? Number.MAX_SAFE_INTEGER) - (b.navigation?.order ?? Number.MAX_SAFE_INTEGER));

  const hostPaths = navigationOnly ? configuredApps.filter(app => canLaunchAgenticApp(app, userContext))
    .flatMap(agenticAppHostPaths) : undefined;
  return Response.json({ items, ...(hostPaths ? { hostPaths } : {}) }, { headers: { "cache-control": "no-store" } });
}
