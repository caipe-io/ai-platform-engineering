import { errors as joseErrors } from "jose";
import { NextRequest } from "next/server";
import { getAuthenticatedUser } from "@/lib/api-middleware";
import { validatePlatformBearerJWT } from "@/lib/jwt-validation";
import type { DelegationIdentity } from "./delegation-contract";
import { HttpAuthzError, decisionContext, isValidId } from "./http";

function invalid(message: string): never { throw new HttpAuthzError(400, "INVALID_REQUEST", message); }
const INVALID_TOKEN_CODES = new Set([
  "ERR_JWT_EXPIRED", "ERR_JWT_CLAIM_VALIDATION_FAILED", "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JOSE_ALG_NOT_ALLOWED", "ERR_JWS_INVALID", "ERR_JWT_INVALID", "ERR_JWKS_NO_MATCHING_KEY",
]);
export async function readAccessJson(request: NextRequest, maxBytes = 16 * 1024): Promise<unknown> {
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
      if (size > maxBytes) { await reader.cancel(); return invalid(`Access request exceeds ${maxBytes} bytes`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return invalid("Invalid JSON"); }
}
export async function authenticatePlatformRequest(
  request: NextRequest, options: { serviceOnly?: boolean; humanSessionOnly?: boolean } = {},
): Promise<{
  identity: DelegationIdentity; tenantId?: string; session?: Record<string, unknown>;
}> {
  const { serviceOnly = false, humanSessionOnly: approvalOnly = false } = options;
  let verifiedSession: Record<string, unknown> | undefined;
  const issuer = process.env.OIDC_ISSUER?.trim();
  if (!issuer) throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Platform issuer is not configured");
  const authorization = request.headers.get("authorization");
  let identity: DelegationIdentity;
  let tenantId: string | undefined;
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
    verifiedSession = { ...session };
    tenantId = decisionContext(session).tenantId;
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
  return { identity, tenantId, session: verifiedSession };
}
