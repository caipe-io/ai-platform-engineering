"use client";

import { AdminNavigation } from "@/components/admin/workspace/AdminNavigation";
import {
  filterAdminCategories,
  findAdminDestinationByPath,
} from "@/components/admin/workspace/admin-routes";
import { CREDENTIALS_GROUPS } from "@/components/credentials/navigation";
import {
  buildDynamicAgentNavigationGroups,
  type DynamicAgentNavigationTab,
} from "@/components/dynamic-agents/navigation";
import { WorkspaceNavigationList } from "@/components/layout/WorkspaceNavigation";
import { KnowledgeSidebar } from "@/components/rag/KnowledgeSidebar";
import { SettingsNavigation } from "@/components/settings/SettingsNavigation";
import {
  DEFAULT_SETTINGS_ROUTE_ID,
  findSettingsRouteById,
  findSettingsRouteBySegment,
} from "@/components/settings/settings-routes";
import { useAdminRole } from "@/hooks/use-admin-role";
import { useRAGHealth } from "@/hooks/use-rag-health";
import { useAdminTabGates } from "@/hooks/useAdminTabGates";
import { config } from "@/lib/config";
import { usePathname,useSearchParams } from "next/navigation";
import type React from "react";

export const APPLICATION_SECTION_AREA_KEYS = new Set([
  "knowledge",
  "dynamic-agents",
  "credentials",
  "admin",
  "settings",
]);

function DynamicAgentsApplicationNavigation(): React.ReactElement {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { gates } = useAdminTabGates();
  const groups = buildDynamicAgentNavigationGroups({
    destinationForTab: (tab: DynamicAgentNavigationTab) => ({
      href: `/dynamic-agents?tab=${tab}`,
    }),
    showConversations: Boolean(gates.dynamic_agent_conversations),
  });

  return (
    <WorkspaceNavigationList
      activeItemId={
        pathname?.startsWith("/dynamic-agents")
          ? searchParams.get("tab") ?? "agents"
          : ""
      }
      ariaLabel="Agent sections"
      groups={groups}
    />
  );
}

function KnowledgeApplicationNavigation(): React.ReactElement {
  const { graphRagEnabled,status } = useRAGHealth();
  return (
    <KnowledgeSidebar
      graphRagEnabled={status === "connected" && graphRagEnabled}
    />
  );
}

function AdminApplicationNavigation(): React.ReactElement | null {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { isAdmin } = useAdminRole();
  const { gates,loading } = useAdminTabGates();
  if (loading) return null;

  const categories = filterAdminCategories({
    ...gates,
    platform_settings: isAdmin,
    feedback: Boolean(gates.feedback && config.feedbackEnabled),
    audit_logs: Boolean(gates.audit_logs && config.auditLogsEnabled),
    credentials: Boolean(gates.credentials && config.credentialsEnabled),
    agents: isAdmin,
    mcp: isAdmin,
    rag: isAdmin,
    identity_sync: Boolean(gates.identity_group_sync && config.oktaSyncEnabled),
  });
  const visibleDestinations = categories.flatMap(
    (category) => category.destinations,
  );
  const onAdminRoute = pathname?.startsWith("/admin") ?? false;
  const requestedDestination = findAdminDestinationByPath(pathname);
  const activeDestination = onAdminRoute && requestedDestination && visibleDestinations.some(
    (destination) => destination.id === requestedDestination.id,
  )
    ? requestedDestination
    : onAdminRoute
      ? visibleDestinations[0]
      : undefined;

  return categories.length > 0 ? (
    <AdminNavigation
      activeDestination={activeDestination}
      categories={categories}
      searchParams={new URLSearchParams(searchParams.toString())}
    />
  ) : null;
}

function SettingsApplicationNavigation(): React.ReactElement {
  const pathname = usePathname();
  const section = pathname?.split("/")[2];
  const activeRoute = pathname?.startsWith("/settings/")
    ? findSettingsRouteBySegment(section)
      ?? findSettingsRouteById(DEFAULT_SETTINGS_ROUTE_ID)
    : undefined;

  return <SettingsNavigation activeRoute={activeRoute} />;
}

export function ApplicationSectionNavigation({
  areaKey,
}: {
  areaKey: string;
}): React.ReactElement | null {
  if (areaKey === "knowledge") return <KnowledgeApplicationNavigation />;
  if (areaKey === "dynamic-agents") {
    return <DynamicAgentsApplicationNavigation />;
  }
  if (areaKey === "credentials") {
    return (
      <WorkspaceNavigationList
        activeItemId=""
        ariaLabel="Credentials sections"
        groups={CREDENTIALS_GROUPS}
      />
    );
  }
  if (areaKey === "admin") return <AdminApplicationNavigation />;
  if (areaKey === "settings") return <SettingsApplicationNavigation />;
  return null;
}
