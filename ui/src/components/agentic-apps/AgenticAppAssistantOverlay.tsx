"use client";

import { FileText, LoaderCircle, MessageCircle, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AssistantOptions, AssistantConfiguration } from "../../../app-sdk/assistant-options.mjs";
import { useAssistantComposerOptions } from "./AssistantComposerOptions";
import { AssistantConversationToolbar } from "./AssistantConversationToolbar";
import HostConversationActions from "@/native-extensions/HostConversationActions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSearchParams } from "next/navigation";
import { readAssistantDeepLink } from "@/lib/agentic-apps/assistant-links";
import Image from "next/image";
import { AppAssistantHistory } from "./AppAssistantHistory";
import { loadHostConversation } from "@/native-extensions/host-chat";
import type { AssistantDraft } from "@/lib/agentic-apps/assistant-draft";
import { ChatPanel } from "@/components/chat/DynamicAgentChatPanel";
import { buildAssistantClientContext } from "@/lib/agentic-apps/assistant-context";
import { useAssistantAppearance } from "@/hooks/use-assistant-appearance";
import { useChatStore } from "@/store/chat-store";
import { findLatestAppConversation, matchesAssistantConversation, mergeAppConversation } from "@/lib/agentic-apps/assistant-conversations";
import { getAgentId } from "@/types/a2a";
import type { AgenticAppAssistantContextRecord } from "@/types/agentic-app";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";

const DEFAULT_PANEL_SIZE = { width: 720, height: 780 };
const MIN_PANEL_SIZE = { width: 480, height: 560 };
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
  assistantAgent?: DynamicAgentConfig;
  composerDraft?: AssistantDraft | null;
  onComposerDraftApplied?: (id: string) => void;
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
  assistantAgent,
  open,
  onOpenChange,
  composerDraft,
  onComposerDraftApplied,
}: AgenticAppAssistantOverlayProps): React.ReactElement {
  const bubbleLabel = (assistantLabel?.trim() || "Ask CAIPE").slice(0, 32);
  const headerTitle = (
    assistantAgentName?.trim() || `CAIPE assistant for ${appName}`
  ).slice(0, 64);
  const [view, setView] = useState<"chat" | "history">("chat");
  const incomingDraftId = composerDraft?.id;
  useEffect(() => {
    if (incomingDraftId) queueMicrotask(() => setView("chat"));
  }, [incomingDraftId]);
  const defaultSize = { width: options?.presentation?.width ?? DEFAULT_PANEL_SIZE.width, height: options?.presentation?.height ?? DEFAULT_PANEL_SIZE.height };
  const [panelSize, setPanelSize] = useState(defaultSize);
  const [expanded, setExpanded] = useState(false);
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false);
  const { fontScale } = useAssistantAppearance(options?.presentation?.fontScale);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const resizeRef = useRef<{ pointerId: number; x: number; y: number; width: number; height: number; maxWidth: number; maxHeight: number } | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const { requestOptions, composerHeader } = useAssistantComposerOptions(options, configuration);
  const [assistantConversation, setAssistantConversation] = useState<{
    key: string;
    id: string;
  } | null>(null);
  const [conversationError, setConversationError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [conversationActionPending, setConversationActionPending] = useState(false);
  const selectedTitle = useChatStore(state => state.conversations.find(c => c.id === assistantConversation?.id)?.title);
  const selectedAccess = useChatStore(state => state.conversations.find(c => c.id === assistantConversation?.id)?.accessLevel);
  const selectionSessionRef = useRef<{ previous: string | null; owned: string | null } | null>(null);
  const conversationRequestRef = useRef<{
    key: string;
    promise: Promise<string>;
  } | null>(null);
  const createConversation = useChatStore((state) => state.createConversation);
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
  const suggestedPrompts = options?.presentation?.showSuggestions
    ? (activeContext?.suggestedPrompts ?? options.presentation.suggestedPrompts ?? [])
    : [];

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
    setHistoryRevision(value => value + 1);
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
      if (event.button !== 0 || !containerRef.current || !panelRef.current) return;
      event.preventDefault();
      const panel = panelRef.current.getBoundingClientRect();
      const container = containerRef.current.getBoundingClientRect();
      resizeRef.current = {
        pointerId: event.pointerId, x: event.clientX, y: event.clientY,
        width: panel.width, height: panel.height,
        maxWidth: container.width,
        maxHeight: container.height - (launcherRef.current?.offsetHeight ?? 0) - 12,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setExpanded(false);
      setPanelSize({ width: panel.width, height: panel.height });
      document.body.style.cursor = "nwse-resize";
      document.body.style.userSelect = "none";
    },
    [],
  );
  const handleResizeMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = resizeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPanelSize(clampPanelSize({
      width: drag.width + drag.x - event.clientX,
      height: drag.height + drag.y - event.clientY,
    }, { width: drag.maxWidth, height: drag.maxHeight }));
  }, []);
  const handleResizeEnd = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  return (
    <div ref={containerRef} className="pointer-events-none fixed inset-x-4 bottom-4 top-18 z-40 flex min-h-0 flex-col items-end justify-end gap-3 sm:inset-x-6 sm:bottom-6" style={{ bottom: configuration?.bottomInset }}>
      {open ? (
        <Tabs value={view} onValueChange={value => setView(value as typeof view)} asChild>
        <section
          ref={panelRef}
          role="dialog"
          aria-label={headerTitle}
          className="pointer-events-auto relative flex min-h-0 flex-col overflow-hidden rounded-3xl border border-border bg-background text-foreground shadow-2xl dark:bg-slate-950"
          style={{
            width: expanded ? "100%" : `min(${panelSize.width}px, 100%)`,
            height: expanded ? "100%" : `min(${panelSize.height}px, 100%)`,
          }}
        >
          <button type="button" aria-label={`Resize ${bubbleLabel} assistant`} onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} onLostPointerCapture={handleResizeEnd}
            className="absolute left-1 top-1 z-10 flex h-6 w-6 cursor-nwse-resize touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          ><span aria-hidden className="h-2 w-2 border-l border-t border-current" /></button>
          <header className="flex items-center justify-between gap-3 border-b border-border bg-background py-3 pl-9 pr-4">
            {hasSelectedConversation && assistantConversation ? <HostConversationActions key={assistantConversation.id}
              appId={appId} agentId={assistantAgentId} conversationId={assistantConversation.id}
              variant="title" conversationTitle={selectedTitle} disabled={conversationActionPending}
              onHistoryChange={() => setHistoryRevision(value => value + 1)} onArchived={() => onArchived(assistantConversation.id)} />
              : <h2 className="min-w-0 truncate text-sm font-semibold">New chat</h2>}
            <AssistantConversationToolbar
              viewTabs={<TabsList aria-label={`${bubbleLabel} views`} indicator="none" className="h-8 w-fit shrink-0 overflow-hidden border border-foreground/30 bg-transparent p-0">
                <TabsTrigger value="chat" className="h-full rounded-none px-4 py-1 data-[state=active]:bg-foreground data-[state=active]:text-background">Chat</TabsTrigger>
                <TabsTrigger value="history" className="h-full rounded-none border-l border-foreground/30 px-4 py-1 data-[state=active]:bg-foreground data-[state=active]:text-background">History</TabsTrigger>
              </TabsList>}
              menuOpen={displayMenuOpen} onMenuOpenChange={setDisplayMenuOpen}
              expanded={expanded} pending={conversationActionPending}
              canStart={view === "history" || hasSelectedConversation}
              onNewChat={() => void handleNewChat()}
              onExpand={() => setExpanded(true)} onResetSize={() => { setExpanded(false); setPanelSize(defaultSize); }}
              chatHref={hasSelectedConversation && assistantConversation ? `/chat/${encodeURIComponent(assistantConversation.id)}` : undefined}
              onMinimize={() => onOpenChange(false)} />
          </header>
          {activeContext?.summary && view === "chat" ? (
            <div role="note" aria-label="Attached page context" className="flex items-start gap-2 border-b border-border bg-muted/30 px-4 py-2 text-xs">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0">
                <p className="font-medium text-foreground">{activeContext.title ?? "Page context"}</p>
                <p className="truncate text-muted-foreground">{activeContext.summary}</p>
              </div>
              <button type="button" aria-label="Clear context" title="Clear context" onClick={onClearContext}
                className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col">
          <TabsContent value="history" className="m-0 min-h-0 flex-1">
            <AppAssistantHistory key={`${appId}:${assistantAgentId}`} appId={appId} agentId={assistantAgentId} includeLegacy={options?.includeLegacyAgentHistory}
              revision={historyRevision} disabled={conversationActionPending}
              selectedId={assistantConversation?.id} onSelect={selectHistory} onArchived={onArchived} />
          </TabsContent>
          <TabsContent value="chat" forceMount className="m-0 min-h-0 flex-1 bg-background data-[state=inactive]:hidden [&>div]:bg-background" style={{
            "--text-sm": fontScale === "large" ? "1rem" : fontScale === "compact" ? "0.8125rem" : "0.875rem",
            "--text-base": fontScale === "large" ? "1.125rem" : fontScale === "compact" ? "0.875rem" : "1rem",
          } as React.CSSProperties}>
            {conversationError?.key === requestKey ? (
              <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-destructive">
                {conversationError.message}
                <button type="button" className="underline" onClick={() => setConversationError(null)}>Retry</button>
              </div>
            ) : hasSelectedConversation && assistantConversation ? (
              <ChatPanel
                key={assistantConversation.id}
                conversationId={assistantConversation.id}
                agentId={assistantAgentId}
                agent={assistantAgent}
                readOnly={selectedAccess === "shared_readonly"} readOnlyReason={selectedAccess === "shared_readonly" ? "shared_readonly" : undefined}
                requestOptions={requestOptions} composerHeader={composerHeader}
                placeholder={options?.presentation?.placeholder ?? `${bubbleLabel}…`}
                emptyStateTitle={bubbleLabel}
                showAuditNotice={options?.presentation?.showAuditNotice}
                feedbackPrompt={options?.presentation?.feedbackPrompt}
                clientContext={clientContext}
                suggestedPrompts={suggestedPrompts}
                composerDraft={composerDraft}
                onComposerDraftApplied={onComposerDraftApplied}
              />
            ) : (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                Starting {bubbleLabel}…
              </div>
            )}
          </TabsContent>
          </div>
        </section>
        </Tabs>
      ) : null}

      <button
        ref={launcherRef}
        type="button"
        aria-label={`Open ${bubbleLabel}`}
        className="pointer-events-auto inline-flex shrink-0 items-center gap-2 rounded-full border border-cyan-200/30 bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 shadow-lg shadow-cyan-950/30 transition hover:bg-cyan-200"
        onClick={() => onOpenChange(!open)}
      >
        {assistantIcon ? <Image src={assistantIcon} width={20} height={20} alt="" unoptimized /> : <MessageCircle className="h-4 w-4" aria-hidden />}
        {bubbleLabel}
      </button>
    </div>
  );
}

function clampPanelSize(size: { width: number; height: number }, maximum: { width: number; height: number }): {
  width: number;
  height: number;
} {
  return {
    width: Math.min(maximum.width, Math.max(MIN_PANEL_SIZE.width, size.width)),
    height: Math.min(maximum.height, Math.max(MIN_PANEL_SIZE.height, size.height)),
  };
}

function updateAssistantDeepLink(id: string | null, aliases: string[] = []): void {
  const url = new URL(window.location.href);
  for (const alias of aliases) url.searchParams.delete(alias);
  if (id) url.searchParams.set("assistant_chat", id);
  else url.searchParams.delete("assistant_chat");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}
