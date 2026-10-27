import { apiClient } from "@/lib/api-client";
import { getStorageMode } from "@/lib/storage-config";
import { getAgentId, type Conversation } from "@/types/a2a";

/** App history requires explicit app and agent bindings; metadata never grants access. */
export function matchesAssistantConversation(appId: string, agentId: string, agent: string | undefined,
  metadata?: Record<string, unknown>): boolean {
  return agent === agentId && metadata?.conversation_surface === "agentic-app" &&
    metadata.agentic_app_id === appId && metadata.agentic_app_agent_id === agentId;
}

/** Search explicit web history without changing the user's sidebar filter. */
export async function findLatestAppConversation(
  local: Conversation[], appId: string, agentId: string,
): Promise<Conversation | null> {
  const matches = (conversation: { participants?: Conversation["participants"]; metadata?: Record<string, unknown> }) =>
    matchesAssistantConversation(appId, agentId, getAgentId(conversation), conversation.metadata);
  if (getStorageMode() !== "mongodb") {
    return local.filter((conversation) => (!conversation.accessLevel || conversation.accessLevel === "owner") && matches(conversation))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
  }
  // The API returns newest first. Stop at the first owned match; never create
  // a duplicate if the bounded scan cannot establish that history is exhausted.
  for (let page = 1; page <= 100; page++) {
    const response = await apiClient.getConversations({
      page, page_size: 100, source: "web", client_type: "webui", archived: false,
    });
    const found = response.items.find((conversation) =>
      matches(conversation) && conversation.access_level === "owner",
    );
    if (found) return {
      id: found._id, title: found.title, createdAt: new Date(found.created_at),
      updatedAt: new Date(found.updated_at), participants: found.participants,
      metadata: found.metadata, messages: [], streamEvents: [], accessLevel: "owner",
    };
    if (!response.has_more) return null;
  }
  throw new Error("Assistant history scan limit reached; no new conversation was created.");
}
