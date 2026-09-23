import { NextRequest } from "next/server";

import { getAuthFromBearerOrSession,successResponse,withErrorHandler } from "@/lib/api-middleware";
import { getAuditReader } from "@/lib/audit/reader";
import { getCollection } from "@/lib/mongodb";
import { checkOpenFgaTuple,writeOpenFgaTuples } from "@/lib/rbac/openfga";
import { requireAdminSurfaceManage } from "@/lib/rbac/require-openfga";
import { subjectFromSession } from "@/lib/rbac/resource-authz";
import { slackChannelTeamVisibilityRelationships } from "@/lib/rbac/slack-channel-rebac";
import type { SlackChannelHealthSummary } from "@/lib/rbac/slack-channel-diagnostics";
import { listSlackChannelGrants,slackWorkspaceRef } from "@/lib/rbac/slack-channel-grant-store";
import { buildUniversalRebacTupleDiff } from "@/lib/rbac/tuple-builders";
import type { SlackChannelAgentRouteDocument } from "@/lib/rbac/slack-channel-route-store";

interface ChannelTeamMappingDoc {
  slack_workspace_id?: string;
  slack_channel_id: string;
  channel_name?: string;
  team_id?: string;
  team_slug?: string;
  active?: boolean;
}

interface ChannelListRow {
  slack_workspace_id?: string;
  slack_channel_id: string;
  channel_name?: string;
  team_id?: string;
  team_slug?: string;
  active?: boolean;
  source: "team_mapping" | "route_metadata";
}

function pickPrimaryAgentId(routes: SlackChannelAgentRouteDocument[]): string | undefined {
  const enabledRoute = routes
    .filter((route) => route.enabled !== false)
    .sort(
      (left, right) =>
        (left.priority ?? 100) - (right.priority ?? 100) ||
        left.agent_id.localeCompare(right.agent_id)
    )[0];
  const agentId = enabledRoute?.agent_id;
  return typeof agentId === "string" && agentId.trim() ? agentId.trim() : undefined;
}

const SLACK_LIST_HEALTH_AUDIT_LIMIT = 5_000;
const SLACK_LIST_HEALTH_AUDIT_TIMEOUT_MS = 2_000;

function slackChannelAuditResourceRef(workspaceId: string, channelId: string): string {
  return `slack_channel:${slackWorkspaceRef(workspaceId)}--${channelId}`;
}

function auditEventTimestamp(event: Record<string, unknown>): string | null {
  const raw = event.ts;
  if (raw instanceof Date) return raw.toISOString();
  return typeof raw === "string" && raw.trim() ? raw : null;
}

function auditEventResourceRef(event: Record<string, unknown>): string | null {
  const raw = event.resource_ref ?? event.resourceRef;
  return typeof raw === "string" && raw.trim() ? raw : null;
}

// assisted-by Codex Codex-sonnet-4-6
async function loadSlackListHealth(rows: ChannelListRow[]): Promise<Map<string, SlackChannelHealthSummary>> {
  const healthByKey = new Map<string, SlackChannelHealthSummary>();
  if (rows.length === 0) return healthByKey;

  for (const row of rows) {
    const workspaceId = slackWorkspaceRef(row.slack_workspace_id);
    healthByKey.set(`${workspaceId}/${row.slack_channel_id}`, {
      warnings_count: 0,
      openfga_reachable: true,
      last_runtime_error_ts: null,
    });
  }

  const until = new Date();
  const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
  const resourceKeys = new Map(
    rows.map((row) => {
      const workspaceId = slackWorkspaceRef(row.slack_workspace_id);
      return [
        slackChannelAuditResourceRef(workspaceId, row.slack_channel_id),
        `${workspaceId}/${row.slack_channel_id}`,
      ] as const;
    })
  );

  const events = await getAuditReader().query({
    since,
    until,
    component: "slack_bot",
    outcome: "error",
    limit: SLACK_LIST_HEALTH_AUDIT_LIMIT,
    timeoutMs: SLACK_LIST_HEALTH_AUDIT_TIMEOUT_MS,
  });

  for (const event of events) {
    const resourceRef = auditEventResourceRef(event);
    if (!resourceRef) continue;
    const key = resourceKeys.get(resourceRef);
    if (!key) continue;
    const ts = auditEventTimestamp(event);
    if (!ts) continue;
    const existing = healthByKey.get(key);
    if (!existing) continue;
    const current = existing.last_runtime_error_ts;
    if (!current || Date.parse(ts) > Date.parse(current)) {
      existing.last_runtime_error_ts = ts;
    }
  }

  return healthByKey;
}

async function slackChannelAccess(
  openfgaUser: string,
  workspaceId: string,
  channelId: string,
  teamSlug?: string,
  repairManageGrant = true,
): Promise<{ canRead: boolean; canManage: boolean }> {
  const object = `slack_channel:${workspaceId}--${channelId}`;
  const checkAccess = () => Promise.all([
    checkOpenFgaTuple({ user: openfgaUser, relation: "can_read", object }).catch(() => ({ allowed: false })),
    checkOpenFgaTuple({ user: openfgaUser, relation: "can_manage", object }).catch(() => ({ allowed: false })),
  ]);
  let [read, manage] = await checkAccess();
  let repairedManageGrant = false;
  if (repairManageGrant && read.allowed && !manage.allowed && teamSlug) {
    // assisted-by Codex Codex-sonnet-4-6
    // Older channel assignments may only have the team-member use tuple.
    // Re-materialize the central assignment policy so upgraded installs get
    // the new team-member manage tuple without a manual migration first.
    const repair = await writeOpenFgaTuples(
      buildUniversalRebacTupleDiff({
        writes: slackChannelTeamVisibilityRelationships(workspaceId, channelId, teamSlug),
        deletes: [],
      })
    ).catch((error) => {
      console.warn("[SlackChannels] Failed to repair team visibility tuples", {
        workspaceId,
        channelId,
        teamSlug,
        error,
      });
      return null;
    });
    repairedManageGrant = Boolean(repair?.enabled && repair.writes > 0);
    [read, manage] = await checkAccess();
  }
  return {
    canRead: read.allowed || manage.allowed || repairedManageGrant,
    canManage: manage.allowed || repairedManageGrant,
  };
}

export const GET = withErrorHandler(async (request: NextRequest) => {
    const { session } = await getAuthFromBearerOrSession(request);
    const subject = subjectFromSession(session);
    // `?health=1` opts the caller in to a per-row diagnostics summary
    // (warnings count + OpenFGA reachability + last runtime error
    // timestamp). Computed in parallel server-side so a workspace with
    // dozens of channels stays under one round-trip from the UI's
    // perspective.
    const includeHealth = request.nextUrl.searchParams.get("health") === "1";
    const canManageSlackSurface = await requireAdminSurfaceManage(session, "slack")
      .then(() => true)
      .catch(() => false);
    const mappings = await getCollection<ChannelTeamMappingDoc>("channel_team_mappings");
    const mappingRows = await mappings
      .find({ active: { $ne: false } } as never)
      .sort({ channel_name: 1 })
      .limit(500)
      .toArray();
    const rowByKey = new Map<string, ChannelListRow>();
    for (const row of mappingRows) {
      const workspaceId = slackWorkspaceRef(row.slack_workspace_id);
      rowByKey.set(`${workspaceId}/${row.slack_channel_id}`, { ...row, slack_workspace_id: workspaceId, source: "team_mapping" });
    }

    const routeCollection = await getCollection<SlackChannelAgentRouteDocument>("slack_channel_agent_routes");
    const routeRows = await routeCollection
      .find({ status: "active" } as never)
      .limit(1000)
      .toArray();
    for (const route of routeRows) {
      const workspaceId = slackWorkspaceRef(String(route.workspace_id ?? ""));
      const channelId = String(route.channel_id ?? "");
      if (!channelId) continue;
      const key = `${workspaceId}/${channelId}`;
      if (!rowByKey.has(key)) {
        rowByKey.set(key, {
          slack_workspace_id: workspaceId,
          slack_channel_id: channelId,
          channel_name: channelId,
          source: "route_metadata",
        });
      }
    }

    const rows = Array.from(rowByKey.values())
      .sort((left, right) => (left.channel_name ?? left.slack_channel_id).localeCompare(right.channel_name ?? right.slack_channel_id))
      .slice(0, 500);

    const healthByKey = includeHealth ? await loadSlackListHealth(rows) : new Map<string, SlackChannelHealthSummary>();

    const channels = await Promise.all(
      rows.map(async (row) => {
        const workspaceId = slackWorkspaceRef(row.slack_workspace_id);
        const access = subject
          ? await slackChannelAccess(
              subject,
              workspaceId,
              row.slack_channel_id,
              row.team_slug,
              true,
            )
          : { canRead: false, canManage: false };
        // A Slack surface admin can see every channel row, including
        // team_mapping rows imported (config_sync) but not yet assigned to a
        // team — those have no per-channel OpenFGA grants yet, so canRead is
        // false, but the admin still needs to see them in order to onboard
        // them. Without this, an imported-but-unassigned channel is invisible
        // in the Configured Channels tab. Non-admins still require canRead.
        if (!access.canRead && !canManageSlackSurface) return null;
        const [grants, routesForChannel, health] = await Promise.all([
          listSlackChannelGrants(workspaceId, row.slack_channel_id),
          routeCollection
            .find({ workspace_id: workspaceId, channel_id: row.slack_channel_id, status: "active" } as never)
            .toArray(),
          Promise.resolve(includeHealth ? healthByKey.get(`${workspaceId}/${row.slack_channel_id}`) : undefined),
        ]);
        return {
          workspace_id: workspaceId,
          channel_id: row.slack_channel_id,
          channel_name: row.channel_name ?? row.slack_channel_id,
          team_id: row.team_id,
          team_slug: row.team_slug,
          primary_agent_id: pickPrimaryAgentId(routesForChannel),
          active_grants: Math.max(grants.length, routesForChannel.length),
          can_manage: access.canManage || canManageSlackSurface,
          ...(health ? { health } : {}),
        };
      })
    );

    return successResponse({ channels: channels.filter((channel): channel is NonNullable<typeof channel> => channel !== null) });
});
