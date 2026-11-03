import { registerOperatorNotificationType } from "@/lib/notifications/operator-registration.server";
import { NextRequest } from "next/server";
import { ApiError, getAuthFromBearerOrSession, successResponse, withErrorHandler } from "@/lib/api-middleware";
import { hasOrganizationAdmin } from "@/lib/rbac/platform-admin";
import { logOpenFgaRebacAuditEvent } from "@/lib/rbac/audit";
import { readNotificationJson } from "@/lib/notifications/http.server";
import { listNotificationEventPolicies, updateNotificationEventPolicy } from "@/lib/notifications/event-policy.server";

async function requireOperator(request: NextRequest): Promise<string> {
  const { session } = await getAuthFromBearerOrSession(request);
  if (session.isServiceAccount || !session.sub || !(await hasOrganizationAdmin(session))) throw new ApiError("Organization administrator required", 403);
  return session.sub;
}
export const GET = withErrorHandler(async (request: NextRequest) => {
  await requireOperator(request);
  return successResponse(await listNotificationEventPolicies());
});
export const PATCH = withErrorHandler(async (request: NextRequest) => {
  const actor = await requireOperator(request);
  const policy = await updateNotificationEventPolicy(await readNotificationJson(request), actor);
  logOpenFgaRebacAuditEvent({ sub: actor, operation: "notification.event_policy.update", scope: "admin", resourceRef: `notification:${policy.sourceId}:${policy.eventType}`, correlationId: `revision:${policy.revision}` });
  return successResponse(policy);
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const actor = await requireOperator(request);
  const event = await registerOperatorNotificationType(await readNotificationJson(request));
  logOpenFgaRebacAuditEvent({ sub: actor, operation: "notification.event.register", scope: "admin", resourceRef: `notification:${event.sourceId}:${event.eventType}` });
  return successResponse(event, 201);
});
