import { getCoordinationFeatures } from "@/lib/coordination/features.server";
import { coordinationPolicy, setCoordinationPolicy } from "@/lib/coordination/policy.server";
import { listHandoffs } from "@/lib/coordination/handoffs.server";
import { NextRequest, NextResponse } from "next/server";

import { authorizeConversationReadAccess } from "@/app/api/v1/chat/_conversation-authz";
import { authenticateChatStreamRequest } from "@/app/api/v1/chat/_stream-auth";
import { ApiError, validateConversationId, withErrorHandler } from "@/lib/api-middleware";
import { findAgenticAppAssistantStream } from "@/lib/agentic-apps/assistant-stream";
import { AGENT_HANDLE_PATTERN, MAX_COORDINATION_AGENTS, type ChatCoordinationAgent } from "@/lib/chat-coordination";
import { isHarnessEngineConfigured } from "@/lib/harness-engine-proxy";
import { getHarnessConversationStatus, resolveHarnessGatewayTarget } from "@/lib/harness-gateway";
import { getCollection } from "@/lib/mongodb";
import { isImplicitConversationOwner } from "@/lib/rbac/conversation-implicit-authz";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
import { getAgentId } from "@/types/a2a";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import type { Conversation } from "@/types/mongodb";

type Context = { params: Promise<{ id: string }> };

async function authorize(request: NextRequest, context: Context) {
  const auth = await authenticateChatStreamRequest(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await context.params;
  if (!validateConversationId(id)) throw new ApiError("Invalid conversation ID", 400);
  const access = await authorizeConversationReadAccess(auth, id);
  if (access.denial) return access.denial;
  const conversation = access.conversation;
  const canManage = isImplicitConversationOwner({ sub: auth.subject }, auth.email ?? "", conversation) &&
    conversation.source !== "autonomous" && !conversation.deleted_at &&
    conversation.client_type === "webui" && !findAgenticAppAssistantStream(getAgentId(conversation) ?? "");
  return { auth, conversation, canManage };
}

export const GET = withErrorHandler(async (request: NextRequest, context: Context) => {
  const access = await authorize(request, context);
  if (access instanceof NextResponse) return access;
  const features = await getCoordinationFeatures();
  return NextResponse.json({ success: true, data: {
    agents: access.conversation.coordination_agents ?? [],
    enabled: features.enabled,
    team_available: features.team,
    can_manage: features.enabled && access.canManage,
    available: features.enabled && isHarnessEngineConfigured(),
    mode: features.team ? (await coordinationPolicy(access.conversation._id))?.mode ?? "mentions" : "mentions",
    handoffs: await listHandoffs(access.conversation._id),
  } }, { headers: { "Cache-Control": "no-store" } });
});

export const POST = withErrorHandler(async (request: NextRequest, context: Context) => {
  const access = await authorize(request, context);
  if (access instanceof NextResponse) return access;
  if (!(await getCoordinationFeatures()).enabled) throw new ApiError("Agent Coordination is disabled by the administrator", 403);
  if (!access.canManage) throw new ApiError("Only this chat's owner can add coordination agents to an interactive web chat.", 403);
  if (!isHarnessEngineConfigured()) throw new ApiError("Harness Engine must be configured to attach chat agents.", 503);
  let body: unknown;
  try { body = await request.json(); } catch { throw new ApiError("Invalid request body", 400); }
  const { agent_id: agentId, handle } = (body ?? {}) as Record<string, unknown>;
  if (typeof agentId !== "string" || !/^[A-Za-z0-9._-]{1,192}$/.test(agentId) ||
      typeof handle !== "string" || !AGENT_HANDLE_PATTERN.test(handle) || handle === "primary") {
    throw new ApiError("Choose an agent and a unique handle of 2–32 lowercase letters, numbers or hyphens, starting with a letter. The handle primary is reserved.", 400);
  }
  const { auth, conversation } = access;
  const denied = await requireAgentUsePermission({ ...auth, agentId });
  if (denied) return denied;
  const agent = await (await getCollection<DynamicAgentConfig>("dynamic_agents")).findOne({ _id: agentId });
  if (!agent || !agent.enabled) throw new ApiError("This agent is unavailable.", 409);
  if (findAgenticAppAssistantStream(agentId)) throw new ApiError("App assistants cannot join as coordination agents yet.", 409);
  if (getAgentId(conversation) === agentId) throw new ApiError("This agent is already the primary agent.", 409);
  const primaryId = getAgentId(conversation);
  if (!primaryId) throw new ApiError("This chat has no primary agent.", 409);
  const primaryTarget = await resolveHarnessGatewayTarget(primaryId, { subject: auth.subject, conversationId: conversation._id });
  if (primaryTarget instanceof NextResponse) return primaryTarget;
  if (primaryTarget.kind !== "harness_engine") throw new ApiError("Migrate this conversation to Harness Engine before adding agents. Its existing runtime and history have been preserved.", 409);
  const statusResponse = await getHarnessConversationStatus(auth, { agentId: primaryId, conversationId: conversation._id });
  if (statusResponse) {
    if (!statusResponse.ok) return statusResponse;
    const status = (await statusResponse.json()).data?.status;
    if (status && status !== "idle") throw new ApiError("Finish or stop the current response before adding an agent.", 409);
  }

  const membership: ChatCoordinationAgent = {
    agent_id: agentId, handle, name: agent.name, added_at: new Date().toISOString(), added_by: auth.subject,
  };
  const conversations = await getCollection<Conversation>("conversations");
  // The conditional write bounds membership and prevents both handle and agent
  // duplicates under concurrent requests, without replacing the primary agent.
  const result = await conversations.updateOne({
    _id: conversation._id, deleted_at: null,
    [`coordination_agents.${MAX_COORDINATION_AGENTS - 1}`]: { $exists: false },
    coordination_agents: { $not: { $elemMatch: { $or: [{ agent_id: agentId }, { handle }] } } },
  }, { $push: { coordination_agents: membership }, $set: { updated_at: new Date() } });
  if (!result.modifiedCount) throw new ApiError("This agent or handle is already in the chat, or the chat has reached its limit of eight additional agents. Refresh the list and try again.", 409);
  return NextResponse.json({ success: true, data: membership }, { status: 201 });
});

export const PATCH = withErrorHandler(async (request: NextRequest, context: Context) => {
  const access = await authorize(request, context);
  if (access instanceof NextResponse) return access;
  if (!access.canManage) throw new ApiError("Only the chat owner can change coordination mode", 403);
  const body = await request.json();
  if (!["mentions", "team"].includes(body.mode)) throw new ApiError("Choose a coordination mode", 400);
  if (body.mode === "team" && !(await getCoordinationFeatures()).team) throw new ApiError("Team handoffs are disabled by the administrator", 403);
  if (body.mode === "team" && (!isHarnessEngineConfigured() || !access.conversation.coordination_agents?.length)) {
    throw new ApiError("Add a joined agent before enabling team coordination", 409);
  }
  await setCoordinationPolicy(request, access.conversation._id, access.auth.subject!, body.mode);
  return NextResponse.json({ success: true });
});
