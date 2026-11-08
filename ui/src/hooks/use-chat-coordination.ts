"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "@/store/chat-store";
import type { ChatCoordinationAgent } from "@/lib/chat-coordination";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";

export interface ChatHandoff { _id: string; handle: string; status: string; lastError?: string; runId?: string; targetAgentId: string; }

export interface ChatCoordination {
  mode?: "mentions" | "team";
  handoffs?: ChatHandoff[];
  setMode?: (mode: "mentions" | "team") => Promise<void>;
  agents: ChatCoordinationAgent[];
  availableAgents: DynamicAgentConfig[];
  canManage: boolean;
  available: boolean;
  loading: boolean;
  error: string | null;
  selectedAgentId: string;
  primaryAgentId: string;
  selectAgent: (id: string) => void;
  refresh: () => Promise<void>;
  addAgent: (agentId: string, handle: string) => Promise<void>;
}

async function readData<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok || !body.success) throw new Error(body.error || "Could not load chat agents.");
  return body.data as T;
}

/** Available agents come from the existing Use-filtered domain endpoint. */
export function useChatCoordination(conversationId: string, primaryAgentId: string): ChatCoordination {
  const handoffSignature = useRef("");
  const [mode, setModeState] = useState<"mentions" | "team">("mentions");
  const [handoffs, setHandoffs] = useState<ChatHandoff[]>([]);
  const [agents, setAgents] = useState<ChatCoordinationAgent[]>([]);
  const [availableAgents, setAvailableAgents] = useState<DynamicAgentConfig[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState({ conversationId, agentId: primaryAgentId });
  const selectedAgentId = selection.conversationId === conversationId ? selection.agentId : primaryAgentId;

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [membershipResponse, catalogResponse] = await Promise.all([
        fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/agents`, { signal, cache: "no-store" }),
        fetch("/api/dynamic-agents/available", { signal, cache: "no-store" }),
      ]);
      const membership = await readData<{ agents: ChatCoordinationAgent[]; can_manage: boolean; available: boolean; mode?: "mentions" | "team"; handoffs?: ChatHandoff[] }>(membershipResponse);
      const catalog = await readData<DynamicAgentConfig[]>(catalogResponse);
      if (signal?.aborted) return;
      setAgents(membership.agents);
      setModeState(membership.mode ?? "mentions");
      setHandoffs(membership.handoffs ?? []);
      setCanManage(membership.can_manage);
      setAvailable(membership.available);
      setAvailableAgents(catalog.filter(agent => agent.enabled && !agent.presentation?.app));
    } catch (error) {
      if (!signal?.aborted) setError(error instanceof Error ? error.message : "Could not load chat agents.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    const controller = new AbortController();
    setAgents([]);
    setHandoffs([]);
    setModeState("mentions");
    handoffSignature.current = "";
    setCanManage(false);
    setAvailableAgents([]);
    void load(controller.signal);
    const onFocus = () => { void load(controller.signal); };
    window.addEventListener("focus", onFocus);
    return () => { controller.abort(); window.removeEventListener("focus", onFocus); };
  }, [load]);

  const refresh = useCallback(() => load(), [load]);
  const selectAgent = useCallback((id: string) => setSelection({ conversationId, agentId: id || primaryAgentId }), [conversationId, primaryAgentId]);
  const addAgent = useCallback(async (agentId: string, handle: string) => {
    await readData(await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/agents`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: agentId, handle }),
    }));
    await load();
    setSelection({ conversationId, agentId });
  }, [conversationId, load]);

  const setMode = useCallback(async (next: "mentions" | "team") => {
    try {
      await readData(await fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/agents`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: next }),
      }));
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update coordination mode."); }
  }, [conversationId, load]);

  useEffect(() => {
    if (mode !== "team") return;
    const controller = new AbortController();
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void fetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}/agents`, { cache: "no-store", signal: controller.signal })
        .then(readData<{ handoffs: ChatHandoff[]; mode: "mentions" | "team" }>)
        .then(async data => {
          if (controller.signal.aborted) return;
          setHandoffs(data.handoffs); setModeState(data.mode);
          const signature = JSON.stringify(data.handoffs.map(job => [job._id, job.status, job.runId]));
          if (signature !== handoffSignature.current) {
            await useChatStore.getState().loadMessagesFromServer(conversationId, { force: true });
            handoffSignature.current = signature;
          }
        }).catch(() => {
          if (!controller.signal.aborted) setError("Could not refresh agent handoffs. Retrying shortly.");
        }).finally(() => { pending = false; });
    }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [mode, conversationId]);

  return { mode, handoffs, setMode, agents, availableAgents, canManage, available, loading, error,
    primaryAgentId, selectedAgentId, selectAgent, refresh, addAgent };
}
