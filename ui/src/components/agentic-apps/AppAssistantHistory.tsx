"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, MessageSquare, MoreHorizontal, RefreshCw } from "lucide-react";

import { matchesAssistantConversation } from "@/lib/agentic-apps/assistant-conversations";
import { apiClient } from "@/lib/api-client";
import { getStorageMode } from "@/lib/storage-config";
import HostConversationActions from "@/native-extensions/HostConversationActions";
import { useChatStore } from "@/store/chat-store";
import { getAgentId, type Conversation } from "@/types/a2a";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type HistoryItem = { id: string; title: string; updatedAt?: string };

/** Browsing never changes the sidebar filter or bypasses app/agent authorization. */
export function AppAssistantHistory({ appId, agentId, includeLegacy = false, selectedId, onSelect, onArchived, revision = 0, disabled = false }: {
  appId: string; agentId: string; includeLegacy?: boolean; selectedId?: string;
  onSelect: (id: string) => Promise<void>;
  onArchived: (id: string) => void;
  revision?: number; disabled?: boolean;
}): React.ReactElement {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const generation = useRef(0);
  const busy = pending || disabled;

  const load = useCallback(async (nextPage: number): Promise<{ items: HistoryItem[]; hasMore: boolean }> => {
    const matches = (agent: string | null | undefined, metadata?: Record<string, unknown>) =>
      matchesAssistantConversation(appId, agentId, agent, metadata, includeLegacy);
    if (getStorageMode() !== "mongodb") return { hasMore: false, items: useChatStore.getState().conversations
      .filter((item: Conversation) => (!item.accessLevel || item.accessLevel === "owner") && item.messages.length > 0 && matches(getAgentId(item), item.metadata))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map(item => ({ id: item.id, title: item.title, updatedAt: item.updatedAt.toISOString() })) };
    const response = await apiClient.getConversations({ page: nextPage, page_size: 20, source: "web", client_type: "webui", archived: false, non_empty: true });
    return { hasMore: response.has_more, items: response.items
      .filter(item => item.access_level === "owner" && matches(getAgentId(item), item.metadata))
      .map(item => ({ id: item._id, title: item.title, updatedAt: item.updated_at ? new Date(item.updated_at).toISOString() : undefined })) };
  }, [appId, agentId, includeLegacy]);

  useEffect(() => {
    let cancelled = false;
    generation.current += 1;
    setLoading(true);
    setError(null);
    setItems([]);
    setActionsFor(null);
    setPending(false);
    void load(1).then(result => {
      if (!cancelled) { setItems(result.items); setHasMore(result.hasMore); setPage(1); }
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "History unavailable");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; generation.current += 1; };
  }, [load, refresh, revision]);

  async function loadMore() {
    if (loading || busy) return;
    const request = generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await load(page + 1);
      if (request !== generation.current) return;
      setItems(previous => [...new Map([...previous, ...result.items].map(item => [item.id, item])).values()]);
      setHasMore(result.hasMore);
      setPage(value => value + 1);
    } catch (reason) {
      if (request === generation.current) setError(reason instanceof Error ? reason.message : "Could not load more chats");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }

  async function select(id: string) {
    if (busy) return;
    const request = generation.current;
    setPending(true);
    try { await onSelect(id); }
    catch (reason) { if (request === generation.current) setError(reason instanceof Error ? reason.message : "Could not open chat"); }
    finally { if (request === generation.current) setPending(false); }
  }

  return <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3">
    <div className="mb-2 flex items-center justify-between text-sm text-muted-foreground">
      <span>Your app chats</span>
      <Button variant="ghost" size="icon" disabled={loading || busy} aria-label="Refresh assistant history" onClick={() => setRefresh(n => n + 1)}><RefreshCw className="h-4 w-4" aria-hidden /></Button>
    </div>
    {loading && !items.length ? <p role="status" className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />Loading history…</p> : null}
    <ul aria-label="Your app chat history" className="space-y-1">
      {items.map(item => <li key={item.id} className={cn("group flex items-center rounded-lg border border-transparent", selectedId === item.id ? "border-border bg-accent" : "hover:bg-accent/50")}>
        <button type="button" disabled={busy} aria-current={selectedId === item.id ? "true" : undefined}
          aria-label={item.title} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" onClick={() => void select(item.id)}>
          <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0"><span className="block truncate text-sm font-medium">{item.title}</span>
            {item.updatedAt ? <time dateTime={item.updatedAt} className="mt-1 block text-xs text-muted-foreground">{new Date(item.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</time> : null}
          </span>
        </button>
        <div className="mr-2 flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <Button type="button" variant="ghost" size="icon" className="h-6 w-6" disabled={busy}
            aria-label={`Actions for ${item.title}`} aria-expanded={actionsFor === item.id}
            onClick={() => setActionsFor(current => current === item.id ? null : item.id)}><MoreHorizontal className="h-3 w-3" aria-hidden /></Button>
          {actionsFor === item.id && <HostConversationActions appId={appId} agentId={agentId} conversationId={item.id} disabled={busy}
            onHistoryChange={() => setRefresh(n => n + 1)} onArchived={() => { onArchived(item.id); setRefresh(n => n + 1); }} />}
        </div>
      </li>)}
    </ul>
    {error ? <div role="alert" className="space-y-2 p-3 text-sm text-destructive"><p>{error}</p><Button variant="outline" size="sm" disabled={loading || busy} onClick={() => setRefresh(n => n + 1)}>Retry</Button></div> : null}
    {!loading && !error && !items.length ? <p className="p-3 text-center text-sm text-muted-foreground">{hasMore ? "No matching chats on this page. Load more to continue." : "Your conversations will appear here after you send a message."}</p> : null}
    {hasMore && !error ? <Button variant="ghost" className="mt-3 w-full" disabled={loading || busy} onClick={() => void loadMore()}>{loading ? "Loading…" : "Load more chats"}</Button> : null}
  </div>;
}
