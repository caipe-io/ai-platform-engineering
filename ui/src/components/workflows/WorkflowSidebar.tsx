"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
Dialog,
DialogContent,
DialogDescription,
DialogFooter,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import {
Popover,
PopoverContent,
PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import {
Tooltip,
TooltipContent,
TooltipProvider,
TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import { cn,formatRelativeTime } from "@/lib/utils";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import { useWorkflowConfigStore } from "@/store/workflow-config-store";
import {
useWorkflowExecStore,
type WfRunStatus,
type WfRunSummary,
} from "@/store/workflow-exec-store";
import type { WorkflowConfig } from "@/types/workflow-config";
import { AnimatePresence,motion } from "framer-motion";
import {
CheckCircle2,
ChevronDown,
ChevronLeft,
ChevronRight,
Clock,
Copy,
Filter,
Globe,
History,
Loader2,
Lock,
MessageSquare,
Play,
Plus,
RefreshCw,
Search,
Trash2,
Users,
Workflow,
X,
XCircle,
} from "lucide-react";
import { useParams,useRouter } from "next/navigation";
import React,{ useCallback,useEffect,useMemo,useState } from "react";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const ALL_STATUSES: WfRunStatus[] = [
  "running",
  "pending",
  "waiting_for_input",
  "completed",
  "failed",
];

const STATUS_ICON: Record<WfRunStatus, React.ReactNode> = {
  pending: <Clock className="h-3.5 w-3.5 text-muted-foreground" />,
  running: <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />,
  waiting_for_input: (
    <MessageSquare className="h-3.5 w-3.5 text-amber-500" />
  ),
  completed: <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />,
  failed: <XCircle className="h-3.5 w-3.5 text-red-500" />,
  cancelled: <XCircle className="h-3.5 w-3.5 text-muted-foreground" />,
};

const STATUS_LABEL: Record<WfRunStatus, string> = {
  pending: "Pending",
  running: "Running",
  waiting_for_input: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_COLOR: Record<WfRunStatus, string> = {
  pending: "border-muted-foreground/40 text-muted-foreground",
  running: "border-blue-500/40 text-blue-500",
  waiting_for_input: "border-amber-500/40 text-amber-500",
  completed: "border-green-500/40 text-green-500",
  failed: "border-red-500/40 text-red-500",
  cancelled: "border-muted-foreground/40 text-muted-foreground",
};


// Animation variants — horizontal slide only, no vertical shift
const tabContentVariants = {
  enter: (direction: number) => ({
    x: direction > 0 ? 40 : -40,
    opacity: 0,
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  exit: (direction: number) => ({
    x: direction > 0 ? -40 : 40,
    opacity: 0,
    position: "absolute" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  }),
};

const sidebarVariants = {
  expanded: {
    width: 300,
    transition: { type: "spring" as const, stiffness: 300, damping: 30 },
  },
  collapsed: {
    width: 52,
    transition: { type: "spring" as const, stiffness: 300, damping: 30 },
  },
};

type SidebarTab = "workflows" | "runs";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WorkflowSidebarProps {
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkflowSidebar({
  collapsed,
  onCollapse,
}: WorkflowSidebarProps) {
  const router = useRouter();
  const { toast } = useToast();
  const params = useParams();
  const activeRunId = params?.id as string | undefined;

  const { runs, isLoadingRuns, loadRuns, executeWorkflow } =
    useWorkflowExecStore();
  const {
    configs,
    isLoading: isLoadingConfigs,
    error: configsError,
    loadConfigs,
    deleteConfig,
    openEditor,
    editMode,
    selectedConfigId,
  } = useWorkflowConfigStore();
  const requestDeferredAction = useUnsavedChangesStore((s) => s.requestDeferredAction);

  const [activeTab, setActiveTab] = useState<SidebarTab>("workflows");
  const [tabDirection, setTabDirection] = useState(0); // -1 = left, 1 = right
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Filters
  const [statusFilter, setStatusFilter] = useState<Set<WfRunStatus>>(new Set());
  const [configFilter, setConfigFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [workflowSearchQuery, setWorkflowSearchQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // Delete run confirmation dialog
  const [deleteRunId, setDeleteRunId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const { deleteRun } = useWorkflowExecStore();

  const configNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of configs) map[c._id] = c.name;
    return map;
  }, [configs]);

  // Unique config IDs in runs (for config filter dropdown)
  const runConfigIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of runs) ids.add(r.workflow_config_id);
    return Array.from(ids);
  }, [runs]);

  const hasActiveFilters = statusFilter.size > 0 || configFilter !== null || searchQuery.length > 0;

  const filteredRuns = useMemo(() => {
    let result = Array.isArray(runs) ? runs : [];
    if (statusFilter.size > 0) {
      result = result.filter((r) => statusFilter.has(r.status));
    }
    if (configFilter) {
      result = result.filter((r) => r.workflow_config_id === configFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter((r) => {
        const name = configNameMap[r.workflow_config_id] || r.workflow_config_id;
        return name.toLowerCase().includes(q);
      });
    }
    return result;
  }, [runs, statusFilter, configFilter, searchQuery, configNameMap]);

  useEffect(() => {
    loadRuns();
    loadConfigs();
  }, [loadRuns, loadConfigs]);

  useEffect(() => {
    if (activeRunId) {
      switchTab("runs");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId]);

  const switchTab = useCallback(
    (tab: SidebarTab) => {
      if (tab === activeTab && !activeRunId) return;
      const doSwitch = () => {
        setTabDirection(tab === "runs" ? 1 : -1);
        setActiveTab(tab);
        // When switching to workflows from the run detail page, navigate back
        if (tab === "workflows" && activeRunId) {
          router.push("/workflows");
        }
      };
      if (editMode) {
        requestDeferredAction(doSwitch);
        return;
      }
      doSwitch();
    },
    [activeTab, activeRunId, editMode, requestDeferredAction, router],
  );

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    if (activeTab === "workflows") {
      await loadConfigs();
    } else {
      await loadRuns();
    }
    setIsRefreshing(false);
  }, [activeTab, loadConfigs, loadRuns]);

  const handleSelectRun = (runId: string) => {
    requestDeferredAction(() => router.push(`/workflows/run/${runId}`));
  };

  const handleEditConfig = (config: WorkflowConfig) => {
    if (editMode === "edit" && selectedConfigId === config._id) return;
    requestDeferredAction(() => {
      openEditor("edit", config._id);
      router.push("/workflows");
    });
  };

  const handleCloneConfig = (config: WorkflowConfig) => {
    requestDeferredAction(() => {
      openEditor("clone", config._id);
      router.push("/workflows");
    });
  };

  const handleNewConfig = () => {
    requestDeferredAction(() => {
      openEditor("new");
      router.push("/workflows");
    });
  };

  const handleDeleteConfig = async (config: WorkflowConfig) => {
    if (!window.confirm(`Delete "${config.name}"? This cannot be undone.`))
      return;
    await deleteConfig(config._id);
  };

  const handleConfirmDeleteRun = async () => {
    if (!deleteRunId) return;
    setIsDeleting(true);
    try {
      // If we're viewing the run being deleted, navigate away
      if (activeRunId === deleteRunId) {
        router.push("/workflows");
      }
      await deleteRun(deleteRunId);
    } catch {
      // store handles errors
    } finally {
      setIsDeleting(false);
      setDeleteRunId(null);
    }
  };

  const handleRunConfig = async (config: WorkflowConfig) => {
    try {
      const runId = await executeWorkflow(config._id);
      switchTab("runs");
      router.push(`/workflows/run/${runId}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to start workflow", "error");
    }
  };

  const toggleStatusFilter = (status: WfRunStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const clearFilters = () => {
    setStatusFilter(new Set());
    setConfigFilter(null);
    setSearchQuery("");
    setWorkflowSearchQuery("");
  };

  return (
    <>
    <motion.div
      className="flex flex-col border-r border-border/50 bg-card/30 shrink-0 overflow-hidden"
      variants={sidebarVariants}
      animate={collapsed ? "collapsed" : "expanded"}
      initial={false}
    >
      <AnimatePresence mode="wait" initial={false}>
        {collapsed ? (
          <motion.div
            key="collapsed"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col items-center py-3 gap-2 h-full"
          >
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => onCollapse(false)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Expand sidebar</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-8 w-8",
                      activeTab === "workflows" && "bg-accent"
                    )}
                    onClick={() => {
                      onCollapse(false);
                      switchTab("workflows");
                    }}
                  >
                    <Workflow className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Workflows</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-8 w-8",
                      activeTab === "runs" && "bg-accent"
                    )}
                    onClick={() => {
                      onCollapse(false);
                      switchTab("runs");
                    }}
                  >
                    <History className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Runs</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </motion.div>
        ) : (
          <motion.div
            key="expanded"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="flex flex-col h-full min-w-0"
          >
            {/* Header with tabs */}
            <div className="shrink-0">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
                <div className="flex items-center gap-1 relative">
                  {/* Tab buttons with animated indicator */}
                  <div className="flex items-center gap-1 relative">
                    <button
                      onClick={() => switchTab("workflows")}
                      className={cn(
                        "relative flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-md transition-colors z-10",
                        activeTab === "workflows"
                          ? "text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {activeTab === "workflows" && (
                        <motion.div
                          layoutId="tab-indicator"
                          className="absolute inset-0 bg-accent rounded-md"
                          transition={{
                            type: "spring",
                            stiffness: 400,
                            damping: 30,
                          }}
                        />
                      )}
                      <span className="relative flex items-center gap-1.5">
                        <Workflow className="h-3.5 w-3.5" />
                        Workflows
                      </span>
                    </button>
                    <button
                      onClick={() => switchTab("runs")}
                      className={cn(
                        "relative flex items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-md transition-colors z-10",
                        activeTab === "runs"
                          ? "text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {activeTab === "runs" && (
                        <motion.div
                          layoutId="tab-indicator"
                          className="absolute inset-0 bg-accent rounded-md"
                          transition={{
                            type: "spring",
                            stiffness: 400,
                            damping: 30,
                          }}
                        />
                      )}
                      <span className="relative flex items-center gap-1.5">
                        <History className="h-3.5 w-3.5" />
                        Runs
                        {hasActiveFilters && (
                          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                        )}
                      </span>
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {activeTab === "runs" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-7 w-7",
                        showFilters && "bg-accent"
                      )}
                      onClick={() => setShowFilters(!showFilters)}
                    >
                      <Filter className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={handleRefresh}
                    disabled={isRefreshing}
                  >
                    <RefreshCw
                      className={cn(
                        "h-3.5 w-3.5",
                        isRefreshing && "animate-spin"
                      )}
                    />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => onCollapse(true)}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {/* Action button area */}
              <div className="border-b border-border/50">
                <AnimatePresence mode="popLayout" initial={false}>
                  {activeTab === "workflows" ? (
                    <motion.div
                      key="new-workflow"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                    >
                      <div className="px-3 py-2 space-y-2">
                        <Button
                          onClick={handleNewConfig}
                          size="sm"
                          className="w-full gap-1.5 gradient-primary text-white"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          New Workflow
                        </Button>
                        <div className="relative">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                          <input
                            type="text"
                            value={workflowSearchQuery}
                            onChange={(e) => setWorkflowSearchQuery(e.target.value)}
                            placeholder="Search workflows..."
                            className="w-full text-xs pl-7 pr-2 py-1.5 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground"
                          />
                        </div>
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="run-workflow"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.15 }}
                    >
                      <div className="px-3 py-2 space-y-2">
                        <RunWorkflowDropdown
                          configs={configs}
                          onRun={handleRunConfig}
                        />
                        <div className="relative">
                          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                          <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search runs..."
                            className="w-full text-xs pl-7 pr-2 py-1.5 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground"
                          />
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Filters panel (runs tab only) */}
              <AnimatePresence>
                {activeTab === "runs" && showFilters && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden border-b border-border/50"
                  >
                    <div className="px-3 py-2 space-y-2">
                      {/* Status filter chips */}
                      <div>
                        <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                          Status
                        </span>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {ALL_STATUSES.map((status) => (
                            <button
                              key={status}
                              onClick={() => toggleStatusFilter(status)}
                              className={cn(
                                "flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full border transition-colors",
                                statusFilter.has(status)
                                  ? cn(STATUS_COLOR[status], "bg-accent/50")
                                  : "border-border text-muted-foreground hover:border-foreground/30"
                              )}
                            >
                              {STATUS_LABEL[status]}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Config filter */}
                      {runConfigIds.length > 1 && (
                        <div>
                          <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                            Workflow
                          </span>
                          <SearchablePicker
                            options={runConfigIds}
                            selected={configFilter ?? undefined}
                            onSelect={setConfigFilter}
                            getOptionKey={(id) => id}
                            getOptionLabel={(id) => configNameMap[id] || id}
                            placeholder="All workflows"
                            searchPlaceholder="Search workflows..."
                            emptyLabel="No workflows match"
                            ariaLabel="Workflow filter"
                            onClear={() => setConfigFilter(null)}
                            clearLabel="Clear workflow filter"
                            triggerClassName="mt-1 h-8 px-2 py-1 text-xs"
                            portalled={false}
                          />
                        </div>
                      )}

                      {/* Clear filters */}
                      {hasActiveFilters && (
                        <button
                          onClick={clearFilters}
                          className="flex items-center gap-1 text-[11px] text-primary hover:underline"
                        >
                          <X className="h-3 w-3" />
                          Clear filters
                        </button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Tab content with slide animation */}
            <div className="flex-1 overflow-hidden relative">
              <AnimatePresence
                mode="wait"
                initial={false}
                custom={tabDirection}
              >
                {activeTab === "workflows" ? (
                  <motion.div
                    key="workflows"
                    custom={tabDirection}
                    variants={tabContentVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.2, ease: "easeInOut" }}
                  >
                    <ScrollArea className="h-full">
                      <WorkflowsTab
                        configs={configs}
                        isLoading={isLoadingConfigs}
                        error={configsError}
                        selectedConfigId={editMode ? selectedConfigId : null}
                        searchQuery={workflowSearchQuery}
                        onEdit={handleEditConfig}
                        onClone={handleCloneConfig}
                        onDelete={handleDeleteConfig}
                        onRun={handleRunConfig}
                      />
                    </ScrollArea>
                  </motion.div>
                ) : (
                  <motion.div
                    key="runs"
                    custom={tabDirection}
                    variants={tabContentVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.2, ease: "easeInOut" }}
                  >
                    <ScrollArea className="h-full">
                      <RunsTab
                        runs={filteredRuns}
                        totalCount={runs.length}
                        isLoading={isLoadingRuns}
                        activeRunId={activeRunId}
                        configNameMap={configNameMap}
                        hasActiveFilters={hasActiveFilters}
                        onSelectRun={handleSelectRun}
                        onDeleteRun={setDeleteRunId}
                      />
                    </ScrollArea>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>

      {/* Delete run confirmation dialog */}
      <Dialog open={!!deleteRunId} onOpenChange={(open) => !open && setDeleteRunId(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete workflow run</DialogTitle>
            <DialogDescription>
              This will permanently delete the workflow run, all associated files, and stream events. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteRunId(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleConfirmDeleteRun}
              disabled={isDeleting}
              className="gap-1.5"
            >
              {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Workflows Tab
// ---------------------------------------------------------------------------

function WorkflowsTab({
  configs,
  isLoading,
  error,
  selectedConfigId,
  searchQuery,
  onEdit,
  onClone,
  onDelete,
  onRun,
}: {
  configs: WorkflowConfig[];
  isLoading: boolean;
  error: string | null;
  selectedConfigId: string | null;
  searchQuery: string;
  onEdit: (config: WorkflowConfig) => void;
  onClone: (config: WorkflowConfig) => void;
  onDelete: (config: WorkflowConfig) => void;
  onRun: (config: WorkflowConfig) => void;
}) {
  if (isLoading && configs.length === 0) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && configs.length === 0) {
    return (
      <div className="text-center py-10 px-4">
        <XCircle className="h-8 w-8 text-destructive/70 mx-auto mb-3" />
        <p className="text-sm text-foreground font-medium">Could not load workflows</p>
        <p className="text-xs text-muted-foreground mt-1">{error}</p>
      </div>
    );
  }

  if (configs.length === 0) {
    return (
      <div className="text-center py-10 px-4">
        <Workflow className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">No workflows yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Create your first workflow above
        </p>
      </div>
    );
  }

  // Filter by search query
  const filtered = searchQuery.trim()
    ? configs.filter((c) => c.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : configs;

  if (filtered.length === 0) {
    return (
      <div className="text-center py-10 px-4">
        <Search className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">No matching workflows</p>
      </div>
    );
  }

  return (
    <div className="py-1">
      {filtered.map((config) => {
        const isActive = config._id === selectedConfigId;
        const stepCount = config.steps?.length ?? 0;

        return (
          <div
            key={config._id}
            onClick={() => onEdit(config)}
            className={cn(
              "group w-full text-left px-3 py-2.5 transition-colors hover:bg-accent/50 cursor-pointer",
              isActive && "bg-accent"
            )}
          >
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-sm font-medium text-foreground truncate flex-1">
                {config.name}
              </span>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRun(config);
                  }}
                  className="p-1 rounded hover:bg-green-500/10 text-muted-foreground hover:text-green-500"
                  title="Run"
                >
                  <Play className="h-3 w-3" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onClone(config);
                  }}
                  className="p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary"
                  title="Clone"
                >
                  <Copy className="h-3 w-3" />
                </button>
                {!config.config_driven && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(config);
                  }}
                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
                )}
              </div>
            </div>
            {config.description && (
              <p className="text-xs text-muted-foreground line-clamp-1">
                {config.description}
              </p>
            )}
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-1">
              <span>{stepCount} step{stepCount !== 1 ? "s" : ""}</span>
              <span className="text-border">·</span>
              {config.visibility === "private" && (
                <span className="flex items-center gap-0.5 text-amber-500">
                  <Lock className="h-2.5 w-2.5" />
                  Private
                </span>
              )}
              {config.visibility === "team" && (
                <span className="flex items-center gap-0.5 text-blue-500">
                  <Users className="h-2.5 w-2.5" />
                  Team
                </span>
              )}
              {(config.visibility === "global" || !config.visibility) && (
                <span className="flex items-center gap-0.5 text-emerald-500">
                  <Globe className="h-2.5 w-2.5" />
                  Global
                </span>
              )}
              {config.config_driven && (
                <Badge
                  variant="outline"
                  className="text-[9px] px-1 py-0 h-3.5 bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30"
                >
                  Config
                </Badge>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run Workflow Dropdown
// ---------------------------------------------------------------------------

function RunWorkflowDropdown({
  configs,
  onRun,
}: {
  configs: WorkflowConfig[];
  onRun: (config: WorkflowConfig) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="w-full [&>.relative.inline-flex]:w-full">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="w-full gap-1.5 justify-center"
          >
            <Play className="h-3.5 w-3.5" />
            Run Workflow
            <ChevronDown className="h-3 w-3 opacity-70" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="p-0 w-[276px]"
          align="start"
          side="bottom"
          sideOffset={4}
        >
          {configs.length === 0 ? (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              No workflows configured
            </div>
          ) : (
            <ScrollArea className="max-h-[300px]">
              <div className="py-1">
                {configs.map((config) => (
                  <button
                    key={config._id}
                    onClick={() => {
                      setOpen(false);
                      onRun(config);
                    }}
                    className="w-full text-left px-3 py-2 hover:bg-accent/50 transition-colors"
                  >
                    <div className="text-sm font-medium text-foreground">
                      {config.name}
                    </div>
                    {config.description && (
                      <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">
                        {config.description}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </ScrollArea>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runs Tab
// ---------------------------------------------------------------------------

function RunsTab({
  runs,
  totalCount,
  isLoading,
  activeRunId,
  configNameMap,
  hasActiveFilters,
  onSelectRun,
  onDeleteRun,
}: {
  runs: WfRunSummary[];
  totalCount: number;
  isLoading: boolean;
  activeRunId: string | undefined;
  configNameMap: Record<string, string>;
  hasActiveFilters: boolean;
  onSelectRun: (runId: string) => void;
  onDeleteRun: (runId: string) => void;
}) {
  if (isLoading && totalCount === 0) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (totalCount === 0) {
    return (
      <div className="text-center py-10 px-4">
        <History className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">No runs yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Run a workflow from the Workflows tab
        </p>
      </div>
    );
  }

  if (runs.length === 0 && hasActiveFilters) {
    return (
      <div className="text-center py-10 px-4">
        <Filter className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
        <p className="text-sm text-muted-foreground">No matching runs</p>
        <p className="text-xs text-muted-foreground mt-1">
          Try adjusting your filters
        </p>
      </div>
    );
  }

  return (
    <div className="py-1">
      {hasActiveFilters && (
        <div className="px-3 py-1 text-[10px] text-muted-foreground">
          Showing {runs.length} of {totalCount} runs
        </div>
      )}
      {runs.map((run) => {
        const isActive = run._id === activeRunId;
        const configName =
          configNameMap[run.workflow_config_id] || run.workflow_config_id;
        const runSteps = run.steps ?? [];
        const completedSteps = runSteps.filter(
          (s) => s.status === "completed"
        ).length;

        return (
          <div
            key={run._id}
            onClick={() => onSelectRun(run._id)}
            className={cn(
              "group relative w-full text-left px-3 py-2.5 transition-colors hover:bg-accent/50 cursor-pointer",
              isActive && "bg-accent"
            )}
          >
            <div>
              <div className="flex items-center gap-2 mb-1">
                {STATUS_ICON[run.status]}
                <span className="text-sm font-medium text-foreground truncate flex-1">
                  {configName}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground pl-5">
                <span>
                  {completedSteps}/{runSteps.length} steps
                </span>
                {run.started_at && <span>{formatRelativeTime(run.started_at)}</span>}
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteRun(run._id);
              }}
              className="absolute right-2 top-2.5 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/10 hover:text-destructive text-muted-foreground cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
