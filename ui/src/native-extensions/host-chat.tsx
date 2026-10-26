"use client";

import { lazy, Suspense, useEffect, useState } from "react";

import type { NativeHostChat, NativeHostChatPanelProps, NativeHostConversationActionsProps } from "../../app-sdk";
import { apiClient } from "@/lib/api-client";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { getAgentId } from "@/types/a2a";
import { useChatStore } from "@/store/chat-store";

const ChatPanel = lazy(() => import("@/components/chat/DynamicAgentChatPanel").then(module => ({ default: module.ChatPanel })));
const ConversationActions = lazy(() => import("./HostConversationActions"));

/** Resolve the installation and agent-use policy before restoring app chat UI. */
export async function loadHostConversation(appId: string, agentId: string, conversationId: string) {
  const response = await fetch(`/api/agentic-apps/${encodeURIComponent(appId)}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Assistant app is unavailable or access was denied");
  const { item } = await response.json();
  if (!item?.canLaunch || item.assistantAgentId !== agentId) throw new Error("Assistant binding changed");
  const agentsResponse = await fetch("/api/dynamic-agents/available", { cache: "no-store" });
  if (!agentsResponse.ok) throw new Error("Assistant is unavailable or access was denied");
  const agents = await agentsResponse.json();
  const agent = agents.success && Array.isArray(agents.data)
    ? (agents.data as DynamicAgentConfig[]).find(candidate => candidate._id === agentId) : undefined;
  if (!agent) throw new Error("Assistant is unavailable or access was denied");
  const saved = await apiClient.getConversation(conversationId);
  if (getAgentId(saved) !== agentId) throw new Error("Agent does not match this conversation");
  return { saved, agent };
}

/** A native package receives a renderer, never a second copy of the host store. */
export function createHostChatCapability(appId: string): NativeHostChat {
  function Panel(props: NativeHostChatPanelProps) {
    const [loaded, setLoaded] = useState("");
    const [agent, setAgent] = useState<DynamicAgentConfig | null>(null);
    const [error, setError] = useState<{ key: string; message: string } | null>(null);
    const key = `${props.conversationId}:${props.agentId}`;
    useEffect(() => {
      let cancelled = false;
      let activated = false;
      const previousConversationId = useChatStore.getState().activeConversationId;
      async function open() {
        const { saved, agent: availableAgent } = await loadHostConversation(appId, props.agentId, props.conversationId);
        if (cancelled) return;
        useChatStore.setState((state) => ({ conversations: state.conversations.some(c => c.id === saved._id)
          ? state.conversations : [...state.conversations, { id: saved._id, title: saved.title,
            participants: saved.participants, createdAt: new Date(saved.created_at), updatedAt: new Date(saved.updated_at),
            metadata: saved.metadata, owner_id: saved.owner_id, accessLevel: saved.access_level, sharing: saved.sharing, messages: [], streamEvents: [] }] }));
        activated = true;
        useChatStore.getState().setActiveConversation(saved._id);
        await useChatStore.getState().loadMessagesFromServer(saved._id, { force: true });
        if (!cancelled) { setAgent(availableAgent); setLoaded(key); setError(null); }
      }
      void open().catch(reason => { if (!cancelled) setError({ key, message: reason instanceof Error ? reason.message : "Chat is unavailable" }); });
      // Restore only our selection; the host keeps the stream alive after unmount.
      return () => {
        cancelled = true;
        const state = useChatStore.getState();
        if (activated && state.activeConversationId === props.conversationId) {
          state.setActiveConversation(previousConversationId);
        }
      };
    }, [key, props.agentId, props.conversationId]);
    if (error?.key === key) return <p role="alert" className="p-4 text-sm text-destructive">{error.message}</p>;
    if (loaded !== key) return <p role="status" className="p-4 text-sm text-muted-foreground">Loading conversation…</p>;
    return <Suspense fallback={<p role="status">Loading conversation…</p>}><ChatPanel {...props} agent={agent} /></Suspense>;
  }
  function Actions(props: NativeHostConversationActionsProps) {
    return <Suspense fallback={null}><ConversationActions key={`${props.conversationId}:${props.agentId}`} {...props} appId={appId} /></Suspense>;
  }
  return { Panel, ConversationActions: Actions };
}
