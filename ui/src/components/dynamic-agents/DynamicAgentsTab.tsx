"use client";

import { getErrorMessage } from "@/lib/error-utils";

// assisted-by Codex Codex-sonnet-4-6

import { LastReviewBadge } from "@/components/ai-review";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { WorkspacePageActions } from "@/components/layout/WorkspacePageActions";
import { Card,CardContent } from "@/components/ui/card";
import { toYaml } from "@/lib/yaml-serializer";
import { useChatStore } from "@/store/chat-store";
import type { DynamicAgentConfigWithPermissions } from "@/types/dynamic-agent";
import {
Bot,
AlertCircle,
ChevronLeft,
ChevronRight,
CopyPlus,
Download,
Globe,
Loader2,
Lock,
MessageSquare,
Plus,
RefreshCw,
Search,
ToggleLeft,
ToggleRight,
Trash2,
Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import React from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { AgentAvatar } from "./AgentAvatar";
import { AgentEditorSkeleton,AgentsListSkeleton } from "./AgentsLoadingSkeleton";
import { DynamicAgentEditor } from "./DynamicAgentEditor";
import type { AgentSetupStep } from "./deep-linking";

const DEFAULT_ROW_PERMISSIONS = {
  can_manage: false,
  can_write: false,
  can_discover: false,
} as const;

function agentCanEdit(agent: DynamicAgentConfigWithPermissions | null | undefined): boolean {
  if (!agent) return true;
  return agent.permissions?.can_write === true || agent.permissions?.can_manage === true;
}

function agentCanManage(agent: DynamicAgentConfigWithPermissions | null | undefined): boolean {
  return agent?.permissions?.can_manage === true;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && getErrorMessage(error, "") ? getErrorMessage(error, "") : fallback;
}

interface DynamicAgentsTabProps {
  selectedAgentId?: string | null;
  initialStep?: AgentSetupStep;
  onSelectedAgentChange?: (agentId: string | null) => void;
  onStepChange?: (step: AgentSetupStep) => void;
}

export function DynamicAgentsTab({
  selectedAgentId,
  initialStep,
  onSelectedAgentChange,
  onStepChange,
}: DynamicAgentsTabProps = {}) {
  const router = useRouter();
  const createConversation = useChatStore((state) => state.createConversation);
  const [agents, setAgents] = React.useState<DynamicAgentConfigWithPermissions[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [editingAgent, setEditingAgent] = React.useState<DynamicAgentConfigWithPermissions | null>(null);
  const [selectionLoading, setSelectionLoading] = React.useState(false);
  const [selectionError, setSelectionError] = React.useState<string | null>(null);
  const selectionRequestRef = React.useRef(0);
  const loadedSelectionIdRef = React.useRef<string | null>(null);
  const [isCreating, setIsCreating] = React.useState(false);
  const [cloningAgent, setCloningAgent] = React.useState<DynamicAgentConfigWithPermissions | null>(null);
  const [pendingDeleteAgentId, setPendingDeleteAgentId] = React.useState<string | null>(null);
  const [deletingAgentId, setDeletingAgentId] = React.useState<string | null>(null);
  const [startingChatAgentId, setStartingChatAgentId] = React.useState<string | null>(null);
  const [rowActionErrors, setRowActionErrors] = React.useState<Record<string, string>>({});
  const [search, setSearch] = React.useState("");
  const [searchInput, setSearchInput] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(20);
  const [total, setTotal] = React.useState(0);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const fetchAgents = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        page_size: pageSize.toString(),
      });
      if (search.trim()) params.set("search", search.trim());
      const response = await fetch(`/api/dynamic-agents?${params}`);
      const data = await response.json();
      if (data.success) {
        setAgents(
          (data.data.items || []).map((agent: DynamicAgentConfigWithPermissions) => ({
            ...agent,
            permissions: agent.permissions ?? DEFAULT_ROW_PERMISSIONS,
          })),
        );
        setTotal(data.data.total ?? 0);
      } else {
        setError(data.error || "Failed to fetch agents");
      }
    } catch (err) {
      setError(getErrorMessage(err, "") || "Failed to fetch agents");
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search]);

  React.useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  React.useEffect(() => {
    if (selectedAgentId === undefined) return;

    const requestId = ++selectionRequestRef.current;
    if (!selectedAgentId) {
      loadedSelectionIdRef.current = null;
      setEditingAgent(null);
      setSelectionError(null);
      setSelectionLoading(false);
      return;
    }

    if (loadedSelectionIdRef.current === selectedAgentId) {
      setSelectionError(null);
      setSelectionLoading(false);
      return;
    }

    setSelectionLoading(true);
    setSelectionError(null);
    void (async () => {
      try {
        const response = await fetch(
          `/api/dynamic-agents/agents/${encodeURIComponent(selectedAgentId)}`,
        );
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || "Agent not found");
        }
        if (selectionRequestRef.current === requestId) {
          loadedSelectionIdRef.current = selectedAgentId;
          setEditingAgent({
            ...data.data,
            permissions: data.data.permissions ?? DEFAULT_ROW_PERMISSIONS,
          });
        }
      } catch (err: unknown) {
        if (selectionRequestRef.current === requestId) {
          loadedSelectionIdRef.current = null;
          setEditingAgent(null);
          setSelectionError(errorMessage(err, "Failed to load agent"));
        }
      } finally {
        if (selectionRequestRef.current === requestId) {
          setSelectionLoading(false);
        }
      }
    })();
  }, [selectedAgentId]);

  // Debounce search input
  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== search) {
        setSearch(searchInput);
        setPage(1);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, search]);

  const clearRowActionError = React.useCallback((agentId: string) => {
    setRowActionErrors((prev) => {
      if (!prev[agentId]) return prev;
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
  }, []);

  const handleDelete = async (agentId: string) => {
    setDeletingAgentId(agentId);
    clearRowActionError(agentId);
    try {
      const response = await fetch(`/api/dynamic-agents?id=${agentId}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (data.success) {
        setPendingDeleteAgentId(null);
        fetchAgents();
      } else {
        setRowActionErrors((prev) => ({
          ...prev,
          [agentId]: data.error || "Failed to delete agent",
        }));
      }
    } catch (err: unknown) {
      setRowActionErrors((prev) => ({
        ...prev,
        [agentId]: errorMessage(err, "Failed to delete agent"),
      }));
    } finally {
      setDeletingAgentId(null);
    }
  };

  const handleToggleEnabled = async (agent: DynamicAgentConfigWithPermissions) => {
    if (!agentCanManage(agent)) return;
    clearRowActionError(agent._id);
    try {
      const response = await fetch(`/api/dynamic-agents?id=${agent._id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !agent.enabled }),
      });
      const data = await response.json();
      if (data.success) {
        fetchAgents();
      } else {
        setRowActionErrors((prev) => ({
          ...prev,
          [agent._id]: data.error || "Failed to update agent",
        }));
      }
    } catch (err: unknown) {
      setRowActionErrors((prev) => ({
        ...prev,
        [agent._id]: errorMessage(err, "Failed to update agent"),
      }));
    }
  };

  const handleStartChat = async (agent: DynamicAgentConfigWithPermissions) => {
    if (!agent.enabled || startingChatAgentId) return;
    setStartingChatAgentId(agent._id);
    clearRowActionError(agent._id);
    try {
      const conversationId = await createConversation(agent._id);
      router.push(`/chat/${conversationId}`);
    } catch (err: unknown) {
      setRowActionErrors((prev) => ({
        ...prev,
        [agent._id]: errorMessage(err, "Failed to start chat"),
      }));
    } finally {
      setStartingChatAgentId(null);
    }
  };

  /**
   * Export agent configuration as YAML file.
   */
  const handleExportYaml = (agent: DynamicAgentConfigWithPermissions) => {
    // Build a complete config object for export (excluding only internal metadata)
    const agentRecord = agent as unknown as Record<string, unknown>;
    const exportConfig = {
      id: agent._id,
      name: agent.name,
      description: agent.description || undefined,
      system_prompt: agent.system_prompt,
      model: agent.model,
      visibility: agent.visibility,
      shared_with_teams: agent.shared_with_teams?.length ? agent.shared_with_teams : undefined,
      allowed_tools: Object.keys(agent.allowed_tools || {}).length ? agent.allowed_tools : undefined,
      builtin_tools: agent.builtin_tools,
      subagents: agent.subagents?.length ? agent.subagents : undefined,
      skills: agent.skills?.length ? agent.skills : undefined,
      features: agent.features,
      interrupt_on: agentRecord.interrupt_on || undefined,
      ui: agent.ui?.gradient_theme ? agent.ui : undefined,
      enabled: agent.enabled,
    };

    const yamlContent = toYaml(exportConfig);

    // Download the file
    const blob = new Blob([yamlContent], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${agent._id}.yaml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  /**
   * Clone an agent - opens the editor with pre-filled values
   */
  const handleClone = (agent: DynamicAgentConfigWithPermissions) => {
    setCloningAgent(agent);
  };

  const openAgent = (agent: DynamicAgentConfigWithPermissions) => {
    loadedSelectionIdRef.current = agent._id;
    setSelectionError(null);
    setEditingAgent(agent);
    onSelectedAgentChange?.(agent._id);
  };

  const closeAgentEditor = () => {
    selectionRequestRef.current += 1;
    loadedSelectionIdRef.current = null;
    setEditingAgent(null);
    setIsCreating(false);
    setCloningAgent(null);
    setSelectionError(null);
    setSelectionLoading(false);
    onSelectedAgentChange?.(null);
  };

  const getVisibilityIcon = (visibility: string) => {
    switch (visibility) {
      case "global":
        return <Globe className="h-3 w-3" />;
      case "team":
        return <Users className="h-3 w-3" />;
      default:
        return <Lock className="h-3 w-3" />;
    }
  };

  const getVisibilityColor = (visibility: string) => {
    switch (visibility) {
      case "global":
        return "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30";
      case "team":
        return "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30";
      default:
        return "bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30";
    }
  };

  const hasMatchingSelectedAgent = editingAgent?._id === selectedAgentId;

  if (selectedAgentId && selectionLoading && !hasMatchingSelectedAgent) {
    return <AgentEditorSkeleton />;
  }

  if (selectedAgentId && selectionError && !hasMatchingSelectedAgent) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-destructive">{selectionError}</p>
          <Button variant="outline" className="mt-4" onClick={closeAgentEditor}>
            Back to Agents
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (isCreating || editingAgent || cloningAgent) {
    return (
      <DynamicAgentEditor
        key={editingAgent?._id ?? (cloningAgent ? `clone-${cloningAgent._id}` : "new")}
        agent={editingAgent}
        cloneFrom={cloningAgent}
        readOnly={Boolean(editingAgent?.config_driven || (editingAgent && !agentCanEdit(editingAgent)))}
        readOnlyReason={editingAgent?.config_driven ? "config" : "permissions"}
        initialStep={initialStep}
        onStepChange={onStepChange}
        onSave={() => {
          closeAgentEditor();
          fetchAgents();
        }}
        onCancel={closeAgentEditor}
      />
    );
  }

  return (
    <>
      <WorkspacePageActions>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name or ID..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-9 w-48 pl-9"
            />
          </div>
          <Button variant="outline" size="sm" onClick={fetchAgents} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setIsCreating(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Agent
          </Button>
        </div>
      </WorkspacePageActions>
      <Card className="rounded-none border-0 bg-transparent shadow-none">
        <CardContent className="px-0 pt-0">
        {loading ? (
          <AgentsListSkeleton />
        ) : error ? (
          <div className="text-center py-12">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" className="mt-4" onClick={fetchAgents}>
              Retry
            </Button>
          </div>
        ) : agents.length === 0 ? (
          <div className="text-center py-12">
            <Bot className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            {search ? (
              <>
                <h3 className="text-lg font-semibold mb-2">No agents match &quot;{search}&quot;</h3>
                <p className="text-muted-foreground mb-4">Try a different search term.</p>
                <Button variant="outline" onClick={() => { setSearchInput(""); setSearch(""); }}>
                  Clear search
                </Button>
              </>
            ) : (
              <>
                <h3 className="text-lg font-semibold mb-2">No agents yet</h3>
                <p className="text-muted-foreground mb-4">
                  Create an agent when you are ready to give your team a tailored assistant.
                </p>
                <Button onClick={() => setIsCreating(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Agent
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {/* Header */}
            <div className="grid grid-cols-12 gap-4 pb-2 border-b text-xs font-medium text-muted-foreground px-2">
              <div className="col-span-4">Name</div>
              <div className="col-span-2">Visibility</div>
              <div className="col-span-1">Tools</div>
              <div className="col-span-1">Grade</div>
              <div className="col-span-2">Status</div>
              <div className="col-span-2 text-right">Actions</div>
            </div>

            {/* Result count */}
            {total > 0 && (
              <div className="text-xs text-muted-foreground px-2 pb-1">
                {search
                  ? `${total} result${total !== 1 ? "s" : ""} for "${search}"`
                  : `${total} agent${total !== 1 ? "s" : ""}`}
              </div>
            )}

            {/* Agent rows */}
            {agents.map((agent) => {
              const canManage = agentCanManage(agent);
              const rowActionError = rowActionErrors[agent._id];
              return (
              <div key={agent._id} className="space-y-2">
              <div
                className="grid grid-cols-12 gap-4 py-3 px-2 rounded-lg hover:bg-muted/50 items-center cursor-pointer"
                onClick={() => openAgent(agent)}
              >
                <div className="col-span-4">
                    <div className="flex items-center gap-3">
                      <AgentAvatar
                        agent={agent}
                        rounded="rounded-lg"
                        size="h-9 w-9"
                        iconSize="h-5 w-5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm truncate">{agent.name}</div>
                        {agent.description && (
                          <div className="text-xs text-muted-foreground truncate">
                            {agent.description}
                          </div>
                        )}
                      </div>
                    </div>
                </div>

                <div className="col-span-2">
                  <Badge
                    variant="outline"
                    className={`gap-1 ${getVisibilityColor(agent.visibility)}`}
                  >
                    {getVisibilityIcon(agent.visibility)}
                    {agent.visibility}
                  </Badge>
                </div>

                <div className="col-span-1">
                  <span className="text-sm text-muted-foreground">
                    {Object.keys(agent.allowed_tools || {}).length}
                  </span>
                </div>

                <div className="col-span-1">
                  <LastReviewBadge review={agent.last_review} />
                </div>

                <div className="col-span-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (canManage && !agent.config_driven) handleToggleEnabled(agent);
                    }}
                    className={`flex items-center gap-1.5 ${
                      agent.config_driven || !canManage ? "cursor-not-allowed opacity-60" : ""
                    }`}
                    disabled={agent.config_driven || !canManage}
                    title={
                      agent.config_driven
                        ? "Config-driven agents cannot be modified"
                        : !canManage
                          ? "You need manage access to enable or disable this agent"
                          : undefined
                    }
                  >
                    {agent.enabled ? (
                      <>
                        <ToggleRight className="h-5 w-5 text-green-500" />
                        <span className="text-xs text-green-600 dark:text-green-400">Active</span>
                      </>
                    ) : (
                      <>
                        <ToggleLeft className="h-5 w-5 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">Disabled</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="col-span-2 flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => void handleStartChat(agent)}
                    aria-label={`Chat with ${agent.name}`}
                    title={agent.enabled ? `Chat with ${agent.name}` : "This agent is disabled"}
                    disabled={!agent.enabled || startingChatAgentId !== null}
                  >
                    {startingChatAgentId === agent._id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <MessageSquare className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleExportYaml(agent)}
                    title="Export as YAML"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleClone(agent)}
                    title="Clone agent"
                  >
                    <CopyPlus className="h-4 w-4" />
                  </Button>
                  {agent.config_driven && (
                    <Badge
                      variant="outline"
                      className="gap-1 mr-1 bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30"
                      title="Loaded from config.yaml - cannot be edited"
                    >
                      Config
                    </Badge>
                  )}
                  {!agent.is_system && !agent.config_driven && canManage && (
                    pendingDeleteAgentId === agent._id ? (
                      <div className="flex items-center gap-1 rounded-full border border-destructive/20 bg-destructive/10 px-2 py-1">
                        <span className="max-w-[7rem] truncate text-xs font-medium text-destructive">
                          Delete {agent.name}?
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                          disabled={deletingAgentId === agent._id}
                          onClick={() => setPendingDeleteAgentId(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          aria-label={`Confirm delete ${agent.name}`}
                          className="h-7 bg-destructive px-2 text-xs text-destructive-foreground hover:bg-destructive/90"
                          disabled={deletingAgentId === agent._id}
                          onClick={() => void handleDelete(agent._id)}
                        >
                          {deletingAgentId === agent._id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            "Delete"
                          )}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => {
                          setPendingDeleteAgentId(agent._id);
                          clearRowActionError(agent._id);
                        }}
                        aria-label={`Delete ${agent.name}`}
                        title="Delete agent"
                        disabled={deletingAgentId === agent._id}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )
                  )}
                </div>
              </div>

              {rowActionError && (
                <div className="ml-12 pl-4 border-l-2 border-destructive/30">
                  <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/30 p-3">
                    <AlertCircle className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" />
                    <div className="flex flex-1 items-start justify-between gap-3">
                      <p className="text-sm text-destructive">{rowActionError}</p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => clearRowActionError(agent._id)}
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                </div>
              )}
              </div>
            );
            })}

            {/* Pagination */}
            {total > pageSize && (
              <div className="flex items-center justify-between pt-4 gap-4 border-t">
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  Showing {Math.min((page - 1) * pageSize + 1, total)}–{Math.min(page * pageSize, total)} of {total}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
                    .reduce<(number | "ellipsis")[]>((acc, p, idx, arr) => {
                      if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push("ellipsis");
                      acc.push(p);
                      return acc;
                    }, [])
                    .map((item, idx) =>
                      item === "ellipsis" ? (
                        <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground text-sm">...</span>
                      ) : (
                        <Button
                          key={item}
                          variant={page === item ? "default" : "outline"}
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => setPage(item)}
                        >
                          {item}
                        </Button>
                      )
                    )}
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page === totalPages}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm text-muted-foreground whitespace-nowrap">Rows</label>
                  <Select
                    value={pageSize}
                    onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                    className="h-8 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {[10, 20, 50, 100].map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </Select>
                </div>
              </div>
            )}
          </div>
        )}
        </CardContent>
      </Card>
    </>
  );
}
