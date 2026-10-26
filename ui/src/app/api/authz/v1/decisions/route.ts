// Deprecated migration-only API: delete this route under #2891 before CAS #2487
// is complete. Migrate remaining delegated callers; do not add new consumers,
// compatibility aliases or redirects to preserve this endpoint.
//
// POST /api/authz/v1/decisions — single authorization decision.
// Verifies the caller JWT, enforces subject-binding, evaluates via CAS.
// A DENY is a 200 with body (see spec §5.3); HTTP error codes are reserved
// for meta-failures (401/403/400/503).

import { NextRequest, NextResponse } from "next/server";

import { getAuthFromBearerOrSession } from "@/lib/api-middleware";
import { authorize } from "@/lib/authz";
import {
  HttpAuthzError,
  decisionContext,
  enforceSubjectBinding,
  metaErrorResponse,
  parseAction,
  parseResource,
  parseSubject,
  resolveCaller,
  sanitizeAdvisoryContext,
} from "@/lib/authz/http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
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

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new HttpAuthzError(400, "INVALID_REQUEST", "Request body must be valid JSON");
    }
    if (!body || typeof body !== "object") {
      throw new HttpAuthzError(400, "INVALID_REQUEST", "Request body must be an object");
    }
    const b = body as Record<string, unknown>;

    const subject = parseSubject(b.subject);
    const resource = parseResource(b.resource);
    const action = parseAction(b.action);
    const ctx = decisionContext(session);

    await enforceSubjectBinding(caller, subject, ctx);

    const context = sanitizeAdvisoryContext(b.context);
    const result = await authorize(
      { subject, resource, action, ...(context ? { context } : {}) },
      ctx,
    );

    if (result.reason === "AUTHZ_UNAVAILABLE") {
      return NextResponse.json(
        { error: "Authorization service temporarily unavailable", code: "AUTHZ_UNAVAILABLE", retriable: true },
        { status: 503 },
      );
    }
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof HttpAuthzError) return metaErrorResponse(err);
    throw err;
  }
}
