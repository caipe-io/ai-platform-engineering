"use client";

import { useMemo } from "react";

import { getConfig } from "@/lib/config";
import type { AdminSimulationQueryTarget } from "@/lib/rbac/admin-simulation-query";
import { withAdminSimulationParams } from "@/lib/rbac/admin-simulation-query";
import type {
ConnectorAdminAdapter,
DiagnosticRoute,
ItemSummary,
RuntimeSyncSummary,
} from "./connector-admin-adapter";
import { parsePendingConnectorPublication } from "./connector-admin-adapter";
import { ConnectorAdminPanel } from "./ConnectorAdminPanel";
import { SlackConfiguredChannelDetail } from "./slack/SlackConfiguredChannelDetail";
import { SlackVictoropsAgentSetting } from "./SlackVictoropsAgentSetting";
import {
  planSlackRouteFixes,
  slackRouteFixesNeeded,
} from "@/lib/rbac/slack-channel-route-fix";

function apiData<T>(payload: { data?: T } & T): T {
  return (payload.data ?? payload) as T;
}

type SlackItemSummary = ItemSummary & {
  primary_agent_id?: string;
};

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatSlackChannelName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name) return "";
  return name.startsWith("#") ? name : `#${name}`;
}

async function responseErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return fallback;
  try {
    const payload = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message;
    }
  } catch {
    // Plain-text responses are already suitable for the toast.
  }
  return text;
}

const SLACK_ADAPTER: ConnectorAdminAdapter = {
  connectorName: "Slack",
  itemSingular: "channel",
  itemPlural: "channels",

  api: {
    list: "/api/admin/slack/channels",
    discoveryUrl: (page, cursor, q) => {
      const p = new URLSearchParams({ member_only: "1", limit: "500" });
      if (cursor) p.set("cursor", cursor);
      if (q) p.set("q", q);
      void page;
      return `/api/admin/slack/available-channels?${p.toString()}`;
    },
    defaults: "/api/admin/slack/channels/defaults",
    runtimeStatus: "/api/admin/slack/runtime/status",
    runtimeReload: "/api/admin/slack/runtime/reload",
    runtimeSyncFromConfig: "/api/admin/slack/runtime/sync-from-config",
    routesFor: (ws, ch) => `/api/admin/slack/channels/${encodeURIComponent(ws)}/${encodeURIComponent(ch)}/routes`,
    diagnosticsFor: (ws, ch) => `/api/admin/slack/channels/${encodeURIComponent(ws)}/${encodeURIComponent(ch)}/diagnostics`,
    legacyConfigDefaults: "/api/admin/slack/runtime/config-defaults",
  },

  parseListResponse: (json) => {
    const d = apiData<{ channels: unknown[] }>(json as { channels: unknown[] });
    return (d.channels ?? []) as Record<string, unknown>[];
  },
  parseListItem: (raw) => {
    const r = raw as Record<string, unknown>;
    if (!r.channel_id) return null;
    return {
      workspace_id: String(r.workspace_id ?? ""),
      item_id: String(r.channel_id),
      item_name: formatSlackChannelName(r.channel_name ?? r.channel_id),
      team_slug: r.team_slug ? String(r.team_slug) : undefined,
      primary_agent_id: r.primary_agent_id ? String(r.primary_agent_id) : undefined,
      active_grants: Number(r.active_grants ?? 0),
      can_manage: Boolean(r.can_manage),
      health: r.health as ItemSummary["health"],
    };
  },
  itemKey: (item) => `${item.workspace_id}/${item.item_id}`,
  parseDiscoveryPage: (json) => {
    const d = apiData<{ channels: unknown[]; next_cursor?: string | null; has_more?: boolean }>(
      json as { channels: unknown[] },
    );
    const channels = (d.channels ?? []) as Record<string, unknown>[];
    return {
      items: channels
        .filter((ch) => ch.is_member !== false)
        .map((ch) => ({
          id: String(ch.id ?? ""),
          name: formatSlackChannelName(ch.name ?? ch.id),
          configured: ch.configured === true,
          configuredBy:
            typeof ch.configured_team_name === "string"
              ? ch.configured_team_name
              : typeof ch.configured_team_slug === "string"
                ? ch.configured_team_slug
                : undefined,
          configuredTeamSlug:
            typeof ch.configured_team_slug === "string"
              ? ch.configured_team_slug
              : undefined,
          configuredAgentId:
            typeof ch.configured_agent_id === "string"
              ? ch.configured_agent_id
              : undefined,
          configuredAgentName:
            typeof ch.configured_agent_name === "string"
              ? ch.configured_agent_name
              : undefined,
          memberCount: typeof ch.num_members === "number" ? ch.num_members : undefined,
          pendingApproval: parsePendingConnectorPublication(ch.pending_publication),
          secondary: [
            String(ch.id ?? ""),
            typeof ch.num_members === "number" ? pluralize(ch.num_members, "member") : "",
          ].filter(Boolean).join(" · "),
        })),
      nextCursor: d.next_cursor ?? null,
      hasMore: Boolean(d.has_more),
    };
  },
  parseRuntimeStatus: (json) => {
    const d = json as Record<string, unknown>;
    const sc = (d.static_config ?? {}) as Record<string, number>;
    const rc = (d.route_cache ?? {}) as Record<string, unknown>;
    return {
      route_mode: String(d.route_mode ?? "unknown"),
      static_config: sc,
      route_cache: { ttl_seconds: Number(rc.ttl_seconds ?? 0), cache_size: Number(rc.cache_size ?? 0) },
      raw: d,
    };
  },
  parseRuntimeSyncSummary: (json) => {
    const d = json as Record<string, unknown>;
    return {
      dry_run: Boolean(d.dry_run),
      items_seen: Number(d.channels_seen ?? 0),
      routes_planned: Number(d.routes_planned ?? 0),
      routes_upserted: Number(d.routes_upserted ?? 0),
      openfga_tuples_written: Number(d.openfga_tuples_written ?? 0),
      channels: Array.isArray(d.channels) ? (d.channels as RuntimeSyncSummary["channels"]) : undefined,
    };
  },

  discoveryCacheProvider: "slack",

  copy: {
    configuredTabTitle: "Configured channels",
    configuredTabDescription: "Configured Slack channels.",
    onboardTabTitle: "Onboard channels",
    onboardTabDescription: "Find Slack channels where the bot is installed and set them up.",
    advancedTabTitle: "Advanced",
    advancedTabDescription: "Superadmin Slack setup and operational controls for platform-wide bot behavior.",
    advancedHeading: "Import from Slackbot YAML",
    advancedSectionDescription: "Preview Slackbot YAML seed data before importing channel routes and agent settings into the database.",
    botNameInLegend: "Slackbot",
    discoveryDescription: "Find Slack channels where the bot is already installed. Channels the bot has not joined will not appear.",
    discoveryFindLabel: "Find channels",
    discoveryRefreshLabel: "Refresh channels",
    discoveryLoadingLabel: "Finding channels…",
    discoveryEmptyLabel: "No bot-member channels were discovered.",
    discoveryDiscoveredLabel: "bot-member channel",
    selfServiceTitle: "Slack channels",
    selfServiceDescription: "Manage existing Slack integrations or request onboarding for a channel your team uses.",
  },
  ariaLabels: {
    tablist: "Slack admin views",
    configuredRegion: "Configured Slack channels",
    advancedRegion: "Advanced Setup - Import/Sync with Slackbot",
  },

  discoveryStatusText: ({ discoveredCount, newCount, configuredCount, unassignedCount }) => [
    `Discovered: ${discoveredCount}`,
    `Configured: ${configuredCount}`,
    ...(newCount > 0 ? [`New: ${newCount}`] : []),
    ...(unassignedCount > 0 ? [`Missing team: ${unassignedCount}`] : []),
  ].join(" · "),

  staticConfigLabel: ({ items, routes }) => `${items} channels / ${routes} routes`,
  routeCacheLabel: (count) => `${count} cached channel${count === 1 ? "" : "s"}`,
  syncDialogueTitle: (mode) => mode === "preview" ? "Slack Bot Config Sync Preview" : "Slack Bot Config Sync Apply",
  syncDialogueDescription: "Preview reads the Slack bot's loaded static YAML config. Apply upserts matching route metadata and channel-agent access grants without deleting UI-managed associations.",
  syncSummaryItemsLabel: "Channels",

  authzDisclaimer: null,

  configuredDetailExtra: (ctx) => (
    <SlackConfiguredChannelDetail
      selected={ctx.item}
      routes={ctx.routes}
      dynamicAgents={ctx.dynamicAgents}
      teams={ctx.teams}
      disabled={ctx.disabled}
      loading={ctx.loading}
      setLoading={ctx.setLoading}
      selectedCanManage={ctx.selectedCanManage}
      onRefresh={ctx.onRefresh}
      onDeselect={ctx.onDeselect}
      routesFor={ctx.routesFor}
      listApi={ctx.listApi}
    />
  ),

  diagnosticRouteIsFixable: (route: DiagnosticRoute) =>
    (route.route_metadata && !route.openfga_tuple) ||
    (route.openfga_tuple && !route.route_metadata),
  fixDiagnosticRoute: async ({ item, route, routes }) => {
    const routeUrl = `/api/admin/slack/channels/${encodeURIComponent(item.workspace_id)}/${encodeURIComponent(item.item_id)}/routes`;
    if (route.route_metadata && !route.openfga_tuple) {
      const res = await fetch(routeUrl, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: route.agent_id }),
      });
      if (!res.ok) throw new Error(await responseErrorMessage(res, "Could not update Slack routing"));
      return { toast: `Removed inactive routing rules for ${route.agent_id}.` };
    }
    const currentRoute = routes.find((entry) => entry.agent_id === route.agent_id);
    const nextRoutes: typeof routes = [
      ...routes.filter((entry) => entry.agent_id !== route.agent_id),
      {
        agent_id: route.agent_id,
        enabled: true,
        priority: currentRoute?.priority ?? 100,
        users: { enabled: true, listen: currentRoute?.users?.listen ?? "mention" },
        ...(currentRoute?.bots ? { bots: currentRoute.bots } : {}),
        ...(currentRoute?.escalation ? { escalation: currentRoute.escalation } : {}),
        ...(currentRoute?.execution_identity ? { execution_identity: currentRoute.execution_identity } : {}),
      },
    ];
    const res = await fetch(routeUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routes: nextRoutes }),
    });
    if (!res.ok) throw new Error(await responseErrorMessage(res, "Could not update Slack routing"));
    const data = apiData<{ routes: typeof routes }>(await res.json());
    return {
      toast: `Saved default routing for ${route.agent_id} (@mentions only).`,
      nextRoutes: data.routes ?? [],
    };
  },

  diagnosticIssuesBatchFixable: ({ diagnostics, routes }) =>
    slackRouteFixesNeeded(diagnostics.routes, routes),

  fixAllDiagnosticIssues: async ({ item, diagnostics, routes }) => {
    const routeUrl = `/api/admin/slack/channels/${encodeURIComponent(item.workspace_id)}/${encodeURIComponent(item.item_id)}/routes`;
    const primaryAgentId = (item as SlackItemSummary).primary_agent_id;
    const nextRoutes = planSlackRouteFixes(
      diagnostics.routes,
      routes,
      primaryAgentId,
    );
    const res = await fetch(routeUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routes: nextRoutes }),
    });
    if (!res.ok) throw new Error(await responseErrorMessage(res, "Could not update Slack routing"));
    const data = apiData<{ routes: typeof routes }>(await res.json());
    return {
      toast: "Routing issues fixed: saved missing rules and set a clear primary agent priority.",
      nextRoutes: data.routes ?? [],
    };
  },

  applyOnboarding: async ({ rows, defaultTeamSlug, defaultAgentId, createDefaultRoutes, fetchFn }) => {
    // Only set up rows that are fully configured (team + agent). Blocked
    // rows that happen to be selected are skipped rather than sent with
    // empty team/agent, so one unconfigured channel can't strand the batch.
    const selectedImports = rows.filter(
      (r) => r.selectable !== false && r.selected && r.teamSlug && r.agentId,
    );
    if (selectedImports.length === 0 && (!defaultTeamSlug || !defaultAgentId)) {
      const missing: string[] = [];
      if (!defaultTeamSlug) missing.push("Preselected Team");
      if (!defaultAgentId) missing.push("Preselected Dynamic Agent");
      throw new Error(`Select ${missing.join(" and ")} in the "Default team and agent for new channels" section before running setup.`);
    }
    const fallbackTeamSlug = defaultTeamSlug || selectedImports[0]?.teamSlug || "";
    const fallbackAgentId = defaultAgentId || selectedImports[0]?.agentId || "";
    const res = await fetchFn("/api/admin/slack/channels/defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        team_slug: fallbackTeamSlug,
        agent_id: fallbackAgentId,
        create_routes: createDefaultRoutes,
        ...(selectedImports.length > 0 ? {
          channel_defaults: selectedImports.map((ch) => ({
            id: ch.id,
            name: ch.name,
            workspace_id: ch.workspaceId,
            member_count: ch.memberCount,
            team_slug: ch.teamSlug,
            agent_id: ch.agentId,
          })),
        } : {}),
      }),
    });
    if (!res.ok) throw new Error(await responseErrorMessage(res, "Could not submit Slack channels"));
    const data = apiData<{
      summary: Record<string, number>;
      publication_requests?: Array<{
        item_id?: string;
        approver_team_slugs?: string[];
      }>;
      applied?: Array<{ item_id?: string }>;
    }>(await res.json());
    const s = data.summary;
    const pendingItemIds = (data.publication_requests ?? [])
      .map((item) => item.item_id ?? "")
      .filter(Boolean);
    const appliedItemIds = (data.applied ?? [])
      .map((item) => item.item_id ?? "")
      .filter(Boolean);
    const pendingApproverTeamSlugs = Array.from(new Set(
      (data.publication_requests ?? []).flatMap((item) =>
        Array.isArray(item.approver_team_slugs) ? item.approver_team_slugs : [],
      ),
    ));
    return {
      toastMessage: pendingItemIds.length > 0
        ? `${pendingItemIds.length} Slack channel${pendingItemIds.length === 1 ? "" : "s"} submitted${appliedItemIds.length > 0 ? `; ${appliedItemIds.length} onboarded immediately` : ""}.`
        : selectedImports.length > 0
          ? `Discovered defaults applied: onboarded ${s.channels_onboarded ?? s.onboarded ?? 0} channels, assigned ${s.channels_assigned_team ?? 0} channels, ensured ${s.channel_grants_ensured ?? 0} channel grants, ensured ${s.routes_ensured ?? 0} routes, preserved ${s.routes_preserved ?? 0} existing routes.`
        : `Slack channel association defaults applied: assigned ${s.channels_assigned_team} channels, ensured ${s.channel_grants_ensured} channel grants, ensured ${s.routes_ensured} routes.`,
      ...(data.publication_requests
        ? { pendingItemIds, appliedItemIds, pendingApproverTeamSlugs }
        : {}),
    };
  },

  missingRouteableAgentAutoFix: null,

  // Superadmin VictorOps escalation agent picker, rendered at the bottom of
  // the Slack Advanced tab. Persists to platform_config and is read by the
  // Slack bot at runtime.
  advancedTabExtraSection: ({ disabled }) => <SlackVictoropsAgentSetting disabled={disabled} />,
};

export function SlackChannelRebacPanel({
  disabled = false,
  selfService = false,
  simulationTarget = null,
}: {
  disabled?: boolean;
  selfService?: boolean;
  simulationTarget?: AdminSimulationQueryTarget | null;
}) {
  const appName = getConfig("appName");
  const adapter = useMemo<ConnectorAdminAdapter>(
    () => ({
      ...SLACK_ADAPTER,
      copy: {
        ...SLACK_ADAPTER.copy,
        configuredTabDescription: `Channels ${appName} already knows about. Click a channel to manage its integration.`,
      },
      api: {
        ...SLACK_ADAPTER.api,
        list: withAdminSimulationParams(SLACK_ADAPTER.api.list, simulationTarget),
      },
    }),
    [appName, simulationTarget],
  );
  return (
    <ConnectorAdminPanel
      adapter={adapter}
      configuredSearchParam="slackChannelSearch"
      disabled={disabled}
      selfService={selfService}
    />
  );
}
