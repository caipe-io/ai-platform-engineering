"use client";

import { useMemo } from "react";

import { getConfig } from "@/lib/config";
import type { AdminSimulationQueryTarget } from "@/lib/rbac/admin-simulation-query";
import { withAdminSimulationParams } from "@/lib/rbac/admin-simulation-query";
import { ConnectorAdminPanel } from "./ConnectorAdminPanel";
import { WebexDirectUsersPanel } from "./WebexDirectUsersPanel";
import { WebexConfiguredSpaceDetail } from "./webex/WebexConfiguredSpaceDetail";
import type {
ConnectorAdminAdapter,
DiagnosticRoute,
ItemDiagnostics,
ItemSummary,
} from "./connector-admin-adapter";
import { parsePendingConnectorPublication } from "./connector-admin-adapter";

function apiData<T>(payload: { data?: T } & T): T {
  return (payload.data ?? payload) as T;
}

function threadContextLabel(raw: Record<string, unknown>): string {
  const ctx = raw.thread_context as { enabled?: boolean; max_messages?: number; max_chars?: number } | undefined;
  if (!ctx) return "unknown";
  return `${ctx.enabled ? "Enabled" : "Disabled"}, ${ctx.max_messages} messages / ${ctx.max_chars} chars`;
}

async function responseErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return `${fallback}: ${res.status}`;
  try {
    const payload = JSON.parse(text) as { error?: unknown; message?: unknown };
    const detail = typeof payload.error === "string" ? payload.error
      : typeof payload.message === "string" ? payload.message : "";
    return detail ? `${fallback}: ${detail}` : `${fallback}: ${res.status}`;
  } catch { return `${fallback}: ${text}`; }
}

const WEBEX_ADAPTER: ConnectorAdminAdapter = {
  connectorName: "Webex",
  itemSingular: "space",
  itemPlural: "spaces",
  singlePanelView: "onboard",
  advancedTabMinimal: true,
  directMessagesPanel: {
    title: "1:1 Messages",
    description: "Configure who can message each Webex bot and how their agent is selected.",
    render: ({ disabled }) => <WebexDirectUsersPanel disabled={disabled} />,
  },

  api: {
    list: "/api/admin/webex/spaces",
    discoveryUrl: (_page, cursor, q, identityId, refresh) => {
      const p = new URLSearchParams({ limit: "200" });
      if (cursor) p.set("cursor", cursor);
      if (q) p.set("q", q);
      if (identityId) p.set("bot_id", identityId);
      if (refresh) p.set("refresh", "1");
      return `/api/admin/webex/available-spaces?${p.toString()}`;
    },
    discoveryIdentities: "/api/admin/webex/bots",
    defaults: "/api/admin/webex/spaces/defaults",
    runtimeStatus: "/api/admin/webex/runtime/status",
    runtimeReload: "/api/admin/webex/runtime/reload",
    runtimeSyncFromConfig: "/api/admin/webex/runtime/sync-from-config",
    runtimeSyncUsesDiscoveryIdentity: true,
    routesFor: (ws, sp, botId) => `/api/admin/webex/spaces/${encodeURIComponent(ws)}/${encodeURIComponent(sp)}/routes?bot_id=${encodeURIComponent(botId ?? "")}`,
    diagnosticsFor: (ws, sp, botId) => `/api/admin/webex/spaces/${encodeURIComponent(ws)}/${encodeURIComponent(sp)}/diagnostics?bot_id=${encodeURIComponent(botId ?? "")}`,
    legacyConfigDefaults: null,
  },

  parseListResponse: (json) => {
    const d = apiData<{ spaces: unknown[] }>(json as { spaces: unknown[] });
    return (d.spaces ?? []) as Record<string, unknown>[];
  },
  parseListItem: (raw) => {
    const r = raw as Record<string, unknown>;
    if (!r.space_id) return null;
    return {
      workspace_id: String(r.workspace_id ?? ""),
      item_id: String(r.space_id),
      item_name: String(r.space_name ?? r.space_id),
      team_slug: r.team_slug ? String(r.team_slug) : undefined,
      primary_agent_id: r.primary_agent_id ? String(r.primary_agent_id) : undefined,
      bot_id: r.bot_id ? String(r.bot_id) : undefined,
      active_grants: Number(r.active_grants ?? 0),
      can_manage: Boolean(r.can_manage),
      health: r.health as ItemSummary["health"],
    };
  },
  itemKey: (item) => `${item.bot_id ?? ""}/${item.workspace_id}/${item.item_id}`,
  parseDiscoveryPage: (json) => {
    const d = apiData<{ spaces: unknown[]; next_cursor?: string | null; has_more?: boolean; total_matches?: number }>(
      json as { spaces: unknown[] },
    );
    const spaces = ((d.spaces ?? []) as Record<string, unknown>[]).filter(
      (space) => String(space.type ?? "group").trim().toLowerCase() !== "direct",
    );
    return {
      items: spaces.map((sp) => {
        const type = String(sp.type ?? "group").trim().toLowerCase() || "group";
        return {
          id: String(sp.id ?? ""),
          name: String(sp.name ?? sp.id),
          secondary: [String(sp.id ?? ""), type, sp.is_locked ? "locked" : ""].filter(Boolean).join(" · "),
          teamRequired: true,
          selectable: true,
          availableBotIds: Array.isArray(sp.available_bot_ids)
            ? sp.available_bot_ids.map((id) => String(id)).filter(Boolean)
            : [],
          botId: Array.isArray(sp.available_bot_ids) && sp.available_bot_ids.length === 1
            ? String(sp.available_bot_ids[0])
            : undefined,
          pendingApproval: parsePendingConnectorPublication(sp.pending_publication),
        };
      }),
      nextCursor: d.next_cursor ?? null,
      hasMore: Boolean(d.has_more),
      totalMatches: typeof d.total_matches === "number" ? d.total_matches : undefined,
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
      items_seen: Number(d.spaces_seen ?? 0),
      routes_planned: Number(d.routes_planned ?? 0),
      routes_upserted: Number(d.routes_upserted ?? 0),
      openfga_tuples_written: Number(d.openfga_tuples_written ?? 0),
    };
  },

  discoveryCacheProvider: "webex",
  discoveryIdentity: {
    label: "Webex bot",
    parseResponse: (json) => {
      const data = apiData<{ bots?: Array<{
        id?: unknown;
        name?: unknown;
        available?: unknown;
        spaces?: {
          accessMode?: unknown;
          defaultTeamSlug?: unknown;
          defaultAgentId?: unknown;
        };
      }> }>(
        json as { bots?: Array<Record<string, unknown>> },
      );
      return (data.bots ?? [])
        .map((bot) => {
          const teamSlug = String(bot.spaces?.defaultTeamSlug ?? "").trim();
          const agentId = String(bot.spaces?.defaultAgentId ?? "").trim();
          return {
            id: String(bot.id ?? "").trim(),
            name: String(bot.name ?? bot.id ?? "").trim(),
            available: bot.available === true,
            ...(bot.spaces?.accessMode === "all_spaces" && teamSlug && agentId
              ? { onboardingDefaults: { team_slug: teamSlug, agent_id: agentId } }
              : {}),
          };
        })
        .filter((bot) => bot.id && bot.name);
    },
  },
  discoveryIdentityPerItem: false,

  copy: {
    configuredTabTitle: "Configured spaces",
    configuredTabDescription: "Configured Webex spaces. Click a space to manage its integration.",
    onboardTabTitle: "Configure spaces",
    onboardTabDescription: "Find Webex spaces where the bot is installed and set them up.",
    advancedTabTitle: "Advanced",
    advancedTabDescription: "One-time YAML import and Webex bot runtime status. Most admins won't need this.",
    advancedHeading: "Advanced Setup - Import/Sync with Webex Bot",
    botNameInLegend: "Webex bot",
    discoveryDescription: "Find Webex spaces where the bot is already installed. Spaces the bot has not joined will not appear.",
    discoveryFindLabel: "Find spaces",
    discoveryRefreshLabel: "Refresh spaces",
    discoveryLoadingLabel: "Finding spaces…",
    discoveryEmptyLabel: "No bot-visible Webex spaces were discovered.",
    discoveryDiscoveredLabel: "bot-visible space",
    advancedSectionDescription: "Preview Webex bot YAML seed data before importing space routes and agent settings into the database.",
    selfServiceTitle: "Webex spaces",
    selfServiceDescription: "Manage existing Webex integrations or request onboarding for a space your team uses.",
  },
  ariaLabels: {
    tablist: "Webex admin views",
    configuredRegion: "Configured Webex spaces",
    advancedRegion: "Advanced Setup - Import/Sync with Webex Bot",
  },

  discoveryStatusText: ({ discoveredCount, newCount, configuredCount, unassignedCount }) => [
    `Discovered: ${discoveredCount}`,
    `Configured: ${configuredCount}`,
    ...(newCount > 0 ? [`New: ${newCount}`] : []),
    ...(unassignedCount > 0 ? [`Missing team: ${unassignedCount}`] : []),
  ].join(" · "),

  staticConfigLabel: ({ items, routes }) => `${items} spaces / ${routes} routes`,
  routeCacheLabel: (count) => `${count} cached space${count === 1 ? "" : "s"}`,
  syncDialogueTitle: (mode) => mode === "preview" ? "Webex Bot Config Sync Preview" : "Webex Bot Config Sync Apply",
  syncDialogueDescription: "Preview reads the Webex bot's loaded static YAML config. Apply upserts matching MongoDB route metadata and space-agent OpenFGA tuples without deleting UI-managed associations.",
  syncSummaryItemsLabel: "Spaces",

  advancedExtraTiles: (status) => [
    {
      label: "Thread context",
      value: threadContextLabel(status.raw),
      description: "Shows whether the bot sends bounded prior Webex thread messages to the selected agent.",
    },
  ],

  authzDisclaimer: (
    <div>
      Assigning an agent controls which agent can answer in this Webex space.
      People must also have access to that agent before they can use it.
    </div>
  ),

  configuredDetailExtra: (ctx) => (
    <WebexConfiguredSpaceDetail
      selected={ctx.item}
      routes={ctx.routes}
      dynamicAgents={ctx.dynamicAgents}
      teams={ctx.teams}
      disabled={ctx.disabled}
      loading={ctx.loading}
      selectedCanManage={ctx.selectedCanManage}
      setLoading={ctx.setLoading}
      onRefresh={ctx.onRefresh}
      onDeselect={ctx.onDeselect}
      routesFor={ctx.routesFor}
      listApi={ctx.listApi}
    />
  ),

  diagnosticRouteIsFixable: (route: DiagnosticRoute) =>
    Boolean(route.route_metadata && !route.openfga_tuple),

  fixDiagnosticRoute: async ({ item, route }) => {
    const routeUrl = `/api/admin/webex/spaces/${encodeURIComponent(item.workspace_id)}/${encodeURIComponent(item.item_id)}/routes?bot_id=${encodeURIComponent(item.bot_id ?? "")}`;
    const res = await fetch(routeUrl, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: route.agent_id }),
    });
    if (!res.ok) throw new Error(await responseErrorMessage(res, `Failed to fix agent:${route.agent_id}`));
    return { toast: `Removed stale route metadata for agent:${route.agent_id}.` };
  },

  applyOnboarding: async ({ rows, defaultTeamSlug, defaultAgentId, createDefaultRoutes, fetchFn }) => {
    const selectedImports = rows.filter((r) =>
      r.selectable !== false &&
      r.teamRequired !== false &&
      r.selected &&
      r.teamSlug &&
      r.agentId &&
      r.botId
    );
    if (selectedImports.length === 0) return { toastMessage: "No spaces selected." };
    const appliedItemIds: string[] = [];
    const pendingItemIds: string[] = [];
    const pendingApproverTeamSlugs = new Set<string>();
    for (const space of selectedImports) {
      const response = await fetchFn("/api/admin/webex/spaces/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bot_id: space.botId,
          workspace_id: space.workspaceId,
          space_id: space.id,
          space_name: space.name,
          team_slug: space.teamSlug || defaultTeamSlug,
          agent_id: space.agentId || defaultAgentId,
          listen: "mention",
          create_route: createDefaultRoutes,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const result = apiData<{
        pending_approval?: boolean;
        publication_request?: { approver_team_slugs?: string[] };
      }>(await response.json());
      if (result.pending_approval) {
        pendingItemIds.push(space.id);
        for (const slug of result.publication_request?.approver_team_slugs ?? []) {
          pendingApproverTeamSlugs.add(slug);
        }
      }
      else appliedItemIds.push(space.id);
    }
    return {
      toastMessage: pendingItemIds.length > 0
        ? `${pendingItemIds.length} Webex space${pendingItemIds.length === 1 ? "" : "s"} submitted${appliedItemIds.length > 0 ? `; ${appliedItemIds.length} onboarded immediately` : ""}.`
        : `Onboarded ${appliedItemIds.length} Webex space${appliedItemIds.length === 1 ? "" : "s"}.`,
      appliedItemIds,
      pendingItemIds,
      pendingApproverTeamSlugs: [...pendingApproverTeamSlugs],
    };
  },

  discoveryAutoSelectNewItems: true,
  discoveryPaginated: true,
  discoveryServerSearch: true,

  missingRouteableAgentAutoFix: {
    title: "Auto-fix missing Webex association",
    description: "Add an agent so the Webex runtime has one to dispatch to.",
    buttonLabel: (agentId) => agentId ? `Fix missing association with agent:${agentId}` : "Select an agent to auto-fix",
    noAgentHelpText: "Select a Dynamic Agent below or configure a default Dynamic Agent first.",
    isApplicable: (_item: ItemSummary, diagnostics: ItemDiagnostics) =>
      Boolean(diagnostics?.openfga.reachable && diagnostics.openfga.tuple_count === 0 && diagnostics.routes.length === 0),
  },
};

export function WebexSpaceRebacPanel({
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
      ...WEBEX_ADAPTER,
      copy: {
        ...WEBEX_ADAPTER.copy,
        configuredTabDescription: `Spaces ${appName} already knows about. Click a space to manage its integration.`,
      },
      api: {
        ...WEBEX_ADAPTER.api,
        list: withAdminSimulationParams(WEBEX_ADAPTER.api.list, simulationTarget),
      },
    }),
    [appName, simulationTarget],
  );
  return (
    <ConnectorAdminPanel
      adapter={adapter}
      configuredSearchParam="webexSpaceSearch"
      disabled={disabled}
      selfService={selfService}
    />
  );
}
