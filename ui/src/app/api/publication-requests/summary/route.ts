import { NextRequest } from "next/server";

import {
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  publicationActorFromSession,
  publicationRequestSummary,
} from "@/lib/publication-approval.server";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  const summary = await publicationRequestSummary(publicationActorFromSession(session));
  return successResponse(summary);
});
