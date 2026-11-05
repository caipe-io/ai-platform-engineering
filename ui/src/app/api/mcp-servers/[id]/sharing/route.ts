/**
 * GET  /api/mcp-servers/[id]/sharing  — list teams with caller access
 * PUT  /api/mcp-servers/[id]/sharing  — replace team access set
 *
 * Team access is modelled as `team:<slug>#member caller tool:<serverId>/*`
 * OpenFGA tuples. Both reads and writes go through the same helpers used
 * by the team-resources route so the tuple shape stays consistent.
 */

import {
  ApiError,
  getAuthFromBearerOrSession,
  successResponse,
  withErrorHandler,
} from "@/lib/api-middleware";
import { getCollection } from "@/lib/mongodb";
import { buildTeamResourceTupleDiff, readOpenFgaTuples } from "@/lib/rbac/openfga";
import { requireResourcePermission } from "@/lib/rbac/resource-authz";
import { reconcileTupleDiff } from "@/lib/authz";
import type { Team } from "@/types/teams";
import type { NextRequest } from "next/server";

type RouteContext = { params: Promise<{ id: string }> };

async function listSharingTeamSlugs(serverId: string): Promise<string[]> {
  const slugs = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const page = await readOpenFgaTuples({
      tuple: { object: `tool:${serverId}/*`, relation: "caller" },
      continuationToken,
    });
    for (const { key } of page.tuples) {
      const match = /^team:([^#]+)#member$/.exec(key.user);
      if (match?.[1]) slugs.add(match[1]);
    }
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return [...slugs];
}

export const GET = withErrorHandler(async (req: NextRequest, { params }: RouteContext) => {
  const { id: serverId } = await params;
  await getAuthFromBearerOrSession(req);

  const mcpCol = await getCollection("mcp_servers");
  const server = await mcpCol.findOne({ _id: serverId } as never);
  if (!server) throw new ApiError("MCP server not found", 404);

  const currentSlugs = await listSharingTeamSlugs(serverId);

  const teamsCol = await getCollection<Team>("teams");
  const teams = await teamsCol
    .find({ slug: { $in: currentSlugs } } as never)
    .project({ _id: 1, name: 1, slug: 1 })
    .toArray();

  return successResponse({ teams, teamSlugs: currentSlugs });
});

export const PUT = withErrorHandler(async (req: NextRequest, { params }: RouteContext) => {
  const { id: serverId } = await params;
  const { session, user } = await getAuthFromBearerOrSession(req);

  await requireResourcePermission(session, {
    type: "mcp_server" as const,
    id: serverId,
    action: "manage" as const,
  });

  const body = (await req.json()) as { teamSlugs?: unknown };
  const nextSlugs: string[] = Array.isArray(body.teamSlugs)
    ? body.teamSlugs.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];

  const currentSlugs = await listSharingTeamSlugs(serverId);
  const currentSet = new Set(currentSlugs);
  const nextSet = new Set(nextSlugs);

  const added = nextSlugs.filter((s) => !currentSet.has(s));
  const removed = currentSlugs.filter((s) => !nextSet.has(s));

  const toolRef = `${serverId}/*`;
  const ctx = { caller: { type: "user" as const, id: session.sub! }, source: "mcp_server_sharing" };

  await Promise.all([
    ...added.map((slug) =>
      reconcileTupleDiff(
        buildTeamResourceTupleDiff({
          teamSlug: slug,
          agents: { added: [], removed: [] },
          agentAdmins: { added: [], removed: [] },
          tools: { added: [toolRef], removed: [] },
          toolWildcard: { added: false, removed: false },
          allMcpServerIds: [serverId],
        }),
        ctx,
      )
    ),
    ...removed.map((slug) =>
      reconcileTupleDiff(
        buildTeamResourceTupleDiff({
          teamSlug: slug,
          agents: { added: [], removed: [] },
          agentAdmins: { added: [], removed: [] },
          tools: { added: [], removed: [toolRef] },
          toolWildcard: { added: false, removed: false },
          allMcpServerIds: [serverId],
        }),
        ctx,
      )
    ),
  ]);

  console.log(
    `[MCP Sharing] PUT server=${serverId} added=${added.length} removed=${removed.length} by=${user.email}`,
  );

  return successResponse({ teamSlugs: nextSlugs });
});
