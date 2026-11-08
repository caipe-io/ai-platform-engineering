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

export interface AgentMentionToken { handle: string; start: number; end: number; }

/** Whitespace-delimited mentions exclude email addresses and partial handles. */
export function agentMentionTokens(input: string): AgentMentionToken[] {
  return Array.from(input.matchAll(/(?:^|\s)@([a-z][a-z0-9-]{1,31})(?=\s|$)/g), match => ({
    handle: match[1], start: match.index! + match[0].indexOf("@"), end: match.index! + match[0].length,
  }));
}

/** Only the consecutive leading mentions address recipients; body references do not. */
export function leadingAgentMentions(input: string): { handles: string[]; end: number } {
  const handles: string[] = [];
  let end = 0;
  for (const token of agentMentionTokens(input)) {
    if (input.slice(end, token.start).trim()) break;
    if (!handles.includes(token.handle)) handles.push(token.handle);
    end = token.end;
  }
  while (/\s/.test(input[end] ?? "") && end < input.length) end++;
  return { handles, end };
}

export function leadingAgentMention(input: string): string | null {
  return leadingAgentMentions(input).handles[0] ?? null;
}

/** Locate the token at the caret so a second mention never replaces the first. */
export function agentMentionQuery(input: string, caret: number): { start: number; filter: string } | null {
  const match = input.slice(0, caret).match(/(?:^|\s)@([a-z0-9-]*)$/i);
  return match ? { start: caret - match[1].length - 1, filter: match[1] } : null;
}

/** Every subscriber and the delivery worker write the same handoff answer. */
export function handoffAssistantMessageId(turnId: string | undefined): string | undefined {
  return turnId && /^handoff-[a-f0-9]{64}$/.test(turnId) ? `${turnId}-assistant` : undefined;
}
