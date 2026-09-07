/**
 * One-shot handoff for the Home page hero composer: it creates a conversation
 * and navigates to it before a message can be sent (ChatPanel only exists once
 * a conversation id is in the URL), so the pending turn is stashed here and
 * picked up by ChatPanel on mount instead of duplicating the send pipeline.
 */

import type { InputFile } from "@/lib/file-attachments";

export interface PendingFirstMessage {
  text: string;
  files: InputFile[];
}

let pending: (PendingFirstMessage & { conversationId: string }) | null = null;

export function setPendingFirstMessage(
  conversationId: string,
  text: string,
  files: InputFile[] = [],
): void {
  pending = { conversationId, text, files };
}

/** Returns and clears the pending message if it matches this conversation. */
export function takePendingFirstMessage(
  conversationId: string,
): PendingFirstMessage | null {
  if (pending?.conversationId !== conversationId) return null;
  const { text, files } = pending;
  pending = null;
  return { text, files };
}
