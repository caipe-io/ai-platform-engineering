import {
  ApiError,
  getAuthFromBearerOrSession,
  requireRbacPermission,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { authenticateRequest, buildBackendHeaders } from "@/lib/da-proxy";
import { NextRequest } from "next/server";

const DYNAMIC_AGENTS_URL = process.env.DYNAMIC_AGENTS_URL || "http://localhost:8100";

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session, "admin_ui", "admin");
  const body = await request.json().catch(() => ({})) as { endpoint?: unknown };
  if (typeof body.endpoint !== "string" || !body.endpoint.trim()) {
    throw new ApiError("Endpoint is required", 400, "INVALID_REMOTE_AGENT");
  }

  const auth = await authenticateRequest(request);
  if (auth instanceof Response) return auth;
  const response = await fetch(`${DYNAMIC_AGENTS_URL}/api/v1/remote-agents/probe`, {
    method: "POST",
    headers: buildBackendHeaders("application/json", auth),
    body: JSON.stringify({ endpoint: body.endpoint.trim() }),
    signal: AbortSignal.timeout(12_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(data.detail || `A2A probe failed with status ${response.status}`, response.status, "REMOTE_AGENT_PROBE_FAILED");
  }
  return successResponse(data);
});
