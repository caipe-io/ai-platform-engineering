"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getHarnessPresentation } from "@/lib/agent-presentation";
import { useChatStore } from "@/store/chat-store";
import type { AvailableSubagent } from "@/types/dynamic-agent";

/** Configured CAIPE workers, not arbitrary ACP endpoints. */
export function isConfiguredAcpAgent(agent: AvailableSubagent): boolean {
  return ["claude_code_acp", "claude_code_cli_acp"].includes(agent.execution_harness_id ?? "");
}

export function ConfiguredAcpAgentCard({ agent }: { agent: AvailableSubagent }) {
  const router = useRouter();
  const createConversation = useChatStore(state => state.createConversation);
  const [starting, setStarting] = React.useState(false);
  const pending = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  async function chat() {
    if (pending.current) return;
    pending.current = true;
    setStarting(true);
    setError(null);
    try {
      const conversationId = await createConversation(agent.id);
      router.push(`/chat/${conversationId}`);
    } catch {
      setError("Could not start this chat. Retry or check your access to the agent.");
    } finally {
      pending.current = false;
      setStarting(false);
    }
  }
  return <article aria-label={`${agent.name} ACP agent`} className="rounded-lg border p-3 space-y-2">
    <div className="font-medium">{agent.name}<span className="ml-2 text-xs text-muted-foreground">ACP · {getHarnessPresentation(agent.execution_harness_id).label}</span></div>
    {agent.description && <p className="text-xs text-muted-foreground">{agent.description}</p>}
    <p className="text-xs text-muted-foreground">Uses its saved operator profile and conversation session. Add it in Agent Builder under Subagents.</p>
    <div className="flex gap-2">
      <Button type="button" size="sm" disabled={starting} onClick={() => void chat()} aria-label={`Chat with ${agent.name}`}>{starting ? "Starting…" : "Chat"}</Button>
      <Button type="button" size="sm" variant="outline" asChild><Link href={`/dynamic-agents?tab=agents&agent=${encodeURIComponent(agent.id)}`}>Open agent</Link></Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </article>;
}
