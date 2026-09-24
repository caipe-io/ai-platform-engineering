import { NextRequest } from "next/server";

import { ApiError, successResponse, withAuth, withErrorHandler } from "@/lib/api-middleware";
import {
  getWritablePlatformResource,
  platformActor,
  platformResourceView,
  type PlatformResourceKind,
} from "@/lib/platform-changes.server";

export const POST = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, user, session) => {
    platformActor(user, session);
    const body = await request.json() as { kind?: unknown; resource_id?: unknown };
    if (!(["agent", "skill", "workflow", "schedule"] as unknown[]).includes(body.kind)) {
      throw new ApiError("Invalid platform resource kind", 400);
    }
    const resourceId = typeof body.resource_id === "string" ? body.resource_id.trim() : "";
    if (!resourceId) throw new ApiError("resource_id is required", 400);
    const resource = await getWritablePlatformResource(
      body.kind as PlatformResourceKind,
      resourceId,
      user,
      session,
    );
    return successResponse({
      kind: body.kind,
      resource_id: resourceId,
      resource: platformResourceView(body.kind as PlatformResourceKind, resource),
    });
  });
});
