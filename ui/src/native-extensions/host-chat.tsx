"use client";

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";

import type { NativeHostChat, NativeHostChatPanelProps, NativeHostConversationActionsProps } from "../../app-sdk";
import { ASSISTANT_EXTENSIONS, validateAssistantConfiguration, type AssistantOptions } from "../../app-sdk/assistant-options.mjs";
import { configureHostAssistant, HOST_ASSISTANT_EVENT, HOST_ASSISTANT_STATE_EVENT, requestHostAssistant } from "@/lib/agentic-apps/assistant-events";
import { apiClient } from "@/lib/api-client";
import { hasStoredAppConversationIdentity, matchesAppConversation } from "@/lib/agentic-apps/app-conversation-binding";
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
  const primary = item?.assistantAgentId === agentId;
  if (!item?.canLaunch || (!primary && !item.chatAgentIds?.includes(agentId))) throw new Error("Assistant binding changed");
  const agentsResponse = await fetch("/api/dynamic-agents/available", { cache: "no-store" });
  if (!agentsResponse.ok) throw new Error("Assistant is unavailable or access was denied");
  const agents = await agentsResponse.json();
  const agent = agents.success && Array.isArray(agents.data)
    ? (agents.data as DynamicAgentConfig[]).find(candidate => candidate._id === agentId) : undefined;
  if (!agent || agent.presentation?.app?.id !== appId || agent.presentation.available !== true) {
    throw new Error("Assistant is unavailable or access was denied");
  }
  const appOwnedRuntime = !primary || item.assistantUsesAppRuntime === true;
  if (appOwnedRuntime && getStorageMode() !== "mongodb") throw new Error("App-owned chat requires canonical server history");
  const saved = getStorageMode() === "mongodb"
    ? await apiClient.getConversation(conversationId) : loadLocalConversation(conversationId);
  if (saved._id !== conversationId || getAgentId(saved) !== agentId) throw new Error("Agent does not match this conversation");
  if (saved.metadata?.agentic_app_id && saved.metadata.agentic_app_id !== appId) throw new Error("Conversation belongs to another app");
  if (personalHistory && saved.access_level !== "owner") throw new Error("Personal history requires its owner");
  if ((appOwnedRuntime || hasStoredAppConversationIdentity(saved)) && !matchesAppConversation(saved, appId, agentId)) {
    throw new Error("Conversation app binding is unavailable");
  }
  return { saved, agent, appOwnedRuntime };
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
    const { data: session } = useSession();
    const [loaded, setLoaded] = useState<{
      key: string; agent: DynamicAgentConfig; readOnly: boolean; appOwnedRuntime: boolean;
      reason?: "admin_audit" | "shared_readonly";
    } | null>(null);
    const [error, setError] = useState<{ key: string; message: string } | null>(null);
    const key = `${session?.sub ?? ""}:${props.conversationId}:${props.agentId}`;
    useEffect(() => {
      let cancelled = false;
      let activated = false;
      const previousConversationId = useChatStore.getState().activeConversationId;
      async function open() {
        const { saved, agent, appOwnedRuntime } = await loadHostConversation(appId, props.agentId, props.conversationId);
        if (cancelled) return;
        useChatStore.setState(state => ({ conversations: mergeAppConversation(state.conversations, saved) }));
        activated = true;
        useChatStore.getState().setActiveConversation(saved._id);
        await useChatStore.getState().loadMessagesFromServer(saved._id);
        if (!cancelled) {
          const reason = saved.access_level === "admin_audit" || saved.access_level === "shared_readonly" ? saved.access_level : undefined;
          setLoaded({ key, agent, readOnly: Boolean(reason) || agent.enabled === false, appOwnedRuntime, reason });
          setError(null);
        }
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
    if (loaded?.key !== key) return <p role="status" className="p-4 text-sm text-muted-foreground">Loading conversation…</p>;
    return <Suspense fallback={<p role="status">Loading conversation…</p>}><ChatPanel {...props}
      appOwnedRuntime={loaded.appOwnedRuntime} readOnly={loaded.readOnly} readOnlyReason={loaded.reason}
      agent={{ ...loaded.agent, name: props.agentName ?? loaded.agent.name }} /></Suspense>;
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

/** Additional installed agent streams use ordinary Chat without mounting app UI. */
export function AppStreamConversationSurface({ appId, conversationId, agentId }: {
  appId: string;
  conversationId: string;
  agentId: string;
}) {
  const { Panel } = useMemo(() => createHostChatCapability(appId), [appId]);
  return <Panel conversationId={conversationId} agentId={agentId} />;
}
