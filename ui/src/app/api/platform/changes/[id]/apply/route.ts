import { NextRequest } from "next/server";

import { ApiError, successResponse, withAuth, withErrorHandler } from "@/lib/api-middleware";
import { applyPlatformChange, platformActor } from "@/lib/platform-changes.server";

export const POST = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => {
  return withAuth(request, async (_req, user, session) => {
    const body = await request.json().catch(() => ({})) as { confirmed?: unknown };
    if (body.confirmed !== true) {
      throw new ApiError("Explicit human confirmation is required", 400);
    }
    const actor = platformActor(user, session);
    const { id } = await context.params;
    return successResponse(await applyPlatformChange({
      changeId: id,
      actor,
      user,
      session,
      request,
    }));
  });
});
