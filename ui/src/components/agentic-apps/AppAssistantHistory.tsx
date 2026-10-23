"use client";

import { useEffect, useState } from "react";
import { MoreHorizontal, RefreshCw } from "lucide-react";

import { matchesAssistantConversation } from "@/lib/agentic-apps/assistant-conversations";
import { apiClient } from "@/lib/api-client";
import { getStorageMode } from "@/lib/storage-config";
import HostConversationActions from "@/native-extensions/HostConversationActions";
import { useChatStore } from "@/store/chat-store";
import { getAgentId, type Conversation } from "@/types/a2a";
import { Button } from "@/components/ui/button";

/** History requires app/agent bindings unless legacy history is explicitly enabled; the API remains the authorization boundary. */
export function AppAssistantHistory({ appId, agentId, includeLegacy = false, selectedId, onSelect, onArchived }: {
  appId: string; agentId: string; includeLegacy?: boolean; selectedId?: string;
  onSelect: (id: string) => Promise<void>;
  onArchived: (id: string) => void;
}): React.ReactElement {
  const [items, setItems] = useState<Array<{ id: string; title: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const matches = (agent: string | null | undefined, metadata?: Record<string, unknown>) =>
        matchesAssistantConversation(appId, agentId, agent, metadata, includeLegacy);
      if (getStorageMode() !== "mongodb") return useChatStore.getState().conversations
        .filter((item: Conversation) => (!item.accessLevel || item.accessLevel === "owner") && item.messages.length > 0 && matches(getAgentId(item), item.metadata))
        .map(item => ({ id: item.id, title: item.title }));
      const result: Array<{ id: string; title: string }> = [];
      for (let page = 1; page <= 100 && !cancelled; page++) {
        const response = await apiClient.getConversations({ page, page_size: 100, source: "web", client_type: "webui", archived: false, non_empty: true });
        result.push(...response.items.filter(item => item.access_level === "owner" && matches(getAgentId(item), item.metadata))
          .map(item => ({ id: item._id, title: item.title })));
        if (!response.has_more) return result;
      }
      throw new Error("Assistant history scan limit reached");
    }
    setError(null);
    void load().then(result => { if (!cancelled) setItems(result); })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "History unavailable"); });
    return () => { cancelled = true; };
  }, [appId, agentId, includeLegacy, refresh]);
  async function select(id: string) {
    setPending(true);
    try { await onSelect(id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not open chat"); }
    finally { setPending(false); }
  }
  return <div className="min-h-0 flex-1 overflow-y-auto p-3">
    <div className="mb-2 flex items-center justify-between text-sm text-muted-foreground">
      <span>Your app chats</span>
      <button type="button" aria-label="Refresh assistant history" onClick={() => setRefresh(n => n + 1)} className="rounded p-2 hover:bg-accent"><RefreshCw className="h-4 w-4" /></button>
    </div>
    {error && <p role="alert" className="p-3 text-sm text-destructive">{error}</p>}
    {items.map(item => <div key={item.id} className="group flex items-center gap-2 rounded-lg p-2 hover:bg-accent" data-selected={selectedId === item.id}>
      <button type="button" disabled={pending} aria-current={selectedId === item.id ? "true" : undefined}
        className="min-w-0 flex-1 truncate p-1 text-left text-sm" onClick={() => void select(item.id)}>{item.title}</button>
      <div className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6" disabled={pending}
          aria-label={`Actions for ${item.title}`} aria-expanded={actionsFor === item.id}
          onClick={() => setActionsFor(current => current === item.id ? null : item.id)}><MoreHorizontal className="h-3 w-3" aria-hidden /></Button>
        {actionsFor === item.id && <HostConversationActions appId={appId} agentId={agentId} conversationId={item.id} disabled={pending}
          onHistoryChange={() => setRefresh(n => n + 1)} onArchived={() => { onArchived(item.id); setRefresh(n => n + 1); }} />}
      </div>
    </div>)}
    {!error && !items.length && <p className="p-3 text-sm text-muted-foreground">No saved chats.</p>}
  </div>;
}
