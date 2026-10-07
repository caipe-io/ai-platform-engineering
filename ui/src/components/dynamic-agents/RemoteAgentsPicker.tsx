"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import type { RemoteAgentRegistryEntry } from "@/types/dynamic-agent";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import React from "react";

interface RemoteAgentsPickerProps {
  value: string[];
  onChange: (value: string[]) => void;
  timeoutValues: Record<string, number>;
  onTimeoutChange: (remoteAgentId: string, seconds: number) => void;
  disabled?: boolean;
}

export function RemoteAgentsPicker({ value, onChange, timeoutValues, onTimeoutChange, disabled }: RemoteAgentsPickerProps) {
  const { toast } = useToast();
  const [items, setItems] = React.useState<RemoteAgentRegistryEntry[]>([]);
  const [canManage, setCanManage] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [name, setName] = React.useState("");
  const [endpoint, setEndpoint] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [timeoutSeconds, setTimeoutSeconds] = React.useState(120);
  const [probing, setProbing] = React.useState(false);
  const [probedCard, setProbedCard] = React.useState<{ protocol_version?: string; protocol_bindings?: string[] } | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editValues, setEditValues] = React.useState({ name: "", endpoint: "", description: "", timeout_seconds: 120 });

  const loadItems = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/remote-agents", { credentials: "include" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Failed to load remote agents");
      setItems(data.data.items || []);
      setCanManage(data.data.can_manage_registry === true);
    } catch (error) {
      toast(`Could not load remote A2A agents: ${error instanceof Error ? error.message : "Request failed"}`, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  React.useEffect(() => { void loadItems(); }, [loadItems]);

  const toggle = (id: string) => {
    if (disabled) return;
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  };

  const probeEndpoint = async () => {
    setProbing(true);
    try {
      const response = await fetch("/api/remote-agents/probe", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Agent Card probe failed");
      setName(data.data.name || "");
      setDescription(data.data.description || "");
      setProbedCard({ protocol_version: data.data.protocol_version, protocol_bindings: data.data.protocol_bindings });
      toast("A2A Agent Card found. Review the metadata, then add the agent to the registry.", "success");
    } catch (error) {
      toast(`Could not probe A2A agent: ${error instanceof Error ? error.message : "Request failed"}`, "error");
    } finally {
      setProbing(false);
    }
  };

  const addRemoteAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/remote-agents", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, endpoint, description, timeout_seconds: timeoutSeconds, ...probedCard }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Failed to add remote agent");
      setItems((current) => [...current, data.data].sort((a, b) => a.name.localeCompare(b.name)));
      onChange([...new Set([...value, data.data._id])]);
      setName(""); setEndpoint(""); setDescription(""); setTimeoutSeconds(120); setProbedCard(null);
      toast("Remote A2A agent added", "success");
    } catch (error) {
      toast(`Could not add remote A2A agent: ${error instanceof Error ? error.message : "Request failed"}`, "error");
    } finally {
      setSaving(false);
    }
  };

  const removeRemoteAgent = async (item: RemoteAgentRegistryEntry) => {
    if (!window.confirm(`Disable ${item.name} for future agent configurations?`)) return;
    try {
      const response = await fetch(`/api/remote-agents/${encodeURIComponent(item._id)}`, { method: "DELETE", credentials: "include" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Failed to remove remote agent");
      setItems((current) => current.filter((entry) => entry._id !== item._id));
      onChange(value.filter((id) => id !== item._id));
    } catch (error) {
      toast(`Could not remove remote A2A agent: ${error instanceof Error ? error.message : "Request failed"}`, "error");
    }
  };

  const saveRemoteAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editingId) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/remote-agents/${encodeURIComponent(editingId)}`, {
        method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editValues),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Failed to update remote agent");
      setItems((current) => current.map((item) => item._id === editingId ? data.data : item).sort((a, b) => a.name.localeCompare(b.name)));
      setEditingId(null);
      toast("Remote A2A agent updated", "success");
    } catch (error) {
      toast(`Could not update remote A2A agent: ${error instanceof Error ? error.message : "Request failed"}`, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <Label>Remote A2A Agents</Label>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose registered agents this agent can call. The caller&apos;s Dynamic Agents bearer token is forwarded on each request.
        </p>
      </div>
      {loading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading remote agents…</div> : items.length === 0 ? <p className="text-sm text-muted-foreground">No remote A2A agents are registered.</p> : (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item._id} className="rounded-lg border p-3">
              <div className="flex items-start gap-3">
                <input aria-label={`Allow ${item.name}`} type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={value.includes(item._id)} disabled={disabled} onChange={() => toggle(item._id)} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{item.name}</div>
                  {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
                  {canManage && item.endpoint && <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{item.endpoint}</p>}
                  <div className="mt-3 flex items-end gap-2">
                    <div className="w-36"><Label htmlFor={`timeout-${item._id}`} className="text-xs">Timeout (seconds)</Label><Input id={`timeout-${item._id}`} type="number" min={1} max={600} value={timeoutValues[item._id] ?? item.timeout_seconds ?? 120} disabled={disabled || !value.includes(item._id)} onChange={(event) => onTimeoutChange(item._id, Number(event.target.value))} /></div>
                    {canManage && <>
                      <Button type="button" variant="ghost" size="sm" onClick={() => { setEditingId(item._id); setEditValues({ name: item.name, endpoint: item.endpoint || "", description: item.description || "", timeout_seconds: item.timeout_seconds || 120 }); }} aria-label={`Edit ${item.name}`}><Pencil className="h-4 w-4" /></Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => void removeRemoteAgent(item)} aria-label={`Remove ${item.name}`}><Trash2 className="h-4 w-4" /></Button>
                    </>}
                  </div>
                </div>
              </div>
              {canManage && editingId === item._id && (
                <form onSubmit={saveRemoteAgent} className="mt-4 space-y-3 border-t pt-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-name-${item._id}`}>Name</Label><Input id={`edit-remote-agent-name-${item._id}`} required value={editValues.name} onChange={(event) => setEditValues((current) => ({ ...current, name: event.target.value }))} /></div>
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-endpoint-${item._id}`}>Agent URL</Label><Input id={`edit-remote-agent-endpoint-${item._id}`} type="url" required value={editValues.endpoint} onChange={(event) => setEditValues((current) => ({ ...current, endpoint: event.target.value }))} /></div>
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-description-${item._id}`}>Description</Label><Input id={`edit-remote-agent-description-${item._id}`} value={editValues.description} onChange={(event) => setEditValues((current) => ({ ...current, description: event.target.value }))} /></div>
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-timeout-${item._id}`}>Default timeout (seconds)</Label><Input id={`edit-remote-agent-timeout-${item._id}`} type="number" min={1} max={600} value={editValues.timeout_seconds} onChange={(event) => setEditValues((current) => ({ ...current, timeout_seconds: Number(event.target.value) }))} /></div>
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={saving}><Check className="mr-2 h-4 w-4" />Save</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setEditingId(null)}><X className="mr-2 h-4 w-4" />Cancel</Button>
                  </div>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
      {canManage && !disabled && (
        <form onSubmit={addRemoteAgent} className="space-y-3 rounded-lg border border-dashed p-4">
          <div className="font-medium">Add a remote A2A agent</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="remote-agent-name">Name</Label><Input id="remote-agent-name" required value={name} onChange={(event) => setName(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="remote-agent-endpoint">Agent URL</Label><Input id="remote-agent-endpoint" type="url" required placeholder="https://agent.example.com" value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setProbedCard(null); }} /></div>
            <div className="space-y-1"><Label htmlFor="remote-agent-description">Description</Label><Input id="remote-agent-description" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="remote-agent-timeout">Timeout (seconds, 1–600)</Label><Input id="remote-agent-timeout" type="number" min={1} max={600} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /></div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={probing || !endpoint.trim()} onClick={() => void probeEndpoint()}>{probing ? "Probing…" : "Discover Agent Card"}</Button>
            <Button type="submit" size="sm" disabled={saving || !name.trim() || !endpoint.trim()}><Plus className="mr-2 h-4 w-4" />{saving ? "Adding…" : "Add and select"}</Button>
            {probedCard?.protocol_bindings?.length ? <span className="text-xs text-muted-foreground">A2A {probedCard.protocol_version || ""} · {probedCard.protocol_bindings.join(", ")}</span> : null}
          </div>
        </form>
      )}
    </div>
  );
}
