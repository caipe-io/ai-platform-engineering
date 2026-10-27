import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import {
  agenticAppUserContextFromSession,
  canLaunchAgenticApp,
} from "@/lib/agentic-apps/access";
import {
  getConfiguredAgenticApp,
  isAgenticAppsEnabled,
} from "@/lib/agentic-apps/config";
import { deriveAgenticAppSubjectId } from "@/lib/agentic-apps/identity";
import { resolveAgenticAppHttpPolicyAction } from "@/lib/agentic-apps/policy-routing";
import { isHostControlledAgenticAppRequestHeader } from "@/lib/agentic-apps/request-headers";
import {
  buildAgenticAppPublicPath,
  buildAgenticAppTargetUrl,
  rewriteAgenticAppResponseLocation,
  resolveAgenticAppOrigin,
} from "@/lib/agentic-apps/runtime";
import { mintAgenticAppToken } from "@/lib/agentic-apps/tokens";
import { ApiError, getAuthenticatedUser } from "@/lib/api-middleware";
import { DEFAULT_AGENTIC_APP_MAX_REQUEST_BODY_BYTES } from "@/types/agentic-app";
import type { AgenticAppAuthMode } from "@/types/agentic-app";
import { nativeExtensionById } from "@/native-extensions/runtime";

import { ASSISTANT_CONTEXT_HEADER, type AssistantClientContext } from "./assistant-clients";

const BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "content-security-policy",
  "content-security-policy-report-only",
  "keep-alive",
  "location",
  "proxy-authenticate",
  "set-cookie",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-frame-options",
]);

export type ProxyContext = {
  params: Promise<{ appId: string; path?: string[] }>;
};

export async function proxyAgenticAppRequest(
  request: Request,
  context: ProxyContext,
  authenticatedUser?: Awaited<ReturnType<typeof getAuthenticatedUser>>,
  assistantClientContext?: AssistantClientContext,
): Promise<Response> {
  if (!isAgenticAppsEnabled()) {
    return Response.json({ error: "app_not_found" }, { status: 404 });
  }

  const nextRequest = request instanceof NextRequest
    ? request
    : new NextRequest(request.url, { headers: request.headers });
  let auth: Awaited<ReturnType<typeof getAuthenticatedUser>>;
  try {
    auth = authenticatedUser ?? await getAuthenticatedUser(nextRequest, { allowAnonymous: false });
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.statusCode === 401 && isDocumentNavigation(request)) {
        return redirectToLogin(request);
      }
      return Response.json({ error: error.message }, { status: error.statusCode });
    }
    throw error;
  }

  const { appId, path = [] } = await context.params;
  let app: ReturnType<typeof getConfiguredAgenticApp>;
  try { app = getConfiguredAgenticApp(appId); }
  catch { return Response.json({ error: "app_configuration_unavailable" }, { status: 503 }); }
  if (!app || !app.installation.installed || !app.installation.enabled) {
    return Response.json({ error: "app_not_found" }, { status: 404 });
  }
  const nativeExtension = nativeExtensionById(appId);
  if (nativeExtension && nativeExtension.auth.mode !== app.manifest.auth.mode) {
    return Response.json({ error: "native_extension_auth_mismatch" }, { status: 500 });
  }
  const session = auth.session as Record<string, unknown>;
  if (
    !canLaunchAgenticApp(
      app,
      agenticAppUserContextFromSession(session, auth.user.role),
    )
  ) {
    return Response.json({ error: "app_unauthorized" }, { status: 403 });
  }
  const subject = deriveAgenticAppSubjectId(session);
  if (!subject) {
    return Response.json({ error: "stable_subject_required" }, { status: 401 });
  }

  const runtimePath = `/${path.join("/")}`;
  const policy = resolveAgenticAppHttpPolicyAction(
    app.manifest,
    request.method,
    runtimePath,
  );
  if (!policy || policy.defaultEffect !== "allow") {
    return Response.json(
      {
        error: "policy_denied",
        reasonCode: policy?.reasonCode ?? "action_not_declared",
      },
      { status: 403 },
    );
  }

  if (!resolveAgenticAppOrigin(app)) {
    return Response.json({ error: "app_runtime_unavailable" }, { status: 503 });
  }

  const maxRequestBodyBytes = app.manifest.runtime?.maxRequestBodyBytes
    ?? DEFAULT_AGENTIC_APP_MAX_REQUEST_BODY_BYTES;
  const declaredContentLength = parseContentLength(
    request.headers.get("content-length"),
  );
  if (declaredContentLength !== null && declaredContentLength > maxRequestBodyBytes) {
    return requestBodyTooLarge(maxRequestBodyBytes);
  }

  const scopes = policy.requiredScopes?.length
    ? [...new Set(policy.requiredScopes)]
    : [...new Set(app.manifest.access.tokenScopes)];
  const declaredScopes = new Set(app.manifest.access.tokenScopes);
  if (scopes.some((scope) => !declaredScopes.has(scope))) {
    return Response.json({ error: "invalid_policy_scopes" }, { status: 500 });
  }

  const decisionId = randomUUID();
  const correlationId = request.headers.get("x-correlation-id") ?? randomUUID();
  const authMode = app.manifest.auth.mode;
  let bearerToken: string;
  if (authMode === "forward-user-access-token") {
    const userAccessToken = readUserAccessToken(session);
    if (!userAccessToken) {
      return Response.json(
        { error: "user_access_token_required" },
        { status: 401 },
      );
    }
    bearerToken = userAccessToken;
  } else {
    const appToken = await mintAgenticAppToken({
      appId,
      subject,
      name: auth.user.name,
      email: auth.user.email,
      scopes,
      decisionId,
      correlationId,
    });
    bearerToken = appToken.token;
  }
  const target = buildAgenticAppTargetUrl(app, path, request.url);
  const body = shouldForwardBody(request.method)
    ? await request.arrayBuffer()
    : undefined;
  if (body && body.byteLength > maxRequestBodyBytes) {
    return requestBodyTooLarge(maxRequestBodyBytes);
  }

  const forwardHeaders = buildForwardHeaders({
    request, appId, bearerToken, authMode, subject,
    roles: deriveRoles(session, auth.user.role), decisionId, correlationId,
  });
  if (assistantClientContext) {
    try {
      const proof = await mintAgenticAppToken({
        appId, subject, scopes, decisionId, correlationId, ttlSeconds: 60,
        assistantContext: { ...assistantClientContext, method: request.method, path: target.pathname,
          bodyHash: createHash("sha256").update(Buffer.from(body ?? new ArrayBuffer(0))).digest("hex"),
          tokenHash: createHash("sha256").update(bearerToken).digest("hex") },
      });
      forwardHeaders.set(ASSISTANT_CONTEXT_HEADER, proof.token);
    } catch {
      console.error("[AppAssistant] Cannot sign native assistant context", { appId });
      return Response.json({ error: "assistant_context_unavailable" }, { status: 503 });
    }
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: forwardHeaders,
      ...(body ? { body } : {}),
      redirect: "manual",
      signal: request.signal,
    });
  } catch {
    return Response.json({ error: "upstream_unavailable" }, { status: 502 });
  }

  const headers = filterResponseHeaders(upstream.headers);
  const location = rewriteAgenticAppResponseLocation(
    app,
    appId,
    target,
    upstream.headers.get("location"),
  );
  if (location) headers.set("location", location);
  headers.set("x-caipe-decision-id", decisionId);
  headers.set("x-correlation-id", correlationId);
  headers.set("cache-control", "no-store");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function buildForwardHeaders(input: {
  request: Request;
  appId: string;
  bearerToken: string;
  authMode: AgenticAppAuthMode;
  subject: string;
  roles: string[];
  decisionId: string;
  correlationId: string;
}): Headers {
  const headers = new Headers();
  const connectionHeaders = new Set(
    (input.request.headers.get("connection") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  input.request.headers.forEach((value, key) => {
    if (
      !connectionHeaders.has(key.toLowerCase())
      && !isHostControlledAgenticAppRequestHeader(key, input.appId)
    ) {
      headers.set(key, value);
    }
  });
  headers.set("authorization", `Bearer ${input.bearerToken}`);
  headers.set("x-caipe-app-id", input.appId);
  headers.set("x-caipe-auth-mode", input.authMode);
  headers.set("x-caipe-user", input.subject);
  headers.set("x-caipe-roles", input.roles.join(","));
  headers.set("x-caipe-decision-id", input.decisionId);
  headers.set("x-correlation-id", input.correlationId);
  headers.set("x-caipe-surface", "hosted");
  headers.set("x-forwarded-prefix", buildAgenticAppPublicPath(input.appId));
  return headers;
}

function readUserAccessToken(session: Record<string, unknown>): string | null {
  const token = session.accessToken;
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

function filterResponseHeaders(source: Headers): Headers {
  const result = new Headers();
  const connectionHeaders = new Set(
    (source.get("connection") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!BLOCKED_RESPONSE_HEADERS.has(lower) && !connectionHeaders.has(lower)) {
      result.set(key, value);
    }
  });
  return result;
}

function deriveRoles(session: Record<string, unknown>, role: string): string[] {
  const roles = new Set<string>([role]);
  if (typeof session.role === "string") roles.add(session.role);
  if (Array.isArray(session.roles)) {
    session.roles.forEach((value) => {
      if (typeof value === "string" && value) roles.add(value);
    });
  }
  if (roles.has("admin")) roles.add("user");
  return [...roles].filter(Boolean).sort();
}

function shouldForwardBody(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function requestBodyTooLarge(maxRequestBodyBytes: number): Response {
  return Response.json(
    {
      error: "request_body_too_large",
      maxRequestBodyBytes,
    },
    { status: 413 },
  );
}

function isDocumentNavigation(request: Request): boolean {
  if (request.method.toUpperCase() !== "GET") return false;
  const destination = request.headers.get("sec-fetch-dest")?.toLowerCase();
  if (destination === "document") return true;
  if (destination) return false;
  return request.headers.get("accept")?.toLowerCase().includes("text/html") ?? false;
}

function redirectToLogin(request: Request): Response {
  const requestUrl = new URL(request.url);
  const query = new URLSearchParams({
    callbackUrl: `${requestUrl.pathname}${requestUrl.search}`,
  });
  // Relative on purpose: behind an ingress `request.url` is the pod's internal
  // listen address (e.g. https://0.0.0.0:3000), which must never reach the client.
  return new Response(null, {
    status: 307,
    headers: { location: `/login?${query}` },
  });
}
