"use client";

import { useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { AgentPicker } from "@/components/ui/agent-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AGENT_HANDLE_PATTERN, MAX_COORDINATION_AGENTS, suggestedAgentHandle } from "@/lib/chat-coordination";
import type { ChatCoordination } from "@/hooks/use-chat-coordination";

export function AddChatAgentDialog({ coordination, disabled }: { coordination: ChatCoordination; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [handle, setHandle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choices = coordination.availableAgents.filter(agent => agent._id !== coordination.primaryAgentId &&
    !coordination.agents.some(member => member.agent_id === agent._id));
  const duplicateHandle = handle === "primary" || coordination.agents.some(agent => agent.handle === handle);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await coordination.addAgent(agentId, handle);
      setOpen(false);
      setAgentId("");
      setHandle("");
    } catch (error) { setError(error instanceof Error ? error.message : "Could not add this agent."); }
    finally { setSaving(false); }
  };
  return <Dialog open={open} onOpenChange={value => { if (!saving) { setOpen(value); setError(null); } }}>
    <DialogTrigger asChild><Button size="sm" variant="outline" className="w-full" disabled={disabled || !coordination.canManage || !coordination.available || coordination.agents.length >= MAX_COORDINATION_AGENTS}>
      <Plus className="mr-2 h-3.5 w-3.5" aria-hidden="true" />Add agent
    </Button></DialogTrigger>
    <DialogContent className="sm:max-w-md">
      <DialogHeader><DialogTitle>Add an agent to this chat</DialogTitle><DialogDescription>Primary can assign work to joined agents using your current access. Use @mentions to address an agent directly.</DialogDescription></DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2"><Label>Agent</Label><AgentPicker ariaLabel="Coordination agent" value={agentId}
          onChange={id => { setAgentId(id); setHandle(suggestedAgentHandle(choices.find(agent => agent._id === id)?.name ?? id)); }}
          options={choices.map(agent => ({ value: agent._id, label: agent.name }))} loading={coordination.loading}
          error={coordination.error} onRetry={() => void coordination.refresh()} placeholder="Choose an agent" required disabled={saving} />
        </div>
        <div className="space-y-2"><Label htmlFor="coordination-handle">Chat handle</Label><Input id="coordination-handle" value={handle} onChange={event => setHandle(event.target.value.toLowerCase())} maxLength={32} placeholder="reviewer" disabled={saving} aria-describedby="coordination-handle-help" />
          <p id="coordination-handle-help" className="text-xs text-muted-foreground">Use @{handle || "reviewer"} at the start of a message. 2–32 letters, numbers or hyphens.</p>
          {duplicateHandle && <p role="alert" className="text-xs text-destructive">This handle is already in use.</p>}
        </div>
        <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground space-y-2"><p>This agent receives messages addressed to it and its own session history. Earlier chat messages and other agents’ workspaces are not copied.</p><p>Each participant needs their own agent and tool access. Connected credentials are not shared.</p></div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={saving} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={saving || !agentId || !AGENT_HANDLE_PATTERN.test(handle) || duplicateHandle}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Join chat</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}
