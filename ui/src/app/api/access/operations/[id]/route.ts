import { NextRequest, NextResponse } from "next/server";

import { ApiError, getAuthFromBearerOrSession, withErrorHandler } from "@/lib/api-middleware";
import { permissionSyncStatus } from "@/lib/authz/permission-sync";
import { getCollection } from "@/lib/mongodb";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";

/** The initiating caller can inspect progress even after transferring ownership. */
export const GET = withErrorHandler(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session } = await getAuthFromBearerOrSession(request);
  const { id } = await context.params;
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new ApiError("Invalid operation reference", 400);
  for (const name of ["dynamic_agents", "platform_config"] as const) {
    const col = await getCollection(name);
    const doc = await col.findOne({ "_permission_sync.id": id }, {
      projection: { _id: 1, "_permission_sync.id": 1, "_permission_sync.state": 1,
        "_permission_sync.requested_at": 1, "_permission_sync.applied_at": 1, "_permission_sync.context.caller": 1 },
    });
    if (!doc) continue;
    const actor = doc._permission_sync?.context?.caller;
    const callerType = session.isServiceAccount === true ? "service_account" : "user";
    if (!session.sub || actor?.id !== session.sub || actor?.type !== callerType) {
      await requireResourcePermission(session, { type: name === "dynamic_agents" ? "agent" : "system_config", id: String(doc._id), action: "manage" });
    }
    return NextResponse.json({ success: true, data: permissionSyncStatus(doc) }, { headers: { "Cache-Control": "no-store" } });
  }
  throw new ApiError("Permission update not found. Reload the resource to check its current state.", 404);
});
