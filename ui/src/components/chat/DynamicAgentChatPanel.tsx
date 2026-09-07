"use client";

import { AgentAvatar } from "@/components/dynamic-agents/AgentAvatar";
import type { TaskItem } from "@/components/shared/timeline";
import { MarkdownRenderer } from "@/components/shared/timeline";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/components/ui/toast";
import { Tooltip,TooltipContent,TooltipProvider,TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentTimeline } from "@/hooks/useDynamicAgentTimeline";
import { apiClient,APIClientError } from "@/lib/api-client";
import { authErrorToastTitle,type AuthError } from "@/lib/auth-error";
import { getConfig } from "@/lib/config";
import { ACCEPT_ATTRIBUTE,fileToInputFile,type InputFile,validateFiles } from "@/lib/file-attachments";
import { takePendingFirstMessage } from "@/lib/pending-first-message";
import { createSubagentResumeSeedEvents } from "@/lib/resume-subagent-context";
import { createStreamAdapter,StreamError,type StreamCallbacks } from "@/lib/streaming";
import { createStreamEvent,FILE_TOOL_NAMES,TODO_TOOL_NAME,type StreamEvent } from "@/lib/streaming/types";
import { cn,deduplicateByKey } from "@/lib/utils";
import { useChatStore } from "@/store/chat-store";
import { useFeatureFlagStore } from "@/store/feature-flag-store";
import { buildParticipants,ChatMessage as ChatMessageType,Conversation,type MessageAttachment,TurnStatus } from "@/types/a2a";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { AnimatePresence,motion } from "framer-motion";
import { Activity,ArrowDown,ArrowLeft,BookOpen,Brain,Check,ChevronUp,Copy,Loader2,Paperclip,RotateCcw,Send,ShieldCheck,Sparkles,Square,User } from "lucide-react";
import { resolveUsableChatAgentId } from "@/lib/chat-agent-selection";
import { AgentPicker } from "@/components/ui/agent-picker";
import { signIn,useSession } from "next-auth/react";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { useRouter } from "next/navigation";
import Image from "next/image";
import React,{ useCallback,useEffect,useMemo,useRef,useState } from "react";
import TextareaAutosize from "react-textarea-autosize";
import { DEFAULT_AGENTS } from "./CustomCallButtons";
import { AgentTimeline,type SubagentLookupInfo } from "./DynamicAgentTimeline";
import { Feedback,FeedbackButton } from "./FeedbackButton";
import { MetadataInputForm,type InputField,type UserInputMetadata } from "./MetadataInputForm";
import { AttachmentChips,type PendingAttachment } from "./AttachmentChips";
import { MessageAttachments } from "./MessageAttachments";
import { MemoryDialog as FileMemoryDialog } from "./MemoryDialog";
import { ProjectPicker } from "./ProjectPicker";
import { getFilteredCommands,SlashCommandMenu,type SlashCommand } from "./SlashCommandMenu";
import { useProjectsEnabled } from "@/hooks/use-projects-enabled";
import { ToolApprovalCard } from "./ToolApprovalCard";
import { useSlashCommands } from "./useSlashCommands";

type ReadOnlyReason = 'admin_audit' | 'shared_readonly' | 'agent_deleted' | 'agent_disabled';

/**
 * A message waiting in the composer queue while a turn streams. Carries any
 * multimodal attachments alongside the text so a queued turn sends its files
 * too, not just the words.
 */
interface QueuedMessage {
  text: string;
  files: InputFile[];
}

interface ChatPanelProps {
  conversationId?: string; // MongoDB conversation UUID
  readOnly?: boolean;
  readOnlyReason?: ReadOnlyReason;
  agentId: string; // Mandatory for Dynamic Agents
  agent?: DynamicAgentConfig | null; // Full agent config object
  isLoadingMessages?: boolean; // Whether messages are still loading (show skeleton)
}

export function ChatPanel({ conversationId, readOnly, readOnlyReason, agentId, agent, isLoadingMessages }: ChatPanelProps) {
  // Derive display values from agent object
  const agentGradient = agent?.ui?.gradient_theme ?? null;
  const agentCustomTheme = agent?.ui?.custom_theme_config ?? null;
  const agentName = agent?.name;
  const agentSkills = agent?.skills;
  const agentAllowsMemory = agent?.builtin_tools?.memory?.enabled === true;
  const projectsEnabled = useProjectsEnabled();
  const { data: session } = useSession();
  const { toast } = useToast();
  const router = useRouter();
  const autoScrollEnabled = useFeatureFlagStore((s) => s.flags.autoScroll ?? true);
  const showTimestamps = useFeatureFlagStore((s) => s.flags.showTimestamps ?? false);

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

  const [input, setInput] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  // Files staged in the composer for the next turn (multimodal input).
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [memoryPreferenceEnabled, setMemoryPreferenceEnabled] = useState(true);
  const [memoryDialogOpen, setMemoryDialogOpen] = useState(false);
  const [memoryFocusIds, setMemoryFocusIds] = useState<string[]>([]);
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

  // Message window: progressive loading of older turns
  const [visibleTurnCount, setVisibleTurnCount] = useState(INITIAL_VISIBLE_TURNS);
  // Ref to preserve scroll position when loading more turns
  const scrollDistanceFromBottomRef = useRef<number | null>(null);

  const {
    activeConversationId,
    getActiveConversation,
    createConversation,
    addMessage,
    updateMessage,
    appendToMessage,
    addStreamEvent,
    clearStreamEvents,
    setConversationStreaming,
    isConversationStreaming,
    cancelConversationRequest,
    updateMessageFeedback,
    consumePendingMessage,
    loadMessagesFromServer,
    updateConversationTitle,
  } = useChatStore();

  // Re-link this deprecated/deleted-agent conversation to the platform default agent,
  // then reload the page so ChatContainer picks up the new participants.
  const handleStartNewConversation = useCallback(async () => {
    if (!conversationId) return;
    try {
      const agentId = await resolveUsableChatAgentId();
      const newParticipants = buildParticipants(agentId);
      await apiClient.updateConversation(conversationId, {
        participants: newParticipants,
      });
      // Patch the Zustand store in-place so ChatContainer sees the new participants
      // immediately — it skips the API fetch when the conversation is already cached.
      useChatStore.setState((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, participants: newParticipants } : c,
        ),
      }));
      router.refresh();
    } catch (err) {
      toast(`Could not resume conversation: ${(err as Error).message}`, "error", 8000);
    }
  }, [conversationId, router, toast]);

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
    try {
      const newParticipants = buildParticipants(chosenAgentId);
      await apiClient.updateConversation(conversationId, { participants: newParticipants });
      useChatStore.setState((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, participants: newParticipants } : c,
        ),
      }));
      router.refresh();
    } catch (err) {
      toast(`Could not resume conversation: ${(err as Error).message}`, "error", 8000);
    }
  }, [conversationId, chosenAgentId, router, toast]);

  // Slash command registry
  const slashCommands = useSlashCommands(agentSkills);

  // Get access token from session (if SSO is enabled and user is authenticated)
  const ssoEnabled = getConfig('ssoEnabled');
  const accessToken = ssoEnabled ? session?.accessToken : undefined;

  const conversation = getActiveConversation();
  const memoryToggleLocked = Boolean(conversation?.messages?.some((message) => message.role === "user"));
  const memoryToggleDisabled = !agentAllowsMemory || memoryToggleLocked;
  const memoryEnabled = agentAllowsMemory && memoryPreferenceEnabled;
  const projectId = typeof conversation?.metadata?.project_id === "string"
    ? conversation.metadata.project_id
    : undefined;
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) {
      setActiveProjectName(null);
      return;
    }
    let cancelled = false;
    void fetch("/api/user/projects", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        const match = Array.isArray(payload.data?.items)
          ? payload.data.items.find((item: { id?: unknown }) => item.id === projectId)
          : undefined;
        if (!cancelled) setActiveProjectName(match?.name || projectId);
      })
      .catch(() => { if (!cancelled) setActiveProjectName(projectId); });
    return () => { cancelled = true; };
  }, [projectId]);

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

  // Handle scroll events to detect user scrolling
  const handleScroll = useCallback(() => {
    // Ignore scroll events caused by auto-scrolling
    if (isAutoScrollingRef.current) return;

    const nearBottom = isNearBottom();
    setIsUserScrolledUp(!nearBottom);
    setShowScrollButton(!nearBottom);
  }, [isNearBottom]);

  // Set up scroll listener
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

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

  // Reset scroll state and visible turns when conversation changes
  useEffect(() => {
    setIsUserScrolledUp(false);
    setShowScrollButton(false);
    setVisibleTurnCount(INITIAL_VISIBLE_TURNS);
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
        const response = await fetch(
          `/api/dynamic-agents/conversations/${encodeURIComponent(conversationId)}/files/list?agent_id=${encodeURIComponent(agentId)}`,
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
        const response = await fetch(
          `/api/dynamic-agents/conversations/${encodeURIComponent(conversationId)}/files/content?agent_id=${encodeURIComponent(agentId)}&path=${encodeURIComponent(path)}`,
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
      const response = await fetch(
        `/api/dynamic-agents/conversations/${encodeURIComponent(conversationId)}/files/content?agent_id=${encodeURIComponent(agentId)}&path=${encodeURIComponent(path)}`,
      );
      if (!response.ok) return null;
      const data = await response.json();
      return typeof data.content === "string" ? data.content : null;
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
        const response = await fetch(
          `/api/dynamic-agents/conversations/${encodeURIComponent(conversationId)}/files/content?agent_id=${encodeURIComponent(agentId)}&path=${encodeURIComponent(path)}`,
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

  const handleOpenMemory = useCallback((memoryIds: string[] = []) => {
    setMemoryFocusIds(memoryIds);
    setMemoryDialogOpen(true);
  }, []);

  const linkContinuation = useCallback(async (nextConversationId: string) => {
    if (!activeConversationId) return;
    try {
      const response = await fetch(`/api/chat/conversations/${activeConversationId}/metadata`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { continued_to: nextConversationId } }),
      });
      if (!response.ok) throw new Error("continuation link was not saved");
      useChatStore.setState((state) => ({
        conversations: state.conversations.map((item) =>
          item.id === activeConversationId
            ? { ...item, metadata: { ...item.metadata, continued_to: nextConversationId } }
            : item,
        ),
      }));
    } catch {
      toast("The new chat was created, but its back-link could not be saved.", "warning", 5000);
    }
  }, [activeConversationId, toast]);

  const handleProjectChange = useCallback(async (nextProjectId?: string) => {
    if (nextProjectId === projectId) return;
    try {
      const nextConversationId = await createConversation(agentId, {
        projectId: nextProjectId,
        ...(activeConversationId && { continuedFrom: activeConversationId }),
      });
      await linkContinuation(nextConversationId);
      router.push(`/chat/${nextConversationId}`);
    } catch (caught) {
      toast((caught as Error).message || "Could not start a scoped chat", "error", 6000);
    }
  }, [activeConversationId, agentId, createConversation, linkContinuation, projectId, router, toast]);

  const handleStartProjectChat = useCallback(async (nextProjectId: string) => {
    try {
      const nextConversationId = await createConversation(agentId, {
        projectId: nextProjectId,
        ...(activeConversationId && { continuedFrom: activeConversationId }),
      });
      await linkContinuation(nextConversationId);
      router.push(`/chat/${nextConversationId}`);
    } catch (caught) {
      toast((caught as Error).message || "Could not start a scoped chat", "error", 6000);
    }
  }, [activeConversationId, agentId, createConversation, linkContinuation, router, toast]);

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
        completed_tool_name: resolvedName,
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

    onMemoryUpdate(memoryIds, action, namespace) {
      const streamEvent = createStreamEvent("memory_update", {
        memory_ids: memoryIds,
        action,
        namespace: namespace ?? [],
      });
      addStreamEvent(streamEvent, convId);
    },

    onMemoryInjected(memoryIds, namespace) {
      const streamEvent = createStreamEvent("memory_injected", {
        memory_ids: memoryIds,
        namespace: namespace ?? [],
      });
      addStreamEvent(streamEvent, convId);
    },

    onDone() {
      // Finalization handled after adapter.streamMessage resolves
    },

    onError(message) {
      console.error("[DynamicAgent] Stream error event:", message);
      loopState.hasError = true;
      loopState.errorMessage = message;
    },
  }; }, [agentId, addStreamEvent, updateMessage, setPendingUserInput, setFilesFetchKey, setTimelineTasks]);

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

  // Core submit function that accepts a message directly
  const submitMessage = useCallback(async (messageToSend: string, filesToSend: InputFile[] = []) => {
    // A turn is valid if it has text OR at least one attachment.
    if ((!messageToSend.trim() && filesToSend.length === 0) || isThisConversationStreaming) return;

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
      ...(conv?.sharing && { chat_sharing: conv.sharing }),
    };
    clearStreamEvents(convId);

    // Add user message - generate turnId for this request/response pair.
    // Retain the attachments on the rendered turn so the upload shows in the
    // transcript (base64 size ≈ 3/4 of the string length, close enough for the
    // size label). Persistence caps large images in saveMessagesToServer.
    const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const attachments: MessageAttachment[] = filesToSend.map((f) => ({
      mime_type: f.mime_type,
      name: f.name,
      data: f.data,
      size: Math.floor((f.data.length * 3) / 4),
    }));
    addMessage(convId, {
      role: "user",
      content: messageToSend,
      senderEmail: session?.user?.email ?? undefined,
      senderName: session?.user?.name ?? undefined,
      senderImage: session?.user?.image ?? undefined,
      ...(attachments.length > 0 && { attachments }),
    }, turnId);

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
          clientContext,
          memoryEnabled,
          projectId,
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
  }, [isThisConversationStreaming, activeConversationId, accessToken, agentId, agentProtocol, getActiveConversation, createConversation, clearStreamEvents, addMessage, appendToMessage, updateMessage, setConversationStreaming, buildStreamCallbacks, finalizeStreamLoop, session?.user, showAuthErrorToast, toast, memoryEnabled, projectId]);

  // The Home page hero composer creates a conversation and navigates here
  // before a message can be sent (this panel only mounts once a conversation
  // id is in the URL) — pick up its stashed first message and send it once
  // through the normal pipeline rather than duplicating it there.
  const pendingFirstMessageSentRef = useRef(false);
  useEffect(() => {
    if (pendingFirstMessageSentRef.current || readOnly) return;
    const pending = takePendingFirstMessage(conversationId);
    if (pending) {
      pendingFirstMessageSentRef.current = true;
      void submitMessage(pending.text, pending.files);
    }
  }, [conversationId, readOnly, submitMessage]);

  // Handle queued messages after streaming completes
  useEffect(() => {
    if (!isThisConversationStreaming && queuedMessages.length > 0) {
      // Process first queued message
      const [firstMessage, ...remaining] = queuedMessages;
      setQueuedMessages(remaining);
      // Small delay to ensure previous message is fully processed
      setTimeout(() => {
        submitMessage(firstMessage.text, firstMessage.files);
      }, 300);
    }
  }, [isThisConversationStreaming, queuedMessages, submitMessage]);

  // Retry handler - re-sends the message content
  const handleRetry = useCallback((content: string) => {
    if (isThisConversationStreaming) return; // Don't retry while streaming
    submitMessage(content);
  }, [isThisConversationStreaming, submitMessage]);

  // Handle /skills chat command: show skills configured on this agent
  const handleSkillsCommand = useCallback(async () => {
    let convId = activeConversationId;
    if (!convId) {
      convId = await createConversation(agentId);
    }

    const turnId = `turn-${Date.now()}`;
    addMessage(convId, { role: "user", content: "/skills" }, turnId);

    updateConversationTitle(convId, "Agent Skills");

    const msgId = addMessage(convId, { role: "assistant", content: "Loading skills..." }, turnId);

    if (!agentSkills || agentSkills.length === 0) {
      updateMessage(convId, msgId, {
        content: "This agent has no skills configured. You can add skills in the agent editor.",
        isFinal: true,
      });
      return;
    }

    try {
      const res = await fetch("/api/skills", { credentials: "include" });
      if (!res.ok) {
        updateMessage(convId, msgId, { content: "Skills are temporarily unavailable. Please try again later.", isFinal: true });
        return;
      }
      const data = await res.json();
      const allSkills = data?.skills || [];
      const skillIdSet = new Set(agentSkills);
      const filtered = allSkills.filter((s: { id: string }) => skillIdSet.has(s.id));

      if (filtered.length === 0) {
        updateMessage(convId, msgId, {
          content: `This agent has ${agentSkills.length} skill(s) configured but none could be resolved. They may have been deleted.`,
          isFinal: true,
        });
        return;
      }

      const lines = [
        `**Agent Skills** (${filtered.length})\n`,
        ...filtered.map((s: { title?: string; name?: string; description?: string; category?: string }) =>
          `- **${s.title || s.name || "Untitled"}**: ${s.description || "No description"}${s.category ? ` *(${s.category})*` : ""}`
        ),
        "\n*These are the skills configured on this agent. Edit in the agent settings.*",
      ];
      updateMessage(convId, msgId, { content: lines.join("\n"), isFinal: true });
    } catch {
      updateMessage(convId, msgId, { content: "Skills are temporarily unavailable. Please try again later.", isFinal: true });
    }
  }, [activeConversationId, createConversation, addMessage, updateMessage, updateConversationTitle, agentId, agentSkills]);

  // Handle /help command: show available commands in chat
  const handleHelpCommand = useCallback(async () => {
    let convId = activeConversationId;
    if (!convId) {
      convId = await createConversation(agentId);
    }
    const turnId = `turn-${Date.now()}`;
    addMessage(convId, { role: "user", content: "/help" }, turnId);

    // Set a descriptive title instead of "/help"
    updateConversationTitle(convId, "Help & Commands");

    const agentLines = DEFAULT_AGENTS.map(a => `  \`/@${a.id}\` — ${a.label} agent`).join("\n");
    const helpText = [
      "**Available Commands**\n",
      "  `/skills` — List all available skills",
      "  `/help` — Show this help message",
      "  `/clear` — Clear the current conversation",
      "",
      "**Agents** (inserts @mention, then keep typing your question)\n",
      agentLines,
      "",
      "*Type `/` to see the autocomplete menu. Use Arrow keys + Tab to select.*",
    ].join("\n");

    addMessage(convId, { role: "assistant", content: helpText, isFinal: true }, turnId);
  }, [activeConversationId, agentId, createConversation, addMessage, updateConversationTitle]);

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

    // If streaming and not force sending, queue the message (up to 3)
    if (isThisConversationStreaming && !forceSend) {
      const message = input.trim();

      // Add to queue if under limit
      if (queuedMessages.length < 3) {
        setQueuedMessages(prev => [...prev, { text: message, files: encodedFiles }]);
        setInput("");
        setAttachments([]);
      } else {
        // Queue is full
        console.log("Queue is full (3/3). Send or cancel messages to queue more.");
      }
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
  }, [input, attachments, submitMessage, isThisConversationStreaming, queuedMessages, pendingUserInput, slashCommands, executeSlashCommand, handleStop]);

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
        { conversationId: activeConversationId, agentId: resumeAgentId, resumeData: formDataJson, clientContext, memoryEnabled, projectId },
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
      clearStreamEvents, getActiveConversation, buildStreamCallbacks, finalizeStreamLoop, memoryEnabled, projectId]);

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

    const clientContext: Record<string, unknown> = { source: "webui" };

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
        { conversationId: activeConversationId, agentId: resumeAgentId, resumeData, clientContext, memoryEnabled, projectId },
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
      buildStreamCallbacks, finalizeStreamLoop, memoryEnabled, projectId]);

  // Handle slash command detection in input
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
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
    if (cmd.category === "agent") {
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
    }
  }, [input, executeSlashCommand, submitMessage, activeConversationId, updateConversationTitle]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
      <FileMemoryDialog
        open={memoryDialogOpen}
        onOpenChange={setMemoryDialogOpen}
        focusIds={memoryFocusIds}
        agentId={agentId}
        projectId={typeof conversation?.metadata?.project_id === "string" ? conversation.metadata.project_id : null}
      />

      {(conversation?.metadata?.continued_from || conversation?.metadata?.continued_to) && (
        <div className="border-b bg-muted/20 px-4 py-1.5 text-center text-xs text-muted-foreground">
          {typeof conversation.metadata.continued_from === "string" && (
            <button className="hover:text-foreground hover:underline" onClick={() => router.push(`/chat/${conversation.metadata?.continued_from}`)}>
              Continued from {conversation.metadata.continued_from.slice(0, 8)}…
            </button>
          )}
          {typeof conversation.metadata.continued_to === "string" && (
            <button className="ml-3 hover:text-foreground hover:underline" onClick={() => router.push(`/chat/${conversation.metadata?.continued_to}`)}>
              Continued in {conversation.metadata.continued_to.slice(0, 8)}…
            </button>
          )}
        </div>
      )}

      {projectId && (
        <div className="border-b bg-primary/5 px-4 py-1.5 text-center text-xs font-medium text-primary">
          Project: {activeProjectName || projectId}
        </div>
      )}

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
                const turns = groupMessagesIntoTurns(allMessages);
                
                // Progressive loading: show only the most recent N turns
                const totalTurns = turns.length;
                const effectiveVisibleCount = Math.min(visibleTurnCount, totalTurns);
                const hiddenTurnCount = Math.max(0, totalTurns - effectiveVisibleCount);
                const visibleTurns = turns.slice(-effectiveVisibleCount);
                
                // Flatten visible turns to messages for rendering
                const visibleMessages = visibleTurns.flatMap(t =>
                  [t.userMsg, t.assistantMsg].filter(Boolean) as ChatMessageType[]
                );

                // Build a Set of visible message IDs for quick lookup
                const visibleMsgIds = new Set(visibleMessages.map(m => m.id));
                const renderMessages = allMessages.filter(m => visibleMsgIds.has(m.id));

                // Handle loading more turns
                const handleLoadMore = async () => {
                  // Capture scroll position before loading
                  if (scrollViewportRef.current) {
                    const viewport = scrollViewportRef.current;
                    scrollDistanceFromBottomRef.current = viewport.scrollHeight - viewport.scrollTop;
                  }
                  
                  // Increase visible turn count
                  const newVisibleCount = Math.min(visibleTurnCount + LOAD_MORE_BATCH_SIZE, totalTurns);
                  setVisibleTurnCount(newVisibleCount);
                  
                  // Re-load messages from MongoDB to restore evicted content
                  if (activeConversationId) {
                    await loadMessagesFromServer(activeConversationId, { force: true });
                  }
                  
                  // Restore scroll position after render (use rAF to wait for layout)
                  requestAnimationFrame(() => {
                    if (scrollViewportRef.current && scrollDistanceFromBottomRef.current !== null) {
                      const viewport = scrollViewportRef.current;
                      viewport.scrollTop = viewport.scrollHeight - scrollDistanceFromBottomRef.current;
                      scrollDistanceFromBottomRef.current = null;
                    }
                  });
                };

                return (
                  <>
                    {/* Load earlier turns divider */}
                    {hiddenTurnCount > 0 && (
                      <LoadEarlierDivider
                        key="load-earlier"
                        count={hiddenTurnCount}
                        onLoad={handleLoadMore}
                      />
                    )}

                    {/* Rendered messages (visible turns only) */}
                    {renderMessages.map((msg, index, arr) => {
                      const isLastMessage = index === arr.length - 1;
                      const isAssistantStreaming = isThisConversationStreaming && msg.role === "assistant" && isLastMessage;

                      // For retry: if user message, use its content; if assistant, find preceding user message
                      const getRetryContent = () => {
                        if (msg.role === "user") return msg.content;
                        for (let i = index - 1; i >= 0; i--) {
                          if (arr[i].role === "user") {
                            return arr[i].content;
                          }
                        }
                        return null;
                      };

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

                      const memoryUpdateIds = msg.role === "assistant"
                        ? Array.from(new Set(
                            turnEvents.flatMap((event) => event.memoryUpdateData?.memory_ids ?? [])
                          ))
                        : [];
                      const memoryInjectedIds = msg.role === "assistant"
                        ? Array.from(new Set(
                            turnEvents.flatMap((event) => event.memoryInjectedData?.memory_ids ?? [])
                          ))
                        : [];
                      return (
                        <ChatMessage
                          key={msg.id}
                          message={msg}
                          onCopy={handleCopy}
                          isCopied={copiedId === msg.id}
                          isStreaming={isAssistantStreaming}
                          isLatestAnswer={isLastAssistantMessage}
                          onRetry={getRetryContent() ? () => handleRetry(getRetryContent()!) : undefined}
                          feedback={msg.feedback}
                          onFeedbackChange={(feedback) => handleFeedbackChange(msg.id, feedback)}
                          isRecovering={recoveringMessageId === msg.id}
                          conversationId={conversationId}
                          userDisplayName={userDisplayName}
                          showTimestamp={showTimestamps}
                          agentGradient={agentGradient}
                          agentCustomTheme={agentCustomTheme}
                          agentName={agentName}
                          turnEvents={turnEvents}
                          memoryInjectedIds={memoryInjectedIds}
                          memoryUpdateIds={memoryUpdateIds}
                          onOpenMemory={handleOpenMemory}
                          onStartProjectChat={handleStartProjectChat}
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

      {/* Input Area - Fixed bottom, doesn't scroll */}
      {readOnly ? (
        <div className={`border-t border-border shrink-0 ${readOnlyReason === 'agent_deleted' || readOnlyReason === 'agent_disabled' ? 'bg-red-500/10' : 'bg-amber-500/10'}`}>
          <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
            <div className={`flex items-center gap-2 ${readOnlyReason === 'agent_deleted' || readOnlyReason === 'agent_disabled' ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'}`}>
              <ShieldCheck className="h-4 w-4 shrink-0" />
              {readOnlyReason === 'admin_audit' ? (
                <>
                  <span className="text-sm font-medium">Read-Only Audit Mode</span>
                  <span className="text-xs text-amber-600 dark:text-amber-500">— You are viewing this conversation as an admin auditor.</span>
                </>
              ) : readOnlyReason === 'agent_deleted' ? (
                <>
                  <span className="text-sm font-medium">Agent No Longer Available</span>
                  <span className="text-xs text-red-600 dark:text-red-500">— This agent has been deprecated or deleted. You can view the history but cannot send new messages.</span>
                </>
              ) : readOnlyReason === 'agent_disabled' ? (
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
            {readOnlyReason === 'admin_audit' ? (
            <NavigationProgressLink
              href="/admin/insights/feedback"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-amber-600/20 text-amber-700 dark:text-amber-300 hover:bg-amber-600/30 transition-colors"
            >
              <ArrowLeft className="h-3 w-3" />
              Back to Feedback
            </NavigationProgressLink>
            ) : (readOnlyReason === 'agent_deleted' || readOnlyReason === 'agent_disabled') ? (
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
            <div className="space-y-2">
              <AnimatePresence mode="popLayout">
                {queuedMessages.map((queuedMsg, index) => (
                  <motion.div
                    key={`${index}-${queuedMsg.text.slice(0, 20)}`}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg border border-border/50"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-medium text-muted-foreground">
                          Queued {queuedMessages.length > 1 ? `(${index + 1}/${queuedMessages.length})` : 'message'}:
                        </span>
                        <button
                          onClick={() => {
                            setQueuedMessages(prev => prev.filter((_, i) => i !== index));
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
              {queuedMessages.length >= 3 && (
                <div className="text-xs text-muted-foreground px-3">
                  Maximum of 3 queued messages. Send or cancel messages to queue more.
                </div>
              )}
            </div>
          )}

          <div className="relative">
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

              {projectsEnabled && (
                <ProjectPicker
                  value={projectId}
                  disabled={memoryToggleLocked}
                  onChange={(value) => { void handleProjectChange(value); }}
                />
              )}

              <div className="flex items-center gap-3">
                <TextareaAutosize
                  ref={inputRef}
                  value={input}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={
                    isThisConversationStreaming
                      ? queuedMessages.length >= 3
                        ? "Queue full (3/3). Send or cancel messages to queue more, or Cmd+Enter to force send..."
                        : `Type to queue message (${queuedMessages.length}/3), or Cmd+Enter to force send...`
                      : `Ask anything, or type / to see commands, skills, and agents...`
                  }
                  className="flex-1 bg-transparent resize-none outline-none px-3 py-2.5 text-sm"
                  minRows={1}
                  maxRows={10}
                />
                <div className="flex items-center gap-1 shrink-0">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <button
                            type="button"
                            aria-pressed={memoryEnabled}
                            disabled={memoryToggleDisabled}
                            onClick={() => {
                              if (memoryToggleDisabled) return;
                              setMemoryPreferenceEnabled((enabled) => !enabled);
                            }}
                            className={cn(
                              "inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                              memoryEnabled
                                ? "border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20"
                                : "border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                            )}
                          >
                            <Brain className="h-3.5 w-3.5" />
                            <span>Memory</span>
                          </button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {!agentAllowsMemory
                          ? "Memory is disabled for this chat. This agent doesn't allow memory use. Please contact an administrator to enable it."
                          : memoryToggleLocked
                          ? "Memory cannot be changed after the first message in this chat"
                          : memoryEnabled
                            ? "Memory is on for this chat"
                            : "Memory is off for this chat"}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>

                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-muted-foreground hover:text-foreground"
                          onClick={() => handleOpenMemory([])}
                        >
                          <BookOpen className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Manage memory</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                {/* Attach files */}
                <Button
                  size="icon"
                  onClick={() => fileInputRef.current?.click()}
                  variant="ghost"
                  className="shrink-0"
                  title="Attach files"
                  aria-label="Attach files"
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                {/* Send/Stop button - toggles based on streaming state */}
                {isThisConversationStreaming ? (
                  <Button
                    size="icon"
                    onClick={handleStop}
                    variant="destructive"
                    className="shrink-0"
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
                    className="shrink-0"
                    title="Send message"
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            {getConfig('appName')} can make mistakes. Verify important info.
            {getConfig('auditLogsEnabled') && ' · Conversations are logged for audit.'}
          </p>
        </div>
      </div>
      )}
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

// ─────────────────────────────────────────────────────────────────────────────
// Message Window: Progressive loading of older turns
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_VISIBLE_TURNS = 3;
const LOAD_MORE_BATCH_SIZE = 3;

interface Turn {
  userMsg?: ChatMessageType;
  assistantMsg?: ChatMessageType;
  preview: string;
  timestamp: Date;
}

function groupMessagesIntoTurns(messages: ChatMessageType[]): Turn[] {
  const turns: Turn[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "user" && i + 1 < messages.length && messages[i + 1].role === "assistant") {
      const assistantMsg = messages[i + 1];
      turns.push({
        userMsg: msg,
        assistantMsg,
        preview: msg.content.slice(0, 80).trim() + (msg.content.length > 80 ? "..." : ""),
        timestamp: msg.timestamp,
      });
      i += 2;
    } else {
      turns.push({
        ...(msg.role === "user" ? { userMsg: msg } : { assistantMsg: msg }),
        preview: msg.content.slice(0, 80).trim() + (msg.content.length > 80 ? "..." : ""),
        timestamp: msg.timestamp,
      });
      i += 1;
    }
  }
  return turns;
}

/**
 * Subtle divider that shows how many earlier turns are available to load.
 * Clicking loads the next batch progressively.
 */
const LoadEarlierDivider = React.memo(function LoadEarlierDivider({
  count,
  onLoad,
}: {
  count: number;
  onLoad: () => void;
}) {
  return (
    <motion.button
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      onClick={onLoad}
      className={cn(
        "w-full flex items-center justify-center gap-2 py-3 my-2",
        "text-xs text-muted-foreground hover:text-foreground transition-colors group cursor-pointer"
      )}
    >
      <span className="flex-1 h-px bg-border/40 group-hover:bg-border/60 transition-colors" />
      <span className="flex items-center gap-1.5 px-3">
        <ChevronUp className="h-3 w-3" />
        {count} earlier
      </span>
      <span className="flex-1 h-px bg-border/40 group-hover:bg-border/60 transition-colors" />
    </motion.button>
  );
});


interface ChatMessageProps {
  message: ChatMessageType;
  onCopy: (content: string, id: string) => void;
  isCopied: boolean;
  isStreaming?: boolean;
  isLatestAnswer?: boolean;
  onRetry?: () => void;
  feedback?: Feedback;
  onFeedbackChange?: (feedback: Feedback) => void;
  conversationId?: string;
  isRecovering?: boolean;
  userDisplayName?: string;
  showTimestamp?: boolean;
  agentGradient?: string | null;
  agentCustomTheme?: import("@/types/dynamic-agent").CustomThemeConfig | null;
  agentName?: string;
  turnEvents?: StreamEvent[];
  memoryInjectedIds?: string[];
  memoryUpdateIds?: string[];
  onOpenMemory?: (memoryIds: string[]) => void;
  onStartProjectChat?: (projectId: string) => void;
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
  isCopied,
  isStreaming = false,
  isLatestAnswer = false,
  onRetry,
  feedback,
  onFeedbackChange,
  conversationId,
  isRecovering = false,
  userDisplayName = "You",
  showTimestamp = false,
  agentGradient,
  agentCustomTheme,
  agentName,
  turnEvents = [],
  memoryInjectedIds = [],
  memoryUpdateIds = [],
  onOpenMemory,
  onStartProjectChat,
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
  const projectActions = useMemo(() => {
    const found = new Map<string, { id: string; name: string }>();
    for (const event of turnEvents) {
      const toolData = event.toolData;
      if (!toolData || !("completed_tool_name" in toolData)) continue;
      const toolName = toolData.completed_tool_name || "";
      if (toolName !== "list_projects" && toolName !== "create_project") continue;
      if (!toolData.result) continue;
      try {
        let decoded: unknown = JSON.parse(toolData.result);
        if (Array.isArray(decoded) && decoded.length === 1 && typeof decoded[0] === "object") {
          const text = (decoded[0] as { text?: unknown }).text;
          if (typeof text === "string") decoded = JSON.parse(text);
        }
        if (!decoded || typeof decoded !== "object") continue;
        const object = decoded as Record<string, unknown>;
        const candidates = Array.isArray(object.items)
          ? object.items
          : [object.project && typeof object.project === "object" ? object.project : object];
        for (const candidate of candidates) {
          if (!candidate || typeof candidate !== "object") continue;
          const record = candidate as Record<string, unknown>;
          const id = String(record.id ?? "");
          if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) continue;
          found.set(id, { id, name: String(record.name ?? id) });
        }
      } catch {
        // Tool result was not structured JSON; no Project action.
      }
    }
    return [...found.values()];
  }, [turnEvents]);

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
            {message.content.trim() && (
              <div
                className="rounded-xl rounded-tr-sm relative overflow-hidden inline-block bg-primary text-primary-foreground px-4 py-3 max-w-full selection:bg-primary-foreground selection:text-primary"
              >
                <div className="overflow-hidden break-words text-left" style={{ overflowWrap: 'anywhere' }}>
                  <MarkdownRenderer content={message.content} variant="user" />
                </div>
              </div>
            )}

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: isHovered ? 1 : 0.8 }}
              className="flex items-center gap-1 mt-2 justify-end"
            >
              {onRetry && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                        onClick={onRetry}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Retry this prompt
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
                    {onRetry && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={onRetry}
                        className="shrink-0 gap-1.5 border-amber-500/30 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Retry
                      </Button>
                    )}
                  </>
                )}
              </motion.div>
            )}

            {memoryInjectedIds.length > 0 && onOpenMemory && (
              <button
                type="button"
                onClick={() => onOpenMemory(memoryInjectedIds)}
                className="mb-2 mr-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20"
              >
                <Brain className="h-3.5 w-3.5" />
                {memoryInjectedIds.length === 1 ? "1 memory injected" : `${memoryInjectedIds.length} memories injected`}
              </button>
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

            {memoryUpdateIds.length > 0 && onOpenMemory && (
              <button
                type="button"
                onClick={() => onOpenMemory(memoryUpdateIds)}
                className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-sky-500/25 bg-sky-500/10 px-2.5 py-1 text-xs font-medium text-sky-300 transition-colors hover:bg-sky-500/20"
              >
                <Brain className="h-3.5 w-3.5" />
                {memoryUpdateIds.length === 1 ? "Memory updated" : `${memoryUpdateIds.length} memories updated`}
              </button>
            )}

            {projectActions.length > 0 && onStartProjectChat && (
              <div className="mt-2 flex flex-wrap gap-2">
                {projectActions.map((project) => (
                  <Button
                    key={project.id}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onStartProjectChat(project.id)}
                  >
                    Start chat in {project.name}
                  </Button>
                ))}
              </div>
            )}

            {/* Action buttons (copy, retry, collapse) */}
            {displayContent && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: isHovered ? 1 : 0.8 }}
                className="flex items-center gap-1 mt-2"
              >
                {onRetry && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-muted"
                          onClick={onRetry}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Regenerate response
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
