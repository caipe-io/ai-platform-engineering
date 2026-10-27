import { apiClient } from "@/lib/api-client";
import { getStorageMode } from "@/lib/storage-config";
import { getAgentId, type Conversation } from "@/types/a2a";

/** Refresh authorized server fields while retaining local messages and stream state. */
export function mergeAppConversation(conversations: Conversation[], saved: {
  _id: string; title: string; participants: Conversation["participants"];
  created_at: Date | string; updated_at: Date | string; metadata?: Conversation["metadata"];
  owner_id?: string; access_level?: Conversation["accessLevel"]; sharing?: Conversation["sharing"];
}): Conversation[] {
  const previous = conversations.find(item => item.id === saved._id);
  const restored: Conversation = { ...previous, id: saved._id, title: saved.title, participants: saved.participants,
    createdAt: new Date(saved.created_at), updatedAt: new Date(saved.updated_at), metadata: saved.metadata,
    owner_id: saved.owner_id, accessLevel: saved.access_level, sharing: saved.sharing,
    messages: previous?.messages ?? [], streamEvents: previous?.streamEvents ?? [] };
  return previous ? conversations.map(item => item.id === saved._id ? restored : item) : [...conversations, restored];
}

/** App history requires explicit app and agent bindings; metadata never grants access. */
export function matchesAssistantConversation(appId: string, agentId: string, agent: string | null | undefined,
  metadata?: Record<string, unknown>, includeLegacy = false): boolean {
  if (agent !== agentId) return false;
  if (metadata?.agentic_app_id !== undefined) return metadata.conversation_surface === "agentic-app" &&
    metadata.agentic_app_id === appId && metadata.agentic_app_agent_id === agentId;
  return includeLegacy && metadata?.conversation_surface !== "agentic-app" && metadata?.agentic_app_agent_id === undefined;
}

/** Search explicit web history without changing the user's sidebar filter. */
export async function findLatestAppConversation(
  local: Conversation[], appId: string, agentId: string, includeLegacy = false,
): Promise<Conversation | null> {
  const matches = (conversation: { participants?: Conversation["participants"]; metadata?: Record<string, unknown> }) =>
    matchesAssistantConversation(appId, agentId, getAgentId(conversation), conversation.metadata, includeLegacy);
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
    if (found) return mergeAppConversation([], found)[0];
    if (!response.has_more) return null;
  }
  throw new Error("Assistant history scan limit reached; no new conversation was created.");
}
