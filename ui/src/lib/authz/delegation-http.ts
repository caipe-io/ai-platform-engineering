import { randomUUID } from "crypto";
import { errors as joseErrors } from "jose";
import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import { getAuthenticatedUser } from "@/lib/api-middleware";
import { validatePlatformBearerJWT } from "@/lib/jwt-validation";
import { isSupportedResourceAction } from "@/lib/rbac/resource-model";
import { authorizeDelegated, createDelegation, inspectDelegation, revokeDelegation } from "./index";
import {
  DELEGATION_MAX_LIFETIME_MS, DELEGATION_MAX_SCOPE, delegationSnapshot,
  type DelegatedPermission, type DelegationIdentity, type DelegationIntent,
} from "./delegation-contract";
import { HttpAuthzError, isValidId, metaErrorResponse, parseAction, parseResource } from "./http";

const INVALID_TOKEN_CODES = new Set([
  "ERR_JWT_EXPIRED", "ERR_JWT_CLAIM_VALIDATION_FAILED", "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JOSE_ALG_NOT_ALLOWED", "ERR_JWS_INVALID", "ERR_JWT_INVALID", "ERR_JWKS_NO_MATCHING_KEY",
]);
const REFERENCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(message: string): never { throw new HttpAuthzError(400, "INVALID_REQUEST", message); }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    return invalid("Unexpected fields or invalid object");
  }
  return value as Record<string, unknown>;
}
function permission(value: unknown): DelegatedPermission {
  const item = object(value, ["resource", "action"]);
  object(item.resource, ["type", "id"]);
  const resource = parseResource(item.resource);
  const action = parseAction(item.action);
  if (!isSupportedResourceAction(resource.type, action)) return invalid("Unsupported resource/action");
  return { resource, action };
}
async function body(request: NextRequest): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return invalid("Content-Type must be application/json");
  }
  const reader = request.body?.getReader();
  if (!reader) return invalid("A JSON body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) { await reader.cancel(); return invalid("Delegation request exceeds 16 KiB"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return invalid("Invalid JSON"); }
}
async function authenticate(request: NextRequest, serviceOnly: boolean, approvalOnly: boolean): Promise<DelegationIdentity> {
  const issuer = process.env.OIDC_ISSUER?.trim();
  if (!issuer) throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Platform issuer is not configured");
  const authorization = request.headers.get("authorization");
  let identity: DelegationIdentity;
  if (authorization !== null) {
    const token = /^Bearer (\S+)$/.exec(authorization)?.[1];
    if (!token || token.length > 16384) throw new HttpAuthzError(401, "NOT_AUTHENTICATED", "A valid platform bearer is required");
    // A valid owner bearer can have been minted by a legacy impersonation flow.
    // It proves identity, not an interactive user's approval of new authority.
    if (approvalOnly) throw new HttpAuthzError(403, "FORBIDDEN", "Approve and revoke through the signed-in browser session");
    try { identity = await validatePlatformBearerJWT(token); }
    catch (error) {
      if (error instanceof joseErrors.JOSEError && INVALID_TOKEN_CODES.has(error.code)) {
        throw new HttpAuthzError(401, "NOT_AUTHENTICATED", "Platform bearer rejected");
      }
      throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Platform token validation unavailable");
    }
  } else {
    if (serviceOnly) throw new HttpAuthzError(401, "NOT_AUTHENTICATED", "A service bearer is required");
    if (request.method !== "GET" && request.headers.get("origin") !== new URL(process.env.NEXTAUTH_URL || request.url).origin) {
      throw new HttpAuthzError(403, "FORBIDDEN", "Same-origin session requests are required");
    }
    const { session } = await getAuthenticatedUser(request);
    if (!("principalType" in session) || session.principalType !== "oidc_user" ||
      ("isServiceAccount" in session && session.isServiceAccount) || !isValidId(session.sub)) {
      throw new HttpAuthzError(401, "NOT_AUTHENTICATED", "A canonical signed-in user is required");
    }
    const clientId = process.env.OIDC_CLIENT_ID?.trim();
    if (!clientId || typeof session.expiresAt !== "number" || !Number.isFinite(session.expiresAt)) {
      throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Session identity is incomplete");
    }
    identity = { issuer, subject: { type: "user", id: session.sub }, clientId, expiresAt: session.expiresAt };
  }
  if (identity.expiresAt * 1000 <= Date.now()) throw new HttpAuthzError(401, "NOT_AUTHENTICATED", "Identity expired");
  if (serviceOnly && identity.subject.type !== "service_account") throw new HttpAuthzError(403, "FORBIDDEN", "A service identity is required");
  return identity;
}

export async function handleDelegation(request: NextRequest, operation: "create" | "inspect" | "revoke" | "check", id?: string): Promise<NextResponse> {
  const correlationId = randomUUID(); // Caller-supplied trace IDs are not provenance.
  let response: NextResponse;
  try {
    const identity = await authenticate(request, operation === "check", operation === "create" || operation === "revoke");
    const ctx = { caller: identity.subject, correlationId };
    if (operation !== "create" && (!id || !REFERENCE_PATTERN.test(id))) {
      return invalid("Invalid delegation reference");
    }
    if (operation === "create") {
      const key = request.headers.get("idempotency-key");
      if (!key || !REFERENCE_PATTERN.test(key)) return invalid("Idempotency-Key must be a UUID v4; reuse it only for the same approval");
      const input = object(await body(request), ["service", "job_id", "scope", "expires_at"]);
      const service = object(input.service, ["id", "client_id"]);
      if (!isValidId(service.id) || typeof service.client_id !== "string" || !service.client_id.trim() ||
        service.client_id !== service.client_id.trim() || service.client_id.length > 256 || !isValidId(input.job_id)) return invalid("Invalid service or job binding");
      if (!Array.isArray(input.scope) || !input.scope.length || input.scope.length > DELEGATION_MAX_SCOPE) return invalid("scope must contain 1–16 exact permissions");
      const expires = typeof input.expires_at === "string" ? Date.parse(input.expires_at) : NaN;
      if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + DELEGATION_MAX_LIFETIME_MS ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(input.expires_at as string)) return invalid("expires_at must be a future UTC timestamp within seven days");
      const intent: DelegationIntent = { service: { id: service.id, client_id: service.client_id },
        job_id: input.job_id, scope: input.scope.map(permission), expires_at: new Date(expires).toISOString() };
      const record = await createDelegation(identity, intent, ctx, key);
      response = NextResponse.json({ delegation_id: record._id, ...delegationSnapshot(record) }, { status: 201 });
    } else if (operation === "check") {
      const input = object(await body(request), ["job_id", "resource", "action"]);
      if (!isValidId(input.job_id)) return invalid("Invalid job binding");
      const result = await authorizeDelegated(id!, identity, {
        ...permission({ resource: input.resource, action: input.action }), job_id: input.job_id,
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
