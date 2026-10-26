// assisted-by Codex Codex-sonnet-4-6
//
// POST   /api/authz/v1/grants  — grant a capability to a grantee on a resource
// DELETE /api/authz/v1/grants  — revoke it
//
// Product-facing PAP endpoint: resource managers (not just org admins) can
// grant access to resources they own. Auth: authenticated session + subject-
// binding + per-resource meta-authz (caller holds `manage` on the resource).
// No admin_ui / audit.view prerequisite — this is the path for product sharing
// flows (workflow share modal, agent-access modal, etc.).
// Body: { resource:{type,id}, grantee:{type,id?}, capability }

import { NextRequest, NextResponse } from "next/server";

import { ApiError } from "@/lib/api-error";
import { getAuthFromBearerOrSession } from "@/lib/api-middleware";
import { grant, revoke } from "@/lib/authz";
import {
  HttpAuthzError,
  decisionContext,
  metaErrorResponse,
  parseGrantIntent,
  requireManage,
  resolveCaller,
} from "@/lib/authz/http";

export const dynamic = "force-dynamic";

async function handle(request: NextRequest, op: "grant" | "revoke"): Promise<NextResponse> {
  let session: unknown;
  try {
    session = (await getAuthFromBearerOrSession(request)).session;
  } catch {
    return metaErrorResponse(new HttpAuthzError(401, "NOT_AUTHENTICATED", "Authentication required"));
  }

  const caller = resolveCaller(session);
  if (!caller) {
    return metaErrorResponse(new HttpAuthzError(401, "NOT_AUTHENTICATED", "Authentication required"));
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return metaErrorResponse(new HttpAuthzError(400, "INVALID_REQUEST", "Request body must be valid JSON"));
  }

  const ctx = decisionContext(session, caller, request);
  try {
    const intent = parseGrantIntent(body);
    await requireManage(caller, intent.resource, ctx, { operation: op, intent });
    if (op === "grant") {
      await grant(intent, ctx);
    } else {
      await revoke(intent, ctx);
    }
    return NextResponse.json(
      op === "grant" ? { granted: true } : { revoked: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof HttpAuthzError) return metaErrorResponse(err);
    if (err instanceof ApiError && err.code === "PERSONAL_CONTEXT_PRIVATE") {
      return NextResponse.json({ error: err.message, code: err.code, retriable: false },
        { status: err.statusCode, headers: { "Cache-Control": "no-store" } });
    }
    throw err;
  }
}

export const POST = (request: NextRequest) => handle(request, "grant");
export const DELETE = (request: NextRequest) => handle(request, "revoke");
