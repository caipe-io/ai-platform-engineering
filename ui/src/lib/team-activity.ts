import type { ChatMessage } from "@/types/a2a";

export type TeamActivityEntry = { kind: "message"; message: ChatMessage } |
  { kind: "activity"; id: string; messages: ChatMessage[]; complete: boolean };

/** Group teammate replies by durable assignment chain or explicit multi-recipient turn. */
export function teamActivityEntries(messages: ChatMessage[], primaryAgentId: string): TeamActivityEntry[] {
  const key = (message: ChatMessage) => message.role === "assistant" && message.agentId &&
    message.agentId !== primaryAgentId && message.coordinationKind !== "summary"
      ? message.coordinationRootId || message.parallelGroupId : undefined;
  const seen = new Set<string>();
  return messages.flatMap<TeamActivityEntry>(message => {
    const id = key(message);
    if (!id) return [{ kind: "message", message }];
    if (seen.has(id)) return [];
    seen.add(id);
    const replies = messages.filter(candidate => key(candidate) === id);
    const complete = replies.every(reply => reply.isFinal && ["done", "cancelled", "interrupted", "error"].includes(reply.turnStatus ?? ""));
    return [{ kind: "activity", id, messages: replies, complete }];
  });
}
