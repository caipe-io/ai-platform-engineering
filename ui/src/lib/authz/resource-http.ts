import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import { agenticAppUserContextFromSession } from "@/lib/agentic-apps/access";
import { resolveAppService } from "@/lib/agentic-apps/service-binding";
import { authorize, registerResource, PendingResourceRegistrationError } from "./index";
import { HttpAuthzError, isValidId, metaErrorResponse } from "./http";
import { authenticatePlatformRequest, readAccessJson } from "./platform-http";
import { parseAccessResource } from "./access-validation";
import { nativeResourceDefinition } from "./model";
import { resourceSnapshot } from "./resource-contract";
import { readRegisteredResource } from "./resource-store";

/** Registration establishes ownership through a real interactive user session. */
export async function handleResource(request: NextRequest, operation: "register" | "inspect", id?: string): Promise<NextResponse> {
  const correlationId = randomUUID();
  let response: NextResponse;
  try {
    const { identity, tenantId, session } = await authenticatePlatformRequest(request, { humanSessionOnly: operation === "register" });
    const ctx = { caller: identity.subject, tenantId, correlationId };
    if (identity.subject.type === "service_account" && !resolveAppService(identity)) {
      throw new HttpAuthzError(403, "FORBIDDEN", "Service is not bound to an enabled resource integration");
    }
    if (operation === "register") {
      const body = await readAccessJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => !["resource", "owner_team"].includes(key))) {
        throw new HttpAuthzError(400, "INVALID_REQUEST", "Unexpected registration fields");
      }
      const input = body as Record<string, unknown>;
      const resource = await parseAccessResource(input.resource);
      if (input.owner_team !== undefined && !isValidId(input.owner_team)) {
        throw new HttpAuthzError(400, "INVALID_REQUEST", "Invalid owner team");
      }
      const record = await registerResource(identity, { resource,
        ...(input.owner_team ? { owner_team: input.owner_team as string } : {}) },
      agenticAppUserContextFromSession(session ?? {}), ctx);
      response = NextResponse.json(resourceSnapshot(record), { status: 201 });
    } else {
      if (!id || !/^[a-z][a-z0-9_]{0,49}:[A-Za-z0-9._%+@-]{1,256}$/.test(id)) throw new HttpAuthzError(400, "INVALID_REQUEST", "Invalid registered resource ID");
      const record = await readRegisteredResource(id);
      // The original creator may inspect a pending registration to recover an
      // ambiguous save. Other callers must pass current resource authorization.
      const creator = record?.state === "pending" && record.issuer === identity.issuer &&
        identity.subject.type === "user" && record.creator.id === identity.subject.id;
      if (record && !creator) {
        await nativeResourceDefinition(record.resource.type);
        const result = await authorize({ subject: identity.subject, resource: record.resource, action: "owner" }, ctx);
        if (result.reason === "AUTHZ_UNAVAILABLE") throw new HttpAuthzError(503, "AUTHZ_UNAVAILABLE", "Resource authorization is unavailable");
        if (result.decision !== "ALLOW") throw new HttpAuthzError(403, "FORBIDDEN", "Resource access denied");
      }
      response = record ? NextResponse.json(resourceSnapshot(record)) :
        NextResponse.json({ error: "Resource not found", code: "NOT_FOUND", retriable: false }, { status: 404 });
    }
  } catch (error) {
    if (error instanceof PendingResourceRegistrationError) {
      response = NextResponse.json({ error: error.message, code: error.code, retriable: true,
        ...resourceSnapshot(error.record) }, { status: 503 });
    } else if (error instanceof HttpAuthzError) response = metaErrorResponse(error);
    else if (error instanceof ApiError && [401, 403].includes(error.statusCode)) {
      response = NextResponse.json({ error: "Authentication required", code: "NOT_AUTHENTICATED", retriable: false }, { status: error.statusCode });
    } else {
      console.error("[cas/resources] Request failed", { correlationId, name: error instanceof Error ? error.name : "UnknownError" });
      response = NextResponse.json({ error: "Resource operation unavailable; retry the same registration to inspect its outcome",
        code: "AUTHZ_UNAVAILABLE", retriable: true }, { status: 503 });
    }
  }
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("x-correlation-id", correlationId);
  return response;
}
