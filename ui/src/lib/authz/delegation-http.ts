import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import { parseAccessAction, parseAccessResource } from "./access-validation";
import { authorizeDelegated, createDelegation, inspectDelegation, revokeDelegation } from "./index";
import {
  DELEGATION_MAX_LIFETIME_MS, DELEGATION_MAX_SCOPE, delegationSnapshot,
  type DelegatedPermission, type DelegationIntent,
} from "./delegation-contract";
import { HttpAuthzError, isValidId, metaErrorResponse } from "./http";

import { authenticatePlatformRequest, readAccessJson } from "./platform-http";

const REFERENCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(message: string): never { throw new HttpAuthzError(400, "INVALID_REQUEST", message); }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    return invalid("Unexpected fields or invalid object");
  }
  return value as Record<string, unknown>;
}
async function permission(value: unknown): Promise<DelegatedPermission> {
  const item = object(value, ["resource", "action"]);
  object(item.resource, ["type", "id"]);
  const resource = await parseAccessResource(item.resource);
  const action = await parseAccessAction(resource, item.action);
  return { resource, action };
}

export async function handleDelegation(request: NextRequest, operation: "create" | "inspect" | "revoke" | "check", id?: string): Promise<NextResponse> {
  const correlationId = randomUUID(); // Caller-supplied trace IDs are not provenance.
  let response: NextResponse;
  try {
    const { identity, tenantId } = await authenticatePlatformRequest(request, { serviceOnly: operation === "check", humanSessionOnly: operation === "create" || operation === "revoke" });
    const ctx = { caller: identity.subject, correlationId, tenantId };
    if (operation !== "create" && (!id || !REFERENCE_PATTERN.test(id))) {
      return invalid("Invalid delegation reference");
    }
    if (operation === "create") {
      const key = request.headers.get("idempotency-key");
      if (!key || !REFERENCE_PATTERN.test(key)) return invalid("Idempotency-Key must be a UUID v4; reuse it only for the same approval");
      const input = object(await readAccessJson(request), ["service", "job_id", "scope", "expires_at"]);
      const service = object(input.service, ["id", "client_id"]);
      if (!isValidId(service.id) || typeof service.client_id !== "string" || !service.client_id.trim() ||
        service.client_id !== service.client_id.trim() || service.client_id.length > 256 || !isValidId(input.job_id)) return invalid("Invalid service or job binding");
      if (!Array.isArray(input.scope) || !input.scope.length || input.scope.length > DELEGATION_MAX_SCOPE) return invalid("scope must contain 1–16 exact permissions");
      const expires = typeof input.expires_at === "string" ? Date.parse(input.expires_at) : NaN;
      if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + DELEGATION_MAX_LIFETIME_MS ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(input.expires_at as string)) return invalid("expires_at must be a future UTC timestamp within seven days");
      const intent: DelegationIntent = { service: { id: service.id, client_id: service.client_id },
        job_id: input.job_id, scope: await Promise.all(input.scope.map(permission)), expires_at: new Date(expires).toISOString() };
      const record = await createDelegation(identity, intent, ctx, key);
      response = NextResponse.json({ delegation_id: record._id, ...delegationSnapshot(record) }, { status: 201 });
    } else if (operation === "check") {
      const input = object(await readAccessJson(request), ["job_id", "resource", "action"]);
      if (!isValidId(input.job_id)) return invalid("Invalid job binding");
      const result = await authorizeDelegated(id!, identity, {
        ...await permission({ resource: input.resource, action: input.action }), job_id: input.job_id,
      }, ctx);
      response = NextResponse.json(result, { status: result.reason === "AUTHZ_UNAVAILABLE" ? 503 : result.reason === "NOT_AUTHENTICATED" ? 401 : 200 });
      response.headers.set("x-caipe-decision-id", result.decision_id);
    } else {
      const record = await (operation === "inspect" ? inspectDelegation(id!, identity) : revokeDelegation(id!, identity, ctx));
      response = record ? NextResponse.json({ delegation_id: record._id, ...delegationSnapshot(record) }) :
        NextResponse.json({ error: "Delegation not found", code: "NOT_FOUND", retriable: false }, { status: 404 });
    }
  } catch (error) {
    if (error instanceof HttpAuthzError) response = metaErrorResponse(error);
    else if (error instanceof ApiError && [401, 403, 503].includes(error.statusCode)) {
      response = NextResponse.json({ error: "Authentication unavailable or rejected", code: error.statusCode === 503 ? "AUTHZ_UNAVAILABLE" : "NOT_AUTHENTICATED", retriable: error.statusCode === 503 }, { status: error.statusCode });
    } else {
      const mutation = operation === "create" || operation === "revoke";
      console.error("[cas/delegation] Request failed", { correlationId, name: error instanceof Error ? error.name : "UnknownError" });
      const reference = id ?? request.headers.get("idempotency-key");
      response = NextResponse.json({ error: mutation ? "Delegation write outcome may be unknown; inspect or retry the same idempotency key" : "Delegation unavailable",
        ...(reference && REFERENCE_PATTERN.test(reference) ? { delegation_id: reference } : {}),
        code: mutation ? "DELEGATION_WRITE_UNKNOWN" : "AUTHZ_UNAVAILABLE", retriable: !mutation }, { status: mutation ? 500 : 503 });
    }
  }
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("x-correlation-id", correlationId);
  return response;
}
