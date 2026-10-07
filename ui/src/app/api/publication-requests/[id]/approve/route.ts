import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { PublicationDriftError } from "@/lib/api-error";
import { applyPublicationRequestAdapter } from "@/lib/publication-approval-adapters.server";
import {
  acquirePublicationRequestForApproval,
  completePublicationApproval,
  failPublicationApproval,
  publicationActorFromSession,
  releasePublicationApprovalForDrift,
  supersedeApplyingPublicationRequest,
} from "@/lib/publication-approval.server";

function decisionNote(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 1000) throw new ApiError("Decision note is too long", 400);
  return trimmed;
}

function acknowledgedDriftFingerprint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 128) throw new ApiError("Drift fingerprint is too long", 400);
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
  const acknowledgedFingerprint = acknowledgedDriftFingerprint(
    (body as { acknowledged_drift_fingerprint?: unknown })?.acknowledged_drift_fingerprint,
  );
  const acquired = await acquirePublicationRequestForApproval(id, actor);
  try {
    // The approved history entry must reflect what the approver actually
    // confirmed, not the request-time snapshot, so the adapter's return
    // value (empty when nothing had drifted) carries forward here.
    const acknowledgedDrift = await applyPublicationRequestAdapter(acquired, session, {
      acknowledgedFingerprint,
    });
    const approved = await completePublicationApproval(id, actor, note, acknowledgedDrift);
    return successResponse({ request: approved });
  } catch (error) {
    if (error instanceof PublicationDriftError) {
      const released = await releasePublicationApprovalForDrift(id, actor, error.drift);
      return successResponse(
        {
          drift_confirmation_required: true,
          drift: error.drift,
          drift_fingerprint: error.fingerprint,
          request: released,
        },
        409,
      );
    }
    if (error instanceof ApiError && error.code === "PUBLICATION_REVISION_CONFLICT") {
      const superseded = await supersedeApplyingPublicationRequest(
        id,
        actor,
        error.message,
        error.drift,
      );
      return successResponse(
        { request: superseded, conflict: true, drift: error.drift },
        409,
      );
    }
    await failPublicationApproval(id, actor, error);
    throw error;
  }
});
