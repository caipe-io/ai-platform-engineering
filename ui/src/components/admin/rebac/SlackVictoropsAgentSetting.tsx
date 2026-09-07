"use client";

// Superadmin-only setting on Admin → Integrations → Slack → Advanced.
// Persists the agent the Slack bot queries for VictorOps on-call lookups
// when escalation fires. Stored in platform_config
// (slack_victorops_escalation_agent_id) and read by the bot at runtime,
// with SLACK_INTEGRATION_VICTOROPS_AGENT_ID as the env/YAML fallback.

import { Loader2,Siren } from "lucide-react";
import { useEffect,useState } from "react";

import { SaveButton } from "@/components/admin/shared/SaveButton";
import { AgentPicker,type AgentPickerOption } from "@/components/ui/agent-picker";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { loadAllDynamicAgents } from "@/lib/dynamic-agent-list";

interface DynamicAgentOption {
  _id: string;
  name?: string;
}

const SUPERVISOR_VALUE = "";

export function SlackVictoropsAgentSetting({ disabled = false }: { disabled?: boolean }) {
  const { toast } = useToast();
  const [agents, setAgents] = useState<DynamicAgentOption[]>([]);
  const [selected, setSelected] = useState<string>(SUPERVISOR_VALUE);
  const [saved, setSaved] = useState<string>(SUPERVISOR_VALUE);
  const [source, setSource] = useState<"db" | "env" | "fallback">("fallback");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [items, configRes] = await Promise.all([
        loadAllDynamicAgents<DynamicAgentOption>({ enabledOnly: true }).catch(() => []),
        fetch("/api/admin/platform-config").then((r) => r.json()).catch(() => ({ success: false })),
      ]);
      if (cancelled) return;
      setAgents(items);
      if (configRes?.success) {
        const id = (configRes.data?.slack_victorops_escalation_agent_id as string | null) ?? SUPERVISOR_VALUE;
        setSelected(id ?? SUPERVISOR_VALUE);
        setSaved(id ?? SUPERVISOR_VALUE);
        setSource((configRes.data?.slack_victorops_escalation_agent_source as typeof source) ?? "fallback");
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const dirty = selected !== saved;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/platform-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slack_victorops_escalation_agent_id: selected || null }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data?.error || "Failed to save");
      setSaved(selected);
      setSource(selected ? "db" : "fallback");
      toast("VictorOps escalation agent saved.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save VictorOps escalation agent", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border bg-background/50 p-3 space-y-3">
      <div>
        <h3 className="inline-flex items-center gap-2 text-base font-semibold tracking-tight">
          <Siren className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          VictorOps escalation agent
        </h3>
        <p className="text-xs text-muted-foreground">
          When a channel&apos;s escalation has VictorOps enabled and a user clicks
          &ldquo;Get help&rdquo;, the bot asks this agent who is on call. Falls back to the
          <code className="mx-1">SLACK_INTEGRATION_VICTOROPS_AGENT_ID</code> env var when unset.
        </p>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="slack-victorops-agent">Escalation agent</Label>
          <div className="flex flex-wrap items-center gap-2">
            <AgentPicker
              id="slack-victorops-agent"
              ariaLabel="VictorOps escalation agent"
              value={selected}
              onChange={setSelected}
              disabled={disabled || saving}
              placeholder="Default CAIPE Supervisor"
              options={agents.map<AgentPickerOption>((a) => ({ value: a._id, label: a.name || a._id }))}
            />
            <SaveButton
              onSave={handleSave}
              saving={saving}
              dirty={dirty}
              disabled={disabled}
              ariaLabel="Save VictorOps escalation agent"
            />
          </div>
          {source === "env" && !dirty && (
            <p className="text-xs text-muted-foreground">
              Currently using the <code>SLACK_INTEGRATION_VICTOROPS_AGENT_ID</code> env var. Saving here overrides it at runtime.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
