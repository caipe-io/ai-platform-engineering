import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api-error";
import { getCollection } from "@/lib/mongodb";
import { requireAgentUsePermission } from "@/lib/rbac/openfga-agent-authz";
import { reconcileAgentRelationships } from "@/lib/rbac/openfga-agent-tools";
import { caipeOrgKey } from "@/lib/rbac/organization";
import { filterResourcesByPermission, requireResourcePermission } from "@/lib/rbac/resource-authz";
import type { AuthResult } from "@/lib/da-proxy";
import type { DynamicAgentConfig, RemoteAgentRegistryEntry } from "@/types/dynamic-agent";
import { getHarnessEngineConfig, proxyHarnessEngine } from "@/lib/harness-engine-proxy";

export const A2A_PARTICIPANT_PREFIX = "a2a-remote-";
export function a2aRegistryId(agentId: string): string | null {
  return agentId.startsWith(A2A_PARTICIPANT_PREFIX) ? agentId.slice("a2a-".length) : null;
}
type RegistryEntry = RemoteAgentRegistryEntry & { enabled?: boolean };

export async function chatA2AAgent(agentId: string): Promise<DynamicAgentConfig | null> {
  const id = a2aRegistryId(agentId);
  if (!id) return null;
  const entry = await (await getCollection<RegistryEntry>("remote_agents")).findOne({ _id: id, enabled: { $ne: false } });
  if (!entry) return null;
  return a2aAgentView(entry);
}

function a2aAgentView(entry: Pick<RegistryEntry, "_id" | "name" | "description">): DynamicAgentConfig {
  // A catalog projection, never a new Agent Builder definition or credential copy.
  return { _id: `a2a-${entry._id}`, name: entry.name, description: entry.description,
    execution_harness_id: "a2a_remote", system_prompt: "Remote A2A participant",
    allowed_tools: {}, subagents: [], skills: [], enabled: true, visibility: "team",
    owner_id: "", is_system: false, created_at: "", updated_at: "" };
}

function session(auth: AuthResult) {
  return { sub: auth.subject, user: { email: auth.email }, isServiceAccount: auth.isServiceAccount };
}
async function registryAdmin(auth: AuthResult): Promise<boolean> {
  try {
    await requireResourcePermission(session(auth), { type: "organization", id: caipeOrgKey(), action: "manage" });
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 403) return false;
    throw error;
  }
}

export async function availableChatA2AAgents(auth: AuthResult): Promise<DynamicAgentConfig[]> {
  if (process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED !== "true") return [];
  const entries = await (await getCollection<RegistryEntry>("remote_agents")).find({ enabled: { $ne: false } })
    .project<Pick<RegistryEntry, "_id" | "name" | "description">>({ _id: 1, name: 1, description: 1 }).sort({ name: 1 }).toArray();
  const views = entries.map(a2aAgentView);
  if (await registryAdmin(auth)) return views;
  return filterResourcesByPermission(session(auth), views, { type: "agent", action: "use", id: agent => agent._id });
}

export async function requireChatA2AUse(auth: AuthResult, agentId: string): Promise<NextResponse | null> {
  const denied = await requireAgentUsePermission({ ...auth, agentId });
  if (!denied || denied.status !== 403 || !await registryAdmin(auth)) return denied;
  // Existing registry entries predate chat participation. Initialize only the
  // organization-admin inheritance; no user/team wildcard is introduced.
  await reconcileAgentRelationships({ agentId, nextAllowedTools: {}, organizationId: caipeOrgKey() });
  return requireAgentUsePermission({ ...auth, agentId });
}

export async function prepareChatA2AExecution(agentId: string, auth: AuthResult): Promise<void> {
  const agent = await chatA2AAgent(agentId);
  if (!agent) throw new ApiError("Remote A2A agent is unavailable", 409);
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) throw new ApiError("Harness Engine is unavailable", 503);
  const existing = await proxyHarnessEngine(config, auth, `/api/v1/agents/${encodeURIComponent(agentId)}`);
  if (existing.ok) {
    const saved = (await existing.json()).data?.version?.blueprint;
    if (saved?.harness?.id !== "a2a_remote" || saved?.harness?.options?.registry_id !== a2aRegistryId(agentId)) {
      throw new ApiError("A2A participant has a conflicting execution binding", 409);
    }
    return;
  }
  if (existing.status !== 404) throw new ApiError("A2A execution configuration is unavailable", 503);
  const result = await proxyHarnessEngine(config, auth, `/api/v1/agents/${encodeURIComponent(agentId)}`, {
    method: "PUT", body: JSON.stringify({ blueprint: { id: agentId, name: agent.name,
      harness: { id: "a2a_remote", profile_id: "registry", options: { registry_id: a2aRegistryId(agentId) } },
      prompt: { system: "Forward addressed messages to the registered A2A agent." }, model: { policy: "harness_default" } } }),
  });
  if (!result.ok) throw new ApiError("Remote A2A execution could not be prepared", result.status >= 400 ? result.status : 502);
}
