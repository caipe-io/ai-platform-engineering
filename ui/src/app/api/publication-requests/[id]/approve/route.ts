import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { applyPublicationRequestAdapter } from "@/lib/publication-approval-adapters.server";
import {
  acquirePublicationRequestForApproval,
  completePublicationApproval,
  failPublicationApproval,
  publicationActorFromSession,
  supersedeApplyingPublicationRequest,
} from "@/lib/publication-approval.server";

function decisionNote(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 1000) throw new ApiError("Decision note is too long", 400);
  return trimmed;
}

export const POST = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => {
  const { id } = await context.params;
  const { session } = await getAuthFromBearerOrSession(request);
  const actor = publicationActorFromSession(session);
  const body = await request.json().catch(() => ({}));
  const note = decisionNote((body as { note?: unknown })?.note);
  const acquired = await acquirePublicationRequestForApproval(id, actor);
  try {
    await applyPublicationRequestAdapter(acquired, session);
    const approved = await completePublicationApproval(id, actor, note);
    return successResponse({ request: approved });
  } catch (error) {
    if (error instanceof ApiError && error.code === "PUBLICATION_REVISION_CONFLICT") {
      const superseded = await supersedeApplyingPublicationRequest(
        id,
        actor,
        error.message,
      );
      return successResponse({ request: superseded, conflict: true }, 409);
    }
    await failPublicationApproval(id, actor, error);
    throw error;
  }
});
