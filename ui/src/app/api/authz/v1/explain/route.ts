// assisted-by Codex Codex-sonnet-4-6
//
// POST /api/authz/v1/explain — admin-only. The ONLY endpoint that surfaces
// OpenFGA internals (relation strings, tuple shape, store id). Gated on
// can_audit on the organization.

import { NextRequest, NextResponse } from "next/server";

import { getAuthFromBearerOrSession } from "@/lib/api-middleware";
import { authorize, describeFgaCheck } from "@/lib/authz";
import {
  HttpAuthzError,
  decisionContext,
  metaErrorResponse,
  parseAction,
  parseResource,
  parseSubject,
  requireAuditCapability,
  resolveCaller,
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
    const ctx = decisionContext(session);
    await requireAuditCapability(caller, ctx);

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

    const req = { subject, resource, action };
    const result = await authorize(req, ctx);
    const fga = await describeFgaCheck(req);

    return NextResponse.json(
      {
        decision: result.decision,
        reason: result.reason,
        retriable: result.retriable,
        debug: {
          engine: fga.engine,
          relation: fga.relation,
          checked: [`${fga.user} ${fga.relation} ${fga.object}`],
          store: fga.store,
        },
      },
      { status: 200 },
    );
  } catch (err) {
    if (err instanceof HttpAuthzError) return metaErrorResponse(err);
    throw err;
  }
}
