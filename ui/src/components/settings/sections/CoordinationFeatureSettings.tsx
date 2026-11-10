"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { SettingsCard } from "@/components/settings/shared/SettingsCard";
import { SettingsSwitch } from "@/components/settings/shared/SettingsSwitch";
import { Button } from "@/components/ui/button";

type Features = { enabled: boolean; team: boolean; activity: boolean };

export function CoordinationFeatureSettings({ readOnly = false }: { readOnly?: boolean }) {
  const [features, setFeatures] = useState<Features | null>(null);
  const [limits, setLimits] = useState<Features>({ enabled: false, team: false, activity: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/admin/platform-config", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || "Could not load coordination settings");
      setFeatures(body.data.agent_coordination);
      setLimits(body.data.agent_coordination_deployment);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load coordination settings"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const save = async (key: keyof Features, value: boolean) => {
    setSaving(true); setSaved(false); setError(null);
    try {
      const response = await fetch("/api/admin/platform-config", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_coordination: { [key]: value } }),
      });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || "Could not save coordination settings");
      setFeatures(body.data.agent_coordination);
      setLimits(body.data.agent_coordination_deployment);
      setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save coordination settings"); }
    finally { setSaving(false); }
  };
  return <SettingsCard title={<span className="flex items-center gap-2">Agent Coordination <Badge variant="secondary">Experimental</Badge></span>}
    description="Control experimental chat participants and delegation without restarting services. Existing chat history and agent permissions are preserved.">
    {!features && !error && <p className="text-sm text-muted-foreground">Loading coordination settings…</p>}
    {features && <div className="space-y-4">
      {([
        { key: "enabled", label: "Agent Coordination", description: "Allow agents to join chats and respond to mentions and assignments." },
        { key: "activity", label: "Agent Team activity", description: "Use the new Conversation and Grouped views. Turn off to restore Classic reply cards without changing agent runs." },
        { key: "team", label: "Team handoffs", description: "Allow joined agents to hand tasks to each other when the chat owner enables Team coordination." },
      ] as const).map(({ key, label, description }) => <div key={key} className="flex items-center justify-between gap-3">
        <div><p className="text-sm font-medium">{label}</p><p className="text-xs text-muted-foreground">{description}</p>
          {!limits[key] && <p className="text-xs text-muted-foreground">Disabled by deployment configuration</p>}</div>
        <SettingsSwitch label={label} checked={features[key]} disabled={readOnly || saving || !limits[key] || (key !== "enabled" && !features.enabled)} onCheckedChange={value => void save(key, value)} />
      </div>)}
      <p className="text-xs text-muted-foreground">Turning Agent Coordination or Team handoffs off cancels queued handoffs and prevents new ones. The activity switch changes presentation only. Active responses continue; use Stop to cancel them. Open chats update within 10 seconds.</p>
    </div>}
    {error && <div role="alert" className="text-sm text-destructive">{error}<Button variant="ghost" size="sm" onClick={() => void load()}>Reload settings</Button></div>}
    {(saving || saved) && <p role="status" className="text-xs text-muted-foreground">{saving ? "Saving…" : "Saved"}</p>}
  </SettingsCard>;
}
