import { NextRequest } from "next/server";

import { ApiError, getAuthenticatedUser } from "@/lib/api-middleware";
import {
  agenticAppUserContextFromSession,
  canLaunchAgenticApp,
} from "@/lib/agentic-apps/access";
import {
  getConfiguredAgenticApp,
  isAgenticAppsEnabled,
} from "@/lib/agentic-apps/config";
import { deriveAgenticAppSubjectId } from "@/lib/agentic-apps/identity";
import { buildPublicAgenticApp } from "@/lib/agentic-apps/public-app";

/** Authorized lookup is independent of public catalog visibility. */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ appId: string }> },
): Promise<Response> {
  if (!isAgenticAppsEnabled())
    return Response.json({ error: "app_not_found" }, { status: 404 });
  let auth: Awaited<ReturnType<typeof getAuthenticatedUser>>;
  try {
    auth = await getAuthenticatedUser(request, { allowAnonymous: false });
  } catch (error) {
    if (error instanceof ApiError)
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.statusCode },
      );
    throw error;
  }
  const session = auth.session as Record<string, unknown>;
  if (!deriveAgenticAppSubjectId(session))
    return Response.json({ error: "stable_subject_required" }, { status: 401 });
  const { appId } = await context.params;
  const app = getConfiguredAgenticApp(appId);
  if (
    !app ||
    !app.installation.installed ||
    !app.installation.enabled ||
    !app.manifest.ui.profiles.length
  ) {
    return Response.json({ error: "app_not_found" }, { status: 404 });
  }
  if (
    !canLaunchAgenticApp(
      app,
      agenticAppUserContextFromSession(session, auth.user.role),
    )
  ) {
    return Response.json({ error: "app_unauthorized" }, { status: 403 });
  }
  return Response.json(
    { item: buildPublicAgenticApp(app, true) },
    { headers: { "cache-control": "no-store" } },
  );
}
