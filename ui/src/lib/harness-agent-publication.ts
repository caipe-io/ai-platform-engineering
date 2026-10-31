import { ApiError } from "@/lib/api-middleware";
import { getHarnessEngineConfig, proxyHarnessEngine } from "@/lib/harness-engine-proxy";
import { NextResponse } from "next/server";

const RUNTIME_FIELDS = [
  "name", "description", "system_prompt", "app_context_prompt", "allowed_tools", "allowed_remote_agents",
  "remote_agent_timeouts", "model", "visibility", "shared_with_teams", "subagents", "skills",
  "datasource_ids", "rag_collection_ids", "builtin_tools", "features", "enabled", "interrupt_on", "backend", "ui",
] as const;

/** Prepare an immutable version; the agent document's pointer is the publication commit. */
export async function prepareAgentExecution(
  agent: Record<string, unknown>, subject: string, prepared?: unknown,
): Promise<{ version: number; revision: number } | null> {
  const harnessId = typeof agent.execution_harness_id === "string" ? agent.execution_harness_id : "dynamic_agents";
  const input = prepared as { blueprint?: Record<string, unknown>; catalog_revision?: string; config_fingerprint?: string; expected_revision?: number } | undefined;
  const native = harnessId === "dynamic_agents";
  if (!input && !(native && (process.env.HARNESS_ENGINE_DEEP_AGENTS_ENABLED === "true" || agent.execution_blueprint_version))) return null;
  const config = getHarnessEngineConfig();
  if (config instanceof NextResponse) throw new ApiError("Harness Engine is required to save this execution configuration", 503);
  const id = String(agent._id);
  const blueprint: Record<string, unknown> = native ? {
    id, name: agent.name, description: agent.description ?? "",
    harness: { id: harnessId, profile_id: "existing", options: { runtime: Object.fromEntries(
      RUNTIME_FIELDS.filter(field => agent[field] !== undefined).map(field => [field, agent[field]]),
    ) } },
    prompt: { system: agent.system_prompt },
    model: { policy: "configured", ...(agent.model as Record<string, unknown>) },
    delegation: { agents: ((agent.subagents ?? []) as Array<{ agent_id: string }>).map(child => child.agent_id) },
  } : {
    ...input?.blueprint, id, name: agent.name, description: agent.description ?? "",
    prompt: { ...(input?.blueprint?.prompt as object), system: agent.system_prompt },
  };
  if ((blueprint.harness as { id?: string } | undefined)?.id !== harnessId) throw new ApiError("Execution harness does not match the agent", 409);
  // ModelPolicy carries execution selection, not UI-only reasoning controls.
  if (native) delete (blueprint.model as Record<string, unknown>).reasoning_effort;
  const response = await proxyHarnessEngine(config, { subject }, `/api/v1/agents/${encodeURIComponent(id)}`, {
    method: "PUT", body: JSON.stringify({
      blueprint,
      ...(input?.catalog_revision && { catalog_revision: input.catalog_revision }),
      ...(!native && input?.config_fingerprint && { config_fingerprint: input.config_fingerprint }),
      ...(input?.expected_revision && { expected_revision: input.expected_revision }),
    }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.success || !Number.isInteger(result.data?.version?.version)) {
    throw new ApiError("Execution configuration could not be prepared; the agent was not changed", response.status >= 400 ? response.status : 502, "HARNESS_PUBLICATION_FAILED");
  }
  return { version: result.data.version.version, revision: result.data.record.revision };
}
