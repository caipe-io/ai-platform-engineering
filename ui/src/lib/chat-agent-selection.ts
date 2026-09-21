"use client";

import type { DynamicAgentConfig } from "@/types/dynamic-agent";

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
}

export interface ResolvedChatAgent {
  id: string;
  name: string;
  execution_harness_id?: string;
  source: "user-default" | "platform-default" | "first-available";
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function normalizedAgentId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export interface ChatDefaultAgentIds {
  userDefaultAgentId: string | null;
  platformDefaultAgentId: string | null;
}

/** Load personal and platform Web defaults in one preferences request. */
export async function fetchChatDefaultAgentIds(): Promise<ChatDefaultAgentIds> {
  const payload = await fetchJson<
    ApiEnvelope<{
      web_default_agent_id?: unknown;
      platform_default_agent_id?: unknown;
    }>
  >("/api/user/preferences");
  const data = payload.success ? payload.data : null;
  return {
    userDefaultAgentId: normalizedAgentId(data?.web_default_agent_id),
    platformDefaultAgentId: normalizedAgentId(data?.platform_default_agent_id),
  };
}

async function fetchAvailableAgents(): Promise<DynamicAgentConfig[]> {
  const payload = await fetchJson<ApiEnvelope<DynamicAgentConfig[]>>(
    "/api/dynamic-agents/available",
  );
  if (!payload.success || !Array.isArray(payload.data)) {
    throw new Error(payload.error || "Failed to load available agents");
  }
  return payload.data.filter((agent) => agent.enabled);
}

export async function resolveUsableChatAgent(): Promise<ResolvedChatAgent> {
  const [defaultsResult, agentsResult] = await Promise.allSettled([
    fetchChatDefaultAgentIds(),
    fetchAvailableAgents(),
  ]);

  const defaults =
    defaultsResult.status === "fulfilled"
      ? defaultsResult.value
      : { userDefaultAgentId: null, platformDefaultAgentId: null };
  const userDefaultAgentId = defaults.userDefaultAgentId;
  const defaultAgentId = defaults.platformDefaultAgentId;
  const availableAgents =
    agentsResult.status === "fulfilled" ? agentsResult.value : [];

  // Highest priority: the user's own Web default, but only if they still have
  // access to it (it's in the available list). A stale/revoked choice falls
  // through to the platform default rather than dead-ending the new chat.
  if (userDefaultAgentId) {
    const userAgent = availableAgents.find((agent) => agent._id === userDefaultAgentId);
    if (userAgent) {
      return {
        id: userAgent._id,
        name: userAgent.name,
        execution_harness_id: userAgent.execution_harness_id,
        source: "user-default",
      };
    }
  }

  if (defaultAgentId) {
    const defaultAgent = availableAgents.find((agent) => agent._id === defaultAgentId);
    if (defaultAgent) {
      return {
        id: defaultAgent._id,
        name: defaultAgent.name,
        execution_harness_id: defaultAgent.execution_harness_id,
        source: "platform-default",
      };
    }

    if (agentsResult.status === "rejected") {
      return {
        id: defaultAgentId,
        name: "Default agent",
        source: "platform-default",
      };
    }
  }

  const fallbackAgent = availableAgents[0];
  if (fallbackAgent) {
    return {
      id: fallbackAgent._id,
      name: fallbackAgent.name,
      source: "first-available",
    };
  }

  throw new Error(
    "No dynamic agents are available. Ask an administrator to configure a default agent or grant you access to an agent.",
  );
}

export async function resolveUsableChatAgentId(): Promise<string> {
  return (await resolveUsableChatAgent()).id;
}
