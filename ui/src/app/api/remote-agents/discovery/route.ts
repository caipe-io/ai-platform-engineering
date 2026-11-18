import { caipeOrgKey } from "@/lib/rbac/organization";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { ApiError, getAuthFromBearerOrSession, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { authenticateRequest, buildBackendHeaders } from "@/lib/da-proxy";
import { NextRequest } from "next/server";

const DYNAMIC_AGENTS_URL = process.env.DYNAMIC_AGENTS_URL || "http://localhost:8100";

async function proxyDiscovery(request: NextRequest) {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireResourcePermission(session, { type: "organization", id: caipeOrgKey(), action: "manage" });
  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  const post = request.method === "POST";
  const response = await fetch(`${DYNAMIC_AGENTS_URL}/api/v1/remote-agents/${post ? "discover" : "discovery"}`, {
    method: post ? "POST" : "GET", headers: buildBackendHeaders("application/json", auth),
    ...(post ? { body: JSON.stringify(await request.json()) } : {}), signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(typeof data.detail === "string" ? data.detail : "Remote agent discovery failed", response.status);
  return successResponse(data);
}

export const GET = withErrorHandler(proxyDiscovery);
export const POST = withErrorHandler(proxyDiscovery);
