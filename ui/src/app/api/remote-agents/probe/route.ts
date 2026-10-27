import { caipeOrgKey } from "@/lib/rbac/organization";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { authenticateRequest, buildBackendHeaders } from "@/lib/da-proxy";
import { normalizeRemoteAgentCredentialSource } from "@/lib/remote-agent-auth";
import { NextRequest } from "next/server";

const DYNAMIC_AGENTS_URL = process.env.DYNAMIC_AGENTS_URL || "http://localhost:8100";

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireResourcePermission(session, { type: "organization", id: caipeOrgKey(), action: "manage" });
  const body = await request.json().catch(() => ({})) as { endpoint?: unknown; credential_source?: unknown };
  if (typeof body.endpoint !== "string" || !body.endpoint.trim()) {
    throw new ApiError("Endpoint is required", 400, "INVALID_REMOTE_AGENT");
  }
  const credential_source = normalizeRemoteAgentCredentialSource(body.credential_source);

  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  const response = await fetch(`${DYNAMIC_AGENTS_URL}/api/v1/remote-agents/probe`, {
    method: "POST",
    headers: buildBackendHeaders("application/json", auth),
    body: JSON.stringify({ endpoint: body.endpoint.trim(), credential_source }),
    signal: AbortSignal.timeout(25_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(data.detail || `A2A probe failed with status ${response.status}`, response.status, "REMOTE_AGENT_PROBE_FAILED");
  }
  return successResponse(data);
});
