import { NextRequest } from "next/server";

import { ApiError, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { SecondaryOidcIdentityLinkError } from "@/lib/auth/secondary-identity-link";
import { isSecondaryOidcConfigured, validateSecondaryOidcJWT } from "@/lib/auth/secondary-oidc";

/** Explicit secondary trust boundary; ordinary host APIs keep primary auth. */
const handlePost = withErrorHandler(async (request: NextRequest) => {
  if (!isSecondaryOidcConfigured()) throw new ApiError("Secondary authentication is disabled", 404, "SECONDARY_AUTH_DISABLED");
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length > 32768) {
    throw new ApiError("A secondary bearer token is required", 401, "SECONDARY_AUTH_REQUIRED");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) throw new ApiError("Request body is too large", 413, "BODY_TOO_LARGE");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
  }
  let body: { resource?: unknown };
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError("A resource URL is required", 400, "INVALID_RESOURCE"); }
  if (!body || typeof body.resource !== "string" || body.resource.length > 2048) {
    throw new ApiError("A resource URL is required", 400, "INVALID_RESOURCE");
  }
  try {
    const identity = await validateSecondaryOidcJWT(authorization.slice(7), body.resource);
    return successResponse({ linked: true, resource: body.resource, identity: { sub: identity.sub, email: identity.email, name: identity.name } });
  } catch (error) {
    if (error instanceof SecondaryOidcIdentityLinkError && error.unlinkedIdentity) {
      return successResponse({ linked: false, resource: body.resource,
        identity: { email: error.unlinkedIdentity.email, name: error.unlinkedIdentity.name } });
    }
    if (error instanceof SecondaryOidcIdentityLinkError) {
      throw new ApiError("The secondary identity cannot be linked to an active user", 403, error.code);
    }
    throw new ApiError("The secondary token or resource could not be verified", 401, "SECONDARY_AUTH_INVALID");
  }
});

export async function POST(request: NextRequest) {
  const response = await handlePost(request, undefined);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
