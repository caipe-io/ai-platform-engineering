/** Public conversation data excludes server-owned edit recovery state. */
import type { Conversation, PendingConversationEdit } from "@/types/mongodb";

type InternalConversation = Conversation & {
  native_rewind?: Record<string, unknown>;
  native_rewind_epoch?: number;
};

export function conversationForViewer<T extends Conversation | null>(
  conversation: T,
  viewer?: { owner: boolean; email: string; subject: string },
): T {
  if (!conversation) return conversation;
  const visible = { ...conversation } as InternalConversation;
  const operation = visible.native_rewind;
  const epoch = visible.native_rewind_epoch ?? 0;
  delete visible.native_rewind;
  delete visible.native_rewind_epoch;
  delete visible.pending_edit;
  if (viewer?.owner && viewer.email === conversation.owner_id && operation?.owner_email === viewer.email
      && operation.owner_subject === viewer.subject && operation.epoch === epoch
      && (operation.phase === "pending_history" || operation.phase === "history_applied")
      && typeof operation.agent_id === "string" && typeof operation.message_id === "string") {
    visible.pending_edit = { agent_id: operation.agent_id, message_id: operation.message_id,
      phase: operation.phase } satisfies PendingConversationEdit;
  }
  return visible as T;
}
