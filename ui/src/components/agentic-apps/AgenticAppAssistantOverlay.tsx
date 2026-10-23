"use client";

import { Bot, LoaderCircle, MessageCircle, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Image from "next/image";
import { AppAssistantHistory } from "./AppAssistantHistory";
import { loadHostConversation } from "@/native-extensions/host-chat";
import { ChatPanel } from "@/components/chat/DynamicAgentChatPanel";
import { buildAssistantClientContext } from "@/lib/agentic-apps/assistant-context";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chat-store";
import { findLatestAppConversation } from "@/lib/agentic-apps/assistant-conversations";
import type { AgenticAppAssistantContextRecord } from "@/types/agentic-app";

const DEFAULT_PANEL_SIZE = { width: 720, height: 780 };
const MIN_PANEL_SIZE = { width: 480, height: 560 };
const MAX_PANEL_SIZE = { width: 1180, height: 940 };
const GLASS_MODE_STORAGE_KEY = "agentic-app-assistant-glass";
const AGENTIC_APP_CONVERSATION_KIND = "agentic-app";

export interface AgenticAppAssistantOverlayProps {
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
  const [panelSize, setPanelSize] = useState(DEFAULT_PANEL_SIZE);
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
  const selectionSessionRef = useRef<{ previous: string | null; owned: string | null } | null>(null);
  const conversationRequestRef = useRef<{
    key: string;
    promise: Promise<string>;
  } | null>(null);
  const createConversation = useChatStore((state) => state.createConversation);
  const deleteConversation = useChatStore((state) => state.deleteConversation);
  const loadMessagesFromServer = useChatStore((state) => state.loadMessagesFromServer);
  const setActiveConversation = useChatStore((state) => state.setActiveConversation);
  const conversationKey = `${appId}:${assistantAgentId}`;
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

  const restoreConversation = useCallback(async (id: string): Promise<string> => {
    const session = selectionSessionRef.current;
    const { saved } = await loadHostConversation(appId, assistantAgentId, id);
    if (!session || selectionSessionRef.current !== session) throw new Error("Assistant session changed");
    useChatStore.setState(state => ({ conversations: state.conversations.some(item => item.id === saved._id)
      ? state.conversations : [...state.conversations, { id: saved._id, title: saved.title, participants: saved.participants,
        createdAt: new Date(saved.created_at), updatedAt: new Date(saved.updated_at), metadata: saved.metadata,
        accessLevel: saved.access_level, sharing: saved.sharing, messages: [], streamEvents: [] }] }));
    await loadMessagesFromServer(saved._id, { force: true });
    return saved._id;
  }, [appId, assistantAgentId, loadMessagesFromServer]);

  const findOrCreateAppConversation = useCallback(async (): Promise<string> => {
    const session = selectionSessionRef.current;
    const requestedId = new URLSearchParams(window.location.search).get("assistant_chat");
    // Invalid/unauthorized deep links report an error; never fall back to another chat.
    if (requestedId) return restoreConversation(requestedId);
    const existing = await findLatestAppConversation(
      useChatStore.getState().conversations,
      appId,
      assistantAgentId,
    );
    if (!session || selectionSessionRef.current !== session) throw new Error("Assistant session changed");
    if (!existing) return createAppConversation();

    useChatStore.setState((state) => ({
      conversations: state.conversations.some((item) => item.id === existing.id)
        ? state.conversations : [existing, ...state.conversations],
    }));
    await loadMessagesFromServer(existing.id);
    return existing.id;
  }, [
    appId,
    assistantAgentId,
    createAppConversation,
    restoreConversation,
    loadMessagesFromServer,
  ]);

  useEffect(() => {
    if (!open || view === "history" || conversationActionPending || conversationError?.key === conversationKey) return;
    let cancelled = false;
    const session = selectionSessionRef.current;

    if (assistantConversation?.key === conversationKey) {
      activate(assistantConversation.id, session);
      return () => {
        cancelled = true;
      };
    }

    let request = conversationRequestRef.current;
    if (!request || request.key !== conversationKey) {
      request = {
        key: conversationKey,
        promise: findOrCreateAppConversation(),
      };
      conversationRequestRef.current = request;
    }

    request.promise
      .then((id) => {
        if (cancelled || conversationRequestRef.current !== request || !activate(id, session)) return;
        setAssistantConversation({ key: conversationKey, id });
      })
      .catch((error: unknown) => {
        // A rejected lookup is not a cached result. Reopening can safely retry
        // history discovery before deciding whether a conversation is absent.
        if (conversationRequestRef.current === request) conversationRequestRef.current = null;
        if (!cancelled && selectionSessionRef.current === session) {
          setConversationError({
            key: conversationKey,
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
    findOrCreateAppConversation,
    activate,
    open,
    view,
    setActiveConversation,
  ]);

  const handleNewChat = useCallback(async (): Promise<void> => {
    if ((view !== "history" && assistantConversation?.key !== conversationKey) || conversationActionPending) return;
    const session = selectionSessionRef.current;
    setConversationActionPending(true);
    setConversationError(null);
    try {
      const id = await createAppConversation();
      if (selectionSessionRef.current !== session) return;
      setView("chat");
      conversationRequestRef.current = { key: conversationKey, promise: Promise.resolve(id) };
      if (activate(id, session)) {
        setAssistantConversation({ key: conversationKey, id });
        updateAssistantDeepLink(id);
      }
    } catch (error: unknown) {
      if (selectionSessionRef.current !== session) return;
      setConversationError({
        key: conversationKey,
        message: error instanceof Error ? error.message : "Could not start a new chat",
      });
    } finally {
      setConversationActionPending(false);
    }
  }, [
    assistantConversation,
    conversationActionPending,
    activate,
    conversationKey,
    createAppConversation,
    view,
  ]);

  const handleClearChat = useCallback(async (): Promise<void> => {
    if (assistantConversation?.key !== conversationKey || conversationActionPending) return;
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
      conversationRequestRef.current = { key: conversationKey, promise: Promise.resolve(id) };
      if (activate(id, session)) {
        setAssistantConversation({ key: conversationKey, id });
        updateAssistantDeepLink(id);
      }
    } catch (error: unknown) {
      if (selectionSessionRef.current !== session) return;
      setConversationError({
        key: conversationKey,
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
    createAppConversation,
    deleteConversation,
  ]);

  async function selectHistory(id: string): Promise<void> {
    const session = selectionSessionRef.current;
    const restoredId = await restoreConversation(id);
    if (!activate(restoredId, session)) return;
    conversationRequestRef.current = { key: conversationKey, promise: Promise.resolve(restoredId) };
    setAssistantConversation({ key: conversationKey, id: restoredId });
    updateAssistantDeepLink(restoredId);
    setView("chat");
  }
  function onArchived(id: string) {
    if (assistantConversation?.id !== id) return;
    updateAssistantDeepLink(null);
    conversationRequestRef.current = null;
    setAssistantConversation(null);
    if (selectionSessionRef.current) selectionSessionRef.current.owned = null;
  }
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onOpenChange(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onOpenChange]);

  const handleResizeStart = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
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
    <div className="pointer-events-none fixed bottom-6 right-6 z-40 flex flex-col items-end gap-3">
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
            width: `min(${panelSize.width}px, calc(100vw - 2rem))`,
            height: `min(${panelSize.height}px, calc(100vh - 7rem))`,
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
              <button
                type="button"
                aria-label="Start new assistant chat"
                title="New chat"
                disabled={(view !== "history" && assistantConversation?.key !== conversationKey) || conversationActionPending}
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
                disabled={assistantConversation?.key !== conversationKey || conversationActionPending}
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
          {view === "history" ? <AppAssistantHistory appId={appId} agentId={assistantAgentId}
            selectedId={assistantConversation?.id} onSelect={selectHistory} onArchived={onArchived} /> :
          <div className="min-h-0 flex-1 [&>div]:bg-transparent">
            {conversationError?.key === conversationKey ? (
              <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-red-200">
                {conversationError.message}
                <button type="button" className="underline" onClick={() => setConversationError(null)}>Retry</button>
              </div>
            ) : assistantConversation?.key === conversationKey ? (
              <ChatPanel
                key={assistantConversation.id}
                conversationId={assistantConversation.id}
                agentId={assistantAgentId}
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

function updateAssistantDeepLink(id: string | null): void {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("assistant_chat", id);
  else url.searchParams.delete("assistant_chat");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}
