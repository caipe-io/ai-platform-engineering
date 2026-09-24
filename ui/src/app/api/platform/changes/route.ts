import { NextRequest } from "next/server";

import { successResponse, withAuth, withErrorHandler } from "@/lib/api-middleware";
import {
  createPlatformChange,
  platformActor,
  validatePlatformChangeInput,
} from "@/lib/platform-changes.server";

export const POST = withErrorHandler(async (request: NextRequest) => {
  return withAuth(request, async (_req, user, session) => {
    const actor = platformActor(user, session);
    const parsed = validatePlatformChangeInput(await request.json());
    const proposal = await createPlatformChange({
      kind: parsed.kind,
      operation: parsed.operation,
      resourceId: parsed.resourceId,
      changes: parsed.changes,
      reason: parsed.reason,
      actor,
      user,
      session,
    });
    return successResponse(proposal, 201);
  });
});
