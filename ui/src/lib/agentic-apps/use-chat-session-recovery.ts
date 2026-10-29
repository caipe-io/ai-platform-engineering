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
      running: boolean; savingSince?: number; turnId?: string; completedTurnId?: string; observedTurnId?: string; busy: boolean }>();
    const unsupported = new Set<string>();
    const expiredTurns = new Map<string, string | undefined>();
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
        const currentMessages = state.conversations.find(c => c.id === id)?.messages ?? [];
        const requestedTurnId = [...currentMessages].reverse().find(m => m.role === "user" && m.turnId)?.turnId ?? watch.turnId;
        const response = await fetch("/api/v1/chat/stream/status", {
          method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
          body: JSON.stringify({ conversation_id: id, agent_id: watch.agentId, ...(requestedTurnId ? { turn_id: requestedTurnId } : {}) }),
          signal: request.signal,
        });
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500 && response.status !== 501) {
            watch.next = Date.now() + 10_000;
            return; // Retry observation only; never start or resend execution.
          }
          // Unknown runtime and revoked access both stop this observer. Reads still enforce RBAC.
          unsupported.add(id);
          useChatStore.getState().setExternalActivity(id, null);
          return;
        }
        const data = await response.json();
        if (typeof data.running !== "boolean" || data.turnId !== undefined &&
            (typeof data.turnId !== "string" || data.turnId.length > 128)) throw new Error("Invalid app turn status");
        if (!currentWatch() || Date.now() > watch.deadline || useChatStore.getState().streamingConversations.has(id)) return;
        if (data.completedTurn && data.completedTurn.turnId === requestedTurnId &&
            watch.completedTurnId !== requestedTurnId) {
          await useChatStore.getState().loadMessagesFromServer(id);
          const answer = useChatStore.getState().conversations.find(c => c.id === id)?.messages
            .find(m => m.role === "assistant" && m.turnId === requestedTurnId && m.appCompletion);
          if (answer?.isFinal) watch.completedTurnId = requestedTurnId;
        }
        if (data.running) {
          watch.running = true;
          watch.turnId = data.turnId;
          watch.savingSince = undefined;
          useChatStore.getState().setExternalActivity(id, { agentId: watch.agentId, state: "running", turnId: watch.turnId });
          await useChatStore.getState().loadMessagesFromServer(id);
          watch.next = Date.now() + 2000;
        } else {
          if (watch.running) {
            watch.savingSince ??= Date.now();
            useChatStore.getState().setExternalActivity(id, { agentId: watch.agentId, state: "saving", turnId: watch.turnId });
            await useChatStore.getState().loadMessagesFromServer(id);
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
      const latestTurnId = [...(conversation?.messages ?? [])].reverse().find(m => m.role === "user" && m.turnId)?.turnId;
      if (id && agentId && !unsupported.has(id) && !watches.has(id) &&
          (!expiredTurns.has(id) || expiredTurns.get(id) !== latestTurnId)) watches.set(id,
        { agentId, deadline: Date.now() + MAX_WATCH_MS, next: 0, busy: false, running: false, observedTurnId: latestTurnId });
      const activeWatch = id ? watches.get(id) : undefined;
      if (activeWatch && activeWatch.observedTurnId !== latestTurnId) {
        activeWatch.observedTurnId = latestTurnId;
        activeWatch.deadline = Date.now() + MAX_WATCH_MS;
        activeWatch.next = 0;
      }
      for (const [key, watch] of watches) {
        if (!state.conversations.some(c => c.id === key)) {
          watches.delete(key);
          state.setExternalActivity(key, null);
        } else if (unsupported.has(key) || Date.now() > watch.deadline) {
          if (!unsupported.has(key)) expiredTurns.set(key, watch.observedTurnId);
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
