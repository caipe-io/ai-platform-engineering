/**
 * POST /api/user/check_agent_access — bot-facing PDP endpoint.
 *
 * Phase 2 of spec 2026-05-24-derive-team-from-channel. The Slack and
 * Webex bots call this on every DM / 1:1 message to decide whether the
 * dispatched agent is allowed for the signed-in user. The route is a
 * thin wrapper around `evaluateAgentAccess` (the Phase 1 PDP helper)
 * that:
 *
 *   1. Authenticates the caller (OBO Bearer token, signed by Keycloak).
 *   2. Validates the agent_id is OpenFGA-safe.
 *   3. Runs the user-vs-agent decision (direct grant ∪ team union).
 *   4. Returns a stable, audit-friendly decision shape.
 *
 * Failures are surfaced with stable error codes so the bot can fail-
 * closed on infrastructure errors but still emit a clean deny on
 * legitimate denies.
 */

import { NextRequest, NextResponse } from "next/server";

import {
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { evaluateAgentAccess } from "@/lib/rbac/pdp-shared";
import { evaluatePrivateResourceContext } from "@/lib/authz/domains/private-resource";
import { trustedInteractionFromRequest } from "@/lib/authz/trusted-interaction";
import { isPrivateResourcesEnabled } from "@/lib/feature-flags/private-resources";

const OPENFGA_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export const dynamic = "force-dynamic";

function errorResponse(
  status: number,
  body: { error: string; code: string; reason?: string; action?: string },
): NextResponse {
  return NextResponse.json({ success: false, ...body }, { status });
}

function resolveSubject(session: { sub?: unknown }): string | null {
  if (typeof session.sub === "string" && session.sub.trim().length > 0) {
    return session.sub.trim();
  }
  return null;
}

interface PostBody {
  agent_id?: unknown;
  team_slug?: unknown;
}

export const POST = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);

  const subject = resolveSubject(session);
  if (!subject) {
    return errorResponse(401, {
      error: "You are not signed in. Please sign in to continue.",
      code: "NOT_SIGNED_IN",
      reason: "not_signed_in",
      action: "sign_in",
    });
  }

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return errorResponse(400, {
      error: "Request body must be valid JSON",
      code: "INVALID_BODY",
      reason: "invalid_body",
      action: "fix_request",
    });
  }

  const raw = body.agent_id;
  if (typeof raw !== "string" || !OPENFGA_ID_PATTERN.test(raw)) {
    return errorResponse(400, {
      error: "agent_id must be a non-empty OpenFGA-safe identifier",
      code: "INVALID_BODY",
      reason: "invalid_body",
      action: "fix_request",
    });
  }

  const rawTeamSlug = body.team_slug;
  if (
    rawTeamSlug !== undefined &&
    (typeof rawTeamSlug !== "string" || !OPENFGA_ID_PATTERN.test(rawTeamSlug))
  ) {
    return errorResponse(400, {
      error: "team_slug must be an OpenFGA-safe identifier when provided",
      code: "INVALID_BODY",
      reason: "invalid_body",
      action: "fix_request",
    });
  }

  const agents = await getCollection<{ _id: string; enabled?: boolean; visibility?: string }>(
    "dynamic_agents",
  );
  const agent = await agents.findOne({
    _id: raw,
    enabled: { $ne: false },
  } as never);
  if (!agent) {
    return successResponse({
      allowed: false,
      reason: "DENY_AGENT_NOT_FOUND",
      path: "denied",
    });
  }

  const privateContextDecision = isPrivateResourcesEnabled()
    ? evaluatePrivateResourceContext(
        {
          subject: { type: "user", id: subject },
          resource: { type: "agent", id: raw },
          action: "use",
          trustedContext: { interaction: trustedInteractionFromRequest(request) },
        },
        agent.visibility === "private" ? "private" : null,
      )
    : null;
  if (privateContextDecision?.decision === "DENY") {
    return successResponse({
      allowed: false,
      reason: privateContextDecision.reason,
      path: "private_dm_required",
    });
  }

  let decision;
  try {
    decision = await evaluateAgentAccess({
      subject,
      agentId: raw,
      ...(typeof rawTeamSlug === "string" ? { teamSlug: rawTeamSlug } : {}),
    });
  } catch (err) {
    // PDP infrastructure error — the bot is expected to translate this
    // to a user-facing "auth temporarily unavailable" deny.
    console.error(
      "[check_agent_access] PDP error",
      err instanceof Error ? err.message : String(err),
    );
    return errorResponse(502, {
      error:
        "Authorization service is temporarily unavailable. Please try again in a moment.",
      code: "PDP_UNAVAILABLE",
      reason: "pdp_unavailable",
      action: "retry",
    });
  }

  const payload: {
    allowed: boolean;
    reason: string;
    path: string;
    matched_team_slug?: string;
  } = {
    allowed: decision.allowed,
    reason: decision.reasonCode,
    path: decision.path,
  };
  if (decision.matchedTeamSlug) {
    payload.matched_team_slug = decision.matchedTeamSlug;
  }
  return successResponse(payload);
});
