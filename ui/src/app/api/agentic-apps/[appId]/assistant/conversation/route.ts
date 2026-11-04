import { NextRequest } from "next/server";
import type { Filter } from "mongodb";

import { ApiError, getAuthFromBearerOrSession, withErrorHandler } from "@/lib/api-middleware";
import { agenticAppUserContextFromSession, canLaunchAgenticApp } from "@/lib/agentic-apps/access";
import { getConfiguredAgenticApp, isAgenticAppsEnabled } from "@/lib/agentic-apps/config";
import { deriveAgenticAppSubjectId } from "@/lib/agentic-apps/identity";
import { getCollection, isMongoDBConfigured } from "@/lib/mongodb";
import { conversationOwnershipCandidateQuery } from "@/lib/rbac/conversation-implicit-authz";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
import type { Conversation } from "@/types/mongodb";

/** Find one owned app chat without scanning or counting the user's general history. */
export const GET = withErrorHandler(async (
  request: NextRequest,
  context: { params: Promise<{ appId: string }> },
) => {
  const { user, session } = await getAuthFromBearerOrSession(request);
  const subject = deriveAgenticAppSubjectId(session);
  if (!subject || session.isServiceAccount || session.principalType !== "oidc_user")
    throw new ApiError("Interactive user identity required", 403);
  const { appId } = await context.params;
  const app = getConfiguredAgenticApp(appId);
  const assistant = app?.manifest.ui.assistant;
  if (!isAgenticAppsEnabled() || !app || !assistant || !app.manifest.ui.profiles.length ||
      !app.installation.installed || !app.installation.enabled)
    throw new ApiError("App assistant unavailable", 404);
  if (!canLaunchAgenticApp(app, agenticAppUserContextFromSession(session, user.role)))
    throw new ApiError("App access denied", 403);
  const denied = await requireAgentUsePermission({ subject, agentId: assistant.agentId, email: user.email });
  if (denied) return denied;
  if (!isMongoDBConfigured) throw new ApiError("MongoDB not configured", 503);

  // Match the shared popup's explicit binding and its installation-owned legacy opt-in.
  // Neither caller-supplied agent IDs nor publisher metadata can grant ownership.
  const bindings: Filter<Conversation>[] = [{
    "metadata.conversation_surface": "agentic-app",
    "metadata.agentic_app_id": appId,
    "metadata.agentic_app_agent_id": assistant.agentId,
  }];
  if (assistant.hostOptions?.includeLegacyAgentHistory) bindings.push({
    "metadata.agentic_app_id": { $exists: false },
    "metadata.agentic_app_agent_id": { $exists: false },
    "metadata.conversation_surface": { $ne: "agentic-app" },
  });
  const query: Filter<Conversation> = {
    $and: [
      conversationOwnershipCandidateQuery(session, user.email),
      { participants: { $elemMatch: { type: "agent", id: assistant.agentId } } },
      { $or: bindings },
      { $or: [{ client_type: "webui" }, { client_type: { $exists: false } }] },
    ],
    // The host resolves the first agent participant, even in multi-agent records.
    $expr: { $eq: [
      { $first: { $map: {
        input: { $filter: { input: "$participants", as: "participant", cond: { $eq: ["$$participant.type", "agent"] } } },
        as: "agent", in: "$$agent.id",
      } } },
      assistant.agentId,
    ] },
    deleted_at: null,
    is_archived: false,
    source: { $in: ["web", null] },
    $nor: [
      { "metadata.source": "autonomous" },
      { title: { $regex: "^\\[Autonomous\\](\\s|$)", $options: "i" } },
      { "metadata.schedule_id": { $exists: true } },
      { _id: { $regex: "sched_[a-z0-9]+", $options: "i" } },
    ],
  };
  const conversations = await getCollection<Conversation>("conversations");
  // Retain pinned/recent ordering, including empty chats, so reopening never
  // creates a replacement just because the user has not sent a message yet.
  const conversation = await conversations.findOne(query, { sort: { is_pinned: -1, updated_at: -1, _id: -1 } });
  return Response.json({ success: true, data: {
    conversation: conversation ? { ...conversation, access_level: "owner" } : null,
  } }, { headers: { "Cache-Control": "private, no-store" } });
});
