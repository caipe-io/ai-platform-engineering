/**
 * API route for listing available dynamic agents for the current user.
 * 
 * This returns agents that the user can chat with:
 * - Global agents (visibility: 'global')
 * - Team agents for teams the user belongs to (owner or shared)
 * - Agents owned directly by the user
 * - The configured platform default agent
 * 
 * Only returns enabled agents.
 */

import {
getAuthFromBearerOrSession,
successResponse,
withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { projectAgentAppIdentity } from "@/lib/agentic-apps/agent-catalog";
import { filterAgentsByOwnershipScopeForSession } from "@/lib/rbac/agent-ownership-scope";
import { baselineBootstrapTuples,getBaselineFgaProfile } from "@/lib/rbac/baseline-access";
import { writeOpenFgaTuples } from "@/lib/rbac/openfga";
import { filterResourcesByPermission } from "@/lib/rbac/resource-authz";
import {
createJsonResponseCacheStore,
envTtlMs,
withJsonResponseCache,
} from "@/lib/server-response-cache";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { NextRequest } from "next/server";

const COLLECTION_NAME = "dynamic_agents";
const OPENFGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~@|*+=,/-]{0,191}$/;
const availableAgentsCache = createJsonResponseCacheStore();

function normalizeDefaultAgentId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && OPENFGA_ID_PATTERN.test(trimmed) ? trimmed : null;
}

async function ensureBaselineAccess(session: { sub?: unknown; role?: string }): Promise<void> {
  if (typeof session.sub !== "string" || !session.sub.trim()) return;
  try {
    const profile = await getBaselineFgaProfile();
    await writeOpenFgaTuples({
      writes: baselineBootstrapTuples(session.sub.trim(), session.role === "admin", profile),
      deletes: [],
    });
  } catch (error) {
    console.warn(
      "[DynamicAgentsAvailable] Failed to reconcile baseline OpenFGA grants:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

async function resolveConfiguredDefaultAgentId(): Promise<string | null> {
  const config = await getCollection<{ default_agent_id?: unknown }>("platform_config");
  const doc = await config.findOne({ _id: "platform_settings" } as never);
  return (
    normalizeDefaultAgentId(doc?.default_agent_id) ??
    normalizeDefaultAgentId(process.env.DEFAULT_AGENT_ID)
  );
}

async function ensureConfiguredDefaultAgentGrant(defaultAgentId: string | null): Promise<void> {
  if (!defaultAgentId) return;
  try {
    await writeOpenFgaTuples({
      writes: [{ user: "user:*", relation: "user", object: `agent:${defaultAgentId}` }],
      deletes: [],
    });
  } catch (error) {
    console.warn(
      "[DynamicAgentsAvailable] Failed to reconcile default-agent OpenFGA grant:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Keep the wildcard `user:* user agent:<id>` "everyone can use" grant in
 * sync with each agent's visibility at list time. Global agents get the
 * grant written; non-global agents get it *revoked* — except the platform
 * default agent, which legitimately keeps the wildcard regardless of its
 * own visibility (that is what "default for new chats" means).
 *
 * Self-healing by design: deletes for agents that never had the wildcard
 * are dropped by `filterTupleDiff` (it only emits a delete when the tuple
 * actually resolves), so this is safe to run on every request and cleans
 * up agents that were demoted from `global → team` before the POST/PUT
 * reconcile started carrying the global-access flags.
 */
async function ensureAllUsersAgentGrants(
  agents: DynamicAgentConfig[],
  defaultAgentId: string | null,
): Promise<void> {
  const writes = new Map<string, { user: string; relation: "user"; object: string }>();
  const deletes = new Map<string, { user: string; relation: "user"; object: string }>();

  for (const agent of agents) {
    const agentId = normalizeDefaultAgentId(String(agent._id));
    if (!agentId) continue;
    const tuple = { user: "user:*", relation: "user" as const, object: `agent:${agentId}` };
    if (agent.visibility === "global") {
      writes.set(agentId, tuple);
    } else if (agentId !== defaultAgentId) {
      // Non-global and not the platform default: revoke any stale wildcard.
      deletes.set(agentId, tuple);
    }
  }

  if (writes.size === 0 && deletes.size === 0) return;

  try {
    await writeOpenFgaTuples({
      writes: Array.from(writes.values()),
      deletes: Array.from(deletes.values()),
    });
  } catch (error) {
    console.warn(
      "[DynamicAgentsAvailable] Failed to reconcile global-agent OpenFGA grants:",
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * GET /api/dynamic-agents/available
 * List dynamic agents available for the current user to chat with.
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  return withJsonResponseCache(request, availableAgentsCache, () => getAvailableAgents(request), {
    ttlMs: envTtlMs("DYNAMIC_AGENTS_AVAILABLE_CACHE_TTL_MS", 10_000),
    maxEntries: 512,
  });
});

async function getAvailableAgents(request: NextRequest) {
  const { session } = await getAuthFromBearerOrSession(request);
  await ensureBaselineAccess(session);

  const collection = await getCollection<DynamicAgentConfig>(COLLECTION_NAME);
  let defaultAgentId: string | null = null;
  try {
    defaultAgentId = await resolveConfiguredDefaultAgentId();
  } catch (error) {
    console.warn(
      "[DynamicAgentsAvailable] Failed to resolve configured default agent:",
      error instanceof Error ? error.message : String(error),
    );
  }
  await ensureConfiguredDefaultAgentGrant(defaultAgentId);

  const agents = await collection
    .find({ enabled: true })
    .sort({ name: 1 })
    .toArray();
  await ensureAllUsersAgentGrants(agents, defaultAgentId);

  const scopedAgents = await filterAgentsByOwnershipScopeForSession(
    session,
    agents,
    defaultAgentId,
  );

  const visibleAgents = await filterResourcesByPermission(session, scopedAgents, {
    type: "agent",
    action: "use",
    id: (agent) => String(agent._id),
  });

  // Normalize legacy model_id/model_provider → model
  const normalizedAgents = projectAgentAppIdentity(visibleAgents, session, { availableOnly: true }).map((agent) => {
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
