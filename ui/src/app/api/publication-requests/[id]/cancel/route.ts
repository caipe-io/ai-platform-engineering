import { NextRequest } from "next/server";

import {
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  cancelPublicationRequest,
  publicationActorFromSession,
} from "@/lib/publication-approval.server";

export const POST = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => {
  const { id } = await context.params;
  const { session } = await getAuthFromBearerOrSession(request);
  const actor = publicationActorFromSession(session);
  const cancelled = await cancelPublicationRequest(id, actor);
  return successResponse({ request: cancelled });
});
