"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { MessageCircle, Plus, X } from "lucide-react";

import { useChatStore } from "@/store/chat-store";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import type { NativeExtensionManifest } from "./types";

const ChatPanel = lazy(() =>
  import("@/components/chat/DynamicAgentChatPanel").then((module) => ({
    default: module.ChatPanel,
  })),
);

type Assistant = NonNullable<NativeExtensionManifest["assistant"]>;

export function NativeExtensionAssistant({
  assistant,
  extensionId,
  pathname,
}: {
  assistant: Assistant;
  extensionId: string;
  pathname: string;
}) {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState<DynamicAgentConfig | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || agent) return;
    const controller = new AbortController();
    fetch(`/api/dynamic-agents/agents/${encodeURIComponent(assistant.agentId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Assistant is unavailable or access was denied.");
        const payload: { success?: boolean; data?: DynamicAgentConfig } = await response.json();
        if (!payload.success || !payload.data?.enabled) {
          throw new Error("Assistant is unavailable or access was denied.");
        }
        setAgent(payload.data);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Assistant is unavailable.");
        }
      });
    return () => controller.abort();
  }, [agent, assistant.agentId, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const startConversation = async () => {
    setLoading(true);
    setError(null);
    try {
      const id = await useChatStore.getState().createConversation(assistant.agentId);
      setConversationId(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start a conversation.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex flex-col items-end gap-3">
      {open && (
        <section
          role="dialog"
          aria-label={assistant.name}
          className="pointer-events-auto flex h-[min(720px,calc(100dvh-7rem))] w-[min(520px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-background text-foreground shadow-2xl"
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
            <MessageCircle className="h-4 w-4 text-primary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold">{assistant.name}</h2>
              <p className="truncate text-xs text-muted-foreground">{pathname} context active</p>
            </div>
            <button
              type="button"
              aria-label="Start new assistant chat"
              title="New chat"
              onClick={() => void startConversation()}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Close assistant"
              onClick={() => setOpen(false)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </header>
          {error ? (
            <p role="alert" className="p-4 text-sm text-destructive">{error}</p>
          ) : loading || !agent || !conversationId ? (
            <p className="p-4 text-sm text-muted-foreground">Starting {assistant.label}…</p>
          ) : (
            <div className="min-h-0 flex-1">
              <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading chat…</p>}>
                <ChatPanel
                  conversationId={conversationId}
                  agentId={assistant.agentId}
                  agent={agent}
                  clientContext={{ app_id: extensionId, app_path: pathname.slice(0, 512) }}
                />
              </Suspense>
            </div>
          )}
        </section>
      )}
      <button
        type="button"
        aria-label={open ? "Close assistant" : assistant.label}
        aria-expanded={open}
        onClick={() => {
          if (!open && !conversationId && !loading) void startConversation();
          setOpen((current) => !current);
        }}
        className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <MessageCircle className="h-4 w-4" aria-hidden="true" />
        {assistant.label}
      </button>
    </div>
  );
}
