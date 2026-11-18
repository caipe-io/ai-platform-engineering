import { ApiError, requireRbacPermission, withAuth, withErrorHandler } from "@/lib/api-middleware";
import { getHarnessEngineConfig, proxyHarnessEngine } from "@/lib/harness-engine-proxy";
import { PLATFORM_CONFIG_ID } from "@/lib/platform-default-agent";
import { logRbacAdminAuditEvent } from "@/lib/rbac/audit";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

async function handle(request: NextRequest) {
  return withAuth(request, async (_request, user, session) => {
    await requireRbacPermission(session, "admin_ui", "admin");
    await requireResourcePermission(session, { type: "system_config", id: PLATFORM_CONFIG_ID, action: "admin" });
    if (typeof session.sub !== "string" || !session.sub.trim()) throw new ApiError("A stable caller subject is required", 401);
    const config = getHarnessEngineConfig();
    if (config instanceof NextResponse) return config;
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && body.length > 4096) throw new ApiError("Profile configuration is too large", 413);
    const response = await proxyHarnessEngine(config, { subject: session.sub, traceparent: request.headers.get("traceparent") ?? undefined }, "/api/v1/admin/operator-profiles", {
      method: request.method, body, headers: { "X-Harness-Engine-Admin": "true" },
    });
    if (request.method === "POST" && response.ok) {
      const result = await response.clone().json();
      logRbacAdminAuditEvent({ tenantId: "default", sub: session.sub, email: user.email, kind: "policy_change", operation: "operator_profile.create", resourceRef: `operator_profile:${result.data.profile_id}` });
    }
    return response;
  });
}
export const GET = withErrorHandler(handle);
export const POST = withErrorHandler(handle);
