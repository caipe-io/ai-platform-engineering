import { NextResponse } from "next/server";

import { getCollection } from "@/lib/mongodb";
import { getAgentId } from "@/types/a2a";
import type { Conversation } from "@/types/mongodb";
import type { AgenticAppAssistantStream, AssistantStreamOperation } from "./assistant-stream";

/** Only server-admitted app ownership can override the normal runtime route. */
export function resolveAppConversationDestination(
  conversation: Conversation,
  requestedAgentId: unknown,
  operation: AssistantStreamOperation,
  findStream: (agentId: string, operation?: AssistantStreamOperation) => AgenticAppAssistantStream | null,
  retainedRuntime = false,
): AgenticAppAssistantStream | NextResponse | null {
  const binding = conversation.app_binding;
  const storedApp = binding !== undefined;
  const conflict = () => NextResponse.json(
    { success: false, error: "The conversation's app binding changed; an explicit migration or new conversation is required", code: "APP_BINDING_CONFLICT" },
    { status: 409 },
  );
  if (retainedRuntime) return storedApp ? conflict() : null;
  if (binding !== undefined && (!binding || typeof binding.app_id !== "string" || !binding.app_id ||
      typeof binding.agent_id !== "string" || !binding.agent_id)) return conflict();

  const savedAgentId = getAgentId(conversation);
  let target: AgenticAppAssistantStream | null;
  try {
    target = savedAgentId ? findStream(savedAgentId, operation) : null;
    if (!target && typeof requestedAgentId === "string" && requestedAgentId !== savedAgentId &&
        findStream(requestedAgentId)) {
      return NextResponse.json({ success: false, error: "Agent does not match this conversation" }, { status: 409 });
    }
  } catch {
    console.error(`[stream/${operation}] Installed app assistant configuration is unavailable`);
    return NextResponse.json({ success: false, error: "Assistant configuration unavailable" }, { status: 503 });
  }
  if (binding && (!target || binding.app_id !== target.appId ||
      binding.agent_id !== savedAgentId || requestedAgentId !== savedAgentId)) return conflict();
  if (target && requestedAgentId !== savedAgentId) {
    return NextResponse.json({ success: false, error: "Agent does not match this conversation" }, { status: 409 });
  }
  return target;
}

/** Atomically retain the first authorized app route in the canonical conversation. */
export async function admitAppConversation(
  conversation: Conversation,
  target: AgenticAppAssistantStream,
  findStream: (agentId: string, operation?: AssistantStreamOperation) => AgenticAppAssistantStream | null,
): Promise<NextResponse | null> {
  const agentId = getAgentId(conversation);
  const conflict = () => NextResponse.json(
    { success: false, error: "Conversation app ownership changed before admission", code: "APP_BINDING_CONFLICT" },
    { status: 409 },
  );
  if (!conversation._id || !agentId || conversation.deleted_at) return conflict();
  if (conversation.app_binding && (conversation.app_binding.app_id !== target.appId ||
      conversation.app_binding.agent_id !== agentId)) return conflict();
  const query: Record<string, unknown> = {
    _id: conversation._id,
    participants: { $elemMatch: { type: "agent", id: agentId } },
    app_binding: conversation.app_binding ? { $eq: conversation.app_binding } : { $exists: false },
  };
  const identityFields = ["owner_id", "owner_subject", "owner_identity_version", "client_type"] as const;
  for (const field of identityFields) {
    const observed = conversation[field];
    query[field] = observed === undefined ? { $exists: false } : { $eq: observed };
  }
  query.deleted_at = null;
  try {
    const conversations = await getCollection<Conversation>("conversations");
    const admitted = await conversations.findOneAndUpdate(query, {
      $set: { app_binding: { app_id: target.appId, agent_id: agentId } },
    }, { returnDocument: "after" });
    if (admitted) return null;
    const winner = await conversations.findOne({ _id: conversation._id });
    if (!winner || winner.deleted_at || identityFields.some(field => winner[field] !== conversation[field]) || getAgentId(winner) !== agentId || winner.app_binding?.app_id !== target.appId ||
        winner.app_binding.agent_id !== agentId) return conflict();
    const current = resolveAppConversationDestination(winner, agentId, "start", findStream);
    return current instanceof NextResponse ? current : current?.appId === target.appId ? null : conflict();
  } catch {
    console.error("[AppAssistant] Conversation app admission is unavailable");
    return NextResponse.json({ success: false, error: "Conversation app admission unavailable", code: "APP_BINDING_UNAVAILABLE" }, { status: 503 });
  }
}

