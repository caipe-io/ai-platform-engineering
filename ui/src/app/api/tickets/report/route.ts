import { NextRequest, NextResponse } from "next/server";

import { agenticAppUserContextFromSession, canLaunchAgenticApp } from "@/lib/agentic-apps/access";
import { loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import { agenticAppHostPaths, ownsAppPath } from "@/lib/agentic-apps/host-routes";
import { proxyAgenticAppRequest } from "@/lib/agentic-apps/proxy";
import { ApiError, requireConversationAccess, validateConversationId, withErrorHandler } from "@/lib/api-middleware";
import { getServerConfig } from "@/lib/config";
import { authenticateRequest, type AuthResult } from "@/lib/da-proxy";
import { appGitHubFeedbackSettings, createGitHubFeedback, createPlatformGitHubFeedback, platformFeedbackCapabilities, platformFeedbackHandler } from "@/lib/feedback-github";
import { parseFeedbackFeatures, platformFeedbackFeatures } from "@/lib/feedback-features";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { requireConversationResourcePermission } from "@/lib/rbac/conversation-implicit-authz";
import type { ConfiguredAgenticApp } from "@/types/agentic-app";

type Reporter = NonNullable<AuthResult["authenticatedUser"]>;

/** Resolve both the category list and submission destination from the same ownership. */
async function feedbackApp(contextUrl: unknown, conversationId: unknown, reporter: Reporter, componentId?: unknown): Promise<ConfiguredAgenticApp | undefined> {
  if (typeof contextUrl !== "string") throw new ApiError("contextUrl is required", 400);
  let url: URL;
  try { url = new URL(contextUrl); }
  catch { throw new ApiError("Invalid contextUrl", 400); }
  if (!["http:", "https:"].includes(url.protocol)) throw new ApiError("Invalid contextUrl", 400);
  const apps = loadConfiguredAgenticApps();
  conversationId ??= url.pathname.match(/^\/chat\/([^/]+)$/)?.[1];
  let conversationAppId: string | undefined;
  if (conversationId !== undefined && isMongoDBConfigured) {
    if (typeof conversationId !== "string" || !validateConversationId(conversationId)) throw new ApiError("Invalid conversation ID", 400);
    const { conversation } = await requireConversationAccess(conversationId, reporter.user.email, getCollection, reporter.session);
    await requireConversationResourcePermission(reporter.session, reporter.user.email, conversation, "read");
    if (typeof conversation.metadata?.agentic_app_id === "string") conversationAppId = conversation.metadata.agentic_app_id;
  }
  if (componentId !== undefined) {
    if (componentId === null) return undefined;
    if (typeof componentId !== "string" || !componentId.trim()) throw new ApiError("Invalid feedback component", 400);
    const selected = apps.find(app => app.installation.appId === componentId);
    if (!(selected?.installation.feedbackPath || selected?.installation.feedbackGitHub)) throw new ApiError("Feedback component is not registered", 400);
    if (!canLaunchAgenticApp(selected, agenticAppUserContextFromSession(reporter.session, reporter.user.role))) {
      throw new ApiError("Feedback component is unavailable", 403);
    }
    return selected;
  }
  if (conversationAppId) {
    const app = apps.find(item => item.installation.appId === conversationAppId);
    if (!app) throw new ApiError("The conversation's app is unavailable", 503);
    return app;
  }
  const matches = apps.filter(app => {
    // Keep unavailable ownership: it must not silently become a platform report.
    const roots = [...agenticAppHostPaths({ ...app,
      installation: { ...app.installation, installed: true, enabled: true },
    }), app.installation.runtimeMountPath ?? `/apps/${app.installation.appId}`];
    return roots.some(root => ownsAppPath(root, url.pathname));
  });
  if (matches.length > 1) throw new ApiError("Feedback app ownership is ambiguous", 503);
  return matches[0];
}

function proxy(request: Request, app: ConfiguredAgenticApp, reporter: Reporter) {
  return proxyAgenticAppRequest(request, {
    params: Promise.resolve({ appId: app.installation.appId, path: app.installation.feedbackPath!.slice(1).split("/") }),
  }, reporter);
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateRequest(request, { resource: "feedback", scope: "submit" });
  if (auth instanceof NextResponse) return auth;
  if (!auth.authenticatedUser || auth.isServiceAccount) throw new ApiError("Sign in to submit feedback", 403);
  const cfg = getServerConfig();
  if (!cfg.reportProblemEnabled) throw new ApiError("Feedback reporting is disabled", 503);
  const query = request.nextUrl.searchParams;
  const componentId = query.has("componentId") ? query.get("componentId") || null : undefined;
  const resolved = await feedbackApp(query.get("contextUrl"), query.get("conversationId") ?? undefined, auth.authenticatedUser, componentId);
  const app = resolved?.installation.feedbackPath || resolved?.installation.feedbackGitHub ? resolved : undefined;
  const user = agenticAppUserContextFromSession(auth.authenticatedUser.session, auth.authenticatedUser.user.role);
  const platformLabel = process.env.FEEDBACK_PLATFORM_LABEL?.trim() || cfg.appName;
  const components = [
    { appId: null, label: platformLabel },
    ...loadConfiguredAgenticApps().filter(item => (item.installation.feedbackPath || item.installation.feedbackGitHub) && canLaunchAgenticApp(item, user))
      .map(item => ({ appId: item.installation.appId, label: item.manifest.displayName })),
  ];
  if (app && !canLaunchAgenticApp(app, user)) throw new ApiError("Feedback app is unavailable", 403);
  if (query.get("view") === "components") return NextResponse.json({ success: true, data: {
    appId: app?.installation.appId ?? null, components,
  } }, { headers: { "Cache-Control": "private, no-store" } });
  let features: string[];
  let screenshotsEnabled: boolean | undefined;
  if (!app) {
    features = platformFeedbackFeatures(process.env.FEEDBACK_FEATURES);
    screenshotsEnabled = platformFeedbackCapabilities().screenshotsEnabled;
  }
  else {
    features = app.installation.feedbackFeatures ?? ["Other"];
    if (app.installation.feedbackGitHub) screenshotsEnabled = Boolean(appGitHubFeedbackSettings(app).assets);
    else if (!app.installation.feedbackFeatures && app.installation.feedbackPath) {
      const response = await proxy(new Request(new URL(app.installation.feedbackPath, request.url), {
        headers: request.headers, signal: request.signal,
      }), app, auth.authenticatedUser);
      // A capability GET is optional for existing POST-only app handlers.
      if (response.ok) {
        const body = await response.json();
        if (typeof body?.data?.screenshotsEnabled === "boolean") screenshotsEnabled = body.data.screenshotsEnabled;
        if (body?.data?.features !== undefined) features = parseFeedbackFeatures(body.data.features);
      } else if (![404, 405].includes(response.status)) return response;
    }
  }
  return NextResponse.json({ success: true, data: {
    appId: app?.installation.appId ?? null, label: app?.manifest.displayName ?? platformLabel, features, components, screenshotsEnabled,
  } }, { headers: { "Cache-Control": "private, no-store" } });
});

/** App provider handling stays in the app; the platform flow remains the default. */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateRequest(request, { resource: "feedback", scope: "submit" });
  if (auth instanceof NextResponse) return auth;
  if (!auth.authenticatedUser || auth.isServiceAccount) throw new ApiError("Sign in to submit feedback", 403);
  if (!getServerConfig().reportProblemEnabled) throw new ApiError("Feedback reporting is disabled", 503);
  const body = await request.json().catch(() => null);
  const app = await feedbackApp(body?.contextUrl, body?.conversationId, auth.authenticatedUser, body?.componentId);
  if (app?.installation.feedbackGitHub) {
    if (!canLaunchAgenticApp(app, agenticAppUserContextFromSession(auth.authenticatedUser.session, auth.authenticatedUser.user.role))) throw new ApiError("Feedback component is unavailable", 403);
    const data = await createGitHubFeedback(body, auth.authenticatedUser.user.email, request.signal, appGitHubFeedbackSettings(app));
    return NextResponse.json({ success: true, data });
  }
  if (!app?.installation.feedbackPath) {
    if (platformFeedbackHandler() === "github") {
      const data = await createPlatformGitHubFeedback(body, auth.authenticatedUser.user.email, request.signal);
      return NextResponse.json({ success: true, data });
    }
    return NextResponse.json({ success: true, data: { handled: false } });
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return proxy(new Request(new URL(app.installation.feedbackPath, request.url), {
    method: "POST", headers, signal: request.signal,
    body: JSON.stringify({ ...body, userEmail: auth.authenticatedUser.user.email }),
  }), app, auth.authenticatedUser);
});
