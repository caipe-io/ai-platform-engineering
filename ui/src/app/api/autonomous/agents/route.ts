import { NextRequest, NextResponse } from "next/server";

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getConfig } from "@/lib/config";
import { getCollection } from "@/lib/mongodb";
import { checkOpenFgaTuple, listOpenFgaObjects } from "@/lib/rbac/openfga";
import { organizationObjectId } from "@/lib/rbac/organization";
import { subjectFromSession } from "@/lib/rbac/resource-authz";
import {
  createJsonResponseCacheStore,
  envTtlMs,
  withJsonResponseCache,
} from "@/lib/server-response-cache";

export const dynamic = "force-dynamic";

const summaryCache = createJsonResponseCacheStore();

export interface AutonomousAgentSummary {
  id: string;
  name: string;
  owner_team_slug: string | null;
}

interface AgentDoc {
  _id: string;
  name?: string;
  owner_team_slug?: string;
}

function stripPrefix(objects: string[], prefix: string): string[] {
  return objects
    .filter((object) => object.startsWith(prefix))
    .map((object) => object.slice(prefix.length))
    .filter(Boolean);
}

function toSummary(doc: AgentDoc): AutonomousAgentSummary {
  return {
    id: String(doc._id),
    name: typeof doc.name === "string" && doc.name ? doc.name : String(doc._id),
    owner_team_slug:
      typeof doc.owner_team_slug === "string" && doc.owner_team_slug ? doc.owner_team_slug : null,
  };
}

/**
 * Autonomous is a user entitlement. Membership in any team with an
 * `automation_eligible` organization grant (or org admin) is sufficient.
 */
async function isAutonomousEligible(openFgaUser: string): Promise<boolean> {
  const decision = await checkOpenFgaTuple({
    user: openFgaUser,
    relation: "can_automate",
    object: organizationObjectId(),
  });
  return decision.allowed;
}

async function usableAgentIds(openFgaUser: string): Promise<string[]> {
  const result = await listOpenFgaObjects({
    user: openFgaUser,
    relation: "can_use",
    type: "agent",
  });
  return stripPrefix(result.objects, "agent:");
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  if (request.nextUrl.searchParams.get("summary") !== "true") {
    return resolveAgents(request);
  }
  return withJsonResponseCache(request, summaryCache, () => resolveAgents(request), {
    ttlMs: envTtlMs("AUTONOMOUS_CAPABILITY_CACHE_TTL_MS", 10_000),
    maxEntries: 512,
  });
});

async function resolveAgents(request: NextRequest): Promise<NextResponse> {
  if (!getConfig("autonomousAgentsEnabled")) {
    throw new ApiError("Autonomous agents are disabled", 404);
  }

  const { session } = await getAuthFromBearerOrSession(request);
  const openFgaUser = subjectFromSession(session);
  if (!openFgaUser) {
    return successResponse({ schedulable: [], eligible: false });
  }

  const summaryOnly = request.nextUrl.searchParams.get("summary") === "true";
  let eligible = false;
  let agentIds: string[] = [];
  try {
    eligible = await isAutonomousEligible(openFgaUser);
    if (eligible && !summaryOnly) {
      agentIds = await usableAgentIds(openFgaUser);
    }
  } catch (error) {
    console.warn("[autonomous/agents] authorization lookup failed:", error);
    return successResponse({ schedulable: [], eligible: false });
  }

  if (summaryOnly || !eligible || agentIds.length === 0) {
    return successResponse({ schedulable: [], eligible });
  }

  const agents = await getCollection<AgentDoc>("dynamic_agents");
  const docs = await agents
    .find({ _id: { $in: agentIds } } as never)
    .project({ name: 1, owner_team_slug: 1 })
    .sort({ name: 1 })
    .toArray();

  return successResponse({
    schedulable: (docs as AgentDoc[]).map(toSummary),
    eligible,
  });
}
