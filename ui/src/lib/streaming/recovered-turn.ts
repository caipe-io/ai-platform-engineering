import type { ChatMessage } from "@/types/a2a";

import type { NativeRun } from "./native-runs";

export function assistantMessageIdForTurn(turnId: string): string {
  return `assistant-${turnId}`;
}

/** Keep an existing message identity when recovering chats created before stable IDs. */
export function recoveredAssistantMessage(run: NativeRun, messages: ChatMessage[]): ChatMessage | undefined {
  return messages.find((message) => message.role === "assistant" && message.turnId === run.turn_id);
}

export function needsNativeRunReplay(run: NativeRun, message: ChatMessage | undefined): boolean {
  if (run.status === "queued" || run.status === "running") return true;
  if (!message || !message.isFinal) return true;
  if (run.status === "completed") return message.turnStatus !== "done";
  if (run.status === "awaiting_input") return message.turnStatus !== "waiting_for_input";
  return message.turnStatus !== "interrupted";
}
