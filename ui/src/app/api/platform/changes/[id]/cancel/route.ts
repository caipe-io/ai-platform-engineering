import { NextRequest } from "next/server";

import { successResponse, withAuth, withErrorHandler } from "@/lib/api-middleware";
import { cancelPlatformChange, platformActor } from "@/lib/platform-changes.server";

export const POST = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => {
  return withAuth(request, async (_req, user, session) => {
    const actor = platformActor(user, session);
    const { id } = await context.params;
    return successResponse(await cancelPlatformChange(id, actor));
  });
});
