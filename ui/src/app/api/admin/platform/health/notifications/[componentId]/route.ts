import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  requireRbacPermission,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { resolvePlatformHealthNotification } from "@/lib/platform-health-notifications.server";

export const PATCH = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ componentId: string }> },
) => {
  const { session } = await getAuthFromBearerOrSession(request);
  await requireRbacPermission(session,"admin_ui","admin");
  const actorSubject = typeof session.sub === "string" ? session.sub.trim() : "";
  if (!actorSubject) {
    throw new ApiError("Your session has expired. Please sign in again.",401);
  }

  const { componentId } = await context.params;
  const normalizedComponentId = componentId.trim();
  if (!normalizedComponentId) throw new ApiError("Component is required",400);
  const body = await request.json().catch(() => ({})) as { note?: unknown };
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > 500) throw new ApiError("Resolution note is too long",400);

  const resolved = await resolvePlatformHealthNotification({
    componentId: normalizedComponentId,
    actorSubject,
    ...(note ? { note } : {}),
  });
  if (!resolved) throw new ApiError("No active platform health notification found",404);
  return successResponse({ component_id: normalizedComponentId,resolved: true });
});
