import { NextRequest } from "next/server";

import { getAuthFromBearerOrSession,successResponse,withErrorHandler } from "@/lib/api-middleware";
import { getRbacCollection } from "@/lib/rbac/mongo-collections";
import { checkOpenFgaTuple } from "@/lib/rbac/openfga";
import { hasOrganizationAdmin } from "@/lib/rbac/platform-admin";
import { subjectFromSession } from "@/lib/rbac/resource-authz";
import {
computeWebexSpaceHealthSummaries,
type WebexSpaceHealthSummary,
} from "@/lib/rbac/webex-space-diagnostics";
import { listWebexSpaceGrants,webexWorkspaceRef } from "@/lib/rbac/webex-space-grant-store";
import { listWebexSpaceAgentRoutes } from "@/lib/rbac/webex-space-route-store";
import { callWebexBotAdmin } from "@/lib/webex-bot-admin";
import { requireAvailableWebexBotPolicy } from "@/lib/webex-bot-policy";

interface WebexSpaceTeamMappingDoc {
  bot_id: string;
  webex_workspace_id?: string;
  webex_space_id: string;
  space_name?: string;
  space_title?: string;
  team_id?: string;
  team_slug?: string;
  active?: boolean;
}

interface DiscoveredWebexSpace {
  id: string;
  name: string;
}

function storedSpaceName(row: WebexSpaceTeamMappingDoc): string {
  const savedName = [row.space_name, row.space_title]
    .map((value) => value?.trim() ?? "")
    .find((value) => value && value !== row.webex_space_id);
  return savedName ?? row.webex_space_id;
}

function pickPrimaryAgentId(
  routes: Awaited<ReturnType<typeof listWebexSpaceAgentRoutes>>,
): string | undefined {
  const enabledRoute = routes
    .filter((route) => route.enabled !== false)
    .sort(
      (left, right) =>
        (left.priority ?? 100) - (right.priority ?? 100) ||
        left.agent_id.localeCompare(right.agent_id)
    )[0];
  if (enabledRoute?.agent_id) return enabledRoute.agent_id;
  return undefined;
}

async function webexSpaceAccess(
  openfgaUser: string,
  workspaceId: string,
  spaceId: string
): Promise<{ canRead: boolean; canManage: boolean }> {
  const object = `webex_space:${workspaceId}--${spaceId}`;
  const [read, manage] = await Promise.all([
    checkOpenFgaTuple({ user: openfgaUser, relation: "can_read", object }).catch(() => ({ allowed: false })),
    checkOpenFgaTuple({ user: openfgaUser, relation: "can_manage", object }).catch(() => ({ allowed: false })),
  ]);
  return {
    canRead: read.allowed || manage.allowed,
    canManage: manage.allowed,
  };
}

export const GET = withErrorHandler(async (request: NextRequest) => {
    const { session } = await getAuthFromBearerOrSession(request);
    const organizationAdmin = await hasOrganizationAdmin(session);
    const subject = subjectFromSession(session);
    // `?health=1` opts the caller in to a per-row diagnostics summary
    // (warnings count + OpenFGA reachability + last runtime error
    // timestamp). Mirrors the Slack channels endpoint so the shared
    // ConnectorAdminPanel can show real per-row health for Webex too.
    const includeHealth = request.nextUrl.searchParams.get("health") === "1";
    const botId = (
      await requireAvailableWebexBotPolicy(request.nextUrl.searchParams.get("bot_id"))
    ).id;
    const mappings = await getRbacCollection<WebexSpaceTeamMappingDoc>("webexSpaceTeamMappings");
    const rows = await mappings
      .find({
        bot_id: botId,
        active: { $ne: false },
      } as never)
      .sort({ space_name: 1, space_title: 1 })
      .limit(500)
      .toArray();

    const needsDiscoveredNames = rows.some(
      (row) => storedSpaceName(row) === row.webex_space_id,
    );
    const discoveredNames = new Map<string, string>();
    if (needsDiscoveredNames) {
      try {
        const snapshot = await callWebexBotAdmin<{ spaces?: DiscoveredWebexSpace[] }>(
          `/admin/webex/bots/${botId}/spaces`,
          { query: { limit: 500 } },
        );
        for (const space of snapshot.spaces ?? []) {
          const id = String(space.id ?? "").trim();
          const name = String(space.name ?? "").trim();
          if (id && name && name !== id) discoveredNames.set(id, name);
        }
      } catch (error) {
        console.warn(
          `[Admin WebexSpaces] unable to resolve stored space names for bot=${botId}`,
          error,
        );
      }
    }

    const visibleRows = (
      await Promise.all(
        rows.map(async (row) => {
          const workspaceId = webexWorkspaceRef(row.webex_workspace_id);
          const [access, routes] = await Promise.all([
            subject
              ? organizationAdmin
                ? Promise.resolve({ canRead: true, canManage: true })
                : webexSpaceAccess(subject, workspaceId, row.webex_space_id)
              : Promise.resolve({ canRead: false, canManage: false }),
            listWebexSpaceAgentRoutes(workspaceId, row.webex_space_id, botId),
          ]);
          if (!access.canRead || routes.length === 0) return null;
          return { row, workspaceId, access, routes };
        })
      )
    ).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

    const healthSummaries = includeHealth
      ? await computeWebexSpaceHealthSummaries(
          visibleRows.map(({ row, workspaceId }) => ({
            workspaceId,
            spaceId: row.webex_space_id,
          })),
          botId,
        ).catch(
          () =>
            visibleRows.map(
              (): WebexSpaceHealthSummary => ({
                warnings_count: 0,
                openfga_reachable: false,
                last_runtime_error_ts: null,
              }),
            ),
        )
      : [];

    const spaces = await Promise.all(
      visibleRows.map(async ({ row, workspaceId, access, routes }, index) => {
        const grants = await listWebexSpaceGrants(workspaceId, row.webex_space_id);
        const health = includeHealth ? healthSummaries[index] : undefined;
        const savedSpaceName = storedSpaceName(row);
        return {
          workspace_id: workspaceId,
          space_id: row.webex_space_id,
          space_name:
            savedSpaceName === row.webex_space_id
              ? discoveredNames.get(row.webex_space_id) ?? savedSpaceName
              : savedSpaceName,
          team_id: row.team_id,
          team_slug: row.team_slug,
          bot_id: row.bot_id,
          primary_agent_id: pickPrimaryAgentId(routes),
          active_grants: grants.length,
          can_manage: access.canManage,
          ...(health ? { health } : {}),
        };
      })
    );

    return successResponse({ spaces: spaces.filter((space): space is NonNullable<typeof space> => space !== null) });
});
