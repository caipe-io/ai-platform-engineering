import { NextRequest, NextResponse } from "next/server";

import { loadConfiguredAgenticApps } from "@/lib/agentic-apps/config";
import { agenticAppHostPaths, ownsAppPath } from "@/lib/agentic-apps/host-routes";
import { proxyAgenticAppRequest } from "@/lib/agentic-apps/proxy";
import { ApiError, withErrorHandler } from "@/lib/api-middleware";
import { getServerConfig } from "@/lib/config";
import { authenticateRequest } from "@/lib/da-proxy";

/** Compatibility entry point for app feedback; provider handling stays in the app. */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateRequest(request, { resource: "feedback", scope: "submit" });
  if (auth instanceof NextResponse) return auth;
  if (!auth.authenticatedUser || auth.isServiceAccount) throw new ApiError("Sign in to submit feedback", 403);
  if (!getServerConfig().reportProblemEnabled) throw new ApiError("Feedback reporting is disabled", 503);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.contextUrl !== "string") throw new ApiError("contextUrl is required", 400);
  let contextUrl: URL;
  try { contextUrl = new URL(body.contextUrl); }
  catch { throw new ApiError("Invalid contextUrl", 400); }
  if (!["http:", "https:"].includes(contextUrl.protocol)) throw new ApiError("Invalid contextUrl", 400);
  const matches = loadConfiguredAgenticApps().filter(app => {
    // Resolve ownership before availability so a disabled app cannot fall back
    // to the platform destination. The proxy enforces availability and access.
    const roots = [...agenticAppHostPaths({ ...app,
      installation: { ...app.installation, installed: true, enabled: true },
    }), app.installation.runtimeMountPath ?? `/apps/${app.installation.appId}`];
    return roots.some(root => ownsAppPath(root, contextUrl.pathname));
  });
  if (matches.length > 1) throw new ApiError("Feedback app ownership is ambiguous", 503);
  const app = matches[0];
  if (!app?.installation.feedbackPath) {
    return NextResponse.json({ success: true, data: { handled: false } });
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  const forwarded = new Request(new URL(app.installation.feedbackPath, request.url), {
    method: "POST", headers, signal: request.signal,
    body: JSON.stringify({ ...body, userEmail: auth.authenticatedUser.user.email }),
  });
  return proxyAgenticAppRequest(forwarded, {
    params: Promise.resolve({ appId: app.installation.appId, path: app.installation.feedbackPath.slice(1).split("/") }),
  }, auth.authenticatedUser);
});
