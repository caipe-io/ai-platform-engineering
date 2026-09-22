"use client";

import { AgentAvatar } from "@/components/dynamic-agents/AgentAvatar";
import { ContextUsageIndicator } from "@/components/chat/ContextUsageIndicator";
import type { TaskItem } from "@/components/shared/timeline";
import { MarkdownRenderer } from "@/components/shared/timeline";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/components/ui/toast";
import { Tooltip,TooltipContent,TooltipProvider,TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentTimeline } from "@/hooks/useDynamicAgentTimeline";
import { apiClient,APIClientError } from "@/lib/api-client";
import { authErrorToastTitle,type AuthError } from "@/lib/auth-error";
import { getDeterministicAgentThemeId } from "@/lib/agent-theme";
import { getConfig } from "@/lib/config";
import { fetchEphemeralFileContent } from "@/lib/ephemeral-files";
import { ACCEPT_ATTRIBUTE,fileToInputFile,type InputFile,validateFiles } from "@/lib/file-attachments";
import { getGradientColors } from "@/lib/gradient-themes";
import { takePendingFirstMessage } from "@/lib/pending-first-message";
import { getStorageMode } from "@/lib/storage-config";
import { createSubagentResumeSeedEvents } from "@/lib/resume-subagent-context";
import { createStreamAdapter,StreamError,type StreamCallbacks } from "@/lib/streaming";
import { createStreamEvent,FILE_TOOL_NAMES,TODO_TOOL_NAME,type StreamEvent } from "@/lib/streaming/types";
import { cn,deduplicateByKey,generateId } from "@/lib/utils";
import { useChatStore } from "@/store/chat-store";
import { useFeatureFlagStore } from "@/store/feature-flag-store";
import { buildParticipants,ChatMessage as ChatMessageType,Conversation,type MessageAttachment,TurnStatus } from "@/types/a2a";
import type { DynamicAgentConfig,ReasoningEffort } from "@/types/dynamic-agent";
import { AnimatePresence,motion,useReducedMotion } from "framer-motion";
import { Activity,AlertTriangle,ArrowDown,ArrowLeft,Check,Copy,Loader2,Paperclip,Pencil,Send,ShieldCheck,Sparkles,Square,User,X } from "lucide-react";
import { resolveUsableChatAgentId } from "@/lib/chat-agent-selection";
import { AgentPicker } from "@/components/ui/agent-picker";
import { signIn,useSession } from "next-auth/react";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import Image from "next/image";
import React,{ useCallback,useEffect,useMemo,useRef,useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { AgentTimeline,type SubagentLookupInfo } from "./DynamicAgentTimeline";
import { Feedback,FeedbackButton } from "./FeedbackButton";
import { MetadataInputForm,type InputField,type UserInputMetadata } from "./MetadataInputForm";
import { AttachmentChips,type PendingAttachment } from "./AttachmentChips";
import { MessageAttachments } from "./MessageAttachments";
import { RewindConfirmationDialog } from "./RewindConfirmationDialog";
import { getFilteredCommands,SlashCommandMenu,type SlashCommand } from "./SlashCommandMenu";
import { ToolApprovalCard } from "./ToolApprovalCard";
import { useSlashCommands } from "./useSlashCommands";

type ReadOnlyReason = 'admin_audit' | 'shared_readonly' | 'agent_deleted' | 'agent_disabled';

/**
 * A message waiting in the composer queue while a turn streams. Carries any
 * multimodal attachments alongside the text so a queued turn sends its files
 * too, not just the words.
 */
interface QueuedMessage {
  id: string;
  text: string;
  files: InputFile[];
}

interface EffortStatus {
  id: number;
  text: string;
  tone: "success" | "warning" | "error";
}

interface CommandPanelItem {
  label: string;
  description: string;
  insertText: string;
}

interface CommandPanelSection {
  title?: string;
  items: CommandPanelItem[];
}

interface CommandPanelState {
  id: number;
  title: string;
  message?: string;
  loading?: boolean;
  sections?: CommandPanelSection[];
}

function buildQueuedBatchPrompt(messages: QueuedMessage[]): string {
  if (messages.length === 1) return messages[0].text;
  return messages
    .map((message, index) => {
      const content = message.text.trim() || '(attachments only)';
      return `[Queued message ${index + 1}]\n${content}`;
    })
    .join('\n\n');
}

interface ChatPanelProps {
  conversationId?: string; // MongoDB conversation UUID
  readOnly?: boolean;
  readOnlyReason?: ReadOnlyReason;
  /** Whether this conversation is also used by an API client. */
  apiConversation?: boolean;
  agentId: string; // Mandatory for Dynamic Agents
  agent?: DynamicAgentConfig | null; // Full agent config object
  isLoadingMessages?: boolean; // Whether messages are still loading (show skeleton)
  /** Called after a deprecated conversation is linked to a usable agent. */
  onAgentRelinked?: (agentId: string) => void;
  /** Bounded, host-validated metadata attached to each app-assistant turn. */
  clientContext?: Record<string, unknown>;
}

export function ChatPanel({
  conversationId,
  readOnly,
  readOnlyReason,
  apiConversation,
  agentId,
  agent,
  isLoadingMessages,
  onAgentRelinked,
  clientContext: suppliedClientContext,
}: ChatPanelProps) {
  // Derive display values from agent object
  const agentGradient = agent?.ui?.gradient_theme ?? null;
  const agentCustomTheme = agent?.ui?.custom_theme_config ?? null;
  const agentName = agent?.name;
  const agentSkills = agent?.skills;
  const { data: session } = useSession();
  const { toast } = useToast();
  const initializeFeatureFlags = useFeatureFlagStore((s) => s.initialize);
  const autoScrollEnabled = useFeatureFlagStore((s) => s.flags.autoScroll ?? true);
  const showTimestamps = useFeatureFlagStore((s) => s.flags.showTimestamps ?? false);
  const showContextUsage = useFeatureFlagStore((s) => s.flags.showContextUsage ?? true);

  useEffect(() => {
    initializeFeatureFlags();
  }, [initializeFeatureFlags]);

  /**
   * Surface a structured auth-failure (from the Web UI backend or stream adapters) to
   * the user as a toast with a short title + the server-supplied message,
   * and trigger NextAuth re-sign-in when the server's `action` hint is
   * `sign_in`. Returns true so callers can short-circuit the inline error
   * rendering.
   *
   * Why a toast over inline error text: auth failures are recoverable
   * (sign in / contact admin), not part of the conversation. Burying them
   * inside an `**Error:** ...` blob in the assistant turn taught users to
   * blame the agent and made the recovery path invisible. See
   * docs/docs/specs/098-enterprise-rbac-slack-ui/how-rbac-works.md.
   */
  const showAuthErrorToast = useCallback(
    (err: AuthError) => {
      const title = authErrorToastTitle(err);
      // Toast component renders message as text; combine title + body with
      // a newline so both are visible without exposing custom JSX.
      toast(`${title}\n${err.message}`, "error", 8000);

      // For session-expired / not-signed-in, redirect to NextAuth sign-in
      // after a short delay so the user has time to read the toast. We use
      // signIn() (not router.push) because NextAuth handles the OIDC flow
      // and round-trips the user back to the current page on success.
      if (err.action === "sign_in") {
        setTimeout(() => {
          void signIn(undefined, { callbackUrl: window.location.href });
        }, 1500);
      }
    },
    [toast],
  );

  // Derive the user's first name for message labels (falls back to "You")
  const userDisplayName = useMemo(() => {
    const fullName = session?.user?.name;
    if (!fullName) return "You";
    const firstName = fullName.split(" ")[0].trim();
    return firstName || "You";
  }, [session?.user?.name]);

  const maxEffortTheme = useMemo(
    () => getGradientColors(
      agentGradient || getDeterministicAgentThemeId(agentId),
      agentCustomTheme,
    ),
    [agentCustomTheme, agentGradient, agentId],
  );

  const [input, setInput] = useState("");
  const [hasRelinkedAgent, setHasRelinkedAgent] = useState(false);
  const relinkRestoresWriteAccess = hasRelinkedAgent && (
    readOnlyReason === 'agent_deleted' || readOnlyReason === 'agent_disabled'
  );
  const panelReadOnly = readOnly && !relinkRestoresWriteAccess;
  const panelReadOnlyReason = hasRelinkedAgent ? undefined : readOnlyReason;
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [isRewindConfirmationOpen, setIsRewindConfirmationOpen] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  // Files staged in the composer for the next turn (multimodal input).
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [maxEffortAnimationKey, setMaxEffortAnimationKey] = useState(0);
  const [effortStatus, setEffortStatus] = useState<EffortStatus | null>(null);
  const [commandPanel, setCommandPanel] = useState<CommandPanelState | null>(null);
  const [commandPanelSelectedIndex, setCommandPanelSelectedIndex] = useState(0);
  const prefersReducedMotion = useReducedMotion();
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(
    agent?.model.reasoning_effort ?? "medium",
  );
  const [supportedReasoningEfforts, setSupportedReasoningEfforts] = useState<ReasoningEffort[] | null>(null);
  const effortStatusSequenceRef = useRef(0);
  const commandPanelSequenceRef = useRef(0);
  const commandPanelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // User input form state (HITL - Human-in-the-Loop)
  const [pendingUserInput, setPendingUserInput] = useState<{
    messageId: string;
    metadata: UserInputMetadata;
    contextId?: string;
    // SSE/Dynamic Agent specific fields
    isSSE?: boolean;
    agentId?: string;
  } | null>(null);

  // Tool approval state (HITL for gated tools)
  const [pendingToolApproval, setPendingToolApproval] = useState<{
    messageId: string;
    interruptId: string;
    agentId: string;
    /** All tool calls needing approval in this interrupt batch */
    tools: Array<{
      toolName: string;
      toolArgs: Record<string, unknown>;
      allowedDecisions: string[];
    }>;
    /** Index of the tool currently being shown to the user */
    currentIndex: number;
    /** Accumulated decisions (one per tool, filled as user decides) */
    decisions: Array<{ decision: string; toolName: string; editedArgs?: Record<string, unknown> }>;
  } | null>(null);

  // Track message IDs where the user explicitly dismissed the input form,
  // so we don't re-show it after the restore effect runs.
  const dismissedInputForMessageRef = useRef<Set<string>>(new Set());

  // Whether we're still checking for a pending HITL interrupt (after page refresh)
  const [checkingInterrupt, setCheckingInterrupt] = useState(false);

  // Auto-scroll state
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const isAutoScrollingRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const queueFlushInProgressRef = useRef(false);

  const {
    activeConversationId,
    getActiveConversation,
    createConversation,
    addMessage,
    updateMessage,
    appendToMessage,
    truncateConversationFromMessage,
    addStreamEvent,
    contextUsageByConversation,
    setContextUsage,
    clearStreamEvents,
    setConversationStreaming,
    isConversationStreaming,
    cancelConversationRequest,
    updateMessageFeedback,
    consumePendingMessage,
    saveMessagesToServer,
    loadOlderMessagesFromServer,
    messageHistory,
    updateConversationTitle,
    clearConversationInputRequired,
  } = useChatStore();

  // Re-link this deprecated/deleted-agent conversation to the platform default agent,
  // then reload the page so ChatContainer picks up the new participants.
  const handleStartNewConversation = useCallback(async () => {
    if (!conversationId) return;
    setHasRelinkedAgent(true);
    try {
      const agentId = await resolveUsableChatAgentId();
      const newParticipants = buildParticipants(agentId);
      await apiClient.updateConversation(conversationId, {
        participants: newParticipants,
      });
      setHasRelinkedAgent(true);
      // Patch the Zustand store in-place so ChatContainer sees the new participants
      // immediately — it skips the API fetch when the conversation is already cached.
      useChatStore.setState((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, participants: newParticipants } : c,
        ),
      }));
      onAgentRelinked?.(agentId);
    } catch (err) {
      setHasRelinkedAgent(false);
      toast(`Could not resume conversation: ${(err as Error).message}`, "error", 8000);
    }
  }, [conversationId, onAgentRelinked, toast]);

  // "Choose agent" picker state — loaded lazily when the deprecated-agent banner is shown.
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [availableAgents, setAvailableAgents] = useState<{ value: string; label: string }[]>([]);
  const [chosenAgentId, setChosenAgentId] = useState("");

  useEffect(() => {
    const isDeprecatedBanner = readOnlyReason === 'agent_deleted' || readOnlyReason === 'agent_disabled';
    if (!isDeprecatedBanner || availableAgents.length > 0) return;
    fetch("/api/dynamic-agents/available", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        const list: DynamicAgentConfig[] = Array.isArray(data?.data) ? data.data : [];
        setAvailableAgents(
          list.filter((a) => a.enabled).map((a) => ({ value: a._id, label: a.name })),
        );
      })
      .catch(() => {/* non-critical — picker just stays empty */});
  }, [readOnlyReason, availableAgents.length]);

  const handleResumeWithChosenAgent = useCallback(async () => {
    if (!conversationId || !chosenAgentId) return;
    setHasRelinkedAgent(true);
    try {
      const newParticipants = buildParticipants(chosenAgentId);
      await apiClient.updateConversation(conversationId, { participants: newParticipants });
      setHasRelinkedAgent(true);
      useChatStore.setState((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, participants: newParticipants } : c,
        ),
      }));
      onAgentRelinked?.(chosenAgentId);
    } catch (err) {
      setHasRelinkedAgent(false);
      toast(`Could not resume conversation: ${(err as Error).message}`, "error", 8000);
    }
  }, [conversationId, chosenAgentId, onAgentRelinked, toast]);

  // Slash command registry
  const slashCommands = useSlashCommands(agentSkills, agent?.allowed_tools, agent?.subagents);

  // Get access token from session (if SSO is enabled and user is authenticated)
  const ssoEnabled = getConfig('ssoEnabled');
  const accessToken = ssoEnabled ? session?.accessToken : undefined;

  const conversation = getActiveConversation();
  const configuredReasoningEffort = agent?.model.reasoning_effort ?? "medium";
  const requestReasoningEffort = supportedReasoningEfforts?.includes(reasoningEffort)
    ? reasoningEffort
    : undefined;

  useEffect(() => {
    const stored = conversation?.metadata?.reasoning_effort;
    const next = typeof stored === "string" && ["low", "medium", "high", "max"].includes(stored)
      ? stored as ReasoningEffort
      : configuredReasoningEffort;
    setReasoningEffort(next);
  }, [conversation?.id, conversation?.metadata?.reasoning_effort, configuredReasoningEffort]);

  useEffect(() => {
    if (!agent?.model.id || !agent.model.provider) {
      setSupportedReasoningEfforts([]);
      return;
    }
    let cancelled = false;
    setSupportedReasoningEfforts(null);
    const params = new URLSearchParams({
      model_id: agent.model.id,
      provider: agent.model.provider,
    });
    fetch(`/api/dynamic-agents/model-capabilities?${params}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) setSupportedReasoningEfforts(data?.reasoning_efforts ?? []);
      })
      .catch(() => {
        if (!cancelled) setSupportedReasoningEfforts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agent?.model]);

  const persistReasoningEffort = useCallback(async (
    effort: ReasoningEffort,
    source: "selector" | "command" = "selector",
    conversationIdOverride?: string,
  ): Promise<"changed" | "unsupported" | "error"> => {
    if (!supportedReasoningEfforts?.includes(effort)) {
      if (source === "selector") {
        toast(
          `The selected model does not support changing reasoning effort. It will keep the provider default.`,
          "warning",
          6000,
        );
      }
      return "unsupported";
    }

    try {
      let convId = conversationIdOverride ?? activeConversationId;
      if (!convId) convId = await createConversation(agentId);
      if (getStorageMode() === "mongodb") {
        await apiClient.patchConversationMetadata(convId, { reasoning_effort: effort });
      }
      useChatStore.setState((state) => ({
        conversations: state.conversations.map((item) =>
          item.id === convId
            ? { ...item, metadata: { ...item.metadata, reasoning_effort: effort } }
            : item,
        ),
      }));
      setReasoningEffort(effort);
      if (source === "selector") {
        toast(`Reasoning effort changed to ${effort} for this chat.`, "success", 3500);
      }
      return "changed";
    } catch {
      if (source === "selector") {
        toast("Could not save the reasoning effort. Try again.", "error", 5000);
      }
      return "error";
    }
  }, [activeConversationId, agentId, createConversation, supportedReasoningEfforts, toast]);

  const showEffortStatus = useCallback((
    text: string,
    tone: EffortStatus["tone"],
  ) => {
    effortStatusSequenceRef.current += 1;
    setEffortStatus({
      id: effortStatusSequenceRef.current,
      text,
      tone,
    });
  }, []);

  useEffect(() => {
    if (!effortStatus) return;
    const timeout = window.setTimeout(() => setEffortStatus(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [effortStatus]);

  const showCommandPanel = useCallback((panel: Omit<CommandPanelState, "id">) => {
    commandPanelSequenceRef.current += 1;
    setCommandPanelSelectedIndex(0);
    setCommandPanel({ id: commandPanelSequenceRef.current, ...panel });
  }, []);

  const selectCommandPanelItem = useCallback((item: CommandPanelItem) => {
    setCommandPanel(null);
    setInput(item.insertText);
    window.setTimeout(() => {
      const textarea = inputRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = item.insertText.length;
      textarea.selectionEnd = item.insertText.length;
    }, 0);
  }, []);

  const commandPanelItems = useMemo(
    () => commandPanel?.sections?.flatMap((section) => section.items) ?? [],
    [commandPanel],
  );

  useEffect(() => {
    const selected = commandPanelRef.current?.querySelector<HTMLElement>(
      `[data-command-panel-index="${commandPanelSelectedIndex}"]`,
    );
    selected?.scrollIntoView({ block: "nearest" });
  }, [commandPanelSelectedIndex]);

  const editingMessageIndex = editingMessageId
    ? (conversation?.messages.findIndex((message) => message.id === editingMessageId) ?? -1)
    : -1;
  const rewindMessageCount = editingMessageIndex >= 0
    ? (conversation?.messages.length ?? 0) - editingMessageIndex
    : 0;
  const contextUsageId = conversationId ?? activeConversationId;
  const contextUsage = contextUsageId
    ? contextUsageByConversation[contextUsageId]
    : undefined;

  // Ref to track which conversations we've checked for HITL interrupt state
  const interruptCheckedRef = useRef<Set<string>>(new Set());

  // ─── Files & Tasks for Timeline (fetched via API) ─────────────────
  const [timelineFiles, setTimelineFiles] = useState<string[]>([]);
  const [timelineTasks, setTimelineTasks] = useState<TaskItem[]>([]);
  const [isDownloadingFile, setIsDownloadingFile] = useState(false);
  const [downloadingFilePath, setDownloadingFilePath] = useState<string | undefined>();
  const [isDeletingFile, setIsDeletingFile] = useState(false);
  const [deletingFilePath, setDeletingFilePath] = useState<string | undefined>();
  const [filesFetchKey, setFilesFetchKey] = useState(0);
  const filesFetchedForRef = useRef<{ conversationId: string; agentId: string; fetchKey: number } | null>(null);

  // ─── Subagent Info Cache (for timeline avatar gradients) ──────────
  const [subagentCache, setSubagentCache] = useState<Map<string, SubagentLookupInfo>>(new Map());
  const subagentCacheFetchedRef = useRef(false);

  // Fetch all available agents once for subagent lookup
  useEffect(() => {
    if (subagentCacheFetchedRef.current) return;
    subagentCacheFetchedRef.current = true;

    const fetchAgents = async () => {
      try {
        const response = await fetch("/api/dynamic-agents?enabled_only=true");
        const data = await response.json();
        if (data.success && data.data?.items) {
          const cache = new Map<string, SubagentLookupInfo>();
          for (const agent of data.data.items as DynamicAgentConfig[]) {
            // Index by both id and name for flexible lookup
            const info: SubagentLookupInfo = {
              name: agent.name,
              gradientTheme: agent.ui?.gradient_theme,
              customThemeConfig: agent.ui?.custom_theme_config,
            };
            cache.set(agent._id, info);
            // Also index by lowercase name for name-based lookup
            cache.set(agent.name.toLowerCase(), info);
          }
          setSubagentCache(cache);
        }
      } catch (err) {
        console.warn("[ChatPanel] Failed to fetch agents for subagent lookup:", err);
      }
    };

    fetchAgents();
  }, []);

  // Callback to look up subagent info by name
  const getSubagentInfo = useCallback((subagentName: string): SubagentLookupInfo | undefined => {
    // Try exact match first, then lowercase
    return subagentCache.get(subagentName) || subagentCache.get(subagentName.toLowerCase());
  }, [subagentCache]);

  // Check if THIS conversation is streaming (not global)
  const isThisConversationStreaming = activeConversationId
    ? isConversationStreaming(activeConversationId)
    : false;
  const hasAssistantMessageForInterruptCheck = conversation?.messages?.some((message) => message.role === "assistant") ?? false;

  // Check if user is near the bottom of the scroll area
  const isNearBottom = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return true;

    // During streaming, use a much larger threshold to prevent false positives
    // when content updates faster than scroll can complete
    const threshold = isThisConversationStreaming ? 300 : 100; // pixels from bottom
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    return scrollHeight - scrollTop - clientHeight < threshold;
  }, [isThisConversationStreaming]);

  // Scroll to bottom with smooth animation
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    if (messagesEndRef.current) {
      isAutoScrollingRef.current = true;
      messagesEndRef.current.scrollIntoView({ behavior, block: "end" });
      // Reset auto-scrolling flag after animation
      setTimeout(() => {
        isAutoScrollingRef.current = false;
        setIsUserScrolledUp(false);
        setShowScrollButton(false);
      }, behavior === "smooth" ? 300 : 0);
    }
  }, []);

  const loadOlderMessages = useCallback(() => {
    if (!activeConversationId || loadingOlderRef.current) return;
    const history = messageHistory[activeConversationId];
    if (!history?.hasMore || history.isLoadingOlder) return;

    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const previousScrollHeight = viewport.scrollHeight;
    const previousScrollTop = viewport.scrollTop;
    loadingOlderRef.current = true;
    void loadOlderMessagesFromServer(activeConversationId).finally(() => {
      requestAnimationFrame(() => {
        const currentViewport = scrollViewportRef.current;
        if (currentViewport) {
          currentViewport.scrollTop =
            currentViewport.scrollHeight - previousScrollHeight + previousScrollTop;
        }
        loadingOlderRef.current = false;
      });
    });
  }, [activeConversationId, loadOlderMessagesFromServer, messageHistory]);

  // Handle scroll events to detect user scrolling
  const handleScroll = useCallback(() => {
    // Ignore scroll events caused by auto-scrolling
    if (isAutoScrollingRef.current) return;

    const nearBottom = isNearBottom();
    setIsUserScrolledUp(!nearBottom);
    setShowScrollButton(!nearBottom);
    if ((scrollViewportRef.current?.scrollTop ?? Number.POSITIVE_INFINITY) < 80) {
      loadOlderMessages();
    }
  }, [isNearBottom, loadOlderMessages]);

  const handleWheel = useCallback((event: WheelEvent) => {
    if (event.deltaY < 0 && (scrollViewportRef.current?.scrollTop ?? 0) < 80) {
      loadOlderMessages();
    }
  }, [loadOlderMessages]);

  // Set up scroll listener
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", handleScroll);
      viewport.removeEventListener("wheel", handleWheel);
    };
  }, [handleScroll, handleWheel]);

  // Auto-scroll when new messages arrive (only if user hasn't scrolled up)
  useEffect(() => {
    if (autoScrollEnabled && !isUserScrolledUp) {
      scrollToBottom("smooth");
    }
  }, [conversation?.messages?.length, isUserScrolledUp, scrollToBottom, autoScrollEnabled]);

  // Auto-scroll during streaming only if user is near the bottom
  // Depend on both message content AND streamEvents length since timeline renders from SSE events
  const latestMessageContent = conversation?.messages?.at(-1)?.content;
  const streamEventCount = conversation?.streamEvents?.length;
  useEffect(() => {
    if (autoScrollEnabled && isThisConversationStreaming && !isUserScrolledUp) {
      scrollToBottom("instant");
    }
  }, [latestMessageContent, streamEventCount, isThisConversationStreaming, isUserScrolledUp, scrollToBottom, autoScrollEnabled]);

  // ResizeObserver-based auto-scroll: catches DOM changes from morphdom patches
  // that happen asynchronously after React renders (marked parses async, then
  // morphdom patches the DOM directly). Without this, scrollToBottom fires before
  // the DOM height has actually grown.
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport || !autoScrollEnabled) return;

    const observer = new ResizeObserver(() => {
      if (isThisConversationStreaming && !isUserScrolledUp && messagesEndRef.current) {
        messagesEndRef.current.scrollIntoView({ behavior: "instant", block: "end" });
      }
    });

    // Observe the first child of the viewport (the content wrapper)
    const content = viewport.firstElementChild;
    if (content) {
      observer.observe(content);
    }

    return () => observer.disconnect();
  }, [isThisConversationStreaming, isUserScrolledUp, autoScrollEnabled]);

  // Reset scroll state when conversation changes.
  useEffect(() => {
    setIsUserScrolledUp(false);
    setShowScrollButton(false);
    loadingOlderRef.current = false;
    // Scroll to bottom when switching conversations. Use rAF to wait for
    // the browser to lay out the newly rendered messages, then scroll.
    const raf = requestAnimationFrame(() => {
      scrollToBottom("instant");
    });
    return () => cancelAnimationFrame(raf);
  }, [activeConversationId, scrollToBottom]);

  const recoveringMessageId = null;

  // ═══════════════════════════════════════════════════════════════
  // CHECK HITL INTERRUPT STATE from checkpointer (messages loaded by ChatContainer)
  // ═══════════════════════════════════════════════════════════════
  useEffect(() => {
    // Skip if no conversationId (new conversation) or agentId
    if (!conversationId || !agentId) return;
    
    // Wait for messages to be loaded (race condition on page refresh:
    // this effect can fire before ChatContainer finishes loading messages
    // from MongoDB, causing lastMsg to be undefined and recovery to fail)
    if (isLoadingMessages) return;
    if (isThisConversationStreaming) return;
    // assisted-by Codex Codex-sonnet-4-6
    // Empty chats have no assistant turn to attach restored HITL state to.
    if (!hasAssistantMessageForInterruptCheck) return;

    // Skip if already checked this conversation
    if (interruptCheckedRef.current.has(conversationId)) return;
    
    // Mark as checked BEFORE async to prevent duplicate checks in Strict Mode
    interruptCheckedRef.current.add(conversationId);

    const checkInterruptState = async () => {
      setCheckingInterrupt(true);
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 5000);
      try {
        // Check for pending HITL interrupt state (lightweight call to checkpointer)
        // Messages are already loaded by ChatContainer - we only check interrupt state here
        const interruptResponse = await fetch(
          `/api/dynamic-agents/conversations/${conversationId}/interrupt-state?agent_id=${encodeURIComponent(agentId)}`,
          { signal: controller.signal },
        );
        
        if (interruptResponse.ok) {
          const interruptData = await interruptResponse.json();
          
          // Handle pending interrupt - restore the HITL form or tool approval card
          if (interruptData.has_pending_interrupt && interruptData.interrupt_data) {
            const idata = interruptData.interrupt_data;
            
            // Get the last message from the store (already loaded by ChatContainer)
            const currentConv = useChatStore.getState().conversations.find(c => c.id === conversationId);
            const lastMsg = currentConv?.messages?.[currentConv.messages.length - 1];
            
            if (lastMsg && lastMsg.role === "assistant") {
              if (idata.type === "tool_approval") {
                // Build tools list from tool_approvals if available, else single tool
                const tools = idata.tool_approvals && idata.tool_approvals.length > 1
                  ? idata.tool_approvals.map((t: { tool_name: string; tool_args: Record<string, unknown>; allowed_decisions?: string[] }) => ({
                      toolName: t.tool_name,
                      toolArgs: t.tool_args || {},
                      allowedDecisions: t.allowed_decisions || ["approve", "edit", "reject"],
                    }))
                  : [{
                      toolName: idata.tool_name,
                      toolArgs: idata.tool_args || {},
                      allowedDecisions: idata.allowed_decisions || ["approve", "edit", "reject"],
                    }];
                setPendingToolApproval({
                  messageId: lastMsg.id,
                  interruptId: idata.interrupt_id,
                  agentId,
                  tools,
                  currentIndex: 0,
                  decisions: [],
                });
              } else {
                const { prompt, fields } = idata;
                const inputFields: InputField[] = (fields || []).map((f: { field_name: string; field_label?: string; field_description?: string; field_type?: string; field_values?: string[]; required?: boolean; default_value?: string; placeholder?: string }) => ({
                  field_name: f.field_name,
                  field_label: f.field_label,
                  field_description: f.field_description,
                  field_type: f.field_type,
                  field_values: f.field_values,
                  required: f.required,
                  default_value: f.default_value,
                  placeholder: f.placeholder,
                }));

                setPendingUserInput({
                  messageId: lastMsg.id,
                  metadata: {
                    user_input: true,
                    input_title: `Input Required`,
                    input_description: prompt || "",
                    input_fields: inputFields,
                  },
                  contextId: conversationId,
                  isSSE: true,
                  agentId: agentId,
                });
              }
            }
          }
        }
      } catch (interruptError) {
        // Non-fatal: HITL state check failed
        console.warn("[ChatPanel] Failed to check interrupt state:", interruptError);
      } finally {
        window.clearTimeout(timeoutId);
        setCheckingInterrupt(false);
      }
    };

    checkInterruptState();
  }, [conversationId, agentId, isLoadingMessages, isThisConversationStreaming, hasAssistantMessageForInterruptCheck]);

  // ═══════════════════════════════════════════════════════════════
  // FILES & TASKS FETCH (for timeline display in latest message)
  // ═══════════════════════════════════════════════════════════════

  // Fetch files from API
  useEffect(() => {
    if (!conversationId || !agentId) {
      setTimelineFiles([]);
      filesFetchedForRef.current = null;
      return;
    }

    const currentFetchState = { conversationId, agentId, fetchKey: filesFetchKey };
    if (
      filesFetchedForRef.current?.conversationId === currentFetchState.conversationId &&
      filesFetchedForRef.current?.agentId === currentFetchState.agentId &&
      filesFetchedForRef.current?.fetchKey === currentFetchState.fetchKey
    ) {
      return;
    }
    
    filesFetchedForRef.current = currentFetchState;

    const fetchFiles = async () => {
      try {
        // No Authorization header — session cookie handles auth for same-origin requests.
        // Bearer tokens resolve email from JWT `sub` which may not match conversation owner_id.
        const fsNamespace = JSON.stringify([agentId, conversationId, "filesystem"]);
        const response = await fetch(
          `/api/files/list?fs_namespace=${encodeURIComponent(fsNamespace)}`,
        );
        if (response.ok) {
          const data = await response.json();
          setTimelineFiles(data.files || []);
        }
      } catch {
        // Silently ignore fetch errors - files are optional
      }
    };

    fetchFiles();
  }, [conversationId, agentId, filesFetchKey]);

  // Handle file download
  const handleTimelineFileDownload = useCallback(
    async (path: string) => {
      if (!conversationId || !agentId || isDownloadingFile) return;

      setIsDownloadingFile(true);
      setDownloadingFilePath(path);

      try {
        const fsNamespace = JSON.stringify([agentId, conversationId, "filesystem"]);
        const response = await fetch(
          `/api/files/content?fs_namespace=${encodeURIComponent(fsNamespace)}&path=${encodeURIComponent(path)}`,
        );

        if (response.ok) {
          const data = await response.json();
          const content = data.content || "";

          // Create blob and download
          const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          const filename = path.split("/").pop() || "file.txt";
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
      } catch {
        // Silently ignore download errors
      } finally {
        setIsDownloadingFile(false);
        setDownloadingFilePath(undefined);
      }
    },
    [conversationId, agentId, isDownloadingFile]
  );

  const handleGetFileContent = useCallback(
    async (path: string): Promise<string | null> => {
      if (!conversationId || !agentId) return null;
      const fsNamespace = JSON.stringify([agentId, conversationId, "filesystem"]);
      return fetchEphemeralFileContent(fsNamespace, path);
    },
    [conversationId, agentId],
  );

  // Handle file delete
  const handleTimelineFileDelete = useCallback(
    async (path: string) => {
      if (!conversationId || !agentId || isDeletingFile) return;

      setIsDeletingFile(true);
      setDeletingFilePath(path);

      try {
        const fsNamespace = JSON.stringify([agentId, conversationId, "filesystem"]);
        const response = await fetch(
          `/api/files/content?fs_namespace=${encodeURIComponent(fsNamespace)}&path=${encodeURIComponent(path)}`,
          {
            method: "DELETE",
          }
        );

        if (response.ok) {
          setFilesFetchKey((k) => k + 1);
        }
      } catch {
        // Silently ignore delete errors
      } finally {
        setIsDeletingFile(false);
        setDeletingFilePath(undefined);
      }
    },
    [conversationId, agentId, isDeletingFile]
  );

  // ═══════════════════════════════════════════════════════════════
  // RESTORE PENDING USER INPUT FORM after page refresh / navigation.
  // ═══════════════════════════════════════════════════════════════
  useEffect(() => {
    // Clear dismissed-form tracking when switching conversations
    dismissedInputForMessageRef.current.clear();
    setPendingUserInput(null);
  }, [activeConversationId]);

  // Track last message SSE events length to re-trigger restoration when events load
  const lastMsgEventsLen = conversation?.messages?.[conversation.messages.length - 1]?.streamEvents?.length ?? 0;

  useEffect(() => {
    if (pendingUserInput || isThisConversationStreaming) return;
    if (!conversation || conversation.messages.length === 0) return;

    const messages = conversation.messages;
    const lastMsg = messages[messages.length - 1];

    // Only restore if the last message is from the assistant (user hasn't replied yet)
    if (lastMsg.role !== "assistant") return;

    // Don't restore if the assistant message completed (isFinal=true)
    if (lastMsg.isFinal) {
      return;
    }

    // Don't restore if user explicitly dismissed the form for this message
    if (dismissedInputForMessageRef.current.has(lastMsg.id)) return;

    // HITL state is restored from persisted stream events.
    const streamEventsFromConv = conversation.streamEvents || [];
    
    // Find the last input_required event
    // We reverse to find the most recent one
    const inputEvent = [...streamEventsFromConv].reverse().find((e) => e.type === "input_required");

    if (inputEvent && inputEvent.inputRequiredData) {
       const { prompt, fields } = inputEvent.inputRequiredData;

       // Check if already answered
       const assistantIdx = messages.findIndex(m => m.id === lastMsg.id);
       const hasUserReplyAfter = messages.slice(assistantIdx + 1).some(m => m.role === "user");
       if (hasUserReplyAfter) {
         return;
       }

       // Tool approval events don't have fields — skip form restore for those
       if (!fields) return;

       const inputFields: InputField[] = fields.map(f => ({
            field_name: f.field_name,
            field_label: f.field_label,
            field_description: f.field_description,
            field_type: f.field_type,
            field_values: f.field_values,
            required: f.required,
            default_value: f.default_value,
            placeholder: f.placeholder,
          }));

       setPendingUserInput({
          messageId: lastMsg.id,
          metadata: {
            user_input: true,
            input_title: `Input Required`,
            input_description: prompt,
            input_fields: inputFields,
          },
          contextId: activeConversationId,
          isSSE: true,
          agentId: agentId,
       });
    }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, conversation?.messages?.length, conversation?.streamEvents?.length, lastMsgEventsLen, isThisConversationStreaming, agentId]);

  const handleCopy = async (content: string, id: string) => {
    await navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // ═══════════════════════════════════════════════════════════════
  // Streaming state & helpers
  // ═══════════════════════════════════════════════════════════════
  interface StreamLoopState {
    accumulatedText: string;
    rawStreamContent: string;
    hitlFormRequested: boolean;
    hasError: boolean;
    errorMessage?: string;
    /** Epoch ms when the turn was submitted — used to derive latency_ms. */
    startedAt?: number;
  }

  // Get the protocol-agnostic adapter config
  const agentProtocol = getConfig('agentProtocol');

  /**
   * Build StreamCallbacks that wire adapter events into the Zustand store,
   * HITL form, and file/todo fetches. Used by both submitMessage and HITL resume.
   */
  const buildStreamCallbacks = useCallback((
    convId: string,
    assistantMsgId: string,
    loopState: StreamLoopState,
    toolCallIdToName: Map<string, string>,
  ): StreamCallbacks => {
    /** Parse todos from write_todos args (handles both object and JSON string). */
    const parseTodosFromArgs = (args: unknown) => {
      try {
        const obj = typeof args === "string" ? JSON.parse(args) : args;
        const todos: TaskItem[] = (obj?.todos || []).map(
          (todo: { content?: string; status?: string }, idx: number) => ({
            id: `todo-${idx}`,
            content: todo.content || "",
            status: (todo.status as TaskItem["status"]) || "pending",
          })
        );
        if (todos.length > 0) {
          setTimelineTasks(todos);
        }
      } catch {
        // Silently ignore parse errors — todos are optional
      }
    };

    return {
    onContent(text, namespace) {
      loopState.accumulatedText += text;
      loopState.rawStreamContent += text;

      // Build a StreamEvent for the store (timeline rendering)
      const streamEvent = createStreamEvent("content", { text, namespace });
      addStreamEvent(streamEvent, convId);

      // Update message content immediately for progressive rendering
      updateMessage(convId, assistantMsgId, {
        content: loopState.accumulatedText,
        rawStreamContent: loopState.rawStreamContent,
      });
    },

    onToolStart(toolCallId, toolName, args, namespace) {
      toolCallIdToName.set(toolCallId, toolName);
      const streamEvent = createStreamEvent("tool_start", {
        tool_name: toolName,
        tool_call_id: toolCallId,
        args,
        namespace: namespace ?? [],
      });
      addStreamEvent(streamEvent, convId);

      // Custom protocol: write_todos args arrive in tool_start (already parsed)
      if (toolName === TODO_TOOL_NAME && args) {
        parseTodosFromArgs(args);
      }
    },

    onToolEnd(toolCallId, toolName, error, namespace, args, result) {
      const resolvedName = toolName ?? toolCallIdToName.get(toolCallId);
      // Parse accumulated args string (from AG-UI TOOL_CALL_ARGS deltas) into object.
      let parsedArgs: Record<string, unknown> | undefined;
      if (args) {
        try {
          const parsed = typeof args === "string" ? JSON.parse(args) : args;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            parsedArgs = parsed as Record<string, unknown>;
          }
        } catch {
          // Args string was not valid JSON; omit it from the timeline event.
        }
      }
      const streamEvent = createStreamEvent("tool_end", {
        tool_call_id: toolCallId,
        error,
        result,
        args: parsedArgs,
        namespace: namespace ?? [],
      });
      addStreamEvent(streamEvent, convId);

      // Trigger file fetches when file tools complete
      if (resolvedName) {
        if (FILE_TOOL_NAMES.includes(resolvedName as typeof FILE_TOOL_NAMES[number])) {
          setFilesFetchKey((k) => k + 1);
        } else if (resolvedName === TODO_TOOL_NAME && args) {
          // AG-UI protocol: write_todos args accumulated from TOOL_CALL_ARGS (string)
          parseTodosFromArgs(args);
        }
      }
    },

    onInputRequired(interruptId, prompt, fields, agent) {
      loopState.hitlFormRequested = true;

      const streamEvent = createStreamEvent("input_required", {
        interrupt_id: interruptId,
        prompt,
        fields,
        agent,
        namespace: [],
      });
      addStreamEvent(streamEvent, convId);

      const inputFields: InputField[] = fields.map(f => ({
        field_name: f.field_name,
        field_label: f.field_label,
        field_description: f.field_description,
        field_type: f.field_type,
        field_values: f.field_values,
        required: f.required,
        default_value: f.default_value,
        placeholder: f.placeholder,
      }));

      setPendingUserInput({
        messageId: assistantMsgId,
        metadata: {
          user_input: true,
          input_title: "Input Required",
          input_description: prompt,
          input_fields: inputFields,
        },
        contextId: convId,
        isSSE: true,
        agentId,
      });

      if (prompt) {
        loopState.accumulatedText = prompt;
        updateMessage(convId, assistantMsgId, { content: loopState.accumulatedText });
      }
    },

    onToolApprovalRequired(interruptId, toolName, toolArgs, allowedDecisions, agent, toolApprovals) {
      loopState.hitlFormRequested = true;

      const streamEvent = createStreamEvent("input_required", {
        type: "tool_approval",
        interrupt_id: interruptId,
        tool_name: toolName,
        tool_args: toolArgs,
        allowed_decisions: allowedDecisions,
        agent,
        namespace: [],
      });
      addStreamEvent(streamEvent, convId);

      // Build the list of tools needing approval
      const tools = toolApprovals && toolApprovals.length > 1
        ? toolApprovals.map(t => ({
            toolName: t.tool_name,
            toolArgs: t.tool_args,
            allowedDecisions: t.allowed_decisions,
          }))
        : [{ toolName, toolArgs, allowedDecisions }];

      setPendingToolApproval({
        messageId: assistantMsgId,
        interruptId,
        agentId,
        tools,
        currentIndex: 0,
        decisions: [],
      });

      const toolCount = tools.length;
      updateMessage(convId, assistantMsgId, {
        content: toolCount > 1
          ? `Requesting approval for ${toolCount} tool calls...`
          : `Requesting approval to run \`${toolName}\`...`,
      });
    },

    onWarning(message, namespace) {
      const streamEvent = createStreamEvent("warning", {
        message,
        namespace: namespace ?? [],
      });
      addStreamEvent(streamEvent, convId);
    },

    onContextUsage(usage, namespace) {
      if ((namespace?.length ?? 0) === 0) setContextUsage(convId,usage);
    },

    onDone() {
      // Finalization handled after adapter.streamMessage resolves
    },

    onError(message) {
      console.error("[DynamicAgent] Stream error event:", message);
      loopState.hasError = true;
      loopState.errorMessage = message;
    },
  }; }, [agentId, addStreamEvent, updateMessage, setPendingUserInput, setFilesFetchKey, setTimelineTasks, setContextUsage]);

  /**
   * Finalize a stream loop — copies conversation-level streamEvents to the
   * message for persistence, determines turn status, and saves to MongoDB.
   */
  const finalizeStreamLoop = useCallback((
    conversationId: string,
    assistantMsgId: string,
    state: StreamLoopState,
  ) => {
    // Check if the message was already finalized (e.g., by cancelConversationRequest)
    const currentConv = useChatStore.getState().conversations.find((c: Conversation) => c.id === conversationId);
    const currentMsg = currentConv?.messages.find((m: ChatMessageType) => m.id === assistantMsgId);
    const wasAlreadyCancelled = currentMsg?.isFinal && currentMsg?.turnStatus === "interrupted";

    // Copy conversation-level streamEvents to the message for persistence.
    const turnStreamEvents = currentConv?.streamEvents || [];

    if (wasAlreadyCancelled) {
      // Store's setConversationStreaming(null) hook already saved — nothing to do.
      return;
    }

    const isFinal = !state.hitlFormRequested;
    const turnStatus: TurnStatus = state.hitlFormRequested
      ? "waiting_for_input"
      : state.hasError
        ? "interrupted"
        : "done";

    // Client-measured end-to-end latency for the turn. Only recorded on a
    // clean completion (a HITL pause or error would skew response-time stats).
    const latencyMs =
      isFinal && !state.hasError && state.startedAt != null
        ? Date.now() - state.startedAt
        : undefined;

    updateMessage(conversationId, assistantMsgId, {
      content: state.accumulatedText,
      rawStreamContent: state.rawStreamContent,
      isFinal,
      turnStatus,
      ...(state.errorMessage ? { error: state.errorMessage } : {}),
      streamEvents: turnStreamEvents.length > 0 ? turnStreamEvents : undefined,
      // Persisted to metadata.agent_name / metadata.latency_ms for Insights.
      ...(agentName && { agentName }),
      ...(latencyMs != null && { latencyMs }),
    });
    setConversationStreaming(conversationId, null);
    // Store's setConversationStreaming(null) hook auto-saves after 500ms.
  }, [updateMessage, setConversationStreaming, agentName]);

  // A queued batch renders as separate user bubbles but is sent as one prompt,
  // producing one coherent assistant response for the whole batch.
  const submitMessageBatch = useCallback(async (messagesToSend: QueuedMessage[]) => {
    const validMessages = messagesToSend.filter(
      (message) => message.text.trim() || message.files.length > 0,
    );
    if (validMessages.length === 0 || isThisConversationStreaming) return;
    const messageToSend = buildQueuedBatchPrompt(validMessages);
    const filesToSend = validMessages.flatMap((message) => message.files);

    // Create conversation if needed. This hits POST /api/chat/conversations
    // which is gated by the Web UI backend auth middleware, so we have to handle the
    // structured auth-error here too (not just on the stream call) — without
    // this, an expired session looks like a generic "Failed to create
    // conversation" with no recovery hint.
    let convId = activeConversationId;
    if (!convId) {
      try {
        convId = await createConversation(agentId);
      } catch (err) {
        if (err instanceof APIClientError && (err.reason || err.status === 401 || err.status === 403)) {
          showAuthErrorToast({
            status: err.status,
            message: err.message,
            code: err.code,
            reason: err.reason,
            action: err.action,
          });
          return;
        }
        // Non-auth failure — fall through to existing toast surface so the
        // user still sees something instead of a silent no-op.
        toast(
          `Failed to start conversation: ${err instanceof Error ? err.message : String(err)}`,
          "error",
          8000,
        );
        return;
      }
    }

    // Build client context for system prompt rendering and user_info tool
    const conv = getActiveConversation();
    const clientContext: Record<string, unknown> = {
      source: "webui",
      ...suppliedClientContext,
      ...(conv?.sharing && { chat_sharing: conv.sharing }),
    };
    clearStreamEvents(convId);

    // Add user message - generate turnId for this request/response pair.
    // Retain the attachments on the rendered turn so the upload shows in the
    // transcript (base64 size ≈ 3/4 of the string length, close enough for the
    // size label). Persistence caps large images in saveMessagesToServer.
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    validMessages.forEach((queuedMessage) => {
      const attachments: MessageAttachment[] = queuedMessage.files.map((file) => ({
        mime_type: file.mime_type,
        name: file.name,
        data: file.data,
        size: Math.floor((file.data.length * 3) / 4),
      }));
      addMessage(convId, {
        role: "user",
        content: queuedMessage.text,
        senderEmail: session?.user?.email ?? undefined,
        senderName: session?.user?.name ?? undefined,
        senderImage: session?.user?.image ?? undefined,
        ...(attachments.length > 0 && { attachments }),
      }, turnId);
    });

    // Add assistant message placeholder with same turnId
    const assistantMsgId = addMessage(convId, { role: "assistant", content: "" }, turnId);

    // Create protocol-agnostic adapter
    const adapter = createStreamAdapter({
      protocol: agentProtocol as "custom" | "agui",
      accessToken,
    });

    const loopState: StreamLoopState = {
      accumulatedText: "",
      rawStreamContent: "",
      hitlFormRequested: false,
      hasError: false,
      startedAt: Date.now(),
    };
    const toolCallIdToName = new Map<string, string>();

    // Mark this conversation as streaming
    setConversationStreaming(convId, {
      conversationId: convId,
      messageId: assistantMsgId,
      client: { abort: () => adapter.abort() },
      streamAdapter: adapter,
    });

    try {
      const callbacks = buildStreamCallbacks(convId, assistantMsgId, loopState, toolCallIdToName);

      await adapter.streamMessage(
        {
          message: messageToSend,
          conversationId: convId,
          agentId,
          turnId,
          reasoningEffort: requestReasoningEffort,
          clientContext,
          ...(filesToSend.length > 0 && { files: filesToSend }),
        },
        callbacks,
      );

      // Finalize the stream
      finalizeStreamLoop(convId, assistantMsgId, loopState);

    } catch (error) {
      console.error("[DynamicAgent] Stream error:", error);

      // Auth failures (401/403/503-pdp_unavailable) come through as
      // StreamError with structured fields populated by the Web UI backend. Surface
      // them as a toast (with sign-in CTA when applicable) instead of
      // burying them inside the assistant turn — see showAuthErrorToast
      // for the rationale.
      const isAuthError = error instanceof StreamError && error.isAuthError();
      if (isAuthError) {
        const se = error as StreamError;
        showAuthErrorToast({
          status: se.status,
          message: se.message,
          code: se.code,
          reason: se.reason,
          action: se.action,
        });
      } else if (!(error as Error).message?.startsWith("Session expired:")) {
        appendToMessage(convId, assistantMsgId, `\n\n**Error:** ${(error as Error).message || "Failed to connect to agent endpoint"}`);
      }
      // Set interrupted status on error
      updateMessage(convId!, assistantMsgId, {
        turnStatus: "interrupted" as TurnStatus,
      });
      setConversationStreaming(convId, null);
    }
  }, [isThisConversationStreaming, activeConversationId, accessToken, agentId, agentProtocol, getActiveConversation, createConversation, clearStreamEvents, addMessage, appendToMessage, updateMessage, setConversationStreaming, buildStreamCallbacks, finalizeStreamLoop, requestReasoningEffort, session?.user, showAuthErrorToast, suppliedClientContext, toast]);

  const submitMessage = useCallback(
    (messageToSend: string, filesToSend: InputFile[] = []) => submitMessageBatch([{
      id: generateId(),
      text: messageToSend,
      files: filesToSend,
    }]),
    [submitMessageBatch],
  );

  const startEditingMessage = useCallback((message: ChatMessageType) => {
    setIsRewindConfirmationOpen(false);
    setEditingMessageId(message.id);
    setEditDraft(message.content);
  }, []);

  const cancelEditingMessage = useCallback(() => {
    if (isSavingEdit) return;
    setIsRewindConfirmationOpen(false);
    setEditingMessageId(null);
    setEditDraft("");
  }, [isSavingEdit]);

  const requestEditedMessageSave = useCallback(() => {
    if (!editingMessageId || !activeConversationId || isSavingEdit) return;
    const targetMessage = getActiveConversation()?.messages.find(
      (message) => message.id === editingMessageId,
    );
    if (!targetMessage) {
      toast("The message is no longer available to edit.", "error", 6000);
      cancelEditingMessage();
      return;
    }
    if (targetMessage.attachments?.some((attachment) => !attachment.data)) {
      toast(
        "This message has an attachment that is no longer available. Re-upload it in a new message instead.",
        "error",
        8000,
      );
      return;
    }
    if (!editDraft.trim() && !targetMessage.attachments?.length) return;
    setIsRewindConfirmationOpen(true);
  }, [
    activeConversationId,
    cancelEditingMessage,
    editDraft,
    editingMessageId,
    getActiveConversation,
    isSavingEdit,
    toast,
  ]);

  const saveEditedMessage = useCallback(async () => {
    if (!editingMessageId || !activeConversationId || isSavingEdit) return;
    const targetMessage = getActiveConversation()?.messages.find(
      (message) => message.id === editingMessageId,
    );
    if (!targetMessage) {
      toast("The message is no longer available to edit.", "error", 6000);
      cancelEditingMessage();
      return;
    }

    const targetAttachments = targetMessage.attachments ?? [];
    if (targetAttachments.some((attachment) => !attachment.data)) {
      setIsRewindConfirmationOpen(false);
      toast(
        "This message has an attachment that is no longer available. Re-upload it in a new message instead.",
        "error",
        8000,
      );
      return;
    }
    if (!editDraft.trim() && targetAttachments.length === 0) return;

    const files: InputFile[] = targetAttachments.map((attachment) => ({
      mime_type: attachment.mime_type,
      name: attachment.name,
      data: attachment.data!,
    }));

    setIsSavingEdit(true);
    try {
      await saveMessagesToServer(activeConversationId);
      await apiClient.rewindConversation(activeConversationId, {
        agent_id: agentId,
        message_id: editingMessageId,
      });
      truncateConversationFromMessage(activeConversationId, editingMessageId);
      setQueuedMessages([]);
      setPendingUserInput(null);
      setPendingToolApproval(null);
      clearConversationInputRequired(activeConversationId);
      dismissedInputForMessageRef.current.clear();
      setIsRewindConfirmationOpen(false);
      setEditingMessageId(null);
      setEditDraft("");
      await submitMessage(editDraft, files);
    } catch (error) {
      toast(
        `Could not edit message: ${error instanceof Error ? error.message : String(error)}`,
        "error",
        8000,
      );
    } finally {
      setIsSavingEdit(false);
    }
  }, [
    activeConversationId,
    agentId,
    cancelEditingMessage,
    clearConversationInputRequired,
    editDraft,
    editingMessageId,
    getActiveConversation,
    isSavingEdit,
    saveMessagesToServer,
    submitMessage,
    toast,
    truncateConversationFromMessage,
  ]);

  // The Home page hero composer creates a conversation and navigates here
  // before a message can be sent (this panel only mounts once a conversation
  // id is in the URL) — pick up its stashed first message and send it once
  // through the normal pipeline rather than duplicating it there.
  const pendingFirstMessageSentRef = useRef(false);
  useEffect(() => {
    if (pendingFirstMessageSentRef.current || panelReadOnly) return;
    const pending = takePendingFirstMessage(conversationId);
    if (pending) {
      pendingFirstMessageSentRef.current = true;
      void submitMessage(pending.text, pending.files);
    }
  }, [conversationId, panelReadOnly, submitMessage]);

  // Flush the entire queue atomically so it creates one assistant turn.
  useEffect(() => {
    if (
      isThisConversationStreaming ||
      queuedMessages.length === 0 ||
      queueFlushInProgressRef.current ||
      pendingUserInput ||
      pendingToolApproval
    ) return;

    const batch = queuedMessages;
    queueFlushInProgressRef.current = true;
    setQueuedMessages([]);
    void submitMessageBatch(batch).finally(() => {
      queueFlushInProgressRef.current = false;
    });
  }, [
    isThisConversationStreaming,
    pendingToolApproval,
    pendingUserInput,
    queuedMessages,
    submitMessageBatch,
  ]);

  // Handle /skills locally so command output stays out of conversation context.
  const handleSkillsCommand = useCallback(async () => {
    if (!agentSkills || agentSkills.length === 0) {
      showCommandPanel({
        title: "Agent skills",
        message: "This agent has no skills configured. You can add skills in the agent editor.",
      });
      return;
    }

    showCommandPanel({ title: "Agent skills", message: "Loading skills…", loading: true });
    try {
      const res = await fetch("/api/skills", { credentials: "include" });
      if (!res.ok) {
        showCommandPanel({
          title: "Agent skills",
          message: "Skills are temporarily unavailable. Please try again later.",
        });
        return;
      }
      const data = await res.json();
      const allSkills = data?.skills || [];
      const skillIdSet = new Set(agentSkills);
      const filtered = allSkills.filter((skill: { id: string }) => skillIdSet.has(skill.id));

      if (filtered.length === 0) {
        showCommandPanel({
          title: "Agent skills",
          message: `This agent has ${agentSkills.length} configured skill(s), but none could be resolved.`,
        });
        return;
      }

      showCommandPanel({
        title: `Agent skills (${filtered.length})`,
        sections: [{
          items: filtered.map((skill: { title?: string; name?: string; description?: string; category?: string }) => ({
            label: skill.title || skill.name || "Untitled",
            description: `${skill.description || "No description"}${skill.category ? ` · ${skill.category}` : ""}`,
            insertText: `Use the ${skill.title || skill.name || "selected"} skill to `,
          })),
        }],
      });
    } catch {
      showCommandPanel({
        title: "Agent skills",
        message: "Skills are temporarily unavailable. Please try again later.",
      });
    }
  }, [agentSkills, showCommandPanel]);

  const handleEffortCommand = useCallback(async (argument: string) => {
    const normalized = argument.trim().toLowerCase();
    if (!["low", "medium", "high", "max"].includes(normalized)) {
      showEffortStatus(
        `Use /effort <low|medium|high|max>. Current effort: ${reasoningEffort}.`,
        "warning",
      );
      return;
    }

    let convId = activeConversationId;
    if (!convId) convId = await createConversation(agentId);
    const result = await persistReasoningEffort(
      normalized as ReasoningEffort,
      "command",
      convId,
    );
    if (result === "changed") {
      if (normalized === "max") {
        setMaxEffortAnimationKey((current) => current + 1);
      } else {
        showEffortStatus(`Reasoning effort changed to ${normalized} for this chat.`, "success");
      }
      return;
    }
    showEffortStatus(
      result === "unsupported"
        ? "This model does not support changing reasoning effort."
        : "Could not save the reasoning effort. Try again.",
      result === "unsupported" ? "warning" : "error",
    );
  }, [activeConversationId, agentId, createConversation, persistReasoningEffort, reasoningEffort, showEffortStatus]);

  // Handle /help locally so its reference list does not become model context.
  const handleHelpCommand = useCallback(() => {
    const mcpItems = Object.entries(agent?.allowed_tools ?? {})
      .filter(([, selection]) => selection !== false)
      .map(([serverId]) => ({
        label: `/@${serverId}`,
        description: "MCP server",
        insertText: `@${serverId} `,
      }));
    const subagentItems = (agent?.subagents ?? []).map((subagent) => ({
      label: `/@${subagent.name || subagent.agent_id}`,
      description: subagent.description || "Configured subagent",
      insertText: `@${subagent.name || subagent.agent_id} `,
    }));

    showCommandPanel({
      title: "Available commands",
      sections: [
        {
          items: [
            { label: "/skills", description: "List available skills", insertText: "/skills" },
            { label: "/effort <low|medium|high|max>", description: "Set reasoning effort for this chat", insertText: "/effort " },
            { label: "/help", description: "Show this help panel", insertText: "/help" },
            { label: "/clear", description: "Start a new conversation and reset context", insertText: "/clear" },
          ],
        },
        ...(mcpItems.length ? [{ title: "MCP servers", items: mcpItems }] : []),
        ...(subagentItems.length ? [{ title: "Subagents", items: subagentItems }] : []),
      ],
    });
  }, [agent, showCommandPanel]);

  // Handle /clear command
  const handleClearCommand = useCallback(async () => {
    await createConversation(agentId);
  }, [createConversation, agentId]);

  const handleStop = useCallback(() => {
    if (activeConversationId) {
      cancelConversationRequest(activeConversationId);
    }
  }, [activeConversationId, cancelConversationRequest]);

  // Unified slash command executor
  const executeSlashCommand = useCallback(async (commandId: string) => {
    switch (commandId) {
      case "skills":
        await handleSkillsCommand();
        break;
      case "help":
        handleHelpCommand();
        break;
      case "clear":
        await handleClearCommand();
        break;
    }
  }, [handleSkillsCommand, handleHelpCommand, handleClearCommand]);

  // Stage files onto the composer, validating type + size caps first and
  // toasting anything rejected so the user knows why it didn't attach.
  const addFiles = useCallback((incoming: File[]) => {
    if (incoming.length === 0) return;
    setAttachments((prev) => {
      const { accepted, rejected } = validateFiles(
        prev.map((a) => a.file),
        incoming,
      );
      if (rejected.length > 0) {
        const detail = rejected.map((r) => `${r.name}: ${r.reason}`).join("\n");
        toast(
          `${rejected.length} file${rejected.length > 1 ? "s" : ""} not attached\n${detail}`,
          "error",
          6000,
        );
      }
      if (accepted.length === 0) return prev;
      const staged = accepted.map((file) => ({
        id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        file,
      }));
      return [...prev, ...staged];
    });
  }, [toast]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files));
    // Reset so selecting the same file again re-triggers change.
    e.target.value = "";
  }, [addFiles]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      addFiles(files);
    }
  }, [addFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFiles(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) addFiles(files);
  }, [addFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      setIsDraggingFiles(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the composer entirely, not when moving between
    // its children (relatedTarget stays inside the container in that case).
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDraggingFiles(false);
    }
  }, []);

  // Wrapper for form submission that uses input state
  const handleSubmit = useCallback(async (forceSend = false) => {
    // Allow a turn with text OR attachments (a file-only send is valid).
    if (!input.trim() && attachments.length === 0) return;

    // Check for slash commands via the registry
    const trimmed = input.trim();
    const effortMatch = trimmed.match(/^\/effort(?:\s+(.*))?$/i);
    if (effortMatch) {
      setInput("");
      await handleEffortCommand(effortMatch[1] ?? "");
      return;
    }
    if (trimmed.startsWith("/")) {
      const cmdName = trimmed.slice(1).toLowerCase();
      const cmd = slashCommands.find(
        (c) => c.action === "execute" && c.id === cmdName,
      );
      if (cmd) {
        setInput("");
        await executeSlashCommand(cmd.id);
        return;
      }
    }

    // Encode staged attachments once, up front, so both the queue and the
    // direct-send path carry the same InputFile[] shape the backend expects.
    const encodedFiles: InputFile[] = attachments.length
      ? await Promise.all(attachments.map((a) => fileToInputFile(a.file)))
      : [];

    // While a response streams, retain each prompt as a distinct queued bubble.
    if (isThisConversationStreaming && !forceSend) {
      const message = input.trim();
      setQueuedMessages(prev => [...prev, {
        id: generateId(),
        text: message,
        files: encodedFiles,
      }]);
      setInput("");
      setAttachments([]);
      return;
    }

    // If streaming and force sending, stop current task first
    if (isThisConversationStreaming && forceSend) {
      handleStop();
      // Clear queued messages when force sending
      setQueuedMessages([]);
      // Wait a bit for cancellation to process
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const message = input.trim();

    // Dismiss any pending input form when user types text directly
    if (pendingUserInput) {
      dismissedInputForMessageRef.current.add(pendingUserInput.messageId);
      setPendingUserInput(null);
    }

    setInput("");
    setAttachments([]);

    await submitMessage(message, encodedFiles);
  }, [input, attachments, submitMessage, isThisConversationStreaming, pendingUserInput, slashCommands, executeSlashCommand, handleEffortCommand, handleStop]);

  // Auto-submit pending message from use case selection
  useEffect(() => {
    const pendingMessage = consumePendingMessage();
    if (pendingMessage) {
      submitMessage(pendingMessage);
    }
  }, [activeConversationId, consumePendingMessage, submitMessage]);

  // Stable callback for feedback changes
  const handleFeedbackChange = useCallback((messageId: string, feedback: Feedback) => {
    if (activeConversationId) {
      updateMessageFeedback(activeConversationId, messageId, feedback);
    }
  }, [activeConversationId, updateMessageFeedback]);

  // Handle user input form submission via SSE/Dynamic Agents resume
  const handleUserInputSubmitSSE = useCallback(async (formData: Record<string, string>) => {
    if (!pendingUserInput || !activeConversationId || !pendingUserInput.agentId) return;

    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const selectionSummary = Object.entries(formData)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
    addMessage(activeConversationId, { role: "user", content: selectionSummary || "Form submitted." }, turnId);
    const assistantMsgId = addMessage(activeConversationId, { role: "assistant", content: "" }, turnId);

    dismissedInputForMessageRef.current.add(pendingUserInput.messageId);
    const resumeAgentId = pendingUserInput.agentId;
    setPendingUserInput(null);

    // Resume continues the existing LangGraph task namespace, but the server
    // does not repeat its parent `task` start. Seed active task starts into the
    // new turn so resumed child events retain their subagent timeline.
    const resumeSeedEvents = createSubagentResumeSeedEvents(
      getActiveConversation()?.streamEvents ?? [],
    );
    clearStreamEvents(activeConversationId);
    for (const event of resumeSeedEvents) {
      addStreamEvent(event, activeConversationId);
    }

    // Create protocol-agnostic adapter for resume
    const adapter = createStreamAdapter({
      protocol: agentProtocol as "custom" | "agui",
      accessToken,
    });

    // Build client context for system prompt rendering and user_info tool
    const conv = getActiveConversation();
    const clientContext: Record<string, unknown> = {
      source: "webui",
      ...suppliedClientContext,
      ...(conv?.sharing && { chat_sharing: conv.sharing }),
    };

    // Send form data as discriminated resume payload
    const formDataJson = JSON.stringify({ type: "form_input", values: formData });

    setConversationStreaming(activeConversationId, {
      conversationId: activeConversationId,
      messageId: assistantMsgId,
      client: { abort: () => adapter.abort() },
      streamAdapter: adapter,
    });

    const loopState: StreamLoopState = {
      accumulatedText: "",
      rawStreamContent: "",
      hitlFormRequested: false,
      hasError: false,
      startedAt: Date.now(),
    };
    const toolCallIdToName = new Map<string, string>();

    try {
      const callbacks = buildStreamCallbacks(activeConversationId, assistantMsgId, loopState, toolCallIdToName);

      await adapter.resumeStream(
        { conversationId: activeConversationId, agentId: resumeAgentId, resumeData: formDataJson, reasoningEffort: requestReasoningEffort, clientContext },
        callbacks,
      );

      // Finalize the stream
      finalizeStreamLoop(activeConversationId, assistantMsgId, loopState);

    } catch (error) {
      console.error("[DynamicAgent] HITL resume error:", error);
      appendToMessage(activeConversationId, assistantMsgId,
        `\n\n**Error:** ${(error as Error).message || "Failed to resume"}`);
      updateMessage(activeConversationId, assistantMsgId, { turnStatus: "interrupted" as TurnStatus });
      setConversationStreaming(activeConversationId, null);
    }
  }, [pendingUserInput, activeConversationId, accessToken, agentProtocol, addMessage, updateMessage,
      appendToMessage, addStreamEvent, setConversationStreaming,
      clearStreamEvents, getActiveConversation, buildStreamCallbacks, finalizeStreamLoop,
      suppliedClientContext, requestReasoningEffort]);

  // Handle tool approval decisions (approve/reject/edit)
  // Shows cards sequentially; only resumes after all tools are decided.
  const handleToolApprovalDecision = useCallback(async (
    decision: "approve" | "reject" | "edit",
    editedArgs?: Record<string, unknown>,
  ) => {
    if (!pendingToolApproval || !activeConversationId) return;

    const { tools, currentIndex, decisions } = pendingToolApproval;
    const currentTool = tools[currentIndex];

    // Accumulate this decision
    const newDecisions = [
      ...decisions,
      { decision, toolName: currentTool.toolName, editedArgs },
    ];

    // If there are more tools to decide, advance to the next card
    if (currentIndex + 1 < tools.length) {
      setPendingToolApproval({
        ...pendingToolApproval,
        currentIndex: currentIndex + 1,
        decisions: newDecisions,
      });
      return;
    }

    // All tools decided — send the resume with all decisions
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const summaryParts = newDecisions.map(d => {
      const label = d.decision === "approve" ? "Approved" : d.decision === "reject" ? "Rejected" : "Edited & approved";
      return `${label} \`${d.toolName}\``;
    });
    addMessage(activeConversationId, {
      role: "user",
      content: summaryParts.join("\n"),
    }, turnId);
    const assistantMsgId = addMessage(activeConversationId, { role: "assistant", content: "" }, turnId);

    const resumeAgentId = pendingToolApproval.agentId;
    setPendingToolApproval(null);

    const resumeSeedEvents = createSubagentResumeSeedEvents(
      getActiveConversation()?.streamEvents ?? [],
    );
    clearStreamEvents(activeConversationId);
    for (const event of resumeSeedEvents) {
      addStreamEvent(event, activeConversationId);
    }

    const adapter = createStreamAdapter({
      protocol: agentProtocol as "custom" | "agui",
      accessToken,
    });

    const clientContext: Record<string, unknown> = {
      source: "webui",
      ...suppliedClientContext,
    };

    // Build resume payload using the format expected by the runtime.
    let resumePayload: Record<string, unknown>;
    if (newDecisions.length === 1) {
      // Single-decision payload keeps the common approval path compact.
      const d = newDecisions[0];
      if (d.decision === "edit" && d.editedArgs) {
        resumePayload = { type: "tool_approval", decision: "edit", edited_args: d.editedArgs };
      } else {
        resumePayload = { type: "tool_approval", decision: d.decision };
      }
    } else {
      // Multi-tool — use batched format
      resumePayload = {
        type: "tool_approval",
        decisions: newDecisions.map(d => {
          if (d.decision === "edit" && d.editedArgs) {
            return { decision: "edit", tool_name: d.toolName, edited_args: d.editedArgs };
          }
          return { decision: d.decision };
        }),
      };
    }
    const resumeData = JSON.stringify(resumePayload);

    setConversationStreaming(activeConversationId, {
      conversationId: activeConversationId,
      messageId: assistantMsgId,
      client: { abort: () => adapter.abort() },
      streamAdapter: adapter,
    });

    const loopState: StreamLoopState = {
      accumulatedText: "",
      rawStreamContent: "",
      hitlFormRequested: false,
      hasError: false,
      startedAt: Date.now(),
    };
    const toolCallIdToName = new Map<string, string>();

    try {
      const callbacks = buildStreamCallbacks(activeConversationId, assistantMsgId, loopState, toolCallIdToName);
      await adapter.resumeStream(
        { conversationId: activeConversationId, agentId: resumeAgentId, resumeData, reasoningEffort: requestReasoningEffort, clientContext },
        callbacks,
      );
      finalizeStreamLoop(activeConversationId, assistantMsgId, loopState);
    } catch (error) {
      console.error("[DynamicAgent] Tool approval resume error:", error);
      updateMessage(activeConversationId, assistantMsgId, {
        error: (error as Error).message || "Failed to resume",
        turnStatus: "interrupted" as TurnStatus,
      });
      setConversationStreaming(activeConversationId, null);
    }
  }, [pendingToolApproval, activeConversationId, accessToken, agentProtocol, addMessage, updateMessage,
      addStreamEvent, setConversationStreaming, clearStreamEvents, getActiveConversation,
      buildStreamCallbacks, finalizeStreamLoop, suppliedClientContext, requestReasoningEffort]);

  // Handle slash command detection in input
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setCommandPanel(null);
    setInput(newValue);

    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = newValue.slice(0, cursorPos);

    // Detect / at start of input or after a newline
    const lastSlash = textBeforeCursor.lastIndexOf("/");
    if (lastSlash !== -1) {
      const charBefore = lastSlash > 0 ? textBeforeCursor[lastSlash - 1] : undefined;
      const isAtStart = lastSlash === 0 || charBefore === "\n";

      if (isAtStart) {
        const filterText = textBeforeCursor.slice(lastSlash + 1);
        if (!filterText.includes(" ") && !filterText.includes("\n")) {
          setSlashFilter(filterText);
          setShowSlashMenu(true);
          setSlashSelectedIndex(0);
          return;
        }
      }
    }

    setShowSlashMenu(false);
  }, []);

  // Handle slash command selection (Tab/Enter/click)
  const handleSlashSelect = useCallback((cmd: SlashCommand) => {
    setShowSlashMenu(false);

    if (cmd.action === "execute") {
      setInput("");
      executeSlashCommand(cmd.id);
      return;
    }

    // Insert commands
    if (cmd.category === "mcp" || cmd.category === "subagent") {
      // Agent: replace /text with @agentname + trailing space
      const cursorPos = inputRef.current?.selectionStart ?? input.length;
      const textBeforeCursor = input.slice(0, cursorPos);
      const lastSlash = textBeforeCursor.lastIndexOf("/");
      const textBefore = lastSlash >= 0 ? input.slice(0, lastSlash) : "";
      const textAfter = input.slice(cursorPos);
      const newText = textBefore + cmd.value + " " + textAfter;

      setInput(newText);
      setTimeout(() => {
        if (inputRef.current) {
          const newPos = textBefore.length + cmd.value.length + 1;
          inputRef.current.selectionStart = newPos;
          inputRef.current.selectionEnd = newPos;
          inputRef.current.focus();
        }
      }, 0);
    } else if (cmd.category === "skill") {
      // Skill: send a rich prompt so the runtime recognizes the skill invocation.
      setInput("");
      const skillPrompt = `Execute skill: ${cmd.value}\n\nRead and follow the instructions in the SKILL.md file for the "${cmd.value}" skill.`;
      submitMessage(skillPrompt).then(() => {
        const convId = activeConversationId;
        if (convId) {
          updateConversationTitle(convId, `Skill: ${cmd.label}`);
        }
      });
    } else if (cmd.category === "command") {
      setInput(cmd.value);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [input, executeSlashCommand, submitMessage, activeConversationId, updateConversationTitle]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (commandPanel) {
      if (e.key === "Escape") {
        e.preventDefault();
        setCommandPanel(null);
        return;
      }
      if (commandPanelItems.length > 0 && e.key === "ArrowDown") {
        e.preventDefault();
        setCommandPanelSelectedIndex((current) => (current + 1) % commandPanelItems.length);
        return;
      }
      if (commandPanelItems.length > 0 && e.key === "ArrowUp") {
        e.preventDefault();
        setCommandPanelSelectedIndex(
          (current) => (current - 1 + commandPanelItems.length) % commandPanelItems.length,
        );
        return;
      }
      if (commandPanelItems.length > 0 && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectCommandPanelItem(commandPanelItems[commandPanelSelectedIndex]);
        return;
      }
    }

    // Slash menu keyboard navigation
    if (showSlashMenu) {
      const filtered = getFilteredCommands(slashCommands, slashFilter);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashSelectedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        if (filtered.length > 0) {
          handleSlashSelect(filtered[slashSelectedIndex]);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSlashMenu(false);
        return;
      }
    }

    // Force send: Cmd/Ctrl + Enter
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit(true); // Force send
      return;
    }
    // Normal send: Enter
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(false);
    }
  };

  return (
    <div className="h-full w-full flex flex-col bg-background relative">
      {/* Messages Area */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <ScrollArea className="flex-1" viewportRef={scrollViewportRef}>
          <div className="max-w-7xl mx-auto pl-1 pr-1 py-4 space-y-6">
            {!conversation?.messages.length && (
              <div className="text-center py-20">
                {isLoadingMessages ? (
                  <>
                    <div className="w-16 h-16 mx-auto mb-6 rounded-2xl gradient-primary-br flex items-center justify-center">
                      <Loader2 className="h-8 w-8 text-white animate-spin" />
                    </div>
                    <h2 className="text-2xl font-bold mb-2">Loading conversation...</h2>
                    <p className="text-muted-foreground max-w-md mx-auto mb-1">
                      Retrieving your conversation history
                    </p>
                  </>
                ) : (
                  <>
                    <AgentAvatar
                      agent={agent}
                      agentId={agentId}
                      rounded="rounded-2xl"
                      size="w-16 h-16 mx-auto mb-6"
                      iconSize="h-8 w-8"
                      icon={Sparkles}
                      useGlobalTheme
                    />
                    <h2 className="text-2xl font-bold mb-4">Welcome to {getConfig('appName')}</h2>
                    <p className="text-muted-foreground mb-3">
                      Start your conversation with
                    </p>
                    <div className="flex items-center justify-center gap-3">
                      <AgentAvatar
                        agent={agent}
                        agentId={agentId}
                        rounded="rounded-lg"
                        size="w-8 h-8"
                        iconSize="h-4 w-4"
                        useGlobalTheme
                      />
                      <span className="text-lg font-semibold">
                        {agentName || "your agent"}
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}

            <AnimatePresence mode="popLayout">
              {(() => {
                const allMessages = deduplicateByKey(conversation?.messages ?? [], (msg) => msg.id);

                return (
                  <>
                    {activeConversationId && messageHistory[activeConversationId]?.isLoadingOlder && (
                      <div className="flex justify-center py-3" aria-label="Loading earlier messages">
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      </div>
                    )}

                    {allMessages.map((msg, index, arr) => {
                      const isLastMessage = index === arr.length - 1;
                      const isAssistantStreaming = isThisConversationStreaming && msg.role === "assistant" && isLastMessage;
                      const messageOwner = msg.senderEmail ?? conversation?.owner_id;
                      const isOwnMessage = !messageOwner || !session?.user?.email ||
                        messageOwner === session.user.email;
                      const isConversationOwner = !conversation?.owner_id || !session?.user?.email ||
                        conversation.owner_id === session.user.email;
                      const isLocalCommand = msg.content.trim() === "/skills" ||
                        msg.content.trim() === "/help";
                      const canEditMessage = msg.role === "user" &&
                        isOwnMessage &&
                        isConversationOwner &&
                        !isLocalCommand &&
                        !panelReadOnly &&
                        !isThisConversationStreaming &&
                        !pendingUserInput &&
                        !pendingToolApproval;

                      // Check if this is the last assistant message (latest answer)
                      const isLastAssistantMessage = msg.role === "assistant" &&
                        index === arr.length - 1;

                      // Get SSE events for this message turn:
                      // - For completed messages: use msg.streamEvents (persisted with the message)
                      // - For streaming (latest message): use conversation.streamEvents (live buffer)
                      // - Fall back to timestamp-based filtering if msg.streamEvents is not available
                      const isStreaming = isLastAssistantMessage && isThisConversationStreaming;
                      let turnEvents: StreamEvent[];
                      
                      if (msg.role !== "assistant") {
                        turnEvents = [];
                      } else if (isStreaming) {
                        // Streaming: use live buffer from conversation
                        turnEvents = conversation?.streamEvents ?? [];
                      } else if (msg.streamEvents && msg.streamEvents.length > 0) {
                        // Completed message with persisted events
                        turnEvents = msg.streamEvents;
                      } else {
                        // Fall back when a message has no persisted stream events.
                        turnEvents = filterEventsForTurn(
                          conversation?.streamEvents ?? [],
                          msg,
                          allMessages,
                          allMessages.findIndex(m => m.id === msg.id)
                        );
                      }

                      return (
                        <ChatMessage
                          key={msg.id}
                          message={msg}
                          onCopy={handleCopy}
                          canEdit={canEditMessage}
                          isEditing={editingMessageId === msg.id}
                          editDraft={editingMessageId === msg.id ? editDraft : undefined}
                          isSavingEdit={isSavingEdit && editingMessageId === msg.id}
                          onStartEdit={() => startEditingMessage(msg)}
                          onEditDraftChange={setEditDraft}
                          onCancelEdit={cancelEditingMessage}
                          onSaveEdit={requestEditedMessageSave}
                          isCopied={copiedId === msg.id}
                          isStreaming={isAssistantStreaming}
                          isLatestAnswer={isLastAssistantMessage}
                          feedback={msg.feedback}
                          onFeedbackChange={(feedback) => handleFeedbackChange(msg.id, feedback)}
                          isRecovering={recoveringMessageId === msg.id}
                          conversationId={conversationId}
                          userDisplayName={userDisplayName}
                          showTimestamp={showTimestamps}
                          agentGradient={agentGradient}
                          agentCustomTheme={agentCustomTheme}
                          agentId={agentId}
                          agentName={agentName}
                          turnEvents={turnEvents}
                          // Timeline props (only passed to latest message)
                          timelineFiles={timelineFiles}
                          timelineTasks={timelineTasks}
                          onFileDownload={handleTimelineFileDownload}
                          getFileContent={handleGetFileContent}
                          onFileDelete={handleTimelineFileDelete}
                          isDownloadingFile={isDownloadingFile}
                          downloadingFilePath={downloadingFilePath}
                           isDeletingFile={isDeletingFile}
                          deletingFilePath={deletingFilePath}
                          getSubagentInfo={getSubagentInfo}
                          pendingHitl={!!(pendingUserInput || pendingToolApproval)}
                        />
                      );
                    })}
                  </>
                );
              })()}
            </AnimatePresence>

            {/* User Input Form */}
            {pendingUserInput && pendingUserInput.metadata.input_fields && (
              <MetadataInputForm
                messageId={pendingUserInput.messageId}
                title={pendingUserInput.metadata.input_title}
                description={pendingUserInput.metadata.input_description}
                inputFields={pendingUserInput.metadata.input_fields}
                onSubmit={handleUserInputSubmitSSE}
                onCancel={() => {
                  if (pendingUserInput) {
                    dismissedInputForMessageRef.current.add(pendingUserInput.messageId);
                    // For SSE, send dismissal message to resume the agent
                    if (pendingUserInput.isSSE && pendingUserInput.agentId && activeConversationId) {
                      const dismissAdapter = createStreamAdapter({
                        protocol: agentProtocol as "custom" | "agui",
                        accessToken,
                      });
                      // Fire-and-forget: resume with rejection message
                      const dismissalPayload = JSON.stringify({ type: "form_input", dismissed: true });
                      dismissAdapter.resumeStream(
                        {
                          conversationId: activeConversationId,
                          agentId: pendingUserInput.agentId,
                          resumeData: dismissalPayload,
                          reasoningEffort: requestReasoningEffort,
                        },
                        {}, // No callbacks — we don't render the response
                      ).catch((err) => {
                        console.error("[ChatPanel] Error sending SSE form dismissal:", err);
                      });
                    }
                  }
                  setPendingUserInput(null);
                }}
                disabled={isThisConversationStreaming}
              />
            )}

            {/* Tool Approval Card */}
            {pendingToolApproval && (() => {
              const currentTool = pendingToolApproval.tools[pendingToolApproval.currentIndex];
              const total = pendingToolApproval.tools.length;
              const current = pendingToolApproval.currentIndex + 1;
              return (
                <ToolApprovalCard
                  toolName={total > 1 ? `${currentTool.toolName} (${current}/${total})` : currentTool.toolName}
                  toolArgs={currentTool.toolArgs}
                  allowedDecisions={currentTool.allowedDecisions}
                  onApprove={() => handleToolApprovalDecision("approve")}
                  onReject={() => handleToolApprovalDecision("reject")}
                  onEdit={(editedArgs) => handleToolApprovalDecision("edit", editedArgs)}
                  disabled={isThisConversationStreaming}
                  totalCount={total}
                />
              );
            })()}

            {/* Loading indicator while checking for pending HITL interrupt */}
            {checkingInterrupt && !pendingUserInput && !pendingToolApproval && (
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Checking conversation state...</span>
              </div>
            )}

            {/* Invisible marker for scroll-to-bottom */}
            <div ref={messagesEndRef} className="h-px" />
          </div>
        </ScrollArea>
      </div>

      {/* Scroll to bottom button */}
      <AnimatePresence>
        {showScrollButton && conversation?.messages.length && (
          <motion.div
            initial={{ opacity: 0, scale: 0.8, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 10 }}
            transition={{ duration: 0.2 }}
            className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10"
          >
            <Button
              onClick={() => scrollToBottom("smooth")}
              size="sm"
              variant="secondary"
              className="rounded-full shadow-lg border border-border/50 gap-1.5 px-4 hover:bg-primary hover:text-primary-foreground transition-colors"
            >
              <ArrowDown className="h-4 w-4" />
              <span className="text-xs font-medium">New messages</span>
            </Button>
          </motion.div>
        )}
      </AnimatePresence>

      {apiConversation && (
        <div
          role="note"
          className="shrink-0 border-t border-amber-500/30 bg-amber-500/10 px-6 py-2.5 text-amber-800 dark:text-amber-300"
        >
          <div className="mx-auto flex max-w-7xl items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="text-xs">
              <span className="font-medium">API-linked chat.</span>{" "}
              Messages sent here update the same conversation used by the API. Continuing here may interfere with that API chat, especially if both clients send at the same time.
            </p>
          </div>
        </div>
      )}

      {/* Input Area - Fixed bottom, doesn't scroll */}
      {panelReadOnly ? (
        <div className={`border-t border-border shrink-0 ${panelReadOnlyReason === 'agent_deleted' || panelReadOnlyReason === 'agent_disabled' ? 'bg-red-500/10' : 'bg-amber-500/10'}`}>
          <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
            <div className={`flex items-center gap-2 ${panelReadOnlyReason === 'agent_deleted' || panelReadOnlyReason === 'agent_disabled' ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`}>
              <ShieldCheck className="h-4 w-4 shrink-0" />
              {panelReadOnlyReason === 'admin_audit' ? (
                <>
                  <span className="text-sm font-medium">Read-Only Audit Mode</span>
                  <span className="text-xs text-amber-600 dark:text-amber-500">— You are viewing this conversation as an admin auditor.</span>
                </>
              ) : panelReadOnlyReason === 'agent_deleted' ? (
                <>
                  <span className="text-sm font-medium">Agent No Longer Available</span>
                  <span className="text-xs text-red-600 dark:text-red-500">— This agent has been deprecated or deleted. You can view the history but cannot send new messages.</span>
                </>
              ) : panelReadOnlyReason === 'agent_disabled' ? (
                <>
                  <span className="text-sm font-medium">Agent Disabled</span>
                  <span className="text-xs text-red-600 dark:text-red-500">— This agent has been disabled by an administrator. You can view the history but cannot send new messages.</span>
                </>
              ) : (
                <>
                  <span className="text-sm font-medium">View Only</span>
                  <span className="text-xs text-amber-600 dark:text-amber-500">— This conversation was shared with you as read-only.</span>
                </>
              )}
            </div>
            {panelReadOnlyReason === 'admin_audit' ? (
            <NavigationProgressLink
              href="/admin/insights/feedback"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-amber-600/20 text-amber-700 dark:text-amber-300 hover:bg-amber-600/30 transition-colors"
            >
              <ArrowLeft className="h-3 w-3" />
              Back to Feedback
            </NavigationProgressLink>
            ) : (panelReadOnlyReason === 'agent_deleted' || panelReadOnlyReason === 'agent_disabled') ? (
            <div className="flex items-center gap-2 flex-wrap">
              {showAgentPicker ? (
                <>
                  <div className="w-56">
                    <AgentPicker
                      options={availableAgents}
                      value={chosenAgentId}
                      onChange={setChosenAgentId}
                      placeholder="Select an agent…"
                      hideIdSuffix
                    />
                  </div>
                  <button
                    onClick={handleResumeWithChosenAgent}
                    disabled={!chosenAgentId}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-red-600/20 text-red-700 dark:text-red-300 hover:bg-red-600/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Resume
                  </button>
                  <button
                    onClick={() => setShowAgentPicker(false)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={handleStartNewConversation}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-red-600/20 text-red-700 dark:text-red-300 hover:bg-red-600/30 transition-colors"
                  >
                    Resume with default agent
                  </button>
                  <button
                    onClick={() => setShowAgentPicker(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-muted text-muted-foreground hover:bg-muted/80 transition-colors"
                  >
                    Choose agent
                  </button>
                </>
              )}
            </div>
            ) : null}
          </div>
        </div>
      ) : (
      <div className="border-t border-border bg-background shrink-0">
        <div className="max-w-7xl mx-auto px-6 py-3 space-y-2">
          {/* Queued Messages Display */}
          {queuedMessages.length > 0 && (
            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
              <AnimatePresence mode="popLayout">
                {queuedMessages.map((queuedMsg) => (
                  <motion.div
                    key={queuedMsg.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg border border-border/50"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          Queued message:
                        </span>
                        <button
                          onClick={() => {
                            setQueuedMessages(prev => prev.filter((message) => message.id !== queuedMsg.id));
                          }}
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                          title="Remove this queued message"
                        >
                          ×
                        </button>
                      </div>
                      {queuedMsg.text && (
                        <p className="text-sm text-foreground/90 break-words">{queuedMsg.text}</p>
                      )}
                      {queuedMsg.files.length > 0 && (
                        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Paperclip className="h-3 w-3" />
                          {queuedMsg.files.length} attachment{queuedMsg.files.length > 1 ? "s" : ""}
                        </div>
                      )}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}

          <div className="relative">
            <AnimatePresence initial={false} mode="wait">
              {commandPanel && (
                <motion.div
                  ref={commandPanelRef}
                  key={commandPanel.id}
                  role="status"
                  aria-live="polite"
                  className="absolute bottom-[calc(100%+0.5rem)] left-0 z-50 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-popover/95 text-popover-foreground shadow-2xl backdrop-blur"
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 5, scale: 0.99 }}
                  transition={{ duration: 0.18 }}
                >
                  <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
                    <span className="text-sm font-semibold">{commandPanel.title}</span>
                    <button
                      type="button"
                      onClick={() => setCommandPanel(null)}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label="Close command panel"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="max-h-80 overflow-y-auto px-4 py-3">
                    {commandPanel.loading ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {commandPanel.message}
                      </div>
                    ) : commandPanel.message ? (
                      <p className="text-sm text-muted-foreground">{commandPanel.message}</p>
                    ) : (
                      <div className="space-y-4">
                        {commandPanel.sections?.map((section, sectionIndex) => (
                          <section key={`${section.title ?? "items"}-${sectionIndex}`}>
                            {section.title && (
                              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {section.title}
                              </h4>
                            )}
                            <div className="space-y-1">
                              {section.items.map((item) => {
                                const flatIndex = commandPanelItems.indexOf(item);
                                const isSelected = flatIndex === commandPanelSelectedIndex;
                                return (
                                  <button
                                    key={`${item.label}-${item.description}`}
                                    type="button"
                                    data-command-panel-index={flatIndex}
                                    aria-current={isSelected ? "true" : undefined}
                                    onMouseEnter={() => setCommandPanelSelectedIndex(flatIndex)}
                                    onClick={() => selectCommandPanelItem(item)}
                                    className={cn(
                                      "flex w-full gap-3 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                      isSelected ? "bg-primary/10" : "hover:bg-muted/60",
                                    )}
                                    title={`Insert ${item.label}`}
                                  >
                                    <code className="shrink-0 text-xs font-semibold text-foreground">{item.label}</code>
                                    <span className="min-w-0 text-xs text-muted-foreground">{item.description}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </section>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Slash command autocomplete menu */}
            <SlashCommandMenu
              filter={slashFilter}
              commands={slashCommands}
              selectedIndex={slashSelectedIndex}
              onSelect={handleSlashSelect}
              visible={showSlashMenu}
            />

            <div
              className={cn(
                "relative flex flex-col gap-2 bg-card rounded-xl border p-3 transition-all duration-200",
                isDraggingFiles
                  ? "border-primary ring-2 ring-primary/40"
                  : "border-border",
              )}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {maxEffortAnimationKey > 0 && (
                <div
                  key={`max-effort-armor-${maxEffortAnimationKey}`}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-xl"
                  data-testid="max-effort-animation"
                >
                  {!prefersReducedMotion && (
                    <>
                      <motion.span
                        className="absolute inset-y-1 left-0 w-[calc(50%+4rem)] rounded-r-xl border-y border-l border-white/20"
                        style={{
                          background: `linear-gradient(115deg, ${maxEffortTheme.from}, ${maxEffortTheme.to})`,
                          boxShadow: `inset 0 0 18px rgb(255 255 255 / 0.24), 0 0 14px ${maxEffortTheme.to}`,
                        }}
                        initial={{ opacity: 0, x: "-105%" }}
                        animate={{
                          opacity: [0, 0.46, 0.38, 0.28, 0],
                          x: ["-105%", "0%", "0%", "105%", "205%"],
                        }}
                        transition={{ duration: 2.4, times: [0, 0.2, 0.4, 0.78, 1], ease: "easeInOut" }}
                      />
                      <motion.span
                        className="absolute inset-y-1 right-0 w-[calc(50%+4rem)] rounded-l-xl border-y border-r border-white/20"
                        style={{
                          background: `linear-gradient(245deg, ${maxEffortTheme.from}, ${maxEffortTheme.to})`,
                          boxShadow: `inset 0 0 18px rgb(255 255 255 / 0.24), 0 0 14px ${maxEffortTheme.to}`,
                        }}
                        initial={{ opacity: 0, x: "105%" }}
                        animate={{
                          opacity: [0, 0.46, 0.38, 0.28, 0],
                          x: ["105%", "0%", "0%", "-105%", "-205%"],
                        }}
                        transition={{ duration: 2.4, times: [0, 0.2, 0.4, 0.78, 1], ease: "easeInOut" }}
                      />

                      <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center text-sm font-black tracking-tight">
                        {[
                          { letter: "M", x: [0, 0, -24, -52] },
                          { letter: "A", x: [0, 0, 0, 0] },
                          { letter: "X", x: [0, 0, 24, 52] },
                        ].map(({ letter, x }) => (
                          <motion.span
                            key={letter}
                            style={{
                              color: maxEffortTheme.to,
                              textShadow: `0 0 10px ${maxEffortTheme.from}, 0 1px 0 rgb(255 255 255 / 0.65)`,
                            }}
                            initial={{ opacity: 0, scale: 0.7, x: 0 }}
                            animate={{
                              opacity: [0, 1, 1, 0],
                              scale: [0.7, 1.12, 1, 0.94],
                              x,
                            }}
                            transition={{
                              delay: 0.4,
                              duration: 1.55,
                              times: [0, 0.16, 0.62, 1],
                              ease: "easeInOut",
                            }}
                          >
                            {letter}
                          </motion.span>
                        ))}
                      </div>
                    </>
                  )}
                  <motion.span
                    className="absolute inset-0 rounded-xl border-2"
                    style={{ borderColor: maxEffortTheme.to }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: prefersReducedMotion ? [0, 0.75, 0] : [0, 1, 0.55, 0] }}
                    transition={{
                      delay: prefersReducedMotion ? 0 : 0.42,
                      duration: prefersReducedMotion ? 0.55 : 1.65,
                      times: prefersReducedMotion ? [0, 0.5, 1] : [0, 0.22, 0.7, 1],
                      ease: "easeInOut",
                    }}
                  />
                </div>
              )}

              {/* Hidden native picker driven by the paperclip button. */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT_ATTRIBUTE}
                className="hidden"
                onChange={handleFileInputChange}
              />

              {/* Staged attachment previews (above the input row). */}
              <AttachmentChips attachments={attachments} onRemove={removeAttachment} />

              <div className="relative z-20 flex items-end gap-3">
                <AnimatePresence initial={false} mode="wait">
                  {effortStatus && (
                    <motion.span
                      key={effortStatus.id}
                      role="status"
                      aria-live="polite"
                      className={cn(
                        "absolute left-3 right-64 top-0 truncate text-[11px] font-medium max-sm:right-44",
                        effortStatus.tone === "error"
                          ? "text-destructive"
                          : effortStatus.tone === "warning"
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground",
                      )}
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -3 }}
                      transition={{ duration: 0.2 }}
                    >
                      {effortStatus.text}
                    </motion.span>
                  )}
                </AnimatePresence>
                <TextareaAutosize
                  ref={inputRef}
                  aria-label="Message"
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={
                    isThisConversationStreaming
                      ? `Type to queue another message${queuedMessages.length > 0 ? ` (${queuedMessages.length} queued)` : ""}, or Cmd+Enter to send now...`
                      : `Ask anything, or type / to see commands, skills, and agents...`
                  }
                  className="flex-1 bg-transparent resize-none outline-none px-3 py-2.5 text-sm"
                  minRows={1}
                  maxRows={10}
                />
                <div className="relative flex shrink-0 items-center gap-2 pt-5">
                  <span
                    className="absolute right-0 top-0 flex max-w-56 items-center gap-1 whitespace-nowrap text-[10px] font-medium text-muted-foreground max-sm:max-w-40"
                    title={`${agent?.model.id || "Model"} · ${reasoningEffort}`}
                    data-testid="composer-model-effort"
                  >
                    <span className="truncate">{agent?.model.id || "Model"}</span>
                    <span aria-hidden="true">·</span>
                    <span
                      className={cn("text-foreground/80", reasoningEffort === "max" && "font-bold")}
                      style={reasoningEffort === "max"
                        ? {
                            background: `linear-gradient(90deg, ${maxEffortTheme.from}, ${maxEffortTheme.to})`,
                            backgroundClip: "text",
                            color: "transparent",
                            WebkitBackgroundClip: "text",
                            WebkitTextFillColor: "transparent",
                          }
                        : undefined}
                    >
                      {reasoningEffort}
                    </span>
                  </span>

                  {/* Attach files */}
                  <div className="shrink-0">
                    <Button
                      size="icon"
                      onClick={() => fileInputRef.current?.click()}
                      variant="ghost"
                      title="Attach files"
                      aria-label="Attach files"
                    >
                      <Paperclip className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* Send/Stop button - toggles based on streaming state */}
                  <div className="shrink-0">
                    {isThisConversationStreaming ? (
                      <Button
                        size="icon"
                        onClick={handleStop}
                        variant="destructive"
                        title="Stop generating"
                      >
                        <Square className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        onClick={() => handleSubmit(false)}
                        disabled={!input.trim() && attachments.length === 0}
                        variant="default"
                        title="Send message"
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="relative flex min-h-6 items-center justify-center">
            <p className="px-28 text-center text-xs text-muted-foreground max-sm:px-0 max-sm:pr-24">
              {getConfig('appName')} can make mistakes. Verify important info.
              {getConfig('auditLogsEnabled') && ' · Conversations are logged for audit.'}
            </p>
            {showContextUsage && contextUsage && (
              <div className="absolute right-0">
                <ContextUsageIndicator usage={contextUsage} />
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      <RewindConfirmationDialog
        open={isRewindConfirmationOpen}
        messageCount={rewindMessageCount}
        isConfirming={isSavingEdit}
        onCancel={() => setIsRewindConfirmationOpen(false)}
        onConfirm={() => {
          void saveEditedMessage();
        }}
      />
    </div>
  );
}

/**
 * Filter SSE events for a specific message turn based on timestamps.
 * Returns events that occurred between this message and the next user message.
 * 
 * Prefer msg.streamEvents for completed assistant messages because message
 * timestamps can be after all events finished.
 */
function filterEventsForTurn(
  streamEvents: StreamEvent[],
  message: ChatMessageType,
  allMessages: ChatMessageType[],
  messageIndex: number
): StreamEvent[] {
  if (message.role !== "assistant") return [];
  
  const msgTime = new Date(message.timestamp).getTime();
  
  // Find next user message timestamp (or use Infinity for latest)
  let endTime = Infinity;
  for (let i = messageIndex + 1; i < allMessages.length; i++) {
    if (allMessages[i].role === "user") {
      endTime = new Date(allMessages[i].timestamp).getTime();
      break;
    }
  }
  
  // Filter events within this turn's time window
  // Events without timestamps are assumed to be from this turn if it's the latest
  return streamEvents.filter(e => {
    if (!e.timestamp) {
      // For events without timestamps, include only if this is the latest assistant message
      return messageIndex === allMessages.length - 1 || 
             (messageIndex === allMessages.length - 2 && allMessages[allMessages.length - 1].role === "assistant");
    }
    const eventTime = new Date(e.timestamp).getTime();
    return eventTime >= msgTime && eventTime < endTime;
  });
}

interface ChatMessageProps {
  message: ChatMessageType;
  onCopy: (content: string, id: string) => void;
  canEdit?: boolean;
  isEditing?: boolean;
  editDraft?: string;
  isSavingEdit?: boolean;
  onStartEdit?: () => void;
  onEditDraftChange?: (value: string) => void;
  onCancelEdit?: () => void;
  onSaveEdit?: () => void;
  isCopied: boolean;
  isStreaming?: boolean;
  isLatestAnswer?: boolean;
  feedback?: Feedback;
  onFeedbackChange?: (feedback: Feedback) => void;
  conversationId?: string;
  isRecovering?: boolean;
  userDisplayName?: string;
  showTimestamp?: boolean;
  agentGradient?: string | null;
  agentCustomTheme?: import("@/types/dynamic-agent").CustomThemeConfig | null;
  agentId?: string | null;
  agentName?: string;
  turnEvents?: StreamEvent[];
  // Timeline props (for AgentTimeline)
  timelineFiles?: string[];
  timelineTasks?: TaskItem[];
  onFileDownload?: (path: string) => void;
  getFileContent?: (path: string) => Promise<string | null>;
  onFileDelete?: (path: string) => void;
  isDownloadingFile?: boolean;
  downloadingFilePath?: string;
  isDeletingFile?: boolean;
  deletingFilePath?: string;
  getSubagentInfo?: (agentId: string) => SubagentLookupInfo | undefined;
  pendingHitl?: boolean;
}

const ChatMessage = React.memo(function ChatMessage({
  message,
  onCopy,
  canEdit = false,
  isEditing = false,
  editDraft = "",
  isSavingEdit = false,
  onStartEdit,
  onEditDraftChange,
  onCancelEdit,
  onSaveEdit,
  isCopied,
  isStreaming = false,
  isLatestAnswer = false,
  feedback,
  onFeedbackChange,
  conversationId,
  isRecovering = false,
  userDisplayName = "You",
  showTimestamp = false,
  agentGradient,
  agentCustomTheme,
  agentId,
  agentName,
  turnEvents = [],
  // Timeline props
  timelineFiles = [],
  timelineTasks = [],
  onFileDownload,
  getFileContent,
  onFileDelete,
  isDownloadingFile,
  downloadingFilePath,
  isDeletingFile,
  deletingFilePath,
  getSubagentInfo,
  pendingHitl = false,
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const [isHovered, setIsHovered] = useState(false);

  const displayContent = message.content;

  // Transform SSE events into grouped timeline data for assistant messages
  // Use turnStatus from message (defaults to "done" for backward compatibility)
  const { data: timelineData } = useAgentTimeline(
    turnEvents, 
    isStreaming, 
    message.turnStatus
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className={cn(
        "flex gap-3 group px-3",
        isUser ? "flex-row-reverse" : "flex-row"
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {isUser ? (
            <div
              className={cn(
            "w-9 h-9 rounded-xl flex items-center justify-center shrink-0 shadow-sm overflow-hidden bg-primary",
          )}
        >
          {message.senderImage ? (
            <Image
              src={message.senderImage}
              alt={message.senderName || userDisplayName}
              width={36}
              height={36}
              unoptimized
              className="w-9 h-9 rounded-xl object-cover"
            />
          ) : (
            <User className="h-4 w-4 text-white" />
          )}
        </div>
      ) : (
        <AgentAvatar
          agentId={agentId}
          gradientTheme={agentGradient}
          customThemeConfig={agentCustomTheme}
          rounded="rounded-xl"
          size="w-9 h-9"
          iconSize="h-4 w-4"
          isStreaming={isStreaming}
          className="overflow-hidden"
        />
      )}

      <div className={cn(
        "flex-1 min-w-0",
        isUser ? "max-w-[85%] text-right ml-auto" : "max-w-full"
      )}>
        <div className={cn(
          "flex items-center mb-1.5",
          isUser
            ? "text-primary justify-end"
            : "text-muted-foreground justify-between"
        )}>
          {isUser ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">
                {message.senderName
                  ? message.senderName.split(" ")[0]
                  : userDisplayName}
              </span>
              {showTimestamp && (
                <span className="text-[10px] text-muted-foreground/60 font-normal">
                  {message.timestamp instanceof Date
                    ? message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{agentName || getConfig('appName')}</span>
                {showTimestamp && (
                  <span className="text-[10px] text-muted-foreground/60 font-normal">
                    {message.timestamp instanceof Date
                      ? message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
              </div>
            </>
          )}
        </div>

        {isUser ? (
          // ── User message bubble ──
          <>
            {message.attachments && message.attachments.length > 0 && (
              <div className="mb-2 flex w-full justify-end">
                <MessageAttachments attachments={message.attachments} align="end" />
              </div>
            )}
            {isEditing ? (
              <div className="ml-auto w-full max-w-2xl rounded-xl border border-primary/40 bg-card p-3 text-left shadow-sm">
                <TextareaAutosize
                  autoFocus
                  minRows={2}
                  maxRows={12}
                  value={editDraft}
                  disabled={isSavingEdit}
                  onChange={(event) => onEditDraftChange?.(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      onCancelEdit?.();
                    }
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      onSaveEdit?.();
                    }
                  }}
                  className="w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
                  aria-label="Edit message"
                />
                <div className="mt-3 flex items-center justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={isSavingEdit}
                    onClick={onCancelEdit}
                  >
                    <X className="mr-1.5 h-3.5 w-3.5" />
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={isSavingEdit || (!editDraft.trim() && !message.attachments?.length)}
                    onClick={onSaveEdit}
                  >
                    {isSavingEdit ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Save and send
                  </Button>
                </div>
              </div>
            ) : message.content.trim() ? (
              <div
                className="rounded-xl rounded-tr-sm relative overflow-hidden inline-block bg-primary text-primary-foreground px-4 py-3 max-w-full selection:bg-primary-foreground selection:text-primary"
              >
                <div className="overflow-hidden break-words text-left" style={{ overflowWrap: 'anywhere' }}>
                  <MarkdownRenderer content={message.content} variant="user" />
                </div>
              </div>
            ) : null}

            {!isEditing && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: isHovered ? 1 : 0.8 }}
                className="flex items-center gap-1 mt-2 justify-end"
              >
                {canEdit && onStartEdit && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                          onClick={onStartEdit}
                          aria-label="Edit message"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Edit message and rewind conversation
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                        onClick={() => onCopy(message.content, message.id)}
                      >
                        {isCopied ? (
                          <Check className="h-3.5 w-3.5 text-green-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {isCopied ? "Copied!" : "Copy message"}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </motion.div>
            )}
          </>
        ) : (
          // ── Assistant message ──
          <>
            {/* Recovery / interrupted banner */}
            {(isRecovering || message.isInterrupted) && (
              <motion.div
                initial={{ opacity: 0, y: -5 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                  "flex items-center gap-3 px-4 py-3 rounded-lg border mb-3",
                  isRecovering
                    ? "bg-sky-500/10 border-sky-500/30 text-sky-400"
                    : "bg-amber-500/10 border-amber-500/30 text-amber-400"
                )}
              >
                {isRecovering ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Recovering interrupted task...</p>
                    </div>
                  </>
                ) : (
                  <>
                    <Activity className="h-4 w-4 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">Response was interrupted</p>
                    </div>
                  </>
                )}
              </motion.div>
            )}

            {/* Main content: timeline (streaming or completed with events) or fallback */}
            {isStreaming || turnEvents.length > 0 ? (
              <AgentTimeline
                data={timelineData}
                files={isLatestAnswer ? timelineFiles : []}
                tasks={isLatestAnswer ? timelineTasks : []}
                isLatestMessage={isLatestAnswer}
                onFileDownload={onFileDownload}
                getFileContent={getFileContent}
                onFileDelete={onFileDelete}
                isDownloadingFile={isDownloadingFile}
                downloadingFilePath={downloadingFilePath}
                isDeletingFile={isDeletingFile}
                deletingFilePath={deletingFilePath}
                getSubagentInfo={getSubagentInfo}
                pendingHitl={pendingHitl}
              />
            ) : displayContent ? (
              // Legacy fallback: completed message with no persisted events
              <div className="rounded-xl bg-card/50 border border-border/50 px-4 py-3">
                <MarkdownRenderer content={displayContent} />
              </div>
            ) : message.turnStatus === "interrupted" ? (
              <div className="text-xs text-muted-foreground italic px-1">
                This response failed to complete. No content was generated.
              </div>
            ) : null}

            {/* Assistant message actions */}
            {displayContent && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: isHovered ? 1 : 0.8 }}
                className="flex items-center gap-1 mt-2"
              >
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                        onClick={() => onCopy(displayContent, message.id)}
                      >
                        {isCopied ? (
                          <Check className="h-3.5 w-3.5 text-green-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {isCopied ? "Copied!" : "Copy response"}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <div className="h-4 w-px bg-border/50" />

                <FeedbackButton
                  messageId={message.id}
                  conversationId={conversationId}
                  feedback={feedback}
                  onFeedbackChange={onFeedbackChange}
                />
              </motion.div>
            )}

          </>
        )}
      </div>
    </motion.div>
  );
});
