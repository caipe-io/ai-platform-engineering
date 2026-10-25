import type { DynamicAgentConfig } from "@/types/dynamic-agent";

interface AgentInfoResult {
  agent: DynamicAgentConfig | null;
  notFound: boolean;
}

export function buildAgentChatTitle(agentName: string, appName: string): string {
  return `${agentName} · Chat · ${appName}`;
}

/**
 * Resolve viewer-facing agent metadata without requiring manage/read access.
 *
 * The detail route is the richest source, but users who only have `agent#use`
 * can still chat with an agent and may not be allowed to read that route. The
 * available-agents route is already filtered by `agent#use`, so it is the
 * correct fallback for the chat identity header.
 */
export async function fetchAgentInfoForChat(agentId: string): Promise<AgentInfoResult> {
  let detailNotFound = false;

  try {
    const response = await fetch(`/api/dynamic-agents/agents/${encodeURIComponent(agentId)}`);
    if (response.ok) {
      const data = await response.json();
      return { agent: data.data as DynamicAgentConfig, notFound: false };
    }
    detailNotFound = response.status === 404;
  } catch (error) {
    console.error("[ChatContainer] Failed to fetch agent detail:", error);
  }

  try {
    const response = await fetch("/api/dynamic-agents/available");
    if (response.ok) {
      const data = await response.json();
      const agents = data.success && Array.isArray(data.data)
        ? data.data as DynamicAgentConfig[]
        : [];
      const agent = agents.find((candidate) => candidate._id === agentId) ?? null;
      if (agent) return { agent, notFound: false };
    }
  } catch (error) {
    console.error("[ChatContainer] Failed to fetch available agent metadata:", error);
  }

  return { agent: null, notFound: detailNotFound };
}
