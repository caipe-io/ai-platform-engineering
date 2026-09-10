"use client";

// assisted-by Codex Codex-sonnet-4-6

import { NewChatButton } from "@/components/chat/NewChatButton";
import { ConversationListSkeleton } from "@/components/chat/ConversationListSkeleton";
import { RecycleBinDialog } from "@/components/chat/RecycleBinDialog";
import { ShareButton } from "@/components/chat/ShareButton";
import { UseCaseBuilderDialog } from "@/components/gallery/UseCaseBuilder";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { autonomousApi } from "@/components/autonomous/api";
import type { AutonomousTask } from "@/components/autonomous/types";
import { Tooltip,TooltipContent,TooltipProvider,TooltipTrigger } from "@/components/ui/tooltip";
import { resolveUsableChatAgentId } from "@/lib/chat-agent-selection";
import { getErrorMessage } from "@/lib/error-utils";
import { getStorageMode } from "@/lib/storage-config";
import { cn,formatDate,truncateText } from "@/lib/utils";
import { useChatStore } from "@/store/chat-store";
import type { Conversation } from "@/types/a2a";
import { getAgentId } from "@/types/a2a";
import { AnimatePresence,motion } from "framer-motion";
import {
Archive,
ArchiveRestore,
Check,
ChevronLeft,
ChevronRight,
Database,
HardDrive,
History,
MessageCircleQuestion,
MessageSquare,
Pencil,
Plus,
Radio,
RefreshCw,
Shield,
Sparkles,
TrendingUp,
Users,
Webhook,
X
} from "lucide-react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useState,
  useTransition,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

interface SidebarProps {
  activeTab: "chat" | "gallery" | "knowledge" | "admin";
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  onUseCaseSaved?: () => void;
}

interface ConversationTitleBadge {
  kind: "autonomous" | "scheduled";
  label: string;
  title: string;
}

type ConversationSectionId = "autonomous" | "webhook" | "scheduled" | "history";

type ConversationListItem =
  | {
      kind: "conversation";
      conversation: Conversation;
    }
  | {
      kind: "section";
      id: ConversationSectionId;
      label: string;
      count: number;
      expanded?: boolean;
      onToggle?: () => void;
      nested?: boolean;
    }
  | {
      kind: "webhook-task";
      task: AutonomousTask;
    };

function getAutonomousBadge(conv: Conversation): ConversationTitleBadge | null {
  if (conv.source !== "autonomous") return null;

  const metadataTaskName = conv.metadata?.task_name;
  const titleTaskName = conv.title.replace(/^\[Autonomous\]\s*/i, "").trim();
  const taskId = conv.task_id?.trim();
  const label =
    typeof metadataTaskName === "string" && metadataTaskName.trim()
      ? metadataTaskName.trim()
      : titleTaskName || taskId || "Autonomous";

  return {
    kind: "autonomous",
    label,
    title: taskId ? `Autonomous task ${taskId}: ${label}` : `Autonomous task: ${label}`,
  };
}

function getScheduleBadge(conv: Conversation): ConversationTitleBadge | null {
  const scheduleId = conv.metadata?.schedule_id;
  const scheduleTitle = conv.metadata?.schedule_title;
  if (typeof scheduleTitle === "string" && scheduleTitle.trim()) {
    const label = scheduleTitle.trim();
    return {
      kind: "scheduled",
      label,
      title: typeof scheduleId === "string" && scheduleId.trim()
        ? `Scheduled run ${scheduleId.trim()}: ${label}`
        : `Scheduled run: ${label}`,
    };
  }

  if (typeof scheduleId === "string" && scheduleId.trim()) {
    const label = scheduleId.trim();
    return { kind: "scheduled", label, title: `Scheduled run ${label}` };
  }

  const legacyMatch = conv.id.match(/sched_[a-z0-9]+/i);
  if (!legacyMatch) return null;

  return {
    kind: "scheduled",
    label: legacyMatch[0],
    title: `Scheduled run ${legacyMatch[0]}`,
  };
}

function getConversationRunKind(
  conv: Conversation,
): ConversationTitleBadge["kind"] | null {
  if (getAutonomousBadge(conv)) return "autonomous";
  if (getScheduleBadge(conv)) return "scheduled";
  return null;
}

export function Sidebar({ activeTab, collapsed, onCollapse, onUseCaseSaved }: SidebarProps) {
  const router = useRouter();
  const {
    conversations,
    activeConversationId,
    setActiveConversation,
    createConversation,
    deleteConversation,
    updateConversationTitle,
    loadConversationsFromServer,
    loadMessagesFromServer,
    isConversationStreaming,
    hasUnviewedMessages,
    isConversationInputRequired,
  } = useChatStore();
  const { data: session } = useSession();
  const [useCaseBuilderOpen, setUseCaseBuilderOpen] = useState(false);
  const storageMode = getStorageMode(); // Exclusive storage mode
  const [isLoadingConversations, setIsLoadingConversations] = useState(
    activeTab === "chat" && storageMode === "mongodb",
  );
  const [, startTransition] = useTransition();
  const [sidebarWidth, setSidebarWidth] = useState(320); // Track sidebar width
  const [isResizing, setIsResizing] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [renameSavingId, setRenameSavingId] = useState<string | null>(null);
  const [autonomousRunsExpanded, setAutonomousRunsExpanded] = useState(false);
  const [webhookRunsExpanded, setWebhookRunsExpanded] = useState(false);
  const [scheduledRunsExpanded, setScheduledRunsExpanded] = useState(false);
  const [webhookTasks, setWebhookTasks] = useState<AutonomousTask[]>([]);
  const { toast } = useToast();

  // Agent name lookup for dynamic agent conversations
  const [agentNameMap, setAgentNameMap] = useState<Record<string, string>>({});
  const [agentNamesLoading, setAgentNamesLoading] = useState(true);

  // Load conversations from server when sidebar mounts (MongoDB mode only)
  // Also re-sync when tab becomes visible (user switches back from another browser/tab)
  useEffect(() => {
    let cancelled = false;
    if (activeTab === "chat" && storageMode === 'mongodb') {
      // Always load from server - the loadConversationsFromServer function
      // will merge server data with local cache intelligently
      setIsLoadingConversations(true);
      void loadConversationsFromServer()
        .catch((error) => {
          console.error('[Sidebar] Failed to load conversations:', error);
        })
        .finally(() => {
          if (!cancelled) setIsLoadingConversations(false);
        });
    } else {
      setIsLoadingConversations(false);
    }

    // Re-sync when user returns to this tab (catches cross-browser deletes)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && activeTab === "chat" && storageMode === 'mongodb') {
        console.log('[Sidebar] Tab became visible, re-syncing conversations');
        loadConversationsFromServer().catch((error) => {
          console.error('[Sidebar] Failed to re-sync conversations:', error);
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, storageMode]); // Intentionally exclude loadConversationsFromServer to prevent re-runs

  // Fetch dynamic agents for name lookup in conversation list
  useEffect(() => {
    let cancelled = false;
    const fetchAgents = async () => {
      try {
        const response = await fetch("/api/dynamic-agents/available");
        const data = await response.json();
        if (!cancelled && data.success && Array.isArray(data.data)) {
          const map: Record<string, string> = {};
          data.data.forEach((agent: { _id: string; name: string }) => {
            map[agent._id] = agent.name;
          });
          setAgentNameMap(map);
        }
      } catch (err) {
        console.error('[Sidebar] Failed to fetch agents for name lookup:', err);
      } finally {
        if (!cancelled) setAgentNamesLoading(false);
      }
    };
    void fetchAgents();
    return () => {
      cancelled = true;
    };
  }, []);

  // Webhook runs are intentionally not mirrored into normal chat
  // conversations. Load the caller's webhook task summaries separately so the
  // sidebar can expose one stable task timeline without one row per delivery.
  useEffect(() => {
    let cancelled = false;
    const ownerEmail = session?.user?.email?.trim().toLowerCase();
    if (activeTab !== "chat" || !ownerEmail) {
      setWebhookTasks([]);
      return;
    }

    void autonomousApi
      .listTasks()
      .then((tasks) => {
        if (cancelled) return;
        setWebhookTasks(
          tasks.filter(
            (task) =>
              task.trigger.type === "webhook" &&
              task.owner_id?.trim().toLowerCase() === ownerEmail,
          ),
        );
      })
      .catch(() => {
        // Autonomous may be disabled or unavailable. Conversation history
        // remains usable; simply omit the optional webhook subsection.
        if (!cancelled) setWebhookTasks([]);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, session?.user?.email]);

  // Handle mouse move for resizing
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      
      const newWidth = Math.max(320, Math.min(500, e.clientX));
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isResizing]);

  const handleReloadConversations = async () => {
    if (isReloading) return;
    setIsReloading(true);
    try {
      console.log('[Sidebar] Manual reload triggered');
      await loadConversationsFromServer();
      // Also force-reload the active conversation's messages to pick up
      // follow-up messages from other devices and refresh stream events
      if (activeConversationId) {
        await loadMessagesFromServer(activeConversationId, { force: true });
      }
    } catch (error) {
      console.error('[Sidebar] Failed to reload conversations:', error);
    } finally {
      setIsReloading(false);
    }
  };

  const handleNewChat = async (agentId?: string) => {
    let resolvedAgentId: string | null = null;
    try {
      resolvedAgentId = agentId?.trim() || await resolveUsableChatAgentId();

      if (storageMode === 'mongodb') {
        // MongoDB mode: Create conversation on server
        const { apiClient } = await import('@/lib/api-client');
        const result = await apiClient.createConversation({
          title: "New Conversation",
          client_type: 'webui',
          agent_id: resolvedAgentId,
        });
        const conversation = result.conversation;

        // Add to local store immediately
        const newConversation: Conversation = {
          id: conversation._id,
          title: conversation.title,
          createdAt: new Date(conversation.created_at),
          updatedAt: new Date(conversation.updated_at),
          messages: [],
          streamEvents: [], // Stream events for Dynamic Agents
          participants: conversation.participants || [],
          metadata: conversation.metadata,
        };

        // Update store and wait for it to propagate
        useChatStore.setState((state) => ({
          conversations: [newConversation, ...state.conversations],
          activeConversationId: conversation._id,
        }));

        // Small delay to ensure store update propagates before navigation
        await new Promise(resolve => setTimeout(resolve, 0));

        // Use React transition for smooth navigation
        startTransition(() => {
          router.push(`/chat/${conversation._id}`);
        });
      } else {
        // Create conversation in localStorage
        const conversationId = await createConversation(resolvedAgentId);

        // Use React transition for smooth navigation
        startTransition(() => {
          router.push(`/chat/${conversationId}`);
        });
      }
    } catch (error) {
      console.error('[Sidebar] Failed to create conversation:', error);
      const message =
        error instanceof Error ? error.message : "Failed to create a chat conversation";
      toast(message, "error");

      if (storageMode !== 'mongodb' && resolvedAgentId) {
        const conversationId = await createConversation(resolvedAgentId);
        startTransition(() => {
          router.push(`/chat/${conversationId}`);
        });
      }
    }
  };

  const beginTitleEdit = (event: ReactMouseEvent, conversation: Conversation) => {
    event.stopPropagation();
    setEditingConversationId(conversation.id);
    setEditingTitle(conversation.title || "");
  };

  const cancelTitleEdit = (event?: ReactMouseEvent) => {
    event?.stopPropagation();
    setEditingConversationId(null);
    setEditingTitle("");
    setRenameSavingId(null);
  };

  const commitTitleEdit = async (
    event: ReactMouseEvent | ReactKeyboardEvent,
    conversation: Conversation,
  ) => {
    event.stopPropagation();
    const nextTitle = editingTitle.trim();
    if (!nextTitle) return;

    if (nextTitle === conversation.title) {
      cancelTitleEdit();
      return;
    }

    setRenameSavingId(conversation.id);
    try {
      await updateConversationTitle(conversation.id, nextTitle);
      setEditingConversationId(null);
      setEditingTitle("");
    } finally {
      setRenameSavingId(null);
    }
  };

  const autonomousConversations = conversations.filter(
    (conversation) => getConversationRunKind(conversation) === "autonomous",
  );
  const scheduledConversations = conversations.filter(
    (conversation) => getConversationRunKind(conversation) === "scheduled",
  );
  const historyConversations = conversations.filter(
    (conversation) => getConversationRunKind(conversation) === null,
  );
  const conversationListItems: ConversationListItem[] = collapsed
    ? conversations.map((conversation) => ({ kind: "conversation", conversation }))
    : [
        {
          kind: "section",
          id: "autonomous",
          label: "Autonomous Runs",
          count: autonomousConversations.length + webhookTasks.length,
          expanded: autonomousRunsExpanded,
          onToggle: () => setAutonomousRunsExpanded((expanded) => !expanded),
        },
        ...(autonomousRunsExpanded
          ? autonomousConversations.map(
              (conversation): ConversationListItem => ({ kind: "conversation", conversation }),
            )
          : []),
        ...(autonomousRunsExpanded
          ? [
              {
                kind: "section" as const,
                id: "webhook" as const,
                label: "Webhook Runs",
                count: webhookTasks.length,
                expanded: webhookRunsExpanded,
                onToggle: () => setWebhookRunsExpanded((expanded) => !expanded),
                nested: true,
              },
              ...(webhookRunsExpanded
                ? webhookTasks.map(
                    (task): ConversationListItem => ({ kind: "webhook-task", task }),
                  )
                : []),
            ]
          : []),
        {
          kind: "section",
          id: "scheduled",
          label: "Scheduled Runs",
          count: scheduledConversations.length,
          expanded: scheduledRunsExpanded,
          onToggle: () => setScheduledRunsExpanded((expanded) => !expanded),
        },
        ...(scheduledRunsExpanded
          ? scheduledConversations.map(
              (conversation): ConversationListItem => ({ kind: "conversation", conversation }),
            )
          : []),
        {
          kind: "section",
          id: "history",
          label: "History",
          count: historyConversations.length,
        },
        ...historyConversations.map(
          (conversation): ConversationListItem => ({ kind: "conversation", conversation }),
        ),
      ];

  return (
    <motion.div
      initial={false}
      animate={{ width: collapsed ? 64 : sidebarWidth }}
      transition={{ duration: 0.2 }}
      className="relative flex flex-col h-full bg-card/50 backdrop-blur-sm border-r border-border/50 shrink-0 z-10"
    >
      {/* Resize Handle */}
      {!collapsed && (
        <div
          onMouseDown={() => setIsResizing(true)}
          className="absolute right-0 top-0 h-full w-1 hover:w-1.5 bg-transparent hover:bg-primary/50 cursor-col-resize transition-all z-20"
          title="Drag to resize sidebar"
        />
      )}
      {/* Collapse Toggle */}
      <div className="flex items-center justify-end p-2 h-12 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onCollapse(!collapsed)}
          className="h-8 w-8 hover:bg-muted shrink-0"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* New Chat Button */}
      {activeTab === "chat" && (
        <div className="px-2 pb-2 shrink-0">
          <NewChatButton
            collapsed={collapsed}
            onNewChat={handleNewChat}
          />
        </div>
      )}

      {/* Bottom-right indicators: Archive + Storage Mode */}
      {activeTab === "chat" && !collapsed && (
        <div className="absolute bottom-2 right-2 z-10 overflow-visible flex items-center gap-1.5">
          {/* Archive button — only in MongoDB mode */}
          {storageMode === 'mongodb' && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setRecycleBinOpen(true)}
                    className="p-1.5 rounded-md bg-muted/50 border border-border/50 hover:bg-muted transition-colors cursor-pointer"
                  >
                    <ArchiveRestore className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8}>
                  <p className="font-medium text-xs">Archive</p>
                  <p className="text-[10px] mt-0.5 opacity-70">Restore deleted conversations</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Storage Mode Indicator */}
          <TooltipProvider delayDuration={200}>
            {storageMode === 'localStorage' ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="p-1.5 rounded-md bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/20 transition-colors cursor-help">
                    <HardDrive className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8} className="bg-amber-600 dark:bg-amber-500 text-white border-amber-700">
                  <p className="font-medium">Local Storage Mode</p>
                  <p className="text-amber-100 text-[10px] mt-0.5">Browser-only • Not shareable</p>
                </TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="p-1.5 rounded-md bg-green-500/10 border border-green-500/20 hover:bg-green-500/20 transition-colors cursor-help">
                    <Database className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8} className="bg-green-600 dark:bg-green-500 text-white border-green-700">
                  <p className="font-medium">MongoDB Mode</p>
                  <p className="text-green-100 text-[10px] mt-0.5">Persistent • Shareable • Teams</p>
                </TooltipContent>
              </Tooltip>
            )}
          </TooltipProvider>
        </div>
      )}

      {/* Chat History */}
      {activeTab === "chat" && (
        <div className="flex-1 overflow-hidden flex flex-col min-w-0">
          <ScrollArea className="flex-1 min-w-0">
            <div className="px-2 space-y-1 pb-4">
              {isLoadingConversations && conversations.length === 0 ? (
                <ConversationListSkeleton collapsed={collapsed} />
              ) : (
                <AnimatePresence mode="popLayout">
                  {conversationListItems.map((item, index) => {
                  if (item.kind === "section") {
                    const sectionHeader = (
                      <>
                        {item.onToggle ? (
                          <ChevronRight
                            className={cn(
                              "h-3.5 w-3.5 shrink-0 transition-transform",
                              item.expanded && "rotate-90",
                            )}
                          />
                        ) : (
                          <History className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="flex-1 text-left">{item.label}</span>
                        <span className="text-[10px] tabular-nums text-muted-foreground/70">
                          {item.count}
                        </span>
                      </>
                    );

                    return (
                      <div
                        key={`section-${item.id}`}
                        className={cn(
                          "flex items-center gap-1.5 px-1 pt-2 text-xs font-medium uppercase tracking-wider text-muted-foreground",
                          item.nested && "ml-4 border-l border-border/60 pl-2",
                        )}
                        data-testid={`conversation-section-${item.id}`}
                      >
                        {item.onToggle ? (
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-muted/50 hover:text-foreground"
                            aria-expanded={item.expanded}
                            onClick={item.onToggle}
                          >
                            {sectionHeader}
                          </button>
                        ) : (
                          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1">
                            {sectionHeader}
                          </div>
                        )}
                        {item.id === "history" && storageMode === "mongodb" && (
                          <TooltipProvider delayDuration={300}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-5 w-5 hover:bg-muted"
                                  onClick={handleReloadConversations}
                                  disabled={isReloading}
                                >
                                  <RefreshCw
                                    className={cn("h-3 w-3", isReloading && "animate-spin")}
                                  />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent side="right" sideOffset={4}>
                                <p className="text-xs">Reload conversations</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </div>
                    );
                  }

                  if (item.kind === "webhook-task") {
                    const provider =
                      item.task.trigger.type === "webhook"
                        ? item.task.trigger.provider ?? "webhook"
                        : "webhook";
                    return (
                      <button
                        key={`webhook-task-${item.task.id}`}
                        type="button"
                        className="ml-4 flex w-[calc(100%-1rem)] min-w-0 items-center gap-2 rounded-lg border border-transparent p-2 text-left transition-colors hover:border-orange-500/20 hover:bg-orange-500/5"
                        onClick={() => {
                          startTransition(() => {
                            router.push(`/chat/webhooks/${encodeURIComponent(item.task.id)}`);
                          });
                        }}
                        aria-label={`Open webhook runs for ${item.task.name}`}
                        data-testid={`webhook-task-${item.task.id}`}
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-orange-500/10">
                          <Webhook className="h-4 w-4 text-orange-600 dark:text-orange-300" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {item.task.name}
                          </span>
                          <span className="block truncate text-[10px] capitalize text-muted-foreground">
                            {provider}
                          </span>
                        </span>
                      </button>
                    );
                  }

                  const conv = item.conversation;
                  const currentUserEmail = session?.user?.email?.trim().toLowerCase();
                  const ownerEmail = conv.owner_id?.trim().toLowerCase();
                  const viewerIsKnownOwner =
                    conv.accessLevel === "owner" ||
                    Boolean(ownerEmail && currentUserEmail && ownerEmail === currentUserEmail);
                  const hasSharingConfig = Boolean(
                    (conv.sharing?.shared_with?.length ?? 0) > 0 ||
                    (conv.sharing?.shared_with_teams?.length ?? 0) > 0 ||
                    conv.sharing?.share_link_enabled
                  );
                  const sharedByKnownDifferentOwner = Boolean(
                    ownerEmail &&
                    currentUserEmail &&
                    ownerEmail !== currentUserEmail &&
                    hasSharingConfig
                  );
                  // assisted-by Codex Codex-sonnet-4-6
                  // The badge is viewer-facing, so prefer the server's per-viewer sharing signal.
                  const isSharedWithViewer = !viewerIsKnownOwner && (
                    conv.isSharedWithViewer === true ||
                    conv.accessLevel === "shared" ||
                    conv.accessLevel === "shared_readonly" ||
                    sharedByKnownDifferentOwner
                  );
                  const sharedByLabel = conv.owner_id?.trim();
                  const canManageSharing = viewerIsKnownOwner || (!ownerEmail && !isSharedWithViewer);

                  const isLive = isConversationStreaming(conv.id);
                  const isInputRequired = !isLive && isConversationInputRequired(conv.id);
                  const isUnviewed = !isLive && !isInputRequired && hasUnviewedMessages(conv.id);
                  const titleBadge = getAutonomousBadge(conv) ?? getScheduleBadge(conv);
                  const isEditingTitle = editingConversationId === conv.id;
                  const isSavingTitle = renameSavingId === conv.id;

                  return (
                  <div
                    key={conv.id}
                    className="group/conv"
                  >
                    <motion.div
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      transition={{ delay: index * 0.02 }}
                      className={cn(
                        "group relative flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-all min-w-0",
                        isLive
                          ? "bg-emerald-500/10 border border-emerald-500/30"
                          : isInputRequired
                            ? "bg-amber-500/10 border border-amber-500/30"
                            : isUnviewed
                              ? "bg-blue-500/5 border border-blue-500/25"
                              : activeConversationId === conv.id
                                ? "bg-primary/10 border border-primary/30"
                                : isSharedWithViewer
                                  ? "hover:bg-muted/50 border border-blue-500/20"
                                  : "hover:bg-muted/50 border border-transparent"
                      )}
                      onClick={() => {
                        setActiveConversation(conv.id);
                        startTransition(() => {
                          router.push(`/chat/${conv.id}`);
                        });
                      }}
                    >
                    <div className={cn(
                      "shrink-0 w-8 h-8 rounded-md flex items-center justify-center relative",
                      isLive
                        ? "bg-emerald-500/20"
                        : isInputRequired
                          ? "bg-amber-500/20"
                          : isUnviewed
                            ? "bg-blue-500/15"
                            : activeConversationId === conv.id
                              ? "bg-primary/20"
                              : "bg-muted"
                    )}>
                      {isLive ? (
                        <>
                          <Radio className="h-4 w-4 text-emerald-500 animate-pulse" />
                          <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
                          </span>
                        </>
                      ) : isInputRequired ? (
                        <>
                          <MessageCircleQuestion className="h-4 w-4 text-amber-500 animate-pulse" />
                          <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
                          </span>
                        </>
                      ) : (
                        <>
                          <MessageSquare className={cn(
                            "h-4 w-4",
                            isUnviewed
                              ? "text-blue-500"
                              : activeConversationId === conv.id
                                ? "text-primary"
                                : "text-muted-foreground"
                          )} />
                          {isUnviewed && (
                            <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
                            </span>
                          )}
                        </>
                      )}
                    </div>

                    {!collapsed && (
                      <>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1 min-w-0">
                            {isEditingTitle ? (
                              <input
                                autoFocus
                                value={editingTitle}
                                disabled={isSavingTitle}
                                onClick={(event) => event.stopPropagation()}
                                onChange={(event) => setEditingTitle(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    void commitTitleEdit(event, conv);
                                  } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    cancelTitleEdit();
                                  }
                                }}
                                className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-2 text-sm font-medium outline-none focus:border-primary"
                                aria-label="Conversation title"
                              />
                            ) : (
                              <>
                                <p className="text-sm font-medium truncate flex-1" title={conv.title}>
                                  {truncateText(conv.title, sidebarWidth > 350 ? 40 : sidebarWidth > 320 ? 25 : 20)}
                                </p>
                                {titleBadge && (
                                  <span
                                    className={cn(
                                      "shrink-0 max-w-[132px] truncate rounded border px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal",
                                      titleBadge.kind === "autonomous"
                                        ? "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                                        : "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
                                    )}
                                    title={titleBadge.title}
                                  >
                                    {truncateText(titleBadge.label, sidebarWidth > 350 ? 24 : 18)}
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                          <div className={cn(
                            "flex min-w-0 items-center text-xs",
                            isLive
                              ? "text-emerald-600 dark:text-emerald-400 font-medium"
                              : isInputRequired
                                ? "text-amber-600 dark:text-amber-400 font-medium"
                                : isUnviewed
                                  ? "text-blue-600 dark:text-blue-400 font-medium"
                                  : "text-muted-foreground"
                          )}>
                            <span className="shrink-0">
                              {isLive ? "Live" : isInputRequired ? "Input needed" : isUnviewed ? "New response" : formatDate(conv.updatedAt)}
                            </span>
                            {/* Dynamic Agent indicator */}
                            {(() => {
                              const agId = getAgentId(conv);
                              if (!agId) return null;
                              const agentName = agentNameMap[agId];
                              if (!agentName && agentNamesLoading) {
                                return (
                                  <>
                                    <span className="ml-1.5 text-[10px] text-purple-500 dark:text-purple-400">•</span>
                                    <Skeleton
                                      className="ml-1 h-2.5 w-16 shrink-0 rounded-full"
                                      data-testid="agent-name-skeleton"
                                    />
                                  </>
                                );
                              }
                              return (
                                <span className="ml-1.5 truncate text-[10px] text-purple-500 dark:text-purple-400" title={agentName || 'Unknown Agent'}>
                                  • {truncateText(agentName || 'Unknown', 20)}
                                </span>
                              );
                            })()}
                          </div>
                        </div>

                        <div className="flex items-center gap-0.5 shrink-0">
                          {isEditingTitle ? (
                            <>
                              <TooltipProvider delayDuration={200}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      aria-label="Save title"
                                      disabled={isSavingTitle || !editingTitle.trim()}
                                      onClick={(event) => void commitTitleEdit(event, conv)}
                                    >
                                      <Check className="h-3 w-3" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" sideOffset={4}>
                                    <p className="text-xs">Save title</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                              <TooltipProvider delayDuration={200}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6"
                                      aria-label="Cancel rename"
                                      disabled={isSavingTitle}
                                      onClick={cancelTitleEdit}
                                    >
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" sideOffset={4}>
                                    <p className="text-xs">Cancel rename</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </>
                          ) : (
                            <>
                              {canManageSharing && (
                                <TooltipProvider delayDuration={200}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                                        aria-label="Rename conversation"
                                        onClick={(event) => beginTitleEdit(event, conv)}
                                      >
                                        <Pencil className="h-3 w-3" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" sideOffset={4}>
                                      <p className="text-xs">Rename conversation</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                              <div
                                className={cn(
                                  "transition-opacity",
                                  activeConversationId === conv.id || hasSharingConfig || isSharedWithViewer
                                    ? "opacity-100"
                                    : "opacity-0 group-hover:opacity-100",
                                )}
                              >
                                <ShareButton
                                  conversationId={conv.id}
                                  conversationTitle={conv.title}
                                  isOwner={canManageSharing}
                                  isSharedWithViewer={isSharedWithViewer}
                                  sharedBy={sharedByLabel}
                                  sharing={conv.sharing}
                                  accessLevel={conv.accessLevel}
                                />
                              </div>
                            </>
                          )}
                          {!isEditingTitle && (
                          <TooltipProvider delayDuration={200}>
                          <Tooltip>
                          <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={async (e) => {
                              console.log('[Sidebar] Archive clicked for:', conv.id);
                              e.stopPropagation();
                              
                              // Capture state BEFORE any async work
                              const conversationsBeforeArchive = useChatStore.getState().conversations;
                              const isLastConversation = conversationsBeforeArchive.length === 1;
                              const archivedTitle = conv.title || 'Untitled';
                              
                              console.log('[Sidebar] Before archive:', {
                                count: conversationsBeforeArchive.length,
                                isLast: isLastConversation,
                              });

                              // If this is the last conversation, create a new one FIRST
                              // so the user always has somewhere to land
                              let navigateToId: string | null = null;
                              if (isLastConversation) {
                                navigateToId = await createConversation(await resolveUsableChatAgentId());
                                console.log('[Sidebar] Created replacement conversation:', navigateToId);
                              }

                              // Archive the conversation (updates store + server).
                              // The store rolls the conversation back into the list
                              // when the server rejects the delete (e.g. a shared
                              // conversation the viewer does not own), so report the
                              // failure instead of claiming success — otherwise the
                              // row silently returns on the next reload.
                              try {
                                await deleteConversation(conv.id);
                              } catch (error) {
                                toast(
                                  `Couldn't archive "${archivedTitle}": ${getErrorMessage(error, 'the server rejected the request')}`,
                                  "error",
                                  6000,
                                );
                                if (navigateToId) {
                                  router.replace(`/chat/${navigateToId}`);
                                }
                                return;
                              }

                              // Show toast
                              if (storageMode === 'mongodb') {
                                toast(`"${archivedTitle}" moved to Archive`, "success", 4000);
                              } else {
                                toast(`"${archivedTitle}" deleted`, "success", 3000);
                              }

                              // Navigate
                              if (navigateToId) {
                                // Last conversation case — go to the fresh conversation
                                router.replace(`/chat/${navigateToId}`);
                              } else {
                                // Multiple conversations — store already picked the next active
                                const storeState = useChatStore.getState();
                                const newActiveId = storeState.activeConversationId;
                                if (newActiveId) {
                                  router.replace(`/chat/${newActiveId}`);
                                }
                              }
                            }}
                          >
                            <Archive className="h-3 w-3" />
                          </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" sideOffset={4}>
                            <p className="text-xs">Archive conversation</p>
                          </TooltipContent>
                          </Tooltip>
                          </TooltipProvider>
                          )}
                        </div>
                      </>
                    )}
                  </motion.div>
                  </div>
                    );
                  })}
                </AnimatePresence>
              )}

              {!isLoadingConversations && conversations.length === 0 && !collapsed && (
                <div className="text-center py-8 px-4">
                  <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-muted flex items-center justify-center">
                    <Sparkles className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-muted-foreground">
                    No conversations yet
                  </p>
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    Start a new chat to begin
                  </p>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      )}

      {/* Gallery mode - Use Cases info */}
      {activeTab === "gallery" && (
        <>
          {collapsed ? (
            /* Collapsed state - Show icon buttons */
            <div className="flex-1 flex flex-col items-center gap-2 px-2 py-4">
              {/* Use Case Builder Button */}
              <Button
                onClick={() => setUseCaseBuilderOpen(true)}
                variant="ghost"
                size="icon"
                className="h-10 w-10 hover:bg-primary/10 hover:text-primary"
                title="Create Use Case"
              >
                <Sparkles className="h-5 w-5" />
              </Button>

              {/* Custom Query Button */}
              <Button
                onClick={() => handleNewChat()}
                variant="ghost"
                size="icon"
                className="h-10 w-10 hover:bg-primary/10 hover:text-primary"
                title="Custom Query"
              >
                <MessageSquare className="h-5 w-5" />
              </Button>
            </div>
          ) : (
            /* Expanded state - Full content */
            <div className="flex-1 flex flex-col p-4">
              {/* Prominent Use Cases info */}
              <div
                className="relative overflow-hidden rounded-xl border border-primary/20 p-4 mb-4"
                style={{
                  background: `linear-gradient(to bottom right, color-mix(in srgb, var(--gradient-from) 20%, transparent), color-mix(in srgb, var(--gradient-to) 15%, transparent), transparent)`
                }}
              >
                <div className="relative">
                  <div className="w-10 h-10 mb-3 rounded-xl gradient-primary-br flex items-center justify-center shadow-lg shadow-primary/30">
                    <Sparkles className="h-5 w-5 text-white" />
                  </div>
                  <p className="text-sm font-semibold gradient-text">Explore Use Cases</p>
                  <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
                    Pre-built platform engineering scenarios. Click any card to start a chat.
                  </p>
                </div>
              </div>

              {/* Use Case Builder Button */}
              <Button
                onClick={() => setUseCaseBuilderOpen(true)}
                variant="outline"
                className="w-full gap-2 border-dashed border-primary/30 hover:border-primary hover:bg-primary/5 mb-4"
              >
                <Sparkles className="h-4 w-4" />
                <span>Create Use Case</span>
              </Button>

              {/* Quick Start Button */}
              <Button
                onClick={() => handleNewChat()}
                variant="outline"
                className="w-full gap-2 border-dashed border-primary/30 hover:border-primary hover:bg-primary/5"
              >
                <Plus className="h-4 w-4" />
                <span>Custom Query</span>
              </Button>

              {/* Categories Legend */}
              <div className="mt-6">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">Categories</p>
                <div className="space-y-2 text-xs">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-blue-500" />
                    <span className="text-muted-foreground">DevOps & Operations</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-purple-500" />
                    <span className="text-muted-foreground">Development</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green-500" />
                    <span className="text-muted-foreground">Cloud & Security</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-orange-500" />
                    <span className="text-muted-foreground">Project Management</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Admin mode - Dashboard info */}
      {activeTab === "admin" && (
        <div className="flex-1 flex flex-col p-4">
          {!collapsed && (
            <>
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <Shield className="h-4 w-4 text-red-500" />
                  <p className="text-sm font-semibold">Admin</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Manage access, teams, usage, and system health.
                </p>
              </div>

              <div className="space-y-2 text-xs">
                <div className="p-2 rounded bg-muted/50 border border-primary/20">
                  <p className="text-muted-foreground mb-2">Go to</p>
                  <div className="space-y-1 text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Users className="h-3 w-3" />
                      <span>Users and roles</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Users className="h-3 w-3" />
                      <span>Teams</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-3 w-3" />
                      <span>Usage</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Database className="h-3 w-3" />
                      <span>System Monitoring</span>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Use Case Builder Dialog */}
      <UseCaseBuilderDialog
        open={useCaseBuilderOpen}
        onOpenChange={setUseCaseBuilderOpen}
        onSuccess={() => {
          console.log("Use case saved successfully");
          // Trigger refresh of use cases gallery
          if (onUseCaseSaved) {
            onUseCaseSaved();
          }
        }}
      />

      {/* Archive Dialog */}
      <RecycleBinDialog
        open={recycleBinOpen}
        onOpenChange={setRecycleBinOpen}
      />

    </motion.div>
  );
}
