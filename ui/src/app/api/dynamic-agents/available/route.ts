/** Read-only chat picker. Grants belong to lifecycle writes and reconciliation. */
import {
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { filterAgentsByOwnershipScopeForSession } from "@/lib/rbac/agent-ownership-scope";
import { getPlatformDefaultAgentId } from "@/lib/rbac/platform-default";
import { filterResourcesByPermission } from "@/lib/rbac/resource-authz";
import {
  createJsonResponseCacheStore,
  envTtlMs,
  withJsonResponseCache,
} from "@/lib/server-response-cache";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { NextRequest } from "next/server";

const availableAgentsCache = createJsonResponseCacheStore();

export const GET = withErrorHandler(async (request: NextRequest) => {
  return withJsonResponseCache(request, availableAgentsCache, () => getAvailableAgents(request), {
    ttlMs: envTtlMs("DYNAMIC_AGENTS_AVAILABLE_CACHE_TTL_MS", 10_000),
    maxEntries: 512,
  });
});

async function getAvailableAgents(request: NextRequest) {
  const { session } = await getAuthFromBearerOrSession(request);
  const collection = await getCollection<DynamicAgentConfig>("dynamic_agents");
  const defaultAgentId = await getPlatformDefaultAgentId();
  const agents = await collection.find({ enabled: true }).sort({ name: 1 }).toArray();

  const scopedAgents = await filterAgentsByOwnershipScopeForSession(session, agents, defaultAgentId);
  const visibleAgents = await filterResourcesByPermission(session, scopedAgents, {
    type: "agent",
    action: "use",
    id: (agent) => String(agent._id),
  });

  const normalizedAgents = visibleAgents.map((agent) => {
    const doc = agent as unknown as Record<string, unknown>;
    if (doc.model_id && !doc.model) {
      doc.model = { id: doc.model_id, provider: doc.model_provider || "unknown" };
      delete doc.model_id;
      delete doc.model_provider;
    }
    return doc;
  });
  return successResponse(normalizedAgents);
}
