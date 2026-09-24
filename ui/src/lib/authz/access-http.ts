import { NextRequest, NextResponse } from "next/server";

import { ApiError } from "@/lib/api-error";
import { getAuthFromBearerOrSession } from "@/lib/api-middleware";
import { isSupportedResourceAction } from "@/lib/rbac/resource-model";
import { authorize, authorizeMany, grant, revoke } from "./index";
import { ACCESS_QUERY_MAX_IDS, type AccessQueryResponse } from "./access-contract";
import type { Action, AuthorizeResult, DecisionContext, ResourceType, Subject } from "./contract";
import {
  HttpAuthzError, decisionContext, isValidResourceId, metaErrorResponse,
  parseAction, parseGrantIntent, parseResource, parseResourceType, requireManage, resolveCaller,
} from "./http";

type AccessHandler = (
  body: Record<string, unknown>, caller: Subject, ctx: DecisionContext,
) => Promise<NextResponse>;

function invalid(message: string): never {
  throw new HttpAuthzError(400, "INVALID_REQUEST", message);
}

function requireAction(resourceType: ResourceType, raw: unknown): Action {
  const action = parseAction(raw);
  if (!isSupportedResourceAction(resourceType, action)) invalid("action is not supported for this resource type");
  return action;
}

async function authenticate(request: NextRequest): Promise<unknown> {
  const authorization = request.headers.get("authorization");
  // Never fall back to a session when a malformed credential was supplied.
  if (authorization !== null && !/^Bearer \S+$/.test(authorization)) {
    throw new HttpAuthzError(401, "NOT_AUTHENTICATED", "A valid bearer token is required");
  }
  try {
    return (await getAuthFromBearerOrSession(request)).session;
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 401) {
      throw new HttpAuthzError(401, "NOT_AUTHENTICATED", "Authentication required");
    }
    if (error instanceof ApiError && error.statusCode === 403) {
      throw new HttpAuthzError(403, "FORBIDDEN", "Credential is not authorized for the Access API");
    }
    console.error("[access] Authentication failed", { name: error instanceof Error ? error.name : "UnknownError" });
    throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Authentication service temporarily unavailable");
  }
}

/** HTTP boundary only; all policy and relationship writes stay in CAS. */
async function handle(request: NextRequest, fields: string[], operation: AccessHandler): Promise<NextResponse> {
  let response: NextResponse;
  try {
    const session = await authenticate(request);
    const caller = resolveCaller(session);
    if (!caller) throw new HttpAuthzError(401, "NOT_AUTHENTICATED", "A stable authenticated subject is required");

    // Cookie-authenticated requests must come from the BFF's own browser origin.
    if (!request.headers.has("authorization")) {
      const expectedOrigin = new URL(process.env.NEXTAUTH_URL || request.url).origin;
      if (request.headers.get("origin") !== expectedOrigin) {
        throw new HttpAuthzError(403, "FORBIDDEN", "Same-origin requests are required for session authentication");
      }
    }
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      invalid("Content-Type must be application/json");
    }
    let body: unknown;
    try { body = await request.json(); } catch { invalid("Request body must be valid JSON"); }
    if (!body || typeof body !== "object" || Array.isArray(body)) invalid("Request body must be an object");
    if (Object.keys(body).some((key) => !fields.includes(key))) invalid("Request contains unsupported fields");
    response = await operation(body as Record<string, unknown>, caller, decisionContext(session, caller, request));
  } catch (error) {
    if (error instanceof HttpAuthzError) response = metaErrorResponse(error);
    else {
      // A failed write may have reached OpenFGA: do not promise safe automatic retries.
      console.error("[access] Operation failed", { name: error instanceof Error ? error.name : "UnknownError" });
      response = NextResponse.json({ error: "Access operation failed", code: "INTERNAL_ERROR", retriable: false }, { status: 500 });
    }
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function checkAccess(request: NextRequest): Promise<NextResponse> {
  return handle(request, ["resource", "action"], async (body, caller, ctx) => {
    const resource = parseResource(body.resource);
    const action = requireAction(resource.type, body.action);
    const result = await authorize({ subject: caller, resource, action }, ctx);
    if (result.reason === "AUTHZ_UNAVAILABLE") {
      throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Authorization service temporarily unavailable");
    }
    return NextResponse.json(result);
  });
}

export function queryAccess(request: NextRequest): Promise<NextResponse> {
  return handle(request, ["resource_type", "action", "ids"], async (body, caller, ctx) => {
    const resourceType = parseResourceType(body.resource_type);
    const action = requireAction(resourceType, body.action);
    if (!Array.isArray(body.ids) || body.ids.length > ACCESS_QUERY_MAX_IDS ||
        !body.ids.every((id) => isValidResourceId(resourceType, id))) {
      invalid(`ids must be an array of at most ${ACCESS_QUERY_MAX_IDS} valid resource identifiers`);
    }
    const ids = [...new Set(body.ids as string[])];
    const results = ids.length
      ? await authorizeMany(caller, action, resourceType, ids, ctx)
      : new Map<string, AuthorizeResult>();
    if (ids.some((id) => !results.has(id) || results.get(id)?.reason === "AUTHZ_UNAVAILABLE")) {
      throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Authorization service temporarily unavailable");
    }
    const result: AccessQueryResponse = { ids: ids.filter((id) => results.get(id)?.decision === "ALLOW") };
    return NextResponse.json(result);
  });
}

export function changeAccess(request: NextRequest, operation: "grant" | "revoke"): Promise<NextResponse> {
  return handle(request, ["resource", "grantee", "capability"], async (body, caller, ctx) => {
    const intent = parseGrantIntent(body);
    await requireManage(caller, intent.resource, ctx, { operation, intent });
    await (operation === "grant" ? grant : revoke)(intent, ctx);
    return NextResponse.json(operation === "grant" ? { granted: true } : { revoked: true });
  });
}
