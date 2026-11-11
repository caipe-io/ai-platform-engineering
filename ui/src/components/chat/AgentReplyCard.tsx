"use client";

import { useState, type ReactNode } from "react";
import { Loader2, Maximize2, Minimize2, Square } from "lucide-react";
import { AgentAvatar } from "@/components/dynamic-agents/AgentAvatar";
import { Button } from "@/components/ui/button";
import { AgentHarnessBadge } from "./AgentHarnessBadge";
import { agentMentionColor } from "@/lib/agent-mention-colors";
import { cn } from "@/lib/utils";
import type { DynamicAgentConfig } from "@/types/dynamic-agent";
import type { TurnStatus } from "@/types/a2a";

export function AgentReplyCard({ handle, handles, agent, name, streaming, stopping, readOnly, status, stopError, onStop, inputAction, children }: {
  handle: string;
  handles: string[];
  agent?: DynamicAgentConfig;
  name: string;
  streaming: boolean;
  stopping?: boolean;
  readOnly?: boolean;
  status?: TurnStatus;
  stopError?: string;
  onStop?: () => void;
  inputAction?: ReactNode;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = stopping ? "Stopping…" : streaming ? "Responding" : status === "waiting_for_input" ? "Needs your input"
    : status === "cancelled" ? "Stopped" : status === "interrupted" ? "Interrupted" : status === "done" ? "Complete" : "Checking response";
  return <section aria-label={`Reply from @${handle}`} className="mx-3 min-w-0 rounded-xl border border-border bg-card">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <AgentAvatar agent={agent} agentId={agent?._id} size="h-8 w-8" iconSize="h-4 w-4" />
        <div className="min-w-0">
          <div className="flex items-center gap-2"><span className={cn("font-medium", agentMentionColor(handle, handles))}>@{handle}</span>{agent && <AgentHarnessBadge harnessId={agent.execution_harness_id} presentation={agent.presentation} compact />}</div>
          <p className="truncate text-xs text-muted-foreground">{name}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span role="status" className={cn("flex items-center gap-1.5 text-xs", streaming ? "text-blue-700 dark:text-blue-300" : "text-muted-foreground")}>
          {(streaming || stopping) && <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />}{label}
        </span>
        {streaming && onStop && <Button size="sm" variant="outline" aria-label={`Stop @${handle}`} disabled={stopping || readOnly} onClick={onStop}><Square className="mr-1 h-3 w-3" />Stop</Button>}
        <Button size="icon" variant="ghost" aria-label={`${expanded ? "Collapse" : "Expand"} @${handle} reply`} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Button>
      </div>
    </header>
    <div className={cn("min-w-0", !expanded && "max-h-96 overflow-y-auto")}>{children}</div>
    {(stopError || inputAction) && <footer className="space-y-2 border-t border-border px-4 py-3">
      {stopError && <p role="alert" className="text-xs text-destructive">{stopError}</p>}{inputAction}
    </footer>}
  </section>;
}
