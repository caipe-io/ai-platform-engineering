"use client";

// assisted-by Codex Codex-sonnet-4-6

import { AgentAvatar } from "@/components/dynamic-agents/AgentAvatar";
import { FileTree } from "@/components/dynamic-agents/FileTree";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { fetchEphemeralFileContent } from "@/lib/ephemeral-files";
import { useChatStore } from "@/store/chat-store";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { motion } from "framer-motion";
import {
Bot,
ChevronLeft,
Download,
FolderOpen,
Info,
Loader2,
RefreshCw,
Server,
Trash2,
} from "lucide-react";
import { useSession } from "next-auth/react";
import { useCallback,useEffect,useState } from "react";
import { useShallow } from "zustand/react/shallow";

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
}

/**
 * Simplified context panel for Dynamic Agents.
 * Shows agent info only - todos/files are shown in the main chat panel.
 */
export function DynamicAgentContext({
  conversationId,
  agentId,
  agent,
  agentNotFound,
  collapsed = false,
  onCollapse,
}: DynamicAgentContextProps) {
  const { data: session } = useSession();
  const { clearStreamEvents, conversations } = useChatStore(
    useShallow((s) => ({
      clearStreamEvents: s.clearStreamEvents,
      conversations: s.conversations,
    }))
  );

  // Get current conversation for download
  const conversation = conversations.find((c) => c.id === conversationId);

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
  const [showFiles, setShowFiles] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);

  const handleToggleFiles = useCallback(async () => {
    if (showFiles) {
      setShowFiles(false);
      return;
    }
    if (!agentId || !conversationId) return;

    setShowFiles(true);
    setIsLoadingFiles(true);
    try {
      const fsNamespace = JSON.stringify([agentId, conversationId, "filesystem"]);
      const res = await fetch(`/api/files/list?fs_namespace=${encodeURIComponent(fsNamespace)}`);
      if (res.ok) {
        const data = await res.json();
        setFiles(data.files || []);
      }
    } catch {
      // ignore
    } finally {
      setIsLoadingFiles(false);
    }
  }, [showFiles, agentId, conversationId]);

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
      className="relative h-full flex flex-col bg-card/30 backdrop-blur-sm border-l border-border/50 overflow-hidden"
    >
      {/* Header - only show when expanded */}
      {!collapsed && (
        <div className="border-b border-border/50">
          <div className="flex items-center py-2 justify-between px-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Info className="h-4 w-4 text-blue-400" />
              Agent Info
            </div>

            {onCollapse && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onCollapse(true)}
                className="h-8 w-8 hover:bg-muted shrink-0"
              >
                <ChevronLeft className="h-4 w-4 rotate-180" />
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Content */}
      {!collapsed && (
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

            <AgentInfoContent
              agent={agent}
              subagentTools={subagentTools}
              agentId={agentId}
              sessionId={conversationId}
              onRestartRuntime={handleRestartRuntime}
              isRestarting={isRestarting}
              agentNotFound={agentNotFound}
              onDownloadChat={handleDownloadChat}
              hasMessages={!!conversation?.messages?.length}
              showFiles={showFiles}
              files={files}
              isLoadingFiles={isLoadingFiles}
              onToggleFiles={handleToggleFiles}
              onFileDownload={handleFileDownload}
              getFileContent={handleGetFileContent}
            />
          </div>
        </ScrollArea>
      )}

      {/* Collapsed state - clickable area to expand */}
      {collapsed && onCollapse && (
        <button
          onClick={() => onCollapse(false)}
          className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
        >
          {/* Small agent avatar */}
          <AgentAvatar
            agent={agent}
            rounded="rounded-full"
            size="w-8 h-8"
            iconSize="h-4 w-4"
          />
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
    </div>
  );
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
            
            {/* Download Chat Button */}
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
          </div>
        </div>
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
