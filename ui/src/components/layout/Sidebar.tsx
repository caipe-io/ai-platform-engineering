"use client";

// assisted-by Codex Codex-sonnet-4-6

import { ChatHistoryOrganizationControls, type OrganizationDialog } from "@/components/chat/ChatHistoryOrganizationControls";
import { ChatHistoryGroupReorder, type GroupDrop } from "@/components/chat/ChatHistoryGroupReorder";
import { reorderChatHistoryGroups } from "@/lib/chat-history-organization";
import { useChatHistoryOrganization } from "@/hooks/use-chat-history-organization";
import { NewChatButton } from "@/components/chat/NewChatButton";
import { AgentHarnessBadge } from "@/components/chat/AgentHarnessBadge";
import { ConversationListSkeleton } from "@/components/chat/ConversationListSkeleton";
import { RecycleBinDialog } from "@/components/chat/RecycleBinDialog";
import { ShareButton } from "@/components/chat/ShareButton";
import { AgentAvatar } from "@/components/dynamic-agents/AgentAvatar";
import { UseCaseBuilderDialog } from "@/components/gallery/UseCaseBuilder";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { autonomousApi } from "@/components/autonomous/api";
import type { AutonomousTask } from "@/components/autonomous/types";
import { Tooltip,TooltipContent,TooltipProvider,TooltipTrigger } from "@/components/ui/tooltip";
import { resolveUsableChatAgentId } from "@/lib/chat-agent-selection";
import type { ConversationListFilter } from "@/lib/api-client";
import { getConfig } from "@/lib/config";
import { getErrorMessage } from "@/lib/error-utils";
import { getStorageMode } from "@/lib/storage-config";
import { cn,formatDate } from "@/lib/utils";
import { useChatStore } from "@/store/chat-store";
import type { Conversation } from "@/types/a2a";
import { getAgentId } from "@/types/a2a";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { motion } from "framer-motion";
import {
Archive,
ArchiveRestore,
CalendarClock,
Check,
ChevronDown,
ChevronLeft,
ChevronRight,
Code2,
Database,
Folder,
Loader2,
ListFilter,
MessageCircleQuestion,
MessageSquare,
Pencil,
Plus,
Radio,
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
  useCallback,
  useRef,
  useState,
  useTransition,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

interface SidebarProps {
  activeTab: "chat" | "gallery" | "knowledge" | "admin";
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  onUseCaseSaved?: () => void;
}

type SidebarAgent = Pick<
  DynamicAgentConfig,
  "_id" | "name" | "execution_harness_id" | "presentation" | "ui"
>;

interface ConversationTitleBadge {
  kind: "autonomous" | "scheduled";
  label: string;
  title: string;
}

type ConversationHistoryFilter = ConversationListFilter | "webhook";

const CONVERSATION_HISTORY_FILTERS: ReadonlyArray<{
  icon: typeof MessageSquare;
  iconClassName: string;
  label: string;
  value: ConversationHistoryFilter;
}> = [
  { icon: ListFilter, iconClassName: "text-muted-foreground", label: "All chats", value: "all" },
  { icon: MessageSquare, iconClassName: "text-muted-foreground", label: "Web chats", value: "web" },
  { icon: Code2, iconClassName: "text-sky-500", label: "API chats", value: "api" },
  { icon: Sparkles, iconClassName: "text-violet-500", label: "Autonomous runs", value: "autonomous" },
  { icon: CalendarClock, iconClassName: "text-cyan-500", label: "Scheduled runs", value: "scheduled" },
  { icon: Webhook, iconClassName: "text-orange-500", label: "Webhook runs", value: "webhook" },
];

const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 320;
const MAX_SIDEBAR_WIDTH = 500;
const SIDEBAR_WIDTH_STORAGE_KEY = "caipe-chat-sidebar-width";
const HISTORY_FILTER_STORAGE_KEY = "caipe-chat-history-filter";
const CHAT_HISTORY_ACTION_CLASS_NAME =
  "h-5 w-5 shrink-0 [&_svg]:size-3.5 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11";

function clampSidebarWidth(width: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
}

function readStoredSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!stored) return DEFAULT_SIDEBAR_WIDTH;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function persistSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Browser storage may be unavailable; resizing still works for this page load.
  }
}

function readStoredHistoryFilter(): ConversationHistoryFilter {
  try {
    const stored = window.localStorage.getItem(HISTORY_FILTER_STORAGE_KEY)
      ?? window.localStorage.getItem("caipe-chat-history-tab");
    const isSupported = CONVERSATION_HISTORY_FILTERS.some(
      (filter) => filter.value === stored,
    );
    return isSupported ? stored as ConversationHistoryFilter : "all";
  } catch {
    return "all";
  }
}

function persistHistoryFilter(filter: ConversationHistoryFilter): void {
  try {
    window.localStorage.setItem(HISTORY_FILTER_STORAGE_KEY, filter);
  } catch {
    // Browser storage may be unavailable; filtering still works for this page load.
  }
}

type ConversationListItem =
  | { kind: "group"; key: string; label: string; count: number; folderId?: string }
  | { kind: "webhook-section" }
  | {
      kind: "conversation";
      conversation: Conversation;
    }
  | {
      kind: "webhook-task";
      task: AutonomousTask;
    };

function getAutonomousBadge(conv: Conversation): ConversationTitleBadge | null {
  const metadataTaskName = conv.metadata?.task_name;
  const metadataTaskId = conv.metadata?.task_id;
  const taskId =
    conv.task_id?.trim() ||
    (typeof metadataTaskId === "string" ? metadataTaskId.trim() : "");
  const hasAutonomousSource =
    conv.source === "autonomous" || conv.metadata?.source === "autonomous";
  const hasLegacyAutonomousMarkers =
    /^\[Autonomous\](?:\s|$)/i.test(conv.title);

  // Conversations created before autonomous provenance became a top-level
  // field may only carry the reserved title prefix. Keep those out of normal
  // Chat history immediately; the backend also repairs their provenance when
  // the task is next touched.
  if (!hasAutonomousSource && !hasLegacyAutonomousMarkers) return null;

  const titleTaskName = conv.title.replace(/^\[Autonomous\]\s*/i, "").trim();
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
    conversationFilter,
    conversationHasMore,
    isLoadingMoreConversations,
    isConversationStreaming,
    hasUnviewedMessages,
    isConversationInputRequired,
  } = useChatStore();
  const { data: session } = useSession();
  const organizationIdentity = session?.user?.email ?? (!getConfig("ssoEnabled") ? "local" : undefined);
  const [historyFilter, setHistoryFilter] = useState<ConversationHistoryFilter>('all');
  const organizationScope = historyFilter === "autonomous" || historyFilter === "scheduled" ? historyFilter : "chats";
  const allowChatFolders = !["autonomous", "scheduled", "webhook"].includes(historyFilter);
  const organization = useChatHistoryOrganization(organizationIdentity, organizationScope);
  const draggedChat = useRef<{ id: string; identity: string; pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const ignoreChatClick = useRef(false);
  const [draggedChatId, setDraggedChatId] = useState<string | null>(null);
  const [dropFolderKey, setDropFolderKey] = useState<string | null>(null);
  const clearChatDrag = () => { draggedChat.current = null; setDraggedChatId(null); setDropFolderKey(null); };
  const canDropChat = () => allowChatFolders && organization.ready && !organization.saving && organization.value.view === "folders" &&
    draggedChat.current?.identity === organizationIdentity && conversations.some(c => c.id === draggedChat.current?.id && getConversationRunKind(c) === null);
  const folderAtPointer = (event: ReactPointerEvent) => event.currentTarget.ownerDocument
    .elementFromPoint(event.clientX, event.clientY)?.closest("[data-chat-folder-drop-target]")
    ?.getAttribute("data-chat-folder-drop-target") ?? null;
  const dropChatIntoFolder = (key: string | null) => {
    const source = draggedChat.current;
    const valid = canDropChat() && source?.moved && key;
    clearChatDrag();
    if (!valid || !source || !key) return;
    const folderId = key === "folder:unfiled" ? undefined : key.slice("folder:".length);
    if (folderId && !organization.value.folders.some(f => f.id === folderId)) return;
    const id = source.id;
    if (organization.value.assignments[id] === folderId) return;
    void organization.update(value => {
      const assignments = { ...value.assignments };
      if (folderId) assignments[id] = folderId; else delete assignments[id];
      return { ...value, assignments, collapsed: value.collapsed.filter(k => k !== key) };
    });
  };
  const [groupDrop, setGroupDrop] = useState<GroupDrop | null>(null);
  const [groupMoveAnnouncement, setGroupMoveAnnouncement] = useState("");
  const [organizationDialog, setOrganizationDialog] = useState<OrganizationDialog | null>(null);
  const [useCaseBuilderOpen, setUseCaseBuilderOpen] = useState(false);
  const storageMode = getStorageMode(); // Exclusive storage mode
  const [isLoadingConversations, setIsLoadingConversations] = useState(
    activeTab === "chat" && storageMode === "mongodb",
  );
  const [, startTransition] = useTransition();
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const [recycleBinOpen, setRecycleBinOpen] = useState(false);
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [renameSavingId, setRenameSavingId] = useState<string | null>(null);
  const [historyFilterHydrated, setHistoryFilterHydrated] = useState(false);
  const [webhooksExpanded, setWebhooksExpanded] = useState(false);
  const [webhookTasks, setWebhookTasks] = useState<AutonomousTask[]>([]);
  const schedulerEnabled = getConfig("schedulerEnabled");
  const autonomousEnabled = getConfig("autonomousAgentsEnabled");
  const availableHistoryFilters = CONVERSATION_HISTORY_FILTERS.filter(
    (filter) =>
      (filter.value !== "scheduled" || schedulerEnabled) &&
      (!["autonomous", "webhook"].includes(filter.value) || autonomousEnabled),
  );
  const conversationScrollViewportRef = useRef<HTMLDivElement>(null);
  const resizeStateRef = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);
  const sidebarWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH);
  const { toast } = useToast();

  useEffect(() => {
    const storedWidth = readStoredSidebarWidth();
    sidebarWidthRef.current = storedWidth;
    setSidebarWidth(storedWidth);
    const storedFilter = readStoredHistoryFilter();
    const unavailable =
      (storedFilter === "scheduled" && !schedulerEnabled) ||
      (["autonomous", "webhook"].includes(storedFilter) && !autonomousEnabled);
    setHistoryFilter(unavailable ? "all" : storedFilter);
    setHistoryFilterHydrated(true);
  }, [schedulerEnabled, autonomousEnabled]);

  // Agent name lookup for dynamic agent conversations
  const [agentMap, setAgentMap] = useState<Record<string, SidebarAgent>>({});
  const [agentNamesLoading, setAgentNamesLoading] = useState(true);

  // Load conversations from server when sidebar mounts (MongoDB mode only)
  // Also re-sync when tab becomes visible (user switches back from another browser/tab)
  useEffect(() => {
    if (!historyFilterHydrated) return;
    let cancelled = false;
    if (
      activeTab === "chat" &&
      storageMode === 'mongodb' &&
      historyFilter !== 'webhook'
    ) {
      // Always load from server - the loadConversationsFromServer function
      // will merge server data with local cache intelligently
      setIsLoadingConversations(true);
      void loadConversationsFromServer({ filter: historyFilter })
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
      if (
        document.visibilityState === 'visible' &&
        activeTab === "chat" &&
        storageMode === 'mongodb' &&
        historyFilter !== 'webhook'
      ) {
        console.log('[Sidebar] Tab became visible, re-syncing conversations');
        loadConversationsFromServer({ filter: historyFilter }).catch((error) => {
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
  }, [activeTab, historyFilter, historyFilterHydrated, storageMode]);

  const handleHistoryFilterChange = useCallback((nextFilter: ConversationHistoryFilter) => {
    if (conversationScrollViewportRef.current) {
      conversationScrollViewportRef.current.scrollTop = 0;
    }
    setHistoryFilter(nextFilter);
    persistHistoryFilter(nextFilter);
  }, []);

  const handleConversationListScroll = useCallback(() => {
    const viewport = conversationScrollViewportRef.current;
    if (
      !viewport ||
      historyFilter === 'webhook' ||
      conversationFilter !== historyFilter ||
      isLoadingConversations ||
      !conversationHasMore ||
      isLoadingMoreConversations
    ) {
      return;
    }
    if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 100) {
      void loadConversationsFromServer({ filter: conversationFilter, append: true });
    }
  }, [
    conversationFilter,
    conversationHasMore,
    historyFilter,
    isLoadingConversations,
    isLoadingMoreConversations,
    loadConversationsFromServer,
  ]);

  useEffect(() => {
    const viewport = conversationScrollViewportRef.current;
    if (!viewport) return;
    viewport.addEventListener('scroll', handleConversationListScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleConversationListScroll);
  }, [activeTab, handleConversationListScroll]);

  // Fetch dynamic agents for name lookup in conversation list
  useEffect(() => {
    let cancelled = false;
    const fetchAgents = async () => {
      try {
        const response = await fetch("/api/dynamic-agents/available");
        const data = await response.json();
        if (!cancelled && data.success && Array.isArray(data.data)) {
          const map: Record<string, SidebarAgent> = {};
          data.data.forEach((agent: SidebarAgent) => {
            map[agent._id] = agent;
          });
          setAgentMap(map);
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
    if (activeTab !== "chat" || !autonomousEnabled || !ownerEmail) {
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
  }, [activeTab, autonomousEnabled, session?.user?.email]);

  useEffect(() => {
    if (!isResizing) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isResizing]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startWidth: sidebarWidthRef.current,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setIsResizing(true);
  }, []);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    const nextWidth = clampSidebarWidth(
      resizeState.startWidth + event.clientX - resizeState.startX,
    );
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
  }, []);

  const finishResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    resizeStateRef.current = null;
    setIsResizing(false);
    persistSidebarWidth(sidebarWidthRef.current);
  }, []);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -16 : 16;
    const nextWidth = clampSidebarWidth(sidebarWidthRef.current + delta);
    sidebarWidthRef.current = nextWidth;
    setSidebarWidth(nextWidth);
    persistSidebarWidth(nextWidth);
  }, []);

  const handleNewChat = async (agentId?: string) => {
    let resolvedAgentId: string | null = null;
    try {
      resolvedAgentId = agentId?.trim() || await resolveUsableChatAgentId();
      setHistoryFilter('web');
      persistHistoryFilter('web');

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
          conversationFilter: 'web',
          conversationPage: Math.max(state.conversationPage, 1),
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

  const visibleConversations = conversations.filter((conversation) => {
    const runKind = getConversationRunKind(conversation);
    if (historyFilter === 'all') return true;
    if (historyFilter === 'api') return conversation.source === 'api';
    if (historyFilter === 'autonomous') return runKind === 'autonomous';
    if (historyFilter === 'scheduled') return runKind === 'scheduled';
    if (historyFilter === 'web') return runKind === null && conversation.source !== 'api';
    return false;
  });
  const conversationListItems: ConversationListItem[] = historyFilter === 'webhook'
    ? webhookTasks.map((task) => ({ kind: 'webhook-task', task }))
    : visibleConversations.map((conversation) => ({ kind: 'conversation', conversation }));
  if (!collapsed && historyFilter !== "webhook" && organization.value.view !== "ungrouped") {
    const groups = new Map<string, { label: string; folderId?: string; conversations: Conversation[] }>();
    if (organization.value.view === "folders") {
      organization.value.folders.forEach(f => groups.set(`folder:${f.id}`, { label: f.name, folderId: f.id, conversations: [] }));
      groups.set("folder:unfiled", { label: "Unfiled", conversations: [] });
    }
    visibleConversations.forEach(conversation => {
      const agentId = getAgentId(conversation);
      const folderId = getConversationRunKind(conversation) ? undefined : organization.value.assignments[conversation.id];
      const key = organization.value.view === "folders" ? folderId ? `folder:${folderId}` : "folder:unfiled" : `agent:${agentId ?? "none"}`;
      if (!groups.has(key)) groups.set(key, { label: agentId ? agentMap[agentId]?.name ?? "Unavailable agent" : "No agent", conversations: [] });
      groups.get(key)!.conversations.push(conversation);
    });
    conversationListItems.length = 0;
    const ranks = new Map((organization.value.groupOrder ?? []).map((key, index) => [key, index]));
    const orderedGroups = [...groups].sort(([a], [b]) => (ranks.get(a) ?? Infinity) - (ranks.get(b) ?? Infinity));
    for (const [key, group] of orderedGroups) {
      conversationListItems.push({ kind: "group", key, label: group.label, count: group.conversations.length, folderId: group.folderId });
      if (!organization.value.collapsed.includes(key)) conversationListItems.push(...group.conversations.map(
        (conversation): ConversationListItem => ({ kind: "conversation", conversation })));
    }
  }
  const groupKeys = conversationListItems.flatMap(item => item.kind === "group" ? [item.key] : []);
  const moveHistoryGroup = (source: string, target: GroupDrop) => {
    if (!organization.ready || organization.saving || !groupKeys.includes(source) || !groupKeys.includes(target.key)) return;
    const order = reorderChatHistoryGroups(organization.value.groupOrder ?? [], groupKeys, source, target.key, target.position);
    if (order.filter(key => groupKeys.includes(key)).every((key, index) => key === groupKeys[index])) return;
    const label = conversationListItems.find(item => item.kind === "group" && item.key === source);
    const destination = conversationListItems.find(item => item.kind === "group" && item.key === target.key);
    void organization.update(value => ({ ...value,
      groupOrder: reorderChatHistoryGroups(value.groupOrder ?? [], groupKeys, source, target.key, target.position),
    })).then(saved => { if (saved && label?.kind === "group") setGroupMoveAnnouncement(`Moved ${label.label} ${target.position} ${destination?.kind === "group" ? destination.label : "the destination group"}.`); });
  };
  if (historyFilter === 'autonomous' && webhookTasks.length > 0) {
    conversationListItems.push({ kind: 'webhook-section' });
    if (webhooksExpanded) {
      conversationListItems.push(...webhookTasks.map(
        (task): ConversationListItem => ({ kind: 'webhook-task', task }),
      ));
    }
  }

  const selectedHistoryFilter = availableHistoryFilters.find(
    filter => filter.value === historyFilter,
  ) ?? availableHistoryFilters[0];

  return (
    <motion.div
      initial={false}
      animate={{ width: collapsed ? 64 : sidebarWidth }}
      transition={{ duration: isResizing ? 0 : 0.2 }}
      className="relative flex flex-col h-full bg-card/50 backdrop-blur-sm border-r border-border/50 shrink-0 z-10"
    >
      {/* Resize Handle */}
      {!collapsed && (
        <div
          role="separator"
          aria-label="Resize chat sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onKeyDown={handleResizeKeyDown}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          className={cn(
            "absolute right-0 top-0 z-20 h-full w-1.5 touch-none cursor-col-resize bg-transparent transition-colors hover:bg-primary/50 focus-visible:bg-primary/50 focus-visible:outline-none",
            isResizing && "bg-primary/60",
          )}
          title="Drag to resize sidebar"
        />
      )}

      {/* New Chat Button */}
      {activeTab === "chat" && (
        <div className="px-2 pt-2 pb-2 shrink-0">
          <NewChatButton
            collapsed={collapsed}
            onNewChat={handleNewChat}
          />
        </div>
      )}

      {/* Chat History */}
      {activeTab === "chat" && (
        <div className="flex-1 overflow-hidden flex flex-col min-w-0 min-h-0">
          {!collapsed && (
            <div className="px-2 pb-2 shrink-0">
              <ChatHistoryOrganizationControls state={organization} dialog={organizationDialog}
                onDialog={setOrganizationDialog} allowFolders={allowChatFolders} allowGrouping={historyFilter !== "webhook"}
                source={selectedHistoryFilter.value}
                onSourceChange={value => handleHistoryFilterChange(value as ConversationHistoryFilter)}
                sources={availableHistoryFilters.map(filter => {
                  const Icon = filter.icon;
                  return { value: filter.value, label: filter.label, content: <>
                    <Icon className={cn("h-3.5 w-3.5 shrink-0", filter.iconClassName)} /><span className="truncate">{filter.label}</span>
                  </> };
                })}
              />
            </div>
          )}
          <ScrollArea
            className="flex-1 min-w-0"
            viewportRef={conversationScrollViewportRef}
            data-testid="conversation-history-scroll"
          >
            {/* Replace filter contents synchronously: exiting headers/rows must not
                linger over the newly selected history. */}
            <div role="status" aria-live="polite" className="sr-only">{groupMoveAnnouncement}</div>
            <div key={historyFilter} className="px-2 space-y-1 pb-4">
              {isLoadingConversations && conversationListItems.length === 0 ? (
                <ConversationListSkeleton collapsed={collapsed} />
              ) : (
                <>
                  {conversationListItems.map((item) => {
                  if (item.kind === "group") {
                    const expanded = !organization.value.collapsed.includes(item.key);
                    return <div key={item.key}
                      data-chat-group-key={item.key}
                      data-chat-folder-drop-target={organization.value.view === "folders" ? item.key : undefined}
                      className={cn("group flex items-center gap-1 rounded-lg pt-2 transition-colors",
                        dropFolderKey === item.key && "bg-primary/15 ring-2 ring-inset ring-primary",
                        groupDrop?.key === item.key && (groupDrop.position === "before" ? "shadow-[inset_0_2px_0_0_hsl(var(--primary))]" : "shadow-[inset_0_-2px_0_0_hsl(var(--primary))]"))}
                    >
                      <ChatHistoryGroupReorder groupKey={item.key} label={item.label} keys={groupKeys}
                        scope={`${organizationIdentity}:${historyFilter}:${organization.value.view}`}
                        disabled={!organization.ready || organization.saving} viewport={conversationScrollViewportRef.current}
                        onMove={moveHistoryGroup} onTarget={setGroupDrop} />
                      <button type="button" aria-expanded={expanded} disabled={organization.saving}
                        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-2 text-left text-base font-medium"
                        onClick={() => void organization.update(v => ({ ...v, collapsed: expanded ? [...v.collapsed, item.key] : v.collapsed.filter(k => k !== item.key) }))}>
                        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                        {organization.value.view === "folders" && <Folder className="h-3.5 w-3.5 shrink-0" />}
                        <span className="truncate" title={item.label}>{item.label}</span><span className="ml-auto text-xs tabular-nums text-muted-foreground">{item.count}</span>
                      </button>
                      {item.folderId && <>
                        <Button size="icon" variant="ghost" className="h-6 w-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
                          aria-label={`Rename folder ${item.label}`} disabled={organization.saving}
                          onClick={() => setOrganizationDialog({ kind: "rename", id: item.folderId!, name: item.label })}><Pencil className="h-3 w-3" /></Button>
                        <Button size="icon" variant="ghost" className="h-6 w-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
                          aria-label={`Remove folder ${item.label}`} title="Remove folder; keep chats in Unfiled" disabled={organization.saving}
                          onClick={() => void organization.update(v => ({ ...v, folders: v.folders.filter(f => f.id !== item.folderId),
                            assignments: Object.fromEntries(Object.entries(v.assignments).filter(([, id]) => id !== item.folderId)),
                            collapsed: v.collapsed.filter(k => k !== item.key),
                            ...(v.groupOrder ? { groupOrder: v.groupOrder.filter(k => k !== item.key) } : {}) }))}><X className="h-3 w-3" /></Button>
                      </>}
                    </div>;
                  }
                  if (item.kind === "webhook-section") {
                    return (
                      <button
                        key="webhook-section"
                        type="button"
                        aria-expanded={webhooksExpanded}
                        onClick={() => setWebhooksExpanded((expanded) => !expanded)}
                        className="flex w-full items-center gap-1.5 px-2 py-2 text-xs font-medium text-muted-foreground"
                      >
                        {webhooksExpanded
                          ? <ChevronDown className="h-3.5 w-3.5" />
                          : <ChevronRight className="h-3.5 w-3.5" />}
                        <Webhook className="h-3.5 w-3.5" />
                        <span>Webhook Runs</span>
                        <span className="ml-auto tabular-nums">{webhookTasks.length}</span>
                      </button>
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
                        className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-transparent p-2 text-left transition-colors hover:border-orange-500/20 hover:bg-orange-500/5"
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
                  const scheduleBadge = getScheduleBadge(conv);
                  const titleBadge = getAutonomousBadge(conv) ?? scheduleBadge;
                  const runKind = getConversationRunKind(conv);
                  const ConversationIcon = conv.source === 'api'
                    ? Code2
                    : runKind === 'autonomous'
                      ? Sparkles
                      : runKind === 'scheduled'
                        ? CalendarClock
                        : MessageSquare;
                  const isEditingTitle = editingConversationId === conv.id;
                  const isSavingTitle = renameSavingId === conv.id;
                  const conversationAgentId = getAgentId(conv);
                  const conversationAgent = conversationAgentId
                    ? agentMap[conversationAgentId]
                    : undefined;
                  const conversationStatus = isLive
                    ? "Live response"
                    : isInputRequired
                      ? "Input required"
                      : isUnviewed
                        ? "New response"
                        : formatDate(conv.updatedAt);
                  const conversationAgentName = conversationAgent?.name
                    ?? (agentNamesLoading ? "Loading agent…" : "Unknown agent");
                  const openConversation = () => {
                    setActiveConversation(conv.id);
                    startTransition(() => {
                      router.push(`/chat/${conv.id}`);
                    });
                  };

                  return (
                  <div
                    key={conv.id}
                    className={cn("group/conv", draggedChatId === conv.id && "opacity-50")}
                    data-chat-conversation-id={conv.id}
                  >
                    <TooltipProvider delayDuration={150}>
                    <Tooltip className="block w-full">
                    <TooltipTrigger asChild>
                    <div
                      onPointerDown={event => {
                        ignoreChatClick.current = false;
                        if (event.button !== 0 || event.pointerType === "touch" || !organizationIdentity || !allowChatFolders || getConversationRunKind(conv) !== null ||
                          collapsed || organization.value.view !== "folders" || !organization.ready ||
                          organization.saving || isEditingTitle || (event.target as Element).closest("button, input, textarea")) return;
                        draggedChat.current = { id: conv.id, identity: organizationIdentity, pointerId: event.pointerId,
                          x: event.clientX, y: event.clientY, moved: false };
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                      onPointerMove={event => {
                        const source = draggedChat.current;
                        if (!source || source.pointerId !== event.pointerId || !canDropChat()) return;
                        if (!source.moved && Math.hypot(event.clientX - source.x, event.clientY - source.y) < 6) return;
                        source.moved = true; ignoreChatClick.current = true; event.preventDefault();
                        setDraggedChatId(source.id); setDropFolderKey(folderAtPointer(event));
                        const viewport = conversationScrollViewportRef.current;
                        if (viewport) {
                          const bounds = viewport.getBoundingClientRect();
                          if (event.clientY < bounds.top + 24) viewport.scrollTop -= 12;
                          else if (event.clientY > bounds.bottom - 24) viewport.scrollTop += 12;
                        }
                      }}
                      onPointerUp={event => {
                        if (draggedChat.current?.pointerId === event.pointerId) dropChatIntoFolder(folderAtPointer(event));
                      }}
                      onPointerCancel={clearChatDrag}
                      onLostPointerCapture={clearChatDrag}
                      onDragStart={event => event.preventDefault()}
                      className={cn(
                        "group relative gap-x-2 rounded-lg cursor-pointer transition-colors min-w-0",
                        collapsed
                          ? "flex items-center p-2"
                          : "grid grid-cols-[2rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.25rem] items-center px-2 py-[7px] [@media(pointer:coarse)]:grid-rows-[1.25rem_1.25rem_auto]",
                        organization.value.view === "folders" && organization.ready && !organization.saving && !isEditingTitle && "cursor-grab active:cursor-grabbing select-none",
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
                      aria-label={collapsed
                        ? `${conv.title}. ${conversationAgentName}. ${conversationStatus}`
                        : undefined}
                      role={collapsed ? "button" : undefined}
                      tabIndex={collapsed ? 0 : undefined}
                      onClick={event => {
                        if (ignoreChatClick.current) { ignoreChatClick.current = false; event.preventDefault(); return; }
                        openConversation();
                      }}
                      onKeyDown={collapsed ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openConversation();
                        }
                      } : undefined}

                    >
                    <div
                      className={cn("relative shrink-0", !collapsed && "col-start-1 row-start-1 row-span-2")}
                      title={titleBadge?.title}
                    >
                      {titleBadge && <span className="sr-only">{titleBadge.title}</span>}
                      {conversationAgentId ? (
                        <AgentAvatar
                          agent={conversationAgent ?? { _id: conversationAgentId }}
                          agentId={conversationAgentId}
                          rounded="rounded-md"
                          size="h-8 w-8"
                          iconSize="h-4 w-4"
                          icon={isLive ? Radio : isInputRequired ? MessageCircleQuestion : ConversationIcon}
                          className={cn(
                            isLive && "ring-2 ring-emerald-500/60",
                            isInputRequired && "ring-2 ring-amber-500/60",
                            isUnviewed && "ring-2 ring-blue-500/60",
                            activeConversationId === conv.id && !isLive && !isInputRequired && !isUnviewed && "ring-2 ring-primary/50",
                          )}
                        />
                      ) : (
                        <div className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-md",
                          isLive
                            ? "bg-emerald-500/20"
                            : isInputRequired
                              ? "bg-amber-500/20"
                              : isUnviewed
                                ? "bg-blue-500/15"
                                : "bg-muted",
                        )}>
                          {isLive ? (
                            <Radio className="h-4 w-4 animate-pulse text-emerald-500" />
                          ) : isInputRequired ? (
                            <MessageCircleQuestion className="h-4 w-4 animate-pulse text-amber-500" />
                          ) : (
                            <ConversationIcon className={cn(
                              "h-4 w-4",
                              isUnviewed ? "text-blue-500" : activeConversationId === conv.id ? "text-primary" : conv.source === "api" ? "text-sky-500" : runKind === "autonomous" ? "text-violet-500" : runKind === "scheduled" ? "text-cyan-500" : "text-muted-foreground",
                            )} />
                          )}
                        </div>
                      )}
                      {conversationAgent && !collapsed && (
                        <AgentHarnessBadge
                          harnessId={conversationAgent.execution_harness_id}
                          presentation={conversationAgent.presentation}
                          compact
                          className="absolute -bottom-2.5 -right-1.5 rounded-sm bg-card ring-2 ring-card"
                        />
                      )}
                      {(isLive || isInputRequired || isUnviewed) && (
                        <span className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
                          {(isLive || isInputRequired) && (
                            <span className={cn(
                              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
                              isLive ? "bg-emerald-400" : "bg-amber-400",
                            )} />
                          )}
                          <span className={cn(
                            "relative inline-flex h-2.5 w-2.5 rounded-full",
                            isLive ? "bg-emerald-500" : isInputRequired ? "bg-amber-500" : "bg-blue-500",
                          )} />
                        </span>
                      )}
                    </div>

                    {!collapsed && (
                      <>
                        <div className="col-start-2 row-start-1 min-w-0">
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
                                className="h-5 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-sm font-medium outline-none focus:border-primary"
                                aria-label="Conversation title"
                              />
                            ) : (
                              <>
                                <p className="text-sm leading-5 font-medium truncate flex-1" title={conv.title}>
                                  {conv.title}
                                </p>
                              </>
                            )}
                          </div>
                        </div>
                        <span
                          className={cn(
                            "col-start-3 row-start-1 whitespace-nowrap text-right text-[11px] leading-5",
                            isLive
                              ? "text-emerald-600 dark:text-emerald-400 font-medium"
                              : isInputRequired
                                ? "text-amber-600 dark:text-amber-400 font-medium"
                                : isUnviewed
                                  ? "text-blue-600 dark:text-blue-400 font-medium"
                                  : "text-muted-foreground"
                          )}
                          title={isLive || isInputRequired || isUnviewed
                            ? undefined
                            : `Last updated: ${conv.updatedAt.toLocaleString()}`}
                        >
                          {isLive ? "Live" : isInputRequired ? "Input needed" : isUnviewed ? "New response" : formatDate(conv.updatedAt)}
                        </span>
                        <div className="col-start-2 row-start-2 flex min-w-0 items-center">
                            {/* Dynamic Agent indicator */}
                            {conversationAgentId && (
                              !conversationAgent && agentNamesLoading ? (
                                <Skeleton
                                  className="h-3 min-w-0 max-w-28 flex-1 rounded-full"
                                  data-testid="agent-name-skeleton"
                                />
                              ) : (
                                <span
                                  className="min-w-0 flex-1 truncate text-xs leading-5 text-foreground/75"
                                  title={conversationAgentName}
                                >
                                  {conversationAgentName}
                                </span>
                              )
                            )}
                        </div>
                        <div className="col-start-3 row-start-2 flex min-w-0 items-center justify-end [@media(pointer:coarse)]:col-start-2 [@media(pointer:coarse)]:col-span-2 [@media(pointer:coarse)]:row-start-3">
                          <div
                            role="group"
                            aria-label={`Actions for ${conv.title}`}
                            className={cn(
                              "ml-auto flex shrink-0 items-center gap-0.5 transition-opacity pointer-events-none opacity-0",
                              "group-hover/conv:pointer-events-auto group-hover/conv:opacity-100 group-focus-within/conv:pointer-events-auto group-focus-within/conv:opacity-100",
                              "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
                              isEditingTitle && "pointer-events-auto opacity-100",
                            )}
                          >
                          {allowChatFolders && !runKind && !isEditingTitle && <Button size="icon" variant="ghost" className={CHAT_HISTORY_ACTION_CLASS_NAME}
                            aria-label="Move conversation to folder" title="Move to folder" disabled={!organization.ready || organization.saving}
                            onClick={event => { event.stopPropagation(); setOrganizationDialog({ kind: "move", id: conv.id, title: conv.title }); }}>
                            <Folder className="h-3 w-3" />
                          </Button>}
                          {isEditingTitle ? (
                            <>
                              <TooltipProvider delayDuration={200}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className={CHAT_HISTORY_ACTION_CLASS_NAME}
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
                                      className={CHAT_HISTORY_ACTION_CLASS_NAME}
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
                                        className={CHAT_HISTORY_ACTION_CLASS_NAME}
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
                              <div className="flex shrink-0">
                                <ShareButton
                                  conversationId={conv.id}
                                  conversationTitle={conv.title}
                                  isOwner={canManageSharing}
                                  isSharedWithViewer={isSharedWithViewer}
                                  sharedBy={sharedByLabel}
                                  sharing={conv.sharing}
                                  accessLevel={conv.accessLevel}
                                  className={CHAT_HISTORY_ACTION_CLASS_NAME}
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
                            className={CHAT_HISTORY_ACTION_CLASS_NAME}
                            aria-label="Archive conversation"
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
                        </div>
                      </>
                    )}
                  </div>
                  </TooltipTrigger>
                  {collapsed ? (
                    <TooltipContent
                      side="right"
                      sideOffset={10}
                      className="w-64 whitespace-normal px-3 py-2.5"
                    >
                      <div className="space-y-2">
                        <div>
                          <p className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">
                            {conv.title}
                          </p>
                          <p className={cn(
                            "mt-1 text-[11px] font-normal",
                            isLive
                              ? "text-emerald-500"
                              : isInputRequired
                                ? "text-amber-500"
                                : isUnviewed
                                  ? "text-blue-500"
                                  : "text-muted-foreground",
                          )}>
                            {conversationStatus}
                          </p>
                        </div>
                        <div className="flex min-w-0 items-center gap-2 border-t border-border/50 pt-2">
                          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/85">
                            {conversationAgentName}
                          </span>
                          {conversationAgent ? (
                            <AgentHarnessBadge
                              harnessId={conversationAgent.execution_harness_id}
                              presentation={conversationAgent.presentation}
                              compact
                            />
                          ) : null}
                        </div>
                        {titleBadge ? (
                          <p className="truncate text-[10px] font-normal text-cyan-600 dark:text-cyan-300">
                            {titleBadge.title}
                          </p>
                        ) : null}
                        {scheduleBadge && titleBadge?.kind === "autonomous" ? (
                          <p className="truncate text-[10px] font-normal text-cyan-600 dark:text-cyan-300">
                            {scheduleBadge.title}
                          </p>
                        ) : null}
                      </div>
                    </TooltipContent>
                  ) : null}
                  </Tooltip>
                  </TooltipProvider>
                  </div>
                    );
                  })}
                </>
              )}

              {conversationHasMore && conversationFilter === historyFilter && !isLoadingMoreConversations && (
                <Button variant="ghost" className="w-full text-xs" onClick={() => void loadConversationsFromServer({ filter: conversationFilter, append: true })}>Load older chats</Button>
              )}
              {isLoadingMoreConversations && conversationFilter === historyFilter && (
                <div className="flex justify-center py-3" aria-label="Loading more chats">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}

              {!isLoadingConversations && conversationListItems.length === 0 && !collapsed && (
                <div className="text-center py-8 px-4">
                  <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-muted flex items-center justify-center">
                    <Sparkles className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-muted-foreground">
                    {historyFilter === 'all' || historyFilter === 'web'
                      ? 'No conversations yet'
                      : `No ${historyFilter === 'webhook' ? 'webhook runs' : 'chats'} found`}
                  </p>
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    {historyFilter === 'all' || historyFilter === 'web'
                      ? 'Start a new chat to begin'
                      : 'Choose another history filter'}
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

      <div className="mt-auto flex shrink-0 items-center justify-between px-2 py-1">
        <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild>
          <Button variant="ghost" size="icon" onClick={() => onCollapse(!collapsed)}
            aria-label={collapsed ? "Expand chat sidebar" : "Collapse chat sidebar"}
            className="h-8 w-8 hover:bg-muted shrink-0">
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </TooltipTrigger><TooltipContent side="top">{collapsed ? "Expand chat sidebar" : "Collapse chat sidebar"}</TooltipContent></Tooltip></TooltipProvider>
        {activeTab === "chat" && !collapsed && storageMode === "mongodb" && (
          <TooltipProvider delayDuration={200}><Tooltip><TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Archive" onClick={() => setRecycleBinOpen(true)} className="h-8 w-8">
              <ArchiveRestore className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </TooltipTrigger><TooltipContent side="top">Restore deleted conversations</TooltipContent></Tooltip></TooltipProvider>
        )}
      </div>

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
