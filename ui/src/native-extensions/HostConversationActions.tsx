"use client";

import { Archive, Pencil } from "lucide-react";
import { useEffect, useState } from "react";

import type { NativeHostConversationActionsProps } from "../../app-sdk";
import { ShareButton } from "@/components/chat/ShareButton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { apiClient } from "@/lib/api-client";
import { getStorageMode } from "@/lib/storage-config";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChatStore } from "@/store/chat-store";
import { loadHostConversation } from "./host-chat";

export default function HostConversationActions({ appId, conversationId, agentId, disabled, onArchived, onHistoryChange, variant = "actions", conversationTitle }:
  NativeHostConversationActionsProps & { appId: string; variant?: "actions" | "title"; conversationTitle?: string }) {
  const [conversation, setConversation] = useState<Awaited<ReturnType<typeof loadHostConversation>>["saved"] | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setConversation(null);
    setError(null);
    void loadHostConversation(appId, agentId, conversationId).then(({ saved }) => {
      if (!cancelled) setConversation(saved);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Conversation actions are unavailable");
    });
    return () => { cancelled = true; };
  }, [appId, agentId, conversationId]);

  async function archive() {
    if (disabled || pending || conversation?.access_level !== "owner") return;
    setPending(true);
    setError(null);
    try {
      // The host store rolls back optimistic removal when CAS denies the API request.
      await useChatStore.getState().deleteConversation(conversationId, { selectNext: false });
      onArchived();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not archive this conversation");
    } finally {
      setPending(false);
    }
  }

  async function rename() {
    if (!title.trim() || disabled || pending || conversation?.access_level !== "owner") return;
    setPending(true);
    setError(null);
    try {
      if (getStorageMode() === "mongodb") await apiClient.updateConversation(conversationId, { title: title.trim() });
      else await useChatStore.getState().updateConversationTitle(conversationId, title.trim());
      useChatStore.setState(state => ({ conversations: state.conversations.map(item => item.id === conversationId
        ? { ...item, title: title.trim() } : item) }));
      setConversation({ ...conversation, title: title.trim() });
      setRenaming(false);
      onHistoryChange?.();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not rename this conversation"); }
    finally { setPending(false); }
  }

  return <div className="group flex min-w-0 items-center gap-1" aria-label="Host conversation actions">
    {variant === "title" && <h2 className="truncate text-sm font-semibold">{conversationTitle || conversation?.title || "New chat"}</h2>}
    {conversation?.access_level === "owner" && <>
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className={variant === "title" ? "h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100" : "h-6 w-6"}
        aria-label="Rename conversation" disabled={disabled || pending}
        onClick={() => { setTitle(conversationTitle ?? conversation.title); setError(null); setRenaming(true); }}><Pencil className="h-3 w-3" aria-hidden />
      </Button></TooltipTrigger><TooltipContent>Rename conversation</TooltipContent></Tooltip>
      {variant === "actions" && getStorageMode() === "mongodb" && !disabled && !pending && (
        <ShareButton conversationId={conversationId} conversationTitle={conversation.title}
          isOwner sharing={conversation.sharing} accessLevel="owner" />
      )}
      {variant === "actions" && <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-6 w-6"
        aria-label="Archive conversation" disabled={disabled || pending} onClick={() => void archive()}>
        <Archive className="h-3 w-3" aria-hidden />
      </Button></TooltipTrigger><TooltipContent>Archive conversation</TooltipContent></Tooltip>}
    </>}
    <Dialog open={renaming} onOpenChange={setRenaming}><DialogContent>
      <DialogHeader><DialogTitle>Rename conversation</DialogTitle></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); void rename(); }} className="space-y-3">
        <Input aria-label="Conversation title" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} autoFocus />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={pending || !title.trim()}>Save</Button>
      </form>
    </DialogContent></Dialog>
    {error && !renaming && <p role="alert" className="max-w-48 text-xs text-destructive">{error}</p>}
  </div>;
}
