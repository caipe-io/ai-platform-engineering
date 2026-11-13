"use client";

import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LastReviewBadge } from "@/components/ai-review";
import { getAgentPresentation } from "@/lib/agent-presentation";
import type { DynamicAgentConfigWithPermissions } from "@/types/dynamic-agent";
import { AgentCatalogCard } from "./AgentCatalogCard";
import { AgentIdentity } from "./AgentIdentity";
import { AgentProtocolBadge } from "./AgentTechnology";

export function NativeAgentCatalogCard({ agent, actions, status, onOpen, onChat, chatDisabled, error, onDismiss }: {
  agent: DynamicAgentConfigWithPermissions; actions: ReactNode; status: ReactNode; onOpen: () => void;
  onChat: () => void; chatDisabled: boolean; error?: string; onDismiss: () => void;
}) {
  const [details, setDetails] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const identity = (decorative = false) => <AgentIdentity agent={agent} harnessId={agent.execution_harness_id} presentation={agent.presentation} decorative={decorative} />;
  const runtime = getAgentPresentation(agent.execution_harness_id, agent.presentation).label.replace(/^Execution harness: /, "");
  const subagents = (agent.subagents?.length || 0) + (agent.allowed_remote_agents?.length || 0);
  return <>
    <AgentCatalogCard name={agent.name} agent={agent} identity={identity()} subtitle={`${agent.visibility} · Created in CAIPE`} footer={<><Button ref={trigger} type="button" variant="outline" size="sm" className="h-8 px-2.5 text-xs" onClick={() => setDetails(true)} aria-label={`Details for ${agent.name}`}>View details</Button><Button type="button" size="sm" className="h-8 px-2.5 text-xs" onClick={onChat} disabled={chatDisabled} aria-label={`Chat with ${agent.name}`}>Chat</Button></>}>
      <p className="line-clamp-2 text-xs text-muted-foreground">{agent.description || "No description provided."}</p>
      <div className="flex min-w-0 items-center gap-2"><p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={runtime}>{runtime}</p>{["claude_code_acp", "claude_code_cli_acp"].includes(agent.execution_harness_id || "") && <AgentProtocolBadge protocol="acp" />}</div>
      <div className="flex flex-wrap items-center gap-1.5"><Badge variant="outline">{Object.keys(agent.allowed_tools || {}).length} MCP server{Object.keys(agent.allowed_tools || {}).length === 1 ? "" : "s"}</Badge>{subagents > 0 && <Badge variant="outline">{subagents} specialists</Badge>}{agent.skills?.length > 0 && <Badge variant="outline">{agent.skills.length} skills</Badge>}{agent.config_driven && <Badge variant="outline">Config</Badge>}<LastReviewBadge review={agent.last_review} />{status}</div>
      {agent.execution_readiness?.ready === false && <p className="text-xs text-amber-600 dark:text-amber-400">Needs attention: {agent.execution_readiness.message}</p>}
      {error && <div role="alert" className="text-xs text-destructive">{error}<Button type="button" variant="ghost" size="sm" onClick={onDismiss}>Dismiss</Button></div>}
    </AgentCatalogCard>
    <Dialog open={details} onOpenChange={setDetails}><DialogContent onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }} className="max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100%-2rem))] min-w-0 max-w-2xl overflow-y-auto p-4 [overflow-wrap:anywhere] sm:p-6"><DialogHeader><DialogTitle className="flex min-w-0 items-center gap-3 pr-6 text-left leading-snug">{identity(true)}{agent.name}</DialogTitle><DialogDescription>{agent.description || "Agent details and management actions."}</DialogDescription></DialogHeader>
      <dl className="grid min-w-0 grid-cols-1 gap-4 text-sm sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">Runtime</dt><dd>{runtime}</dd></div><div><dt className="text-xs text-muted-foreground">Visibility</dt><dd>{agent.visibility}</dd></div><div><dt className="text-xs text-muted-foreground">Source</dt><dd>Created in CAIPE</dd></div><div><dt className="text-xs text-muted-foreground">Status</dt><dd>{status}</dd></div></dl>
      {agent.execution_readiness?.ready === false && <p className="text-sm text-amber-600 dark:text-amber-400">Needs attention: {agent.execution_readiness.message}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3"><Button type="button" variant="outline" onClick={onOpen}>Open agent</Button>{actions}</div>
    </DialogContent></Dialog>
  </>;
}
