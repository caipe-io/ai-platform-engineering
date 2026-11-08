import type { Participant } from "@/types/mongodb";

/** Chat membership grants no agent, tool or credential permissions. */
export interface ChatCoordinationAgent {
  agent_id: string;
  handle: string;
  name: string;
  added_at: string;
  added_by: string;
}

export const MAX_COORDINATION_AGENTS = 8;
export const AGENT_HANDLE_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export function conversationHasAgent(
  conversation: { participants: Participant[]; coordination_agents?: ChatCoordinationAgent[] },
  agentId: unknown,
): boolean {
  return typeof agentId === "string" && (
    conversation.participants.some((participant) => participant.type === "agent" && participant.id === agentId) ||
    (conversation.coordination_agents ?? []).some((agent) => agent.agent_id === agentId)
  );
}

export function suggestedAgentHandle(name: string): string {
  const handle = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return AGENT_HANDLE_PATTERN.test(handle) && handle !== "primary" ? handle : "helper";
}

/** A leading mention selects one chat participant; ordinary text/emails do not. */
export function leadingAgentMention(input: string): string | null {
  return input.match(/^@([a-z][a-z0-9-]{1,31})(?:\s|$)/)?.[1] ?? null;
}
