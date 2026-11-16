import type { Conversation } from "@/types/a2a";

const MESSAGE_LIMIT = 6000;

function excerpt(text: string): string {
  return text.length > MESSAGE_LIMIT
    ? `${text.slice(0, MESSAGE_LIMIT)}\n[Excerpt truncated]`
    : text;
}

/** Capture visible text from the latest exchange, excluding tools and attachments. */
export function captureChatFeedbackContext(conversation: Conversation, origin: string, streaming: boolean): string | undefined {
  const questionIndex = conversation.messages.findLastIndex(message => message.role === "user");
  if (questionIndex < 0) return undefined;
  const question = conversation.messages[questionIndex];
  const answer = conversation.messages.slice(questionIndex + 1)
    .findLast(message => message.role === "assistant" && message.content.trim());
  const partial = streaming || answer?.isInterrupted || answer?.turnStatus === "interrupted" || answer?.isFinal === false;
  return [
    `Conversation: ${conversation.id}`,
    `Chat URL: ${origin}/chat/${encodeURIComponent(conversation.id)}`,
    `Question:\n${excerpt(question.content)}`,
    answer ? `Response${partial ? " (partial)" : ""}:\n${excerpt(answer.content)}` : "Response: Not yet available.",
  ].join("\n\n");
}
