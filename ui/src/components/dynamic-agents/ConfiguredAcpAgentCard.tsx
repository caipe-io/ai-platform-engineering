"use client";

import React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AgentCatalogCard } from "./AgentCatalogCard";
import { AgentTechnologyIcon, AgentProtocolBadge } from "./AgentTechnology";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getHarnessPresentation } from "@/lib/agent-presentation";
import { useChatStore } from "@/store/chat-store";
import type { AvailableSubagent } from "@/types/dynamic-agent";

/** Configured CAIPE workers, not arbitrary ACP endpoints. */
export function isConfiguredAcpAgent(agent: AvailableSubagent): boolean {
  return ["claude_code_acp", "claude_code_cli_acp"].includes(agent.execution_harness_id ?? "");
}

export function ConfiguredAcpAgentCard({ agent }: { agent: AvailableSubagent }) {
  const detailsTrigger = React.useRef<HTMLButtonElement>(null);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const router = useRouter();
  const createConversation = useChatStore(state => state.createConversation);
  const [starting, setStarting] = React.useState(false);
  const pending = React.useRef(false);
  const [error, setError] = React.useState<string | null>(null);
  async function chat() {
    if (pending.current || agent.execution_readiness?.ready === false) return;
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
  const runtime = getHarnessPresentation(agent.execution_harness_id);
  const readiness = agent.execution_readiness;
  return <AgentCatalogCard name={agent.name} ariaLabel={`${agent.name} ACP agent`} agent={agent} identity={<AgentTechnologyIcon agent={agent} protocol="acp" harnessId={agent.execution_harness_id} />} subtitle={runtime.label} footer={null}>
    <p className="line-clamp-3 text-sm text-muted-foreground">{agent.description || "No description provided."}</p>
    <div className="flex flex-wrap gap-1.5"><Badge variant="secondary">Direct chat</Badge><Badge variant="outline">Subagent delegation</Badge><Badge variant="outline">Saved sessions</Badge></div>
    <p className={`text-xs ${readiness?.ready === false ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>{readiness?.ready === false ? "Needs attention" : readiness?.ready ? "Configuration ready" : "Readiness not checked"}</p>
    <div className="mt-auto flex flex-wrap gap-2 pt-2">
      <Button type="button" size="sm" variant="outline" ref={detailsTrigger} aria-label={`Details for ${agent.name}`} onClick={() => setDetailsOpen(true)}>View details</Button>
      <Button type="button" size="sm" disabled={starting || readiness?.ready === false} onClick={() => void chat()} aria-label={`Chat with ${agent.name}`}>{starting ? "Starting…" : "Test chat"}</Button>
    </div>
    {readiness?.ready === false && <p role="status" className="text-sm text-amber-600">Needs attention: {readiness.message}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}><DialogContent onCloseAutoFocus={event => { event.preventDefault(); detailsTrigger.current?.focus(); }} className="max-h-[85dvh] max-w-2xl overflow-y-auto">
      <DialogHeader><DialogTitle className="flex items-center gap-3"><AgentTechnologyIcon decorative agent={agent} protocol="acp" harnessId={agent.execution_harness_id} />{agent.name}</DialogTitle><DialogDescription>{agent.description || "Configured ACP agent details and chat test."}</DialogDescription></DialogHeader>
      <div className="flex flex-wrap gap-2"><AgentProtocolBadge protocol="acp" /><Badge variant="secondary">{runtime.label}</Badge></div>
      <section className="space-y-2"><h3 className="font-medium">Capabilities</h3><p className="text-sm text-muted-foreground">Chat directly or delegate from another agent. Conversations use this agent’s saved operator profile, tools, and access permissions.</p><p className="text-sm text-muted-foreground">Tool availability is controlled by the saved agent configuration.</p></section>
      <section className="space-y-3 rounded-lg border p-4"><h3 className="font-medium">Test chat</h3><p className="text-sm text-muted-foreground">Opens a new conversation with this agent so you can send a test prompt and inspect its response.</p>
        {readiness?.ready === false && <p className="text-sm text-amber-600">Needs attention: {readiness.message}</p>}
        <Button type="button" disabled={starting || readiness?.ready === false} onClick={() => void chat()}>{starting ? "Starting…" : "Open test chat"}</Button>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </section>
      <Button type="button" variant="outline" asChild><Link href={`/dynamic-agents?tab=agents&agent=${encodeURIComponent(agent.id)}`}>Open agent</Link></Button>
    </DialogContent></Dialog>
  </AgentCatalogCard>;
}
