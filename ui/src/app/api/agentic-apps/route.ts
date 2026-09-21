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
import { buildPublicAgenticApp } from "@/lib/agentic-apps/public-app";
import { ApiError, getAuthenticatedUser } from "@/lib/api-middleware";

export async function GET(request: NextRequest): Promise<Response> {
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
  const items = loadConfiguredAgenticApps()
    .filter(
      (app) =>
        app.installation.installed
        && app.installation.enabled
        && app.installation.visible
        && app.manifest.surfaces.showInHub,
    )
    .map((app) => buildPublicAgenticApp(app, canLaunchAgenticApp(app, userContext)));

  return Response.json({ items }, { headers: { "cache-control": "no-store" } });
}
