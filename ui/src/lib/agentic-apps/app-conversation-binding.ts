import { getAgentId } from "@/types/a2a";
import type { Conversation } from "@/types/mongodb";

type AppConversation = Pick<Conversation, "participants" | "app_binding">;

/** Only a server-admitted binding identifies an app execution owner. */
export function hasStoredAppConversationIdentity(conversation: AppConversation): boolean {
  return conversation.app_binding !== undefined;
}

/** A history constraint; catalog, agent-use and conversation-read checks still apply. */
export function matchesAppConversation(conversation: AppConversation, appId: string, agentId: string): boolean {
  if (getAgentId(conversation) !== agentId) return false;
  const binding = conversation.app_binding;
  return binding === undefined || Boolean(binding && binding.app_id === appId && binding.agent_id === agentId);
}
