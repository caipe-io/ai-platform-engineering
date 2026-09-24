import { NextRequest } from "next/server";

import { successResponse, withAuth, withErrorHandler } from "@/lib/api-middleware";
import { platformActor, readPlatformChange } from "@/lib/platform-changes.server";

export const GET = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => {
  return withAuth(request, async (_req, user, session) => {
    const actor = platformActor(user, session);
    const { id } = await context.params;
    return successResponse(await readPlatformChange(id, actor));
  });
});
