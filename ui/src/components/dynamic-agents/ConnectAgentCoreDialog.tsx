"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getErrorMessage } from "@/lib/error-utils";
import { Loader2 } from "lucide-react";
import React from "react";

const endpoint = "/api/admin/harness-engine/agentcore-connections";

export function useAgentCoreConnectionAccess() {
  const [configured, setConfigured] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    fetch(endpoint, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const result = await response.json();
      if (!cancelled && result.success) setConfigured(result.data.configured === true);
    }).catch((cause) => console.warn("AgentCore connection permission could not be loaded", cause));
    return () => { cancelled = true; };
  }, []);
  return configured;
}

export function ConnectAgentCoreDialog({ open, onOpenChange, onConnected }: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  onConnected: (profileId: string) => Promise<void>;
}) {
  const [profileId, setProfileId] = React.useState("");
  const [arn, setArn] = React.useState("");
  const [region, setRegion] = React.useState("");
  const [qualifier, setQualifier] = React.useState("DEFAULT");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile_id: profileId.trim(), arn: arn.trim(), region: region.trim(), qualifier: qualifier.trim() }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success || typeof result.data?.profile_id !== "string") {
        const detail = Array.isArray(result?.detail)
          ? result.detail.map((issue: { msg?: string }) => issue.msg).filter(Boolean).join(". ")
          : result?.detail;
        throw new Error(result?.error || detail || `Connection could not be registered (HTTP ${response.status})`);
      }
      await onConnected(result.data.profile_id);
      onOpenChange(false);
    } catch (cause) {
      setError(getErrorMessage(cause, "Connection could not be registered"));
    } finally {
      setSaving(false);
    }
  }

  return <Dialog open={open} onOpenChange={(value) => { if (!saving) onOpenChange(value); }}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={connect} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Connect an existing AgentCore deployment</DialogTitle>
            <DialogDescription>Register a shared connection and select it for this agent. Review ownership and chat access in Agent Builder, then save the agent. The AWS deployment remains externally managed.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="agentcore-connection-id">Connection ID</Label>
            <Input id="agentcore-connection-id" value={profileId} onChange={(event) => setProfileId(event.target.value)} placeholder="existing-example" pattern="existing-[a-z0-9][a-z0-9-]{0,54}" maxLength={64} required disabled={saving} />
            <p className="text-xs text-muted-foreground">Start with existing-. This permanent ID appears in the operator profile picker and cannot be retargeted.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="agentcore-connection-arn">Harness or Runtime ARN</Label>
            <Input id="agentcore-connection-arn" value={arn} onChange={(event) => setArn(event.target.value)} maxLength={2048} required disabled={saving} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="agentcore-connection-region">AWS Region</Label>
              <Input id="agentcore-connection-region" value={region} onChange={(event) => setRegion(event.target.value)} maxLength={32} required disabled={saving} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agentcore-connection-qualifier">Qualifier</Label>
              <Input id="agentcore-connection-qualifier" value={qualifier} onChange={(event) => setQualifier(event.target.value)} maxLength={64} required disabled={saving} />
            </div>
          </div>
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>This profile becomes available to CAIPE agent builders. Each agent’s ownership and sharing control who can chat.</p>
            <p>Harness Engine uses its existing AWS credentials. AWS access is checked when invoking; registration checks the ARN and Region. Deployment tools retain their AWS permissions and do not inherit CAIPE tool grants.</p>
            <p>Managed Harness calls use the CAIPE agent’s instructions. Custom Runtimes must support the adapter’s message format. Configuration, permissions and chat history are not imported.</p>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Connect and select</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>;
}
