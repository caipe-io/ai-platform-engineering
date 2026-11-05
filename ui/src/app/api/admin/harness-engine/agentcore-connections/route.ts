import { ApiError, requireRbacPermission, withAuth, withErrorHandler } from "@/lib/api-middleware";
import { getHarnessEngineConfig, isHarnessEngineConfigured, proxyHarnessEngine } from "@/lib/harness-engine-proxy";
import { PLATFORM_CONFIG_ID } from "@/lib/platform-default-agent";
import { logRbacAdminAuditEvent } from "@/lib/rbac/audit";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export const GET = withErrorHandler(async (request: NextRequest) =>
  withAuth(request, async (_request, _user, session) => {
    await requireRbacPermission(session, "admin_ui", "admin");
    await requireResourcePermission(session, { type: "system_config", id: PLATFORM_CONFIG_ID, action: "admin" });
    return NextResponse.json({ success: true, data: { configured: isHarnessEngineConfigured() } }, { headers: { "Cache-Control": "no-store" } });
  }),
);

export const POST = withErrorHandler(async (request: NextRequest) =>
  withAuth(request, async (_request, user, session) => {
    await requireRbacPermission(session, "admin_ui", "admin");
    await requireResourcePermission(session, { type: "system_config", id: PLATFORM_CONFIG_ID, action: "admin" });
    if (typeof session.sub !== "string" || !session.sub.trim()) throw new ApiError("A stable caller subject is required", 401);
    const body = await request.text();
    if (body.length > 4096) throw new ApiError("Connection configuration is too large", 413);
    const config = getHarnessEngineConfig();
    if (config instanceof NextResponse) return config;
    const response = await proxyHarnessEngine(config, { subject: session.sub, traceparent: request.headers.get("traceparent") ?? undefined }, "/api/v1/admin/agentcore-connections", {
      method: "POST", body, headers: { "X-Harness-Engine-Admin": "true" },
    });
    if (response.ok) {
      const result = await response.clone().json();
      logRbacAdminAuditEvent({ tenantId: "default", sub: session.sub, email: user.email, kind: "policy_change", operation: "agentcore_connection.register", resourceRef: `agentcore_profile:${result.data.profile_id}` });
    }
    return response;
  }),
);
