"use client";

// assisted-by Codex Codex-sonnet-4-6

import { AuthGuard } from "@/components/auth-guard";
import { ConversationsTab } from "@/components/dynamic-agents/ConversationsTab";
import { DynamicAgentsTab } from "@/components/dynamic-agents/DynamicAgentsTab";
import { LLMModelsTab } from "@/components/dynamic-agents/LLMModelsTab";
import { LLMProvidersTab } from "@/components/dynamic-agents/LLMProvidersTab";
import { MCPServersTab } from "@/components/dynamic-agents/MCPServersTab";
import { isAgentSetupStep,type AgentSetupStep } from "@/components/dynamic-agents/deep-linking";
import {
  BASE_DYNAMIC_AGENT_TABS,
  buildDynamicAgentNavigationGroups,
} from "@/components/dynamic-agents/navigation";
import {
  WorkspaceNavigationList,
} from "@/components/layout/WorkspaceNavigation";
import { WorkspacePageHeader } from "@/components/layout/WorkspacePageHeader";
import { WorkspaceShell } from "@/components/layout/WorkspaceShell";
import { UnsavedChangesDialog } from "@/components/shared/UnsavedChangesDialog";
import { useAdminTabGates } from "@/hooks/useAdminTabGates";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import { usePathname,useRouter,useSearchParams } from "next/navigation";
import React from "react";

const RESOURCE_QUERY_KEYS = ["agent", "server", "model", "step"] as const;

function DynamicAgentsPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { gates } = useAdminTabGates();
  const showConversations = Boolean(gates.dynamic_agent_conversations);
  const visibleTabs = React.useMemo(
    () => new Set<string>(
      showConversations
        ? [...BASE_DYNAMIC_AGENT_TABS, "conversations"]
        : BASE_DYNAMIC_AGENT_TABS,
    ),
    [showConversations],
  );

  const requestedTab = searchParams.get("tab") ?? "agents";
  const activeTab = visibleTabs.has(requestedTab) ? requestedTab : "agents";
  const selectedAgentId = searchParams.get("agent");
  const selectedServerId = searchParams.get("server");
  const selectedModelId = searchParams.get("model");
  const requestedAgentStep = searchParams.get("step");
  const agentStep = isAgentSetupStep(requestedAgentStep) ? requestedAgentStep : "basic";

  // When the embedded DynamicAgentEditor has unsaved changes, switching sibling
  // tabs would unmount it and silently discard work. Intercept the switch and
  // surface the in-app modal instead. The interception is local to this page;
  // the global store's pendingNavigationHref is reserved for header-level
  // navigation handled by AppHeader.
  const [pendingTab, setPendingTab] = React.useState<string | null>(null);

  function hrefFor(params: URLSearchParams): string {
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  function clearResourceSelection(params: URLSearchParams) {
    RESOURCE_QUERY_KEYS.forEach((key) => params.delete(key));
  }

  function hrefForTab(tab: string): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    clearResourceSelection(params);
    return hrefFor(params);
  }

  function performTabSwitch(tab: string) {
    router.push(hrefForTab(tab));
  }

  function selectResource(tab: "agents" | "mcp-servers" | "llm-models", key: "agent" | "server" | "model", id: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    clearResourceSelection(params);
    if (id) {
      params.set(key, id);
      if (key === "agent") params.set("step", "basic");
    }
    router.push(hrefFor(params));
  }

  function setAgentStep(step: AgentSetupStep) {
    if (!selectedAgentId) return;
    const params = new URLSearchParams(searchParams.toString());
    clearResourceSelection(params);
    params.set("tab", "agents");
    params.set("agent", selectedAgentId);
    params.set("step", step);
    router.replace(hrefFor(params));
  }

  function setActiveTab(tab: string) {
    if (tab === activeTab) return;
    if (useUnsavedChangesStore.getState().hasUnsavedChanges) {
      setPendingTab(tab);
      return;
    }
    performTabSwitch(tab);
  }

  function handleConfirmTabSwitch() {
    const target = pendingTab;
    setPendingTab(null);
    useUnsavedChangesStore.getState().setUnsaved(false);
    if (target) performTabSwitch(target);
  }

  function handleCancelTabSwitch() {
    setPendingTab(null);
  }

  const navigationGroups = buildDynamicAgentNavigationGroups({
    destinationForTab: (tab) => ({
      onSelect: () => setActiveTab(tab),
    }),
    showConversations,
  });
  const activeNavigationItem = navigationGroups
    .flatMap((group) => group.items)
    .flatMap((item) => item.children ?? [item])
    .find((item) => item.id === activeTab)!;
  const activeDescription = {
    agents: "Build agents and choose the instructions, tools, and model they use.",
    conversations: "Review agent conversations and manage their checkpoint history.",
    "llm-models": "Register the provider and model identifiers available to agents.",
    "mcp-servers": "Configure MCP connections and authorize each tool call through AgentGateway.",
    "model-providers": "Save the provider credentials agents need to use each model.",
  }[activeTab] ?? activeNavigationItem.description ?? "";
  const agentHomeHref = hrefForTab("agents");
  const modelsHref = hrefForTab("model-providers");
  const currentHref = hrefFor(new URLSearchParams(searchParams.toString()));
  const switchFromBreadcrumb = (
    tab: string,
  ): React.MouseEventHandler<HTMLAnchorElement> => (event) => {
    if (
      event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) return;
    event.preventDefault();
    setActiveTab(tab);
  };

  return (
    <>
      <WorkspaceShell
        header={(
          <WorkspacePageHeader
            breadcrumbs={[
              { label: "Home",href: "/" },
              ...(activeTab === "agents"
                ? [{ label: "Agents",href: currentHref }]
                : [{
                    label: "Agents",
                    href: agentHomeHref,
                    onClick: switchFromBreadcrumb("agents"),
                  }]),
              ...(activeTab === "model-providers" || activeTab === "llm-models"
                ? [{
                    label: "Models",
                    href: modelsHref,
                    onClick: switchFromBreadcrumb("model-providers"),
                  }]
                : []),
              ...(activeTab === "agents"
                ? []
                : [{ label: activeNavigationItem.label,href: currentHref }]),
            ]}
            description={activeDescription}
            title={activeNavigationItem.label}
          />
        )}
        navigation={(
          <WorkspaceNavigationList
            activeItemId={activeTab}
            ariaLabel="Agent sections"
            groups={navigationGroups}
          />
        )}
        navigationAreaKey="dynamic-agents"
        navigationVersion={`${activeTab}:${showConversations}:${searchParams.toString()}`}
      >
        {activeTab === "agents" ? (
          <DynamicAgentsTab
            selectedAgentId={selectedAgentId}
            initialStep={agentStep}
            onSelectedAgentChange={(id) => selectResource("agents", "agent", id)}
            onStepChange={setAgentStep}
          />
        ) : null}

        {activeTab === "mcp-servers" ? (
          <MCPServersTab
            selectedServerId={selectedServerId}
            onSelectedServerChange={(id) => selectResource("mcp-servers", "server", id)}
          />
        ) : null}

        {activeTab === "model-providers" ? <LLMProvidersTab /> : null}

        {activeTab === "llm-models" ? (
          <LLMModelsTab
            selectedModelId={selectedModelId}
            onSelectedModelChange={(id) => selectResource("llm-models", "model", id)}
          />
        ) : null}

        {showConversations && activeTab === "conversations" ? <ConversationsTab /> : null}
      </WorkspaceShell>

      <UnsavedChangesDialog
        open={pendingTab !== null}
        onCancel={handleCancelTabSwitch}
        onDiscard={handleConfirmTabSwitch}
        title="Unsaved changes"
        description="You have unsaved changes in the agent editor. They will be lost if you switch tabs."
      />
    </>
  );
}

export default function DynamicAgentsPage() {
  return (
    <AuthGuard>
      <DynamicAgentsPageContent />
    </AuthGuard>
  );
}
