import { NextRequest } from "next/server";

import { ApiError, successResponse, withAuth, withErrorHandler } from "@/lib/api-middleware";
import {
  assertPlatformOperationSupported,
  getWritablePlatformResource,
  platformActor,
  type PlatformResourceKind,
} from "@/lib/platform-changes.server";

export const POST = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, user, session) => {
    platformActor(user, session);
    const body = await request.json() as {
      kind?: unknown;
      operation?: unknown;
      resource_id?: unknown;
    };
    if (!(["agent", "skill", "workflow", "schedule"] as unknown[]).includes(body.kind)) {
      throw new ApiError("Invalid platform resource kind", 400);
    }
    if (body.operation !== "create" && body.operation !== "update") {
      throw new ApiError("operation must be create or update", 400);
    }
    const kind = body.kind as PlatformResourceKind;
    assertPlatformOperationSupported(kind, body.operation);
    if (body.operation === "create") {
      return successResponse({ allowed: true, kind: body.kind, operation: body.operation });
    }
    const resourceId = typeof body.resource_id === "string" ? body.resource_id.trim() : "";
    if (!resourceId) throw new ApiError("resource_id is required for update", 400);
    await getWritablePlatformResource(
      kind,
      resourceId,
      user,
      session,
    );
    return successResponse({
      allowed: true,
      kind: body.kind,
      operation: body.operation,
      resource_id: resourceId,
    });
  });
});
