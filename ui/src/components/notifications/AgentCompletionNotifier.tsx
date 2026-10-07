"use client";

import {
  deliverAgentCompletionAlert,
  loadAgentCompletionPreferences,
  prepareBrowserNotificationDelivery,
  primeCompletionChime,
} from "@/lib/agent-completion-notifications";
import { useChatStore } from "@/store/chat-store";
import type { ChatMessage } from "@/types/a2a";
import { useEffect,useRef } from "react";

function latestAssistantMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find((message) => message.role === "assistant");
}

/**
 * Observes the protocol-neutral chat store rather than any provider stream.
 * Dynamic Agents, AG-UI, and Harness Gateway runs all converge on this state.
 */
export function AgentCompletionNotifier(): null {
  const conversations = useChatStore((state) => state.conversations);
  const streamingConversations = useChatStore((state) => state.streamingConversations);
  const previousStreamingIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let disposed = false;
    let removeUnlockListeners: (() => void) | undefined;

    void loadAgentCompletionPreferences().then((preferences) => {
      if (disposed) return;
      if (preferences.browserEnabled) void prepareBrowserNotificationDelivery();
      if (!preferences.chimeEnabled) return;
      const unlock = () => {
        void primeCompletionChime();
        removeUnlockListeners?.();
      };
      removeUnlockListeners = () => {
        window.removeEventListener("pointerdown",unlock);
        window.removeEventListener("keydown",unlock);
      };
      window.addEventListener("pointerdown",unlock,{ once: true });
      window.addEventListener("keydown",unlock,{ once: true });
    });

    return () => {
      disposed = true;
      removeUnlockListeners?.();
    };
  }, []);

  useEffect(() => {
    const currentStreamingIds = new Set(streamingConversations.keys());

    for (const conversationId of previousStreamingIdsRef.current) {
      if (currentStreamingIds.has(conversationId)) continue;
      const conversation = conversations.find((item) => item.id === conversationId);
      const message = conversation ? latestAssistantMessage(conversation.messages) : undefined;
      if (!conversation || !message || message.turnStatus !== "done" || message.isFinal === false) continue;

      void deliverAgentCompletionAlert({
        agentName: message.agentName,
        conversationId,
        messageId: message.id,
      });
    }

    previousStreamingIdsRef.current = currentStreamingIds;
  }, [conversations,streamingConversations]);

  return null;
}
