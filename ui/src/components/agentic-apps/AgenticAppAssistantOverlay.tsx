"use client";

import { Bot, LoaderCircle, Maximize2, MoreHorizontal, MessageCircle, Plus, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AssistantOptions, AssistantConfiguration } from "../../../app-sdk/assistant-options.mjs";
import { useAssistantComposerOptions } from "./AssistantComposerOptions";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { useSearchParams } from "next/navigation";
import { readAssistantDeepLink } from "@/lib/agentic-apps/assistant-links";
import Image from "next/image";
import { AppAssistantHistory } from "./AppAssistantHistory";
import { loadHostConversation } from "@/native-extensions/host-chat";
import { ChatPanel } from "@/components/chat/DynamicAgentChatPanel";
import { buildAssistantClientContext } from "@/lib/agentic-apps/assistant-context";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chat-store";
import { findLatestAppConversation, matchesAssistantConversation, mergeAppConversation } from "@/lib/agentic-apps/assistant-conversations";
import { getAgentId } from "@/types/a2a";
import type { AgenticAppAssistantContextRecord } from "@/types/agentic-app";

const DEFAULT_PANEL_SIZE = { width: 720, height: 780 };
const MIN_PANEL_SIZE = { width: 480, height: 560 };
const MAX_PANEL_SIZE = { width: 1180, height: 940 };
const GLASS_MODE_STORAGE_KEY = "agentic-app-assistant-glass";
const AGENTIC_APP_CONVERSATION_KIND = "agentic-app";

export interface AgenticAppAssistantOverlayProps {
  options?: AssistantOptions;
  configuration?: AssistantConfiguration;
  appId: string;
  appName: string;
  assistantIcon?: string;
  assistantLabel?: string;
  assistantAgentName?: string;
  activeContext: AgenticAppAssistantContextRecord | null;
  onClearContext: () => void;
  assistantAgentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgenticAppAssistantOverlay({
  options, configuration,
  appId,
  appName,
  assistantLabel,
  assistantIcon,
  assistantAgentName,
  activeContext,
  onClearContext,
  assistantAgentId,
  open,
  onOpenChange,
}: AgenticAppAssistantOverlayProps): React.ReactElement {
  const bubbleLabel = (assistantLabel?.trim() || "Ask CAIPE").slice(0, 32);
  const headerTitle = (
    assistantAgentName?.trim() || `CAIPE assistant for ${appName}`
  ).slice(0, 64);
  const [view, setView] = useState<"chat" | "history">("chat");
  const defaultSize = { width: options?.presentation?.width ?? DEFAULT_PANEL_SIZE.width, height: options?.presentation?.height ?? DEFAULT_PANEL_SIZE.height };
  const [panelSize, setPanelSize] = useState(defaultSize);
  const [expanded, setExpanded] = useState(false);
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const [fontScale, setFontScale] = useState(options?.presentation?.fontScale ?? "default");
  const { requestOptions, composerHeader } = useAssistantComposerOptions(options, configuration);
  const [glassMode, setGlassMode] = useState(readStoredGlassMode);
  const [assistantConversation, setAssistantConversation] = useState<{
    key: string;
    id: string;
  } | null>(null);
  const [conversationError, setConversationError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [conversationActionPending, setConversationActionPending] = useState(false);
  const selectedAccess = useChatStore(state => state.conversations.find(c => c.id === assistantConversation?.id)?.accessLevel);
  const canClear = !selectedAccess || selectedAccess === "owner";
  const selectionSessionRef = useRef<{ previous: string | null; owned: string | null } | null>(null);
  const conversationRequestRef = useRef<{
    key: string;
    promise: Promise<string>;
  } | null>(null);
  const createConversation = useChatStore((state) => state.createConversation);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const loadMessagesFromServer = useChatStore((state) => state.loadMessagesFromServer);
  const setActiveConversation = useChatStore((state) => state.setActiveConversation);
  const searchParams = useSearchParams();
  const deepLink = readAssistantDeepLink(searchParams.toString(), options);
  const conversationKey = `${appId}:${assistantAgentId}`;
  const requestedId = deepLink.id;
  const requestKey = JSON.stringify([conversationKey, deepLink.error ?? requestedId]);
  const hasSelectedConversation = !deepLink.error && assistantConversation?.key === conversationKey &&
    (!requestedId || assistantConversation.id === requestedId);
  const conversationTitle = `${appName} Assistant`.slice(0, 120);
  const conversationMetadata = useMemo(
    () => ({
      conversation_surface: AGENTIC_APP_CONVERSATION_KIND,
      agentic_app_id: appId,
      agentic_app_agent_id: assistantAgentId,
    }),
    [appId, assistantAgentId],
  );
  const clientContext = useMemo(
    () => buildAssistantClientContext(activeContext),
    [activeContext],
  );

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(GLASS_MODE_STORAGE_KEY, String(glassMode));
    }
  }, [glassMode]);

  useEffect(() => {
    if (deepLink.requested) queueMicrotask(() => setView("chat"));
  }, [deepLink.requested, deepLink.id, deepLink.error]);

  useEffect(() => {
    if (!open) return;
    const session = { previous: useChatStore.getState().activeConversationId, owned: null as string | null };
    selectionSessionRef.current = session;
    queueMicrotask(() => { if (selectionSessionRef.current === session) setConversationError(null); });
    return () => {
      selectionSessionRef.current = null;
      if (useChatStore.getState().activeConversationId === session.owned)
        setActiveConversation(session.previous);
    };
  }, [open, conversationKey, setActiveConversation]);

  const activate = useCallback((id: string, session: typeof selectionSessionRef.current): boolean => {
    if (!session || selectionSessionRef.current !== session) return false;
    const current = useChatStore.getState().activeConversationId;
    if (current !== session.previous && current !== session.owned) return false;
    session.owned = id;
    setActiveConversation(id);
    return true;
  }, [setActiveConversation]);

  const createAppConversation = useCallback(
    () =>
      createConversation(assistantAgentId, {
        title: conversationTitle,
        metadata: conversationMetadata,
        activate: false,
      }),
    [assistantAgentId, conversationMetadata, conversationTitle, createConversation],
  );

  const restoreConversation = useCallback(async (id: string, personalHistory = false): Promise<string> => {
    const session = selectionSessionRef.current;
    const { saved } = await loadHostConversation(appId, assistantAgentId, id, personalHistory);
    if (!matchesAssistantConversation(appId, assistantAgentId, getAgentId(saved), saved.metadata, options?.includeLegacyAgentHistory))
      throw new Error("Conversation is not bound to this app assistant");
    if (!session || selectionSessionRef.current !== session) throw new Error("Assistant session changed");
    useChatStore.setState(state => ({ conversations: mergeAppConversation(state.conversations, saved) }));
    await loadMessagesFromServer(saved._id, { force: true });
    return saved._id;
  }, [appId, assistantAgentId, loadMessagesFromServer, options?.includeLegacyAgentHistory]);

  const findOrCreateAppConversation = useCallback(async (): Promise<string> => {
    const session = selectionSessionRef.current;
    if (deepLink.error) throw new Error(deepLink.error);
    // Invalid/unauthorized deep links report an error; never fall back to another chat.
    if (requestedId) return restoreConversation(requestedId);
    const existing = await findLatestAppConversation(
      useChatStore.getState().conversations,
      appId,
      assistantAgentId,
      options?.includeLegacyAgentHistory,
    );
    if (!session || selectionSessionRef.current !== session) throw new Error("Assistant session changed");
    if (!existing) return createAppConversation();

    return restoreConversation(existing.id, true);
  }, [
    appId,
    assistantAgentId,
    createAppConversation,
    restoreConversation,
    requestedId, deepLink.error, options?.includeLegacyAgentHistory,
  ]);

  useEffect(() => {
    if (!open || view === "history" || conversationActionPending || conversationError?.key === requestKey) return;
    let cancelled = false;
    const session = selectionSessionRef.current;

    if (hasSelectedConversation && assistantConversation) {
      activate(assistantConversation.id, session);
      return () => {
        cancelled = true;
      };
    }

    let request = conversationRequestRef.current;
    if (!request || request.key !== requestKey) {
      request = {
        key: requestKey,
        promise: findOrCreateAppConversation(),
      };
      conversationRequestRef.current = request;
    }

    request.promise
      .then((id) => {
        if (cancelled || conversationRequestRef.current !== request || !activate(id, session)) return;
        setAssistantConversation({ key: conversationKey, id });
        if (deepLink.requested) updateAssistantDeepLink(id, options?.legacyConversationQueryParams);
      })
      .catch((error: unknown) => {
        // A rejected lookup is not a cached result. Reopening can safely retry
        // history discovery before deciding whether a conversation is absent.
        if (conversationRequestRef.current === request) conversationRequestRef.current = null;
        if (!cancelled && selectionSessionRef.current === session) {
          setConversationError({
            key: requestKey,
            message: error instanceof Error ? error.message : "Could not start assistant chat",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    assistantAgentId,
    assistantConversation,
    conversationActionPending,
    conversationError,
    conversationKey,
    requestKey,
    hasSelectedConversation,
    findOrCreateAppConversation,
    activate,
    open,
    view,
    deepLink.requested, options?.legacyConversationQueryParams,
    setActiveConversation,
  ]);

  const handleNewChat = useCallback(async (): Promise<void> => {
    if ((view !== "history" && !hasSelectedConversation) || conversationActionPending) return;
    const session = selectionSessionRef.current;
    setConversationActionPending(true);
    setConversationError(null);
    try {
      const id = await createAppConversation();
      if (selectionSessionRef.current !== session) return;
      setView("chat");
      conversationRequestRef.current = { key: requestKey, promise: Promise.resolve(id) };
      if (activate(id, session)) {
        setAssistantConversation({ key: conversationKey, id });
        updateAssistantDeepLink(id, options?.legacyConversationQueryParams);
      }
    } catch (error: unknown) {
      if (selectionSessionRef.current !== session) return;
      setConversationError({
        key: requestKey,
        message: error instanceof Error ? error.message : "Could not start a new chat",
      });
    } finally {
      setConversationActionPending(false);
    }
  }, [
    conversationActionPending,
    activate,
    conversationKey,
    requestKey,
    hasSelectedConversation,
    createAppConversation,
    options?.legacyConversationQueryParams,
    view,
  ]);

  const handleClearChat = useCallback(async (): Promise<void> => {
    if (!hasSelectedConversation || !assistantConversation || conversationActionPending || !canClear) return;
    if (
      !window.confirm(
        "Clear this chat? The current conversation will move to Trash and a new chat will start.",
      )
    ) {
      return;
    }

    const session = selectionSessionRef.current;
    setConversationActionPending(true);
    setConversationError(null);
    try {
      const priorRequest = conversationRequestRef.current;
      await deleteConversation(assistantConversation.id, { selectNext: false });
      if (conversationRequestRef.current === priorRequest) conversationRequestRef.current = null;
      setAssistantConversation(previous => previous?.id === assistantConversation.id ? null : previous);
      if (selectionSessionRef.current !== session) return;
      // Deletion leaves no active conversation; this operation owns that transition.
      if (session && useChatStore.getState().activeConversationId === null) session.owned = null;
      const id = await createAppConversation();
      if (selectionSessionRef.current !== session) return;
      conversationRequestRef.current = { key: requestKey, promise: Promise.resolve(id) };
      if (activate(id, session)) {
        setAssistantConversation({ key: conversationKey, id });
        updateAssistantDeepLink(id, options?.legacyConversationQueryParams);
      }
    } catch (error: unknown) {
      if (selectionSessionRef.current !== session) return;
      setConversationError({
        key: requestKey,
        message: error instanceof Error ? error.message : "Could not clear this chat",
      });
    } finally {
      setConversationActionPending(false);
    }
  }, [
    assistantConversation,
    conversationActionPending,
    activate,
    conversationKey,
    requestKey,
    hasSelectedConversation,
    createAppConversation,
    deleteConversation, canClear,
    options?.legacyConversationQueryParams,
  ]);

  async function selectHistory(id: string): Promise<void> {
    const session = selectionSessionRef.current;
    const restoredId = await restoreConversation(id, true);
    if (!activate(restoredId, session)) return;
    conversationRequestRef.current = { key: requestKey, promise: Promise.resolve(restoredId) };
    setConversationError(null);
    setAssistantConversation({ key: conversationKey, id: restoredId });
    updateAssistantDeepLink(restoredId, options?.legacyConversationQueryParams);
    setView("chat");
  }
  function onArchived(id: string) {
    if (assistantConversation?.id !== id) return;
    updateAssistantDeepLink(null, options?.legacyConversationQueryParams);
    conversationRequestRef.current = null;
    setAssistantConversation(null);
    if (selectionSessionRef.current) selectionSessionRef.current.owned = null;
  }
  useEffect(() => {
    if (!open) queueMicrotask(() => setDisplayMenuOpen(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !displayMenuOpen) onOpenChange(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onOpenChange, displayMenuOpen]);

  const handleResizeStart = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      setExpanded(false);
      const startPoint = { x: event.clientX, y: event.clientY };
      const startSize = panelSize;
      document.body.style.cursor = "nwse-resize";
      document.body.style.userSelect = "none";

      function handlePointerMove(moveEvent: PointerEvent): void {
        setPanelSize(
          clampPanelSize({
            width: startSize.width + (startPoint.x - moveEvent.clientX),
            height: startSize.height + (startPoint.y - moveEvent.clientY),
          }),
        );
      }

      function handlePointerUp(): void {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      }

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [panelSize],
  );

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-40 flex flex-col items-end gap-3" style={{ bottom: configuration?.bottomInset }}>
      {open ? (
        <section
          role="dialog"
          aria-label={headerTitle}
          className={cn(
            "pointer-events-auto relative flex flex-col overflow-hidden rounded-3xl border shadow-2xl transition-colors",
            glassMode
              ? "border-cyan-200/55 bg-cyan-950/30 shadow-[0_24px_120px_rgba(34,211,238,0.22),inset_0_1px_0_rgba(255,255,255,0.18),inset_0_0_64px_rgba(34,211,238,0.10)] ring-1 ring-cyan-200/45 backdrop-blur-3xl backdrop-saturate-200"
              : "border-cyan-300/20 bg-slate-950/95 shadow-cyan-950/40",
          )}
          style={{
            width: expanded ? "calc(100vw - 3rem)" : `min(${panelSize.width}px, calc(100vw - 3rem))`,
            height: expanded ? `calc(100dvh - ${112 + (configuration?.bottomInset ?? 0)}px)` : `min(${panelSize.height}px, calc(100dvh - ${112 + (configuration?.bottomInset ?? 0)}px))`,
          }}
        >
          <button
            type="button"
            aria-label={`Resize ${bubbleLabel} assistant`}
            onPointerDown={handleResizeStart}
            className="absolute left-3 top-3 z-10 flex h-10 w-10 cursor-nwse-resize touch-none items-center justify-center rounded-full border border-cyan-200/30 bg-slate-950/35 shadow-lg backdrop-blur-md transition hover:border-cyan-200/60 hover:bg-cyan-300/10"
          >
            <span className="absolute h-7 w-7 rounded-full border border-cyan-200/30" aria-hidden />
            <span className="absolute h-4 w-4 rounded-full border border-cyan-300/40" aria-hidden />
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-200 shadow-[0_0_14px_rgba(34,211,238,0.8)]" aria-hidden />
          </button>

          <header className="flex items-center justify-between gap-3 border-b border-white/10 bg-cyan-950/30 py-3 pl-16 pr-4 backdrop-blur-3xl">
            <div className="flex min-w-0 items-center gap-2">
              <span className="rounded-full bg-cyan-300/15 p-2 text-cyan-100">
                {assistantIcon ? <Image src={assistantIcon} width={20} height={20} alt="" unoptimized /> : <Bot className="h-4 w-4" aria-hidden />}
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-white">{headerTitle}</h2>
                <p className="truncate text-xs text-slate-400">
                  {activeContext
                    ? `${activeContext.route} context active`
                    : `Waiting for ${appId} context`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Popover open={displayMenuOpen} onOpenChange={setDisplayMenuOpen}><PopoverTrigger asChild><button type="button" aria-label="Assistant display settings" className="rounded p-2 hover:bg-white/10"><MoreHorizontal className="h-4 w-4" /></button></PopoverTrigger>
              <PopoverContent align="end" className="w-56 space-y-2">
              <label className="block text-sm">Text size<Select aria-label="Assistant text size" className="h-8 w-auto text-xs" value={fontScale}
                onChange={event => setFontScale(event.target.value as typeof fontScale)}>
                <option value="compact">Small</option><option value="default">Default</option><option value="large">Large</option>
              </Select></label>
              <button type="button" aria-label="Expand assistant" aria-pressed={expanded} onClick={() => setExpanded(value => !value)} className="rounded p-2 hover:bg-white/10"><Maximize2 className="h-4 w-4" /></button>
              <button type="button" aria-label="Reset assistant size" onClick={() => { setExpanded(false); setPanelSize(defaultSize); }} className="rounded p-2 hover:bg-white/10"><RotateCcw className="h-4 w-4" /></button>
              </PopoverContent></Popover>
              <button
                type="button"
                aria-label="Start new assistant chat"
                title="New chat"
                disabled={(view !== "history" && !hasSelectedConversation) || conversationActionPending}
                onClick={() => void handleNewChat()}
                className="rounded-full p-2 text-slate-400 transition hover:bg-white/10 hover:text-white disabled:cursor-wait disabled:opacity-50"
              >
                {conversationActionPending ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Plus className="h-4 w-4" aria-hidden />
                )}
              </button>
              <button
                type="button"
                aria-label="Clear assistant chat"
                title="Clear chat"
                disabled={!hasSelectedConversation || conversationActionPending || !canClear}
                onClick={() => void handleClearChat()}
                className="rounded-full p-2 text-slate-400 transition hover:bg-red-400/10 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={glassMode ? "Disable translucent assistant mode" : "Enable translucent assistant mode"}
                aria-pressed={glassMode}
                onClick={() => setGlassMode((value) => !value)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[11px] font-medium transition",
                  glassMode
                    ? "border-cyan-200/70 bg-cyan-300/25 text-cyan-50"
                    : "border-white/10 bg-slate-950/40 text-slate-300 hover:text-white",
                )}
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden /> Glass
              </button>
              <button
                type="button"
                className="rounded-full p-2 text-slate-400 transition hover:bg-white/10 hover:text-white"
                aria-label="Close assistant"
                onClick={() => onOpenChange(false)}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </header>

          <div className="border-b border-white/10 bg-cyan-300/15 px-4 py-3 text-xs text-slate-300 backdrop-blur-2xl">
            {activeContext ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-cyan-100">
                    {activeContext.title ?? "Published app context"}
                  </span>
                  <button
                    type="button"
                    className="rounded-full border border-white/10 px-2 py-1 text-[11px] text-slate-200 transition hover:bg-white/10"
                    onClick={onClearContext}
                  >
                    Clear context
                  </button>
                </div>
                {activeContext.summary ? (
                  <p className="line-clamp-2 text-slate-400">{activeContext.summary}</p>
                ) : null}
              </div>
            ) : (
              <p>App context is treated as untrusted data, not instructions.</p>
            )}
          </div>

          <div className="flex items-center justify-end gap-1 border-b border-white/10 px-4 py-2" role="group" aria-label="Assistant view">
            <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")} className="rounded px-3 py-1 text-sm hover:bg-white/10">Chat</button>
            <button type="button" aria-pressed={view === "history"} onClick={() => setView("history")} className="rounded px-3 py-1 text-sm hover:bg-white/10">History</button>
          </div>
          {view === "history" ? <AppAssistantHistory appId={appId} agentId={assistantAgentId} includeLegacy={options?.includeLegacyAgentHistory}
            selectedId={assistantConversation?.id} onSelect={selectHistory} onArchived={onArchived} /> :
          <div className="min-h-0 flex-1 [&>div]:bg-transparent" style={{
            "--text-sm": fontScale === "large" ? "1rem" : fontScale === "compact" ? "0.8125rem" : "0.875rem",
            "--text-base": fontScale === "large" ? "1.125rem" : fontScale === "compact" ? "0.875rem" : "1rem",
          } as React.CSSProperties}>
            {conversationError?.key === requestKey ? (
              <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-red-200">
                {conversationError.message}
                <button type="button" className="underline" onClick={() => setConversationError(null)}>Retry</button>
              </div>
            ) : hasSelectedConversation && assistantConversation ? (
              <ChatPanel
                key={assistantConversation.id}
                conversationId={assistantConversation.id}
                agentId={assistantAgentId}
                readOnly={selectedAccess === "shared_readonly"} readOnlyReason={selectedAccess === "shared_readonly" ? "shared_readonly" : undefined}
                requestOptions={requestOptions} composerHeader={composerHeader}
                placeholder={options?.presentation?.placeholder}
                showAuditNotice={options?.presentation?.showAuditNotice}
                feedbackPrompt={options?.presentation?.feedbackPrompt}
                clientContext={clientContext}
                suggestedPrompts={activeContext?.suggestedPrompts}
              />
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-300">
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                Starting {bubbleLabel}…
              </div>
            )}
          </div>}
        </section>
      ) : null}

      <button
        type="button"
        aria-label={`Open ${bubbleLabel}`}
        className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-cyan-200/30 bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-950/30 transition hover:bg-cyan-200"
        onClick={() => onOpenChange(!open)}
      >
        {assistantIcon ? <Image src={assistantIcon} width={20} height={20} alt="" unoptimized /> : <MessageCircle className="h-4 w-4" aria-hidden />}
        {bubbleLabel}
        {activeContext ? (
          <span className="rounded-full bg-slate-950/15 px-2 py-0.5 text-xs">context</span>
        ) : null}
      </button>
    </div>
  );
}

function clampPanelSize(size: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(MIN_PANEL_SIZE.width, Math.min(MAX_PANEL_SIZE.width, size.width)),
    height: Math.max(MIN_PANEL_SIZE.height, Math.min(MAX_PANEL_SIZE.height, size.height)),
  };
}

function readStoredGlassMode(): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(GLASS_MODE_STORAGE_KEY);
  return raw === null ? true : raw === "true";
}

function updateAssistantDeepLink(id: string | null, aliases: string[] = []): void {
  const url = new URL(window.location.href);
  for (const alias of aliases) url.searchParams.delete(alias);
  if (id) url.searchParams.set("assistant_chat", id);
  else url.searchParams.delete("assistant_chat");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}
