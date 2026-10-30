import { NextRequest } from "next/server";
import { getAuthFromBearerOrSession, requireRbacPermission, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { isAgenticAppsEnabled, loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import { PLATFORM_CONFIG_ID } from "@/lib/platform-default-agent";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");
  await requireResourcePermission(session, { type: "system_config", id: PLATFORM_CONFIG_ID, action: "admin" });
  return successResponse({ items: isAgenticAppsEnabled() ? loadConfiguredAgenticApps().filter((app) => app.installation.installed && app.installation.enabled && app.manifest.ui.assistant).map((app) => ({ appId: app.installation.appId, displayName: app.manifest.displayName })) : [] });
});
