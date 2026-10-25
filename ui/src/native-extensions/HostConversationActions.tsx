"use client";

import { Archive } from "lucide-react";
import { useEffect, useState } from "react";

import type { NativeHostConversationActionsProps } from "../../app-sdk";
import { ShareButton } from "@/components/chat/ShareButton";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChatStore } from "@/store/chat-store";
import { loadHostConversation } from "./host-chat";

export default function HostConversationActions({ appId, conversationId, agentId, disabled, onArchived }:
  NativeHostConversationActionsProps & { appId: string }) {
  const [conversation, setConversation] = useState<Awaited<ReturnType<typeof loadHostConversation>>["saved"] | null>(null);
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

  return <div className="flex items-center gap-1" aria-label="Host conversation actions">
    {conversation?.access_level === "owner" && <>
      {!disabled && !pending && (
        <ShareButton conversationId={conversationId} conversationTitle={conversation.title}
          isOwner sharing={conversation.sharing} accessLevel="owner" />
      )}
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" className="h-6 w-6"
        aria-label="Archive conversation" disabled={disabled || pending} onClick={() => void archive()}>
        <Archive className="h-3 w-3" aria-hidden />
      </Button></TooltipTrigger><TooltipContent>Archive conversation</TooltipContent></Tooltip>
    </>}
    {error && <p role="alert" className="max-w-48 text-xs text-destructive">{error}</p>}
  </div>;
}
