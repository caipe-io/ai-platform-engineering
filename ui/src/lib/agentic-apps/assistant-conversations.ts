import { apiClient } from "@/lib/api-client";
import { getStorageMode } from "@/lib/storage-config";
import { getAgentId, type Conversation } from "@/types/a2a";
import type { Conversation as StoredConversation } from "@/types/mongodb";

function matchesAppConversation(
  conversation: Pick<Conversation, "participants" | "metadata"> & Pick<StoredConversation, "app_binding">,
  appId: string,
  agentId: string,
): boolean {
  // Labels cannot make a different canonical agent's history usable here.
  if (getAgentId(conversation) !== agentId) return false;
  const binding = conversation.app_binding;
  if (binding !== undefined) return binding?.app_id === appId && binding.agent_id === agentId;
  // Managed and SDK overlays have no app execution binding. Their labels only
  // associate the already-authorized conversation with this UI surface.
  const metadata = conversation.metadata;
  return metadata?.conversation_surface === "agentic-app" &&
    metadata.agentic_app_id === appId && metadata.agentic_app_agent_id === agentId;
}

/** Search explicit web history without changing the user's sidebar filter. */
export async function findLatestAppConversation(
  local: Conversation[], appId: string, agentId: string,
): Promise<Conversation | null> {
  if (getStorageMode() !== "mongodb") {
    return local.filter((conversation) => matchesAppConversation(conversation, appId, agentId))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0] ?? null;
  }
  // The API returns newest first. Stop at the first owned match; never create
  // a duplicate if the bounded scan cannot establish that history is exhausted.
  for (let page = 1; page <= 100; page++) {
    const response = await apiClient.getConversations({
      page, page_size: 100, source: "web", client_type: "webui", archived: false,
    });
    const found = response.items.find((conversation) =>
      matchesAppConversation(conversation, appId, agentId) && conversation.access_level === "owner",
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
