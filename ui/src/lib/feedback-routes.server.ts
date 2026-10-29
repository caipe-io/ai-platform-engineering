import { agenticAppUserContextFromSession, canLaunchAgenticApp } from "@/lib/agentic-apps/access";
import { loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import { agenticAppHostPaths } from "@/lib/agentic-apps/host-routes";
import { getServerConfig } from "@/lib/config";
import { buildFeedbackRoutes, parseFeedbackRoutes, type FeedbackRoute } from "@/lib/feedback-routing";

/** Resolve destinations again on submission; a browser cannot choose a repository. */
export function availableFeedbackRoutes(session: Record<string, unknown>, role?: string): FeedbackRoute[] {
  const cfg = getServerConfig();
  const apps = loadConfiguredAgenticApps();
  const context = agenticAppUserContextFromSession(session, role);
  const allowedApps = apps.filter(app => canLaunchAgenticApp(app, context));
  const allowedIds = new Set(allowedApps.map(app => app.installation.appId));
  const routes = buildFeedbackRoutes(parseFeedbackRoutes(process.env.FEEDBACK_ROUTES),
    cfg.ticketProvider, cfg.githubTicketRepo, cfg.jiraTicketProject);
  const merged = new Map(routes.filter(route => !route.appId || allowedIds.has(route.appId))
    .map(route => [route.id, route]));
  for (const app of allowedApps) {
    const destination = app.installation.feedback !== undefined
      ? app.installation.feedback : app.manifest.catalog?.feedback;
    if (!destination) continue;
    const route: FeedbackRoute = {
      id: `app-${app.installation.appId}`,
      label: app.manifest.displayName,
      appId: app.installation.appId,
      pathPrefixes: [...agenticAppHostPaths(app), `/apps/${app.installation.appId}`],
      ...destination,
    };
    // A deployment's explicit area entry takes precedence over publisher metadata.
    if (!merged.has(route.id)) merged.set(route.id, route);
  }
  return [...merged.values()].map(route => ({
    ...route,
    canAttachScreenshot: route.provider === "jira" || Boolean(cfg.githubScreenshotsRepo),
  }));
}
