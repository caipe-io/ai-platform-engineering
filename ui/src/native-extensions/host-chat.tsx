"use client";

import { lazy, Suspense, useEffect, useState } from "react";

import type { NativeHostChat, NativeHostChatPanelProps, NativeHostConversationActionsProps } from "../../app-sdk";
import { ASSISTANT_EXTENSIONS, validateAssistantConfiguration, type AssistantOptions } from "../../app-sdk/assistant-options.mjs";
import { configureHostAssistant, HOST_ASSISTANT_EVENT, HOST_ASSISTANT_STATE_EVENT, requestHostAssistant } from "@/lib/agentic-apps/assistant-events";
import { apiClient } from "@/lib/api-client";
import { getStorageMode } from "@/lib/storage-config";
import { mergeAppConversation } from "@/lib/agentic-apps/assistant-conversations";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import { getAgentId } from "@/types/a2a";
import { useChatStore } from "@/store/chat-store";

const ChatPanel = lazy(() => import("@/components/chat/DynamicAgentChatPanel").then(module => ({ default: module.ChatPanel })));
const ConversationActions = lazy(() => import("./HostConversationActions"));

/** Resolve the installation and agent-use policy before restoring app chat UI. */
export async function loadHostConversation(appId: string, agentId: string, conversationId: string, personalHistory = false) {
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
  const saved = getStorageMode() === "mongodb"
    ? await apiClient.getConversation(conversationId) : loadLocalConversation(conversationId);
  if (getAgentId(saved) !== agentId) throw new Error("Agent does not match this conversation");
  if (saved.metadata?.agentic_app_id && saved.metadata.agentic_app_id !== appId) throw new Error("Conversation belongs to another app");
  if (personalHistory ? saved.access_level !== "owner" : !["owner", "shared", "shared_readonly"].includes(saved.access_level ?? ""))
    throw new Error("Conversation is not available for this assistant");
  return { saved, agent };
}

function loadLocalConversation(id: string) {
  const local = useChatStore.getState().conversations.find(item => item.id === id);
  if (!local) throw new Error("Conversation not found in local history");
  return { _id: local.id, title: local.title, participants: local.participants,
    created_at: local.createdAt, updated_at: local.updatedAt, metadata: local.metadata,
    owner_id: local.owner_id, access_level: local.accessLevel ?? "owner", sharing: local.sharing };
}

/** A native package receives a renderer, never a second copy of the host store. */
export function createHostChatCapability(appId: string, assistantAvailable = false, options?: AssistantOptions): NativeHostChat {
  function Panel(props: NativeHostChatPanelProps) {
    const [loaded, setLoaded] = useState("");
    const [readOnly, setReadOnly] = useState(false);
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
        useChatStore.setState(state => ({ conversations: mergeAppConversation(state.conversations, saved) }));
        activated = true;
        useChatStore.getState().setActiveConversation(saved._id);
        await useChatStore.getState().loadMessagesFromServer(saved._id, { force: true });
        if (!cancelled) { setAgent(availableAgent); setReadOnly(saved.access_level === "shared_readonly"); setLoaded(key); setError(null); }
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
    return <Suspense fallback={<p role="status">Loading conversation…</p>}><ChatPanel {...props} agent={agent} readOnly={readOnly} readOnlyReason={readOnly ? "shared_readonly" : undefined} /></Suspense>;
  }
  function Actions(props: NativeHostConversationActionsProps) {
    return <Suspense fallback={null}><ConversationActions key={`${props.conversationId}:${props.agentId}`} {...props} appId={appId} /></Suspense>;
  }
  return { Panel, ConversationActions: Actions, ...(assistantAvailable ? { assistant: {
    extensions: ASSISTANT_EXTENSIONS,
    configure: configuration => {
      validateAssistantConfiguration(configuration, options);
      configureHostAssistant(appId, structuredClone(configuration));
    },
    close: () => window.dispatchEvent(new CustomEvent(HOST_ASSISTANT_EVENT, { detail: { appId, close: true } })),
    subscribe: onOpenChange => {
      const listener = (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (detail?.appId === appId && typeof detail.open === "boolean") onOpenChange(detail.open);
      };
      window.addEventListener(HOST_ASSISTANT_STATE_EVENT, listener);
      return () => window.removeEventListener(HOST_ASSISTANT_STATE_EVENT, listener);
    },
    open: context => requestHostAssistant(appId, context),
    setContext: context => requestHostAssistant(appId, context, false),
  } } : {}) };
}
