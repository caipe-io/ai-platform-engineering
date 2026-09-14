import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import {
  agenticAppUserContextFromSession,
  canLaunchAgenticApp,
} from "@/lib/agentic-apps/access";
import { evaluateAgenticAppCasCompatibility } from "@/lib/agentic-apps/cas-compat";
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
  const subjectId = deriveAgenticAppSubjectId(auth.session as Record<string, unknown>);
  if (!subjectId) {
    return Response.json(
      { error: "A stable user subject is required", code: "NO_SUBJECT" },
      { status: 401 },
    );
  }

  const userContext = agenticAppUserContextFromSession(
    auth.session as Record<string, unknown>,
    auth.user.role,
  );
  const configuredApps = loadConfiguredAgenticApps()
    .filter(
      (app) =>
        app.installation.installed
        && app.installation.enabled
        && app.installation.visible
        && app.manifest.surfaces.showInHub,
    );
  const correlationId = request.headers.get("x-correlation-id") ?? randomUUID();
  const items = (
    await Promise.all(
      configuredApps.map(async (app) => {
        const localCanLaunch = canLaunchAgenticApp(app, userContext);
        if (!app.manifest.authorization) {
          return buildPublicAgenticApp(app, localCanLaunch);
        }
        const [readDecision, launchDecision] = await Promise.all([
          evaluateAgenticAppCasCompatibility({
            appId: app.installation.appId,
            subjectId,
            localEffect: "allow",
            correlationId,
            action: "read",
          }),
          evaluateAgenticAppCasCompatibility({
            appId: app.installation.appId,
            subjectId,
            localEffect: localCanLaunch ? "allow" : "deny",
            correlationId,
            action: app.manifest.authorization.launchAction,
          }),
        ]);
        if (readDecision.effectiveEffect !== "allow") return null;
        return buildPublicAgenticApp(
          app,
          launchDecision.effectiveEffect === "allow",
        );
      }),
    )
  ).filter((app): app is NonNullable<typeof app> => app !== null);

  return Response.json({ items }, { headers: { "cache-control": "no-store" } });
}
