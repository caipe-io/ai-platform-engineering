"use client";

// assisted-by Codex Codex-sonnet-4-6

import { agentMentionColor } from "@/lib/agent-mention-colors";
import { AgentAvatar } from "@/components/dynamic-agents/AgentAvatar";
import { ContextUsageDetails } from "@/components/chat/ContextUsageIndicator";
import { AgentHarnessBadge } from "@/components/chat/AgentHarnessBadge";
import { TaskList } from "@/components/shared/timeline/TaskList";
import { useAgentTimeline } from "@/hooks/useDynamicAgentTimeline";
import { getWorkspaceTasks, getWorkspaceTurnEvents } from "@/lib/chat-workspace";
import { FileTree } from "@/components/dynamic-agents/FileTree";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { fetchEphemeralFileContent } from "@/lib/ephemeral-files";
import type { ContextUsageEventData } from "@/lib/streaming/types";
import { useChatStore } from "@/store/chat-store";
import { useFeatureFlagStore } from "@/store/feature-flag-store";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { motion } from "framer-motion";
import {
Bot,
ChevronDown,
CheckCircle2,
Circle,
Download,
FolderOpen,
Info,
ListTodo,
Loader2,
NotebookText,
PanelRightClose,
PanelRightOpen,
RefreshCw,
Server,
Trash2,
Users,
} from "lucide-react";
import { useSession } from "next-auth/react";
import { useCallback,useEffect,useId,useMemo,useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { AddChatAgentDialog } from "@/components/chat/AddChatAgentDialog";
import type { ChatCoordination } from "@/hooks/use-chat-coordination";

interface DynamicAgentContextProps {
  /** Conversation ID from route params - used for API calls */
  conversationId?: string;
  agentId?: string;
  /** Full agent config (null while loading) */
  agent?: DynamicAgentConfig | null;
  /** Whether the agent has been deleted */
  agentNotFound?: boolean;
  collapsed?: boolean;
  onCollapse?: (collapsed: boolean) => void;
  readOnly?: boolean;
  coordination?: ChatCoordination;
}

/**
 * Chat workspace: configured agents, live delegation, published tasks and files.
 * Reads the same conversation store and authorized file APIs as the timeline.
 */
export function DynamicAgentContext({
  conversationId,
  agentId,
  agent,
  agentNotFound,
  collapsed = false,
  onCollapse,
  readOnly = false,
  coordination,
}: DynamicAgentContextProps) {
  const { data: session } = useSession();
  const { clearStreamEvents, contextUsageByConversation, conversations, streamingConversations, externalActivity } = useChatStore(
    useShallow((s) => ({
      clearStreamEvents: s.clearStreamEvents,
      contextUsageByConversation: s.contextUsageByConversation,
      conversations: s.conversations,
      streamingConversations: s.streamingConversations,
      externalActivity: s.externalActivity,
    }))
  );
  const showContextUsage = useFeatureFlagStore((s) => s.flags.showContextUsage ?? true);

  // Get current conversation for download
  const conversation = conversations.find((c) => c.id === conversationId);
  const isStreaming = !!conversationId && (streamingConversations.has(conversationId) || !!externalActivity[conversationId]);
  const activeAgentId = (conversationId ? streamingConversations.get(conversationId)?.agentId ?? externalActivity[conversationId]?.agentId : undefined) ?? agentId;
  const tasks = useMemo(() => getWorkspaceTasks(conversation), [conversation]);
  const turnEvents = getWorkspaceTurnEvents(conversation);
  // A chat's terminal status cannot certify an unfinished child delegation.
  // Only the child's matching tool_end event confirms its completion.
  const { data: timeline } = useAgentTimeline(turnEvents, isStreaming, "unknown");
  const subagentRuns = timeline.segments.filter((segment) => segment.type === "subagent");
  const [openSections, setOpenSections] = useState(["agents", "coordination"]);
  const coordinationEnabled = coordination?.enabled !== false;
  const [activeTab, setActiveTab] = useState("coordination");
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  const [filesError, setFilesError] = useState<string | null>(null);
  const sectionId = useId();
  const [coordinationInfoOpen, setCoordinationInfoOpen] = useState(false);
  const toggleSection = (section: string) => setOpenSections((sections) =>
    sections.includes(section) ? sections.filter((value) => value !== section) : [...sections, section]);
  const openSection = (section: string) => {
    setActiveTab(section === "context" ? "info" : "coordination");
    setOpenSections((sections) => sections.includes(section) ? sections : [...sections, section]);
    onCollapse?.(false);
  };
  const storedReasoningEffort = conversation?.metadata?.reasoning_effort;
  const hasConversationEffortOverride =
    typeof storedReasoningEffort === "string" &&
    ["low", "medium", "high", "max"].includes(storedReasoningEffort);
  const effectiveReasoningEffort = hasConversationEffortOverride
    ? storedReasoningEffort
    : (agent?.model?.reasoning_effort ?? "medium");
  const contextUsage = conversationId
    ? contextUsageByConversation[conversationId]
    : undefined;

  // Restart runtime handler
  const [isRestarting, setIsRestarting] = useState(false);
  const [runtimeRestarted, setRuntimeRestarted] = useState(false);

  // Fetch subagent configs to display their MCP servers
  const [subagentTools, setSubagentTools] = useState<Record<string, Record<string, string[]>>>({});
  useEffect(() => {
    if (!agent?.subagents?.length || !session?.accessToken) {
      setSubagentTools({});
      return;
    }

    let cancelled = false;
    const fetchSubagentConfigs = async () => {
      const results: Record<string, Record<string, string[]>> = {};
      await Promise.all(
        agent.subagents!.map(async (sub) => {
          try {
            const res = await fetch(`/api/dynamic-agents/agents/${sub.agent_id}`, {
              headers: session.accessToken
                ? { Authorization: `Bearer ${session.accessToken}` }
                : {},
            });
            if (res.ok) {
              const json = await res.json();
              const config = json.data;
              if (config?.allowed_tools) {
                results[sub.agent_id] = config.allowed_tools;
              }
            }
          } catch {
            // Silently skip — subagent may have been deleted
          }
        })
      );
      if (!cancelled) setSubagentTools(results);
    };

    fetchSubagentConfigs();
    return () => { cancelled = true; };
  }, [agent?.subagents, session?.accessToken]);

  // File browser state
  const [files, setFiles] = useState<string[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const showFiles = openSections.includes("files");
  useEffect(() => {
    if (!showFiles || collapsed || activeTab !== "coordination" || !agentId || !conversationId) return;
    const controller = new AbortController();
    const load = async () => {
      setIsLoadingFiles(true);
      setFilesError(null);
      try {
        const fsNamespace = JSON.stringify([agentId, conversationId, "filesystem"]);
        const res = await fetch(`/api/files/list?fs_namespace=${encodeURIComponent(fsNamespace)}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`File listing failed (${res.status})`);
        const data = await res.json();
        if (!Array.isArray(data.files) || !data.files.every((file: unknown) => typeof file === "string")) {
          throw new Error("Invalid file list");
        }
        if (!controller.signal.aborted) setFiles(data.files);
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn("[ChatWorkspace] Could not list conversation files", error);
          setFilesError("Workspace files could not be loaded. Retry to check your access and connection.");
        }
      } finally {
        if (!controller.signal.aborted) setIsLoadingFiles(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [showFiles, collapsed, activeTab, agentId, conversationId, filesRefreshKey, isStreaming]);

  const handleFileDownload = useCallback(async (path: string) => {
    if (!agentId || !conversationId) return;
    try {
      const fsNamespace = JSON.stringify([agentId, conversationId, "filesystem"]);
      const res = await fetch(`/api/files/content?fs_namespace=${encodeURIComponent(fsNamespace)}&path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = await res.json();
        const blob = new Blob([data.content || ""], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = path.split("/").pop() || "file";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch {
      // ignore
    }
  }, [agentId, conversationId]);

  const handleGetFileContent = useCallback(async (path: string): Promise<string | null> => {
    if (!agentId || !conversationId) return null;
    const fsNamespace = JSON.stringify([agentId, conversationId, "filesystem"]);
    return fetchEphemeralFileContent(fsNamespace, path);
  }, [agentId, conversationId]);

  // Download chat handler
  const handleDownloadChat = useCallback(() => {
    if (!conversation) return;

    // Build export object, omitting MongoDB-specific fields
    const exportData = {
      exportedAt: new Date().toISOString(),
      conversationId,
      title: conversation.title,
      agent: {
        id: agentId,
        name: agent?.name,
        model: agent?.model?.id,
        visibility: agent?.visibility,
      },
      messages: conversation.messages?.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        streamEvents: m.streamEvents,
        feedback: m.feedback,
      })),
      streamEvents: conversation.streamEvents,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };

    // Create and trigger download
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `chat-${conversationId?.slice(0, 8)}-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [conversation, conversationId, agentId, agent]);

  const handleRestartRuntime = useCallback(async () => {
    if (!agentId || !conversationId || isRestarting) return;
    
    setIsRestarting(true);
    try {
      const response = await fetch("/api/dynamic-agents/chat/restart-runtime", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}),
        },
        body: JSON.stringify({
          agent_id: agentId,
          conversation_id: conversationId,
        }),
      });
      
      if (response.ok) {
        // Clear SSE events on restart
        if (conversationId) clearStreamEvents(conversationId);
        // Show restart notification
        setRuntimeRestarted(true);
        // Clear notification after a few seconds
        setTimeout(() => setRuntimeRestarted(false), 5000);
      } else {
        console.error("Failed to restart runtime:", await response.text());
      }
    } catch (error) {
      console.error("Failed to restart runtime:", error);
    } finally {
      setIsRestarting(false);
    }
  }, [agentId, conversationId, session?.accessToken, isRestarting, clearStreamEvents]);

  return (
    <div
      className="relative h-full flex flex-col bg-card/20 backdrop-blur-sm overflow-hidden"
      aria-label="Chat workspace"
    >
      {/* Header - only show when expanded */}
      {!collapsed && (
        <div className="border-b border-border/50">
          <div className="flex items-center py-2 justify-between px-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <PanelRightOpen className="h-4 w-4 text-primary" />
              Workspace
            </div>

            {onCollapse && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onCollapse(true)}
                className="h-8 w-8 hover:bg-muted shrink-0"
                aria-label="Collapse workspace panel"
                aria-expanded={!collapsed}
              >
                <PanelRightClose className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Content */}
      {!collapsed && (
        <Tabs value={coordinationEnabled ? activeTab : "info"} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
          <TabsList aria-label="Workspace views" className={cn("mx-2 mt-2 grid h-auto shrink-0", coordinationEnabled ? "grid-cols-2" : "grid-cols-1")}>
            <TabsTrigger value="coordination" aria-label="Agent coordination" className={cn("flex-col gap-0.5 whitespace-normal px-2 text-xs", !coordinationEnabled && "hidden")}><span>Agent coordination</span><Badge variant="secondary" className="px-1 py-0 text-[10px]">Experimental</Badge></TabsTrigger>
            <TabsTrigger value="info" className="whitespace-normal px-2 text-xs">Agent info</TabsTrigger>
          </TabsList>
        <ScrollArea className="flex-1">
          <div className="p-3 space-y-4">
            {/* Agent Not Found Warning */}
            {agentNotFound && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-lg border-2 border-amber-500/60 bg-gradient-to-br from-amber-500/15 to-orange-600/10 p-4 shadow-lg shadow-amber-500/10"
              >
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-full bg-amber-500/20 shrink-0">
                    <Trash2 className="h-5 w-5 text-amber-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-amber-400 mb-1">
                      Agent No Longer Exists
                    </p>
                    <p className="text-xs text-amber-300/80 leading-relaxed">
                      This agent has been deleted. You can view the conversation history, but new messages cannot be sent.
                    </p>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Runtime Restarted Notification */}
            {runtimeRestarted && (
              <motion.div
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-lg border-2 border-blue-500/60 bg-gradient-to-br from-blue-500/15 to-blue-600/10 p-3 shadow-lg shadow-blue-500/10"
              >
                <div className="flex items-start gap-2.5">
                  <div className="p-1.5 rounded-full bg-blue-500/20 shrink-0">
                    <RefreshCw className="h-4 w-4 text-blue-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-blue-500 uppercase tracking-wide mb-1.5">
                      Runtime Restarted
                    </p>
                    <p className="text-sm text-blue-300 leading-relaxed">
                      Send a message to create the runtime and reconnect to MCP servers.
                    </p>
                  </div>
                </div>
              </motion.div>
            )}

            <TabsContent value="coordination" className="mt-0 space-y-4">
            {coordination && <div className="space-y-2">
              <AddChatAgentDialog coordination={coordination} disabled={readOnly || isStreaming || coordination.loading} />
              {coordination.error ? <div role="alert" className="text-xs text-destructive">{coordination.error}<Button size="sm" variant="ghost" onClick={() => void coordination.refresh()}>Retry</Button></div>
                : !coordination.loading && !coordination.canManage ? <p className="text-xs text-muted-foreground">Ask the chat owner to add agents. Each person still needs agent Use access.</p>
                : !coordination.loading && !coordination.available ? <p className="text-xs text-muted-foreground">Configure Harness Engine to add chat agents.</p> : null}
            </div>}
            {coordination?.agents.length ? <div className="space-y-2">
              <div className="flex items-center gap-1">
                <p className="text-xs font-medium">How agents respond</p>
                <TooltipProvider delayDuration={0}><Tooltip open={coordinationInfoOpen} onOpenChange={setCoordinationInfoOpen}>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" aria-label="About coordination modes" aria-describedby={`${sectionId}-mode-info`} onClick={() => setCoordinationInfoOpen(true)} onKeyDown={event => { if (event.key === "Escape") setCoordinationInfoOpen(false); }}>
                      <Info className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="max-w-xs whitespace-normal text-left text-xs font-normal leading-relaxed">
                    <p id={`${sectionId}-mode-info`}>{coordination.mode === "team" ? "Agents can hand tasks to joined agents using the chat owner’s access while that sign-in remains valid. Only the assignment is shared. Up to 8 tasks and 4 hops per chain. Turn this off to stop queued handoffs; use Stop for an active response." : "Agents respond when addressed. Team coordination enables agent-to-agent handoffs."}</p>
                  </TooltipContent>
                </Tooltip></TooltipProvider>
              </div>
              <div className="grid gap-2" role="group" aria-label="How agents respond">
                {([
                  { mode: "mentions", label: "Mentions", description: "You choose which agent responds." },
                  { mode: "team", label: "Team coordination", description: "Agents can also hand tasks to each other." },
                ] as const).map(option => {
                  const selected = (coordination.mode ?? "mentions") === option.mode;
                  const unavailable = option.mode === "team" && coordination.teamAvailable === false;
                  const Icon = selected ? CheckCircle2 : Circle;
                  return <Button key={option.mode} type="button" variant="outline" aria-pressed={selected}
                    aria-label={option.label} aria-describedby={`${sectionId}-mode-${option.mode}`}
                    disabled={!coordination.canManage || isStreaming || coordination.loading || unavailable}
                    onClick={() => void coordination.setMode?.(option.mode)}
                    className={cn("h-auto min-h-16 w-full justify-start gap-3 whitespace-normal rounded-lg px-3 py-2.5 text-left", selected
                      ? "border-blue-500 bg-blue-50 text-blue-950 hover:bg-blue-100 hover:text-blue-950 dark:border-blue-400 dark:bg-blue-500/20 dark:text-blue-100 dark:hover:bg-blue-500/25 dark:hover:text-blue-100"
                      : "border-border bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground")}>
                    <Icon className={cn("h-4 w-4", selected && "text-blue-600 dark:text-blue-300")} aria-hidden="true" />
                    <span className="min-w-0"><span className="block text-xs font-semibold">{option.label}</span>
                      <span id={`${sectionId}-mode-${option.mode}`} className={cn("mt-0.5 block text-[11px] font-normal leading-relaxed", selected ? "text-blue-800 dark:text-blue-200" : "text-muted-foreground")}>
                        {unavailable ? "Disabled by your administrator." : option.description}
                      </span>
                    </span>
                  </Button>;
                })}
              </div>
            </div> : null}
            {!!coordination?.handoffs?.length && <div className="space-y-2 border-b pb-3"><p className="text-xs font-medium">Recent handoffs</p>{coordination.handoffs.map(job => <div key={job._id} className="text-xs"><span className={agentMentionColor(job.handle, coordination.agents.map(member => member.handle))}>@{job.handle}</span><span className="ml-2">{job.status === "delivered" ? "Completed" : job.status === "pending" || job.status === "processing" ? job.runId ? "Working" : "Queued" : job.status}</span>{job.lastError && job.lastError !== "retrying" && <p className="text-muted-foreground">{job.lastError.replaceAll("_", " ")}</p>}</div>)}</div>}
            <WorkspaceSection id={`${sectionId}-agents`} title="Agents" icon={<Users className="h-4 w-4" />} expanded={openSections.includes("agents")} onToggle={() => toggleSection("agents")}>
              <div className="flex min-w-0 items-center gap-2">
                <AgentAvatar agent={agent} agentId={agentId} rounded="rounded-lg" size="h-8 w-8" iconSize="h-4 w-4" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="min-w-0 truncate text-sm font-medium">{agent?.name || "Chat agent"}</p>
                    {agent && <AgentHarnessBadge compact harnessId={agent.execution_harness_id} presentation={agent.presentation} />}
                  </div>
                  <p className="text-xs text-muted-foreground">{!!coordination?.agents.length && <><span className={agentMentionColor("primary", [])}>@primary</span><span aria-hidden="true"> · </span></>}{isStreaming && activeAgentId === agentId ? "Responding" : "Primary agent"}</p>
                </div>
              </div>
              {!!coordination?.agents.length && <div className="space-y-3 pt-1">
                {coordination.agents.map(member => {
                  const participant = coordination.availableAgents.find(candidate => candidate._id === member.agent_id);
                  const responding = isStreaming && activeAgentId === member.agent_id;
                  return <div key={member.agent_id} className="flex min-w-0 items-center gap-2">
                    <AgentAvatar agent={participant} agentId={member.agent_id} rounded="rounded-lg" size="h-8 w-8" iconSize="h-4 w-4" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="min-w-0 truncate text-sm font-medium" title={member.name}>{member.name}</p>
                        {participant && <AgentHarnessBadge compact harnessId={participant.execution_harness_id} presentation={participant.presentation} />}
                      </div>
                      <p className="text-xs text-muted-foreground"><span className={agentMentionColor(member.handle, coordination.agents.map(agent => agent.handle))}>@{member.handle}</span><span aria-hidden="true"> · </span>{responding ? "Responding" : participant ? "Joined agent" : "Agent access required"}</p>
                    </div>
                  </div>;
                })}
              </div>}

              {agent?.subagents?.map((subagent) => <div key={subagent.agent_id} className="flex min-w-0 gap-2">
                <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /><div className="min-w-0"><p className="break-words text-xs font-medium">{subagent.name}</p><p className="text-xs text-muted-foreground">Configured subagent</p></div>
              </div>)}
              {subagentRuns.length > 0 && <div className="space-y-2 border-t pt-2"><p className="text-xs text-muted-foreground">Latest turn delegations</p>{subagentRuns.map((run) => <div key={run.id} className="text-xs"><p className="break-words font-medium">{run.info.name}</p><p className="text-muted-foreground">{run.info.status === "running" && !isStreaming ? "Completion unconfirmed" : run.info.status}</p></div>)}</div>}
              <p className="text-xs text-muted-foreground">Chat sharing does not grant agent or tool access.</p>
            </WorkspaceSection>
            <WorkspaceSection id={`${sectionId}-coordination`} title="Tasks" icon={<ListTodo className="h-4 w-4" />} expanded={openSections.includes("coordination")} onToggle={() => toggleSection("coordination")}>
              {tasks.length ? <TaskList tasks={tasks} readonly /> : <p className="text-xs text-muted-foreground">No task list published yet.</p>}
            </WorkspaceSection>
            <WorkspaceSection id={`${sectionId}-files`} title="Workspace files" icon={<FolderOpen className="h-4 w-4" />} expanded={showFiles} onToggle={() => toggleSection("files")}>
              <p className="text-xs text-muted-foreground">Files published to this conversation. This does not browse a remote sandbox&apos;s full filesystem.</p>
              <Button variant="ghost" size="sm" disabled={isLoadingFiles} onClick={() => setFilesRefreshKey((key) => key + 1)}><RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" />Refresh files</Button>
              {isLoadingFiles ? <p role="status" className="text-xs text-muted-foreground">Loading files…</p> : filesError ? <p role="alert" className="text-xs text-destructive">{filesError}</p> : files.length ? <FileTree key={`${agentId}:${conversationId}`} compact files={files} getFileContent={handleGetFileContent} onFileClick={handleFileDownload} /> : <p className="text-xs text-muted-foreground">No files published yet.</p>}
            </WorkspaceSection>
            </TabsContent>
            <TabsContent value="info" className="mt-0">
            <AgentInfoContent
              agent={agent}
              subagentTools={subagentTools}
              agentId={agentId}
              sessionId={conversationId}
              onRestartRuntime={readOnly ? undefined : handleRestartRuntime}
              isRestarting={isRestarting}
              agentNotFound={agentNotFound}
              onDownloadChat={handleDownloadChat}
              hasMessages={!!conversation?.messages?.length}
              contextUsage={showContextUsage ? contextUsage : undefined}
              reasoningEffort={effectiveReasoningEffort}
              hasReasoningEffortOverride={hasConversationEffortOverride}
            />
            </TabsContent>
          </div>
        </ScrollArea>
        </Tabs>
      )}

      {/* Collapsed state - clickable area to expand */}
      {collapsed && onCollapse && (
        <div className="flex flex-row items-center gap-2 py-1 md:flex-col md:py-2">
          <Button variant="ghost" size="icon" aria-label="Expand workspace panel" aria-expanded={false} onClick={() => onCollapse(false)}><PanelRightOpen className="h-4 w-4" /></Button>
          {[{ id: "agents", label: "Open agents", icon: Users }, { id: "coordination", label: "Open coordination", icon: ListTodo }, { id: "files", label: "Open workspace files", icon: FolderOpen }, { id: "context", label: "Open context and agent details", icon: NotebookText }].filter(({ id }) => coordinationEnabled || id === "context").map(({ id, label, icon: Icon }) => <Button key={id} variant="ghost" size="icon" aria-label={label} title={label} onClick={() => openSection(id)}><Icon className="h-4 w-4" /></Button>)}
        </div>
      )}
    </div>
  );
}

function WorkspaceSection({ id, title, icon, expanded, onToggle, children }: {
  id: string; title: string; icon: ReactNode; expanded: boolean; onToggle: () => void; children: ReactNode;
}) {
  return <section aria-labelledby={`${id}-heading`} className="border-b border-border/50 pb-3">
    <button id={`${id}-heading`} type="button" aria-expanded={expanded} aria-controls={id} onClick={onToggle} className="flex w-full items-center gap-2 rounded px-1 py-2 text-left text-sm font-medium hover:bg-muted/50">
      <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", !expanded && "-rotate-90")} aria-hidden="true" />{icon}<span>{title}</span>
    </button>
    <div id={id} hidden={!expanded} className="space-y-3 px-1 pt-2">{children}</div>
  </section>;
}

// ═══════════════════════════════════════════════════════════════
// Agent Info Content
// ═══════════════════════════════════════════════════════════════

interface AgentInfoContentProps {
  agent?: DynamicAgentConfig | null;
  /** Map of subagent agent_id -> their allowed_tools config */
  subagentTools?: Record<string, Record<string, string[]>>;
  /** Agent ID for restart runtime */
  agentId?: string;
  /** Session ID for restart runtime */
  sessionId?: string;
  /** Callback to restart the runtime */
  onRestartRuntime?: () => void;
  /** Whether a restart is in progress */
  isRestarting?: boolean;
  /** Whether the agent has been deleted */
  agentNotFound?: boolean;
  /** Callback to download chat as JSON */
  onDownloadChat?: () => void;
  /** Whether there are messages to download */
  hasMessages?: boolean;
  /** File browser state */
  showFiles?: boolean;
  files?: string[];
  isLoadingFiles?: boolean;
  onToggleFiles?: () => void;
  onFileDownload?: (path: string) => void;
  getFileContent?: (path: string) => Promise<string | null>;
  contextUsage?: ContextUsageEventData;
  reasoningEffort: string;
  hasReasoningEffortOverride: boolean;
}

function AgentInfoContent({
  agent,
  subagentTools,
  agentId,
  sessionId,
  onRestartRuntime,
  isRestarting,
  agentNotFound,
  onDownloadChat,
  hasMessages,
  showFiles,
  files = [],
  isLoadingFiles,
  onToggleFiles,
  onFileDownload,
  getFileContent,
  contextUsage,
  reasoningEffort,
  hasReasoningEffortOverride,
}: AgentInfoContentProps) {
  // Count total tools across all MCP servers
  const toolCount = agent?.allowed_tools
    ? Object.entries(agent.allowed_tools).reduce((sum, [, tools]) => {
        if (tools === false) return sum;
        if (tools === true) return sum + 1;
        return sum + (tools.length > 0 ? tools.length : 1);
      }, 0)
    : 0;

  const serverCount = agent?.allowed_tools
    ? Object.entries(agent.allowed_tools).filter(([, v]) => v !== false).length
    : 0;

  // Format visibility for display
  const visibilityDisplay = agent?.visibility
    ? agent.visibility.charAt(0).toUpperCase() + agent.visibility.slice(1)
    : "Private";

  return (
    <div className="space-y-4">
      {/* Agent header */}
      <div className="flex items-center gap-3">
        <AgentAvatar
          agent={agent}
          rounded="rounded-full"
          size="w-10 h-10"
          iconSize="h-5 w-5"
        />
        <div className="min-w-0">
          <h3 className="font-semibold truncate">{agent?.name || "Agent Builder"}</h3>
          <p className="text-xs text-muted-foreground">Agent Builder</p>
        </div>
      </div>

      {/* Description */}
      {agent?.description && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Description
          </h4>
          <p className="text-sm text-foreground/80 leading-relaxed">
            {agent.description}
          </p>
        </div>
      )}

      {/* Agent details */}
      <div className="space-y-2 pt-2 border-t border-border/50">
        <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Configuration
        </h4>

        <div className="grid grid-cols-2 gap-2 text-sm">
          {/* Model */}
          <div className="space-y-0.5">
            <span className="text-xs text-muted-foreground">Model</span>
            <p className="font-medium truncate" title={agent?.model?.id || "Default"}>
              {agent?.model?.id || "Default"}
            </p>
          </div>

          {/* Visibility */}
          <div className="space-y-0.5">
            <span className="text-xs text-muted-foreground">Visibility</span>
            <p className="font-medium">{visibilityDisplay}</p>
          </div>

          <div className="space-y-0.5">
            <span className="text-xs text-muted-foreground">Reasoning effort</span>
            <p className="font-medium capitalize">{reasoningEffort}</p>
            <p className="text-[10px] text-muted-foreground">
              {hasReasoningEffortOverride ? "Chat override" : "Agent default"}
            </p>
          </div>

          {/* MCP Servers */}
          <div className="space-y-0.5">
            <span className="text-xs text-muted-foreground">MCP Servers</span>
            <p className="font-medium">{serverCount}</p>
          </div>

          {/* Tools */}
          <div className="space-y-0.5">
            <span className="text-xs text-muted-foreground">Tools</span>
            <p className="font-medium">
              {serverCount > 0
                ? toolCount > 0
                  ? `${toolCount}+`
                  : "All"
                : "None"}
            </p>
          </div>

          {/* Skills */}
          <div className="space-y-0.5">
            <span className="text-xs text-muted-foreground">Skills</span>
            <p className="font-medium">{agent?.skills?.length || 0}</p>
          </div>

          {/* Conversation ID */}
          {sessionId && (
            <div className="space-y-0.5 col-span-2">
              <span className="text-xs text-muted-foreground">Conversation ID</span>
              <p className="font-mono text-xs truncate" title={sessionId}>
                {sessionId}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* MCP Server list */}
      {serverCount > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Server className="h-3.5 w-3.5" />
            MCP Servers
          </h4>
          <div className="space-y-1">
            {Object.keys(agent?.allowed_tools || {}).map((serverId) => (
              <div
                key={serverId}
                className="flex items-center gap-2 text-xs px-2 py-1.5 rounded font-mono bg-muted/30 border border-border/50"
              >
                <span className="truncate">{serverId}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Configured Subagents */}
      {agent?.subagents && agent.subagents.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Configured Subagents
          </h4>
          <div className="space-y-1.5">
            {agent.subagents.map((subagent) => {
              const subTools = subagentTools?.[subagent.agent_id];
              const subServerIds = subTools ? Object.keys(subTools) : [];
              return (
                <div
                  key={subagent.agent_id}
                  className="rounded-lg border border-border/50 bg-muted/30 p-2"
                >
                  <div className="flex items-center gap-2">
                    <Bot className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                    <span className="text-xs font-medium truncate" title={subagent.name}>
                      {subagent.name}
                    </span>
                  </div>
                  {subagent.description && (
                    <p className="text-[10px] text-muted-foreground mt-1 pl-5.5 line-clamp-2">
                      {subagent.description}
                    </p>
                  )}
                  {subServerIds.length > 0 && (
                    <div className="mt-1.5 pl-5.5 space-y-1">
                      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                        <Server className="h-3 w-3" />
                        <span>{subServerIds.length} MCP Server{subServerIds.length !== 1 ? "s" : ""}</span>
                      </div>
                      <div className="space-y-0.5">
                        {subServerIds.map((serverId) => (
                          <div
                            key={serverId}
                            className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-muted/50 border border-border/30 truncate"
                            title={serverId}
                          >
                            {serverId}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Context Section */}
      {contextUsage && (
        <div className="space-y-2 pt-2 border-t border-border/50">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Context
          </h4>
          <ContextUsageDetails usage={contextUsage} />
        </div>
      )}

      {/* Advanced Section */}
      {agentId && sessionId && onRestartRuntime && (
        <div className="space-y-2 pt-2 border-t border-border/50">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Advanced
          </h4>
          <div className="space-y-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onRestartRuntime}
              disabled={isRestarting || agentNotFound || agent?.enabled === false}
              className="w-full justify-center gap-2 text-xs"
            >
              {isRestarting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {isRestarting ? "Refreshing..." : "Refresh Agent Session"}
            </Button>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              This will refresh the session, checking for any new updates to the agent and refreshing connections to MCP servers. Chat history will not be affected.
            </p>
            
          </div>
        </div>
      )}

            {/* Export is available to readers independently of runtime control. */}
            {onDownloadChat && (
              <Button
                variant="outline"
                size="sm"
                onClick={onDownloadChat}
                disabled={!hasMessages}
                className="w-full justify-center gap-2 text-xs"
              >
                <Download className="h-3.5 w-3.5" />
                Download Chat
              </Button>
            )}
      {/* Files Section */}
      {onToggleFiles && (
        <div className="space-y-2 pt-2 border-t border-border/50">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <FolderOpen className="h-3.5 w-3.5" />
            Files
          </h4>
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleFiles}
            className={cn("w-full justify-center gap-2 text-xs", showFiles && "bg-muted")}
          >
            {isLoadingFiles ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderOpen className="h-3.5 w-3.5" />
            )}
            {showFiles ? "Hide Files" : "Show Files"}
            {files.length > 0 && (
              <span className="text-[10px] text-muted-foreground">({files.length})</span>
            )}
          </Button>
          {showFiles && (
            <div className="mt-2">
              {files.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No files created yet.</p>
              ) : (
                <FileTree
                  files={files}
                  getFileContent={getFileContent}
                  onFileClick={onFileDownload}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
