import { NextRequest } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  validateConversationId,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { publishNotificationRequest } from "@/lib/notifications/fanout.server";
import { readNotificationJson } from "@/lib/notifications/http.server";
import { consumeNotificationQuota } from "@/lib/notifications/limits.server";
import { isImplicitConversationOwner } from "@/lib/rbac/conversation-implicit-authz";
import type { Conversation } from "@/types/mongodb";

const EVENTS = {
  input_required: {
    type: "agent.requires_input",
    title: "Agent needs your input",
    summary: "An agent is waiting for your answer. Open the conversation to continue.",
  },
  completed: {
    type: "agent.completed",
    title: "Agent task completed",
    summary: "An agent finished its task. Open the conversation for details.",
  },
  failed: {
    type: "agent.failed",
    title: "Agent task failed",
    summary: "An agent could not finish its task. Open the conversation for details.",
  },
} as const;

/** User-delegated agent tools can notify only that user about their own chat.
 * App service accounts use the separately bound app-publisher API instead. */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const { user, session } = await getAuthFromBearerOrSession(request);
  const subject = session.sub?.trim();
  if (session.isServiceAccount || !subject)
    throw new ApiError("A user identity is required for agent notifications", 403, "FORBIDDEN");

  const body = await readNotificationJson(request);
  if (Object.keys(body).some((key) => !["conversation_id", "event_id", "event_type"].includes(key)))
    throw new ApiError("Only conversation_id, event_id and event_type are accepted", 400);
  const { conversation_id: conversationId, event_id: eventId, event_type: eventType } = body;
  if (typeof conversationId !== "string" || !validateConversationId(conversationId))
    throw new ApiError("A valid conversation_id is required", 400);
  if (typeof eventId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(eventId))
    throw new ApiError("event_id must be a stable URL-safe identifier of at most 128 characters", 400);
  if (typeof eventType !== "string" || !Object.hasOwn(EVENTS, eventType))
    throw new ApiError("event_type must be input_required, completed or failed", 400);

  const conversation = await (await getCollection<Conversation>("conversations")).findOne({ _id: conversationId });
  // Reuse chat's canonical owner policy. Sharing and admin audit access do not
  // authorize an agent to publish events about someone else's conversation.
  if (!conversation || conversation.deleted_at || !isImplicitConversationOwner(session, user.email, conversation))
    throw new ApiError("Conversation unavailable", 404, "NOT_FOUND");

  await consumeNotificationQuota(`recipient:${subject}`, 20);
  const event = EVENTS[eventType as keyof typeof EVENTS];
  const result = await publishNotificationRequest({
    base: {
      id: `agent-tool:${eventId}`,
      type: event.type,
      version: 1,
      occurred_at: new Date().toISOString(),
      resource: { type: "conversation", id: conversationId },
      attempt_id: eventId,
      data: {
        status: eventType,
        title: event.title,
        summary: event.summary,
        callbackUri: `/chat/${encodeURIComponent(conversationId)}`,
      },
    },
    recipients: [{ subject }],
    includeOrgAdmins: false,
  });
  if (result.results.failed || result.results.invalid || result.recipients !== 1)
    throw new ApiError("Notification could not be queued. Retry with the same event_id.", 503, "NOTIFICATION_UNAVAILABLE");

  const queued = (result.results.queued ?? 0) + (result.results.delivered ?? 0);
  // Queued is not a delivery receipt. Preferences can also intentionally skip it.
  return successResponse({ status: queued ? "queued" : "disabled", event_type: event.type }, queued ? 202 : 200);
});
