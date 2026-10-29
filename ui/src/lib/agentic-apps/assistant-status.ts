import { randomUUID } from "node:crypto";
import { getCollection } from "@/lib/mongodb";
import { ownsPersonalEvidenceConversation } from "@/lib/conversation-evidence-privacy";
import { upsertChatMessage } from "@/lib/chat-message-persistence";
import { getAgentId } from "@/types/a2a";
import type { Conversation, Message } from "@/types/mongodb";
import type { AgenticAppAssistantStatus, AgenticAppCompletedTurn } from "@/types/agentic-app";

/** App status is a bounded public contract, never a channel for native session state. */
export async function readAssistantStatus(response: Response): Promise<AgenticAppAssistantStatus> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing assistant status");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024) throw new Error("Assistant status exceeds its limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  const value = JSON.parse(new TextDecoder().decode(buffer));
  if (!value || typeof value !== "object" || typeof value.running !== "boolean" ||
      value.turnId !== undefined && (typeof value.turnId !== "string" || !value.turnId || value.turnId.length > 128)) {
    throw new Error("Invalid assistant status");
  }
  let completedTurn: AgenticAppCompletedTurn | undefined;
  if (value.completedTurn !== undefined) {
    const turn = value.completedTurn;
    if (!turn || typeof turn !== "object" || Object.keys(turn).some(key =>
      !["turnId", "content", "completedAt"].includes(key)) || typeof turn.turnId !== "string" ||
      !turn.turnId || turn.turnId.length > 128 || typeof turn.content !== "string" ||
      !turn.content.trim() || turn.content.length > 12_000 || typeof turn.completedAt !== "string" ||
      !Number.isFinite(Date.parse(turn.completedAt))) throw new Error("Invalid assistant completion");
    completedTurn = { turnId: turn.turnId, content: turn.content, completedAt: turn.completedAt };
  }
  return { running: value.running, ...(value.turnId ? { turnId: value.turnId } : {}),
    ...(completedTurn ? { completedTurn } : {}) };
}

/** Called only after the app's authenticated status response and canonical write authorization. */
export async function persistAssistantCompletion(input: {
  subject: string; email?: string; conversationId: string; agentId: string;
  appId: string; turn: AgenticAppCompletedTurn;
}): Promise<boolean> {
  const conversations = await getCollection<Conversation>("conversations");
  const conversation = await conversations.findOne({ _id: input.conversationId });
  if (!conversation || conversation.deleted_at || conversation.client_type !== "webui" ||
      !ownsPersonalEvidenceConversation(conversation, input.subject, input.email) ||
      getAgentId(conversation) !== input.agentId || conversation.app_binding?.app_id !== input.appId ||
      conversation.app_binding.agent_id !== input.agentId) return false;
  const messages = await getCollection<Message>("messages");
  // The runtime cannot invent a user turn or choose an arbitrary message ID.
  const user = await messages.findOne({ conversation_id: conversation._id,
    role: "user", "metadata.turn_id": input.turn.turnId });
  if (!user) return false;
  const now = new Date();
  const { result } = await upsertChatMessage(messages, {
    conversationId: conversation._id, role: "assistant", turnId: input.turn.turnId, appTurn: true, trustedCompletion: true,
    fields: { content: input.turn.content, updated_at: now, metadata: {
      source: "web", turn_id: input.turn.turnId, agent_id: input.agentId,
      is_final: true, is_interrupted: false, turn_status: "done", app_completion: {
        app_id: input.appId, agent_id: input.agentId, turn_id: input.turn.turnId,
        completed_at: input.turn.completedAt,
      },
    } },
    insert: { message_id: randomUUID(), conversation_id: conversation._id,
      role: "assistant", owner_id: conversation.owner_id,
      created_at: new Date(new Date(user.created_at).getTime() + 1) },
  });
  if (result.upsertedCount) await conversations.updateOne({ _id: conversation._id },
    { $inc: { "metadata.total_messages": 1 } });
  return true;
}
