import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import {
  publicationActorFromSession,
  rejectPublicationRequest,
} from "@/lib/publication-approval.server";

export const POST = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => {
  const { id } = await context.params;
  const { session } = await getAuthFromBearerOrSession(request);
  const actor = publicationActorFromSession(session);
  const body = await request.json().catch(() => ({}));
  const note = typeof (body as { note?: unknown }).note === "string"
    ? (body as { note: string }).note.trim()
    : "";
  if (!note) throw new ApiError("Add a reason before rejecting this request", 400);
  if (note.length > 1000) throw new ApiError("Decision note is too long", 400);
  const rejected = await rejectPublicationRequest(id, actor, note);
  return successResponse({ request: rejected });
});
