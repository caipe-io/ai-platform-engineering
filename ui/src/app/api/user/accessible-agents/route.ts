/**
 * GET /api/user/accessible-agents
 *
 * Returns the list of agents the signed-in user has `can_use` on, in a
 * compact picker-shaped form ({id, name, description}). Used by the DM
 * agent preference picker (spec FR-021).
 *
 * Pagination: ?page=1&page_size=25  (page_size capped at 100).
 */

import { NextRequest } from "next/server";

import {
getAuthFromBearerOrSession,
successResponse,
withErrorHandler,
} from "@/lib/api-middleware";
import { getHarnessPresentation } from "@/lib/agent-presentation";
import { getCollection } from "@/lib/mongodb";
import { filterResourcesByPermission } from "@/lib/rbac/resource-authz";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { NextResponse } from "next/server";

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export const dynamic = "force-dynamic";

interface AgentPickerEntry {
  id: string;
  name: string;
  description: string;
  harness_id: string;
  harness_name: string;
}

function parsePagination(url: URL): { page: number; pageSize: number } {
  const rawPage = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const rawPageSize = Number.parseInt(
    url.searchParams.get("page_size") ?? String(DEFAULT_PAGE_SIZE),
    10,
  );
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const pageSize = Math.min(
    Math.max(Number.isFinite(rawPageSize) && rawPageSize > 0 ? rawPageSize : DEFAULT_PAGE_SIZE, 1),
    MAX_PAGE_SIZE,
  );
  return { page, pageSize };
}

function toPickerEntry(agent: DynamicAgentConfig & { _id: unknown }): AgentPickerEntry {
  const harness = getHarnessPresentation(agent.execution_harness_id);
  return {
    id: String(agent._id),
    name: typeof agent.name === "string" ? agent.name : String(agent._id),
    description: typeof agent.description === "string" ? agent.description : "",
    harness_id: harness.id,
    harness_name: harness.label,
  };
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  const { session } = await getAuthFromBearerOrSession(request);
  if (typeof session.sub !== "string" || session.sub.trim().length === 0) {
    return NextResponse.json(
      {
        success: false,
        error: "You are not signed in. Please sign in to continue.",
        code: "NOT_SIGNED_IN",
        reason: "not_signed_in",
        action: "sign_in",
      },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const { page, pageSize } = parsePagination(url);

  const collection = await getCollection<DynamicAgentConfig & { _id: unknown }>(
    "dynamic_agents",
  );
  const allAgents = await collection
    .find({ enabled: true })
    .sort({ name: 1 })
    .toArray();

  const visible = await filterResourcesByPermission(session, allAgents, {
    type: "agent",
    action: "use",
    id: (agent) => String(agent._id),
  });

  const total = visible.length;
  const startIndex = (page - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const pageItems = visible.slice(startIndex, endIndex).map(toPickerEntry);

  return successResponse({
    agents: pageItems,
    total,
    page,
    page_size: pageSize,
  });
});
