"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";

import { useChatStore } from "@/store/chat-store";
import { getAgentId } from "@/types/a2a";

const MAX_WATCH_MS = 20 * 60_000;
const SAVE_GRACE_MS = 10_000;

/** Observe authorized app status and saved messages; never restart a model turn. */
export function useChatSessionRecovery(): void {
  const { data: session, status } = useSession();
  const identity = session?.user?.email;
  useEffect(() => {
    if (status !== "authenticated" || !identity) return;
    const controller = new AbortController();
    const watches = new Map<string, { agentId: string; deadline: number; next: number;
      running: boolean; savingSince?: number; turnId?: string; busy: boolean }>();
    const unsupported = new Set<string>();
    async function check(id: string, watch: NonNullable<ReturnType<typeof watches.get>>) {
      const currentWatch = () => !controller.signal.aborted && watches.get(id) === watch &&
        useChatStore.getState().conversations.some(c => c.id === id);
      watch.busy = true;
      const request = new AbortController();
      const abort = () => request.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 10_000);
      try {
        const state = useChatStore.getState();
        if (state.streamingConversations.has(id)) {
          state.setExternalActivity(id, null);
          watch.next = Date.now() + 2000;
          return;
        }
        const response = await fetch("/api/v1/chat/stream/status", {
          method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
          body: JSON.stringify({ conversation_id: id, agent_id: watch.agentId }),
          signal: request.signal,
        });
        if (!response.ok) {
          // Unknown runtime and revoked access both stop this observer. Reads still enforce RBAC.
          unsupported.add(id);
          useChatStore.getState().setExternalActivity(id, null);
          return;
        }
        const data = await response.json();
        if (typeof data.running !== "boolean" || data.turnId !== undefined &&
            (typeof data.turnId !== "string" || data.turnId.length > 128)) throw new Error("Invalid app turn status");
        if (!currentWatch() || Date.now() > watch.deadline || useChatStore.getState().streamingConversations.has(id)) return;
        if (data.running) {
          watch.running = true;
          watch.turnId = data.turnId;
          watch.savingSince = undefined;
          useChatStore.getState().setExternalActivity(id, { agentId: watch.agentId, state: "running", turnId: watch.turnId });
          await useChatStore.getState().loadMessagesFromServer(id, { force: true });
          watch.next = Date.now() + 2000;
        } else {
          if (watch.running) {
            watch.savingSince ??= Date.now();
            useChatStore.getState().setExternalActivity(id, { agentId: watch.agentId, state: "saving", turnId: watch.turnId });
            await useChatStore.getState().loadMessagesFromServer(id, { force: true });
            if (!currentWatch()) return;
            const messages = useChatStore.getState().conversations.find(c => c.id === id)?.messages ?? [];
            const answer = watch.turnId ? messages.find(m => m.role === "assistant" && m.turnId === watch.turnId) : messages.at(-1);
            if (!answer?.isFinal && Date.now() - watch.savingSince < SAVE_GRACE_MS) {
              watch.next = Date.now() + 2000;
              return;
            }
          }
          watch.running = false;
          watch.savingSince = undefined;
          useChatStore.getState().setExternalActivity(id, null);
          watch.next = Date.now() + 10_000;
        }
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[App chat] Status refresh failed", error instanceof Error ? error.name : "unknown");
        watch.next = Date.now() + 10_000;
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abort);
        watch.busy = false;
      }
    }
    const tick = () => {
      const state = useChatStore.getState();
      const id = state.activeConversationId;
      const conversation = state.conversations.find(c => c.id === id);
      const agentId = conversation && getAgentId(conversation);
      if (id && agentId && !unsupported.has(id) && !watches.has(id)) watches.set(id,
        { agentId, deadline: Date.now() + MAX_WATCH_MS, next: 0, busy: false, running: false });
      for (const [key, watch] of watches) {
        if (!state.conversations.some(c => c.id === key)) {
          watches.delete(key);
          state.setExternalActivity(key, null);
        } else if (unsupported.has(key) || Date.now() > watch.deadline) {
          unsupported.add(key);
          watches.delete(key);
          state.setExternalActivity(key, null);
        } else if (!watch.busy && Date.now() >= watch.next && (key === id || watch.running || watch.savingSince)) {
          void check(key, watch);
        }
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      controller.abort(); clearInterval(timer);
      for (const id of watches.keys()) useChatStore.getState().setExternalActivity(id, null);
    };
  }, [identity, status]);
}
