import type { NextRequest } from "next/server";

import type { ResourceAuthzSession } from "@/lib/rbac/resource-authz";
import { buildSignedUserContextHeaders } from "@/lib/server/user-context-signing";

/**
 * Headers for server-side workflow engine calls into Dynamic Agents.
 * Prefer the caller's Bearer token; fall back to the OIDC access token on the session.
 */
export function buildWorkflowDaAuthHeaders(
  request: NextRequest,
  user: { email: string; name?: string | null },
  session: ResourceAuthzSession,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const incomingAuth = request.headers.get("Authorization")?.trim();
  const sessionRecord = session as Record<string, unknown>;
  const accessToken =
    typeof sessionRecord.accessToken === "string" ? sessionRecord.accessToken.trim() : "";

  if (incomingAuth) {
    headers.Authorization = incomingAuth;
  } else if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const encodedUserContext = Buffer.from(
    JSON.stringify({
      email: user.email,
      name: user.name ?? null,
    }),
  ).toString("base64");
  Object.assign(headers, buildSignedUserContextHeaders(encodedUserContext));

  return headers;
}
