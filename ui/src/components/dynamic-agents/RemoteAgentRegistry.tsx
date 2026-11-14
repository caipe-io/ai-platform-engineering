"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import type { AvailableSubagent, RemoteAgentCredentialSource, RemoteAgentRegistryEntry } from "@/types/dynamic-agent";
import { Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import React from "react";
import { RemoteAgentDiscovery, type DiscoveredAgent } from "./RemoteAgentDiscovery";
import { RemoteAgentSelection } from "./RemoteAgentSelection";
import { ConfiguredAcpAgentCard, isConfiguredAcpAgent } from "./ConfiguredAcpAgentCard";
import { defaultRemoteAgentAuth, isRemoteAgentAuthConfigured, RemoteAgentAuthFields } from "./RemoteAgentAuthFields";

export interface RemoteAgentsPickerProps {
  value: string[];
  onChange: (value: string[]) => void;
  timeoutValues: Record<string, number>;
  onTimeoutChange: (remoteAgentId: string, seconds: number) => void;
  disabled?: boolean;
}

export function RemoteAgentRegistry({ selection }: { selection?: RemoteAgentsPickerProps }) {
  const { value = [], onChange = () => {}, timeoutValues = {}, onTimeoutChange = () => {}, disabled } = selection ?? {};
  const { toast } = useToast();
  const includeAcp = !selection;
  const [acpAgents, setAcpAgents] = React.useState<AvailableSubagent[]>([]);
  const [acpLoading, setAcpLoading] = React.useState(includeAcp);
  const [acpError, setAcpError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [items, setItems] = React.useState<RemoteAgentRegistryEntry[]>([]);
  const [canManage, setCanManage] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const mutationPending = React.useRef(false);
  const [name, setName] = React.useState("");
  const [endpoint, setEndpoint] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [timeoutSeconds, setTimeoutSeconds] = React.useState(120);
  const [streaming, setStreaming] = React.useState(false);
  const [credentialSource, setCredentialSource] = React.useState<RemoteAgentCredentialSource>(() => selection ? defaultRemoteAgentAuth() : { kind: "none", target: "header", name: "Authorization" });
  const [probing, setProbing] = React.useState(false);
  const [cardPreview, setCardPreview] = React.useState<Record<string, unknown> | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [probedCard, setProbedCard] = React.useState<{ protocol_version?: string; protocol_bindings?: string[]; supports_streaming?: boolean } | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editValues, setEditValues] = React.useState({ name: "", endpoint: "", description: "", timeout_seconds: 120, streaming: false, credential_source: defaultRemoteAgentAuth() });

  const loadItems = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/remote-agents", { credentials: "include" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Failed to load remote agents");
      setItems(data.data.items || []);
      setCanManage(data.data.can_manage_registry === true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the registry");
      toast(`Could not load remote A2A agents: ${error instanceof Error ? error.message : "Request failed"}`, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadAcpAgents = React.useCallback(async () => {
    if (!includeAcp) return;
    setAcpLoading(true);
    setAcpError(null);
    try {
      const response = await fetch("/api/dynamic-agents/available-subagents?create=true", { credentials: "include", cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !body.success || !Array.isArray(body.data?.agents)) throw new Error("Could not load configured ACP agents");
      setAcpAgents(body.data.agents.filter(isConfiguredAcpAgent));
    } catch {
      setAcpError("Could not load configured ACP agents. Saved agents and their permissions have not changed.");
    } finally {
      setAcpLoading(false);
    }
  }, [includeAcp]);

  React.useEffect(() => { void loadItems(); void loadAcpAgents(); }, [loadItems, loadAcpAgents]);

  const toggle = (id: string) => {
    if (disabled) return;
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  };

  const probeEndpoint = async (edit = false, registered?: RemoteAgentRegistryEntry) => {
    if (disabled || probing || mutationPending.current) return;
    setProbing(true);
    try {
      const response = await fetch("/api/remote-agents/probe", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: registered?.endpoint || (edit ? editValues.endpoint : endpoint),
          credential_source: registered ? registered.credential_source || defaultRemoteAgentAuth() : edit ? editValues.credential_source : credentialSource,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Agent Card probe failed");
      setCardPreview(data.data.agent_card || data.data);
      if (edit || registered) {
        toast("A2A Agent Card resolved with the selected authentication.", "success");
      } else {
        setName(data.data.name || "");
        setDescription(data.data.description || "");
        setProbedCard({ protocol_version: data.data.protocol_version, protocol_bindings: data.data.protocol_bindings, supports_streaming: data.data.supports_streaming });
        toast("A2A Agent Card found. Review the metadata, then add the agent to the registry.", "success");
      }
    } catch (error) {
      toast(`Could not probe A2A agent: ${error instanceof Error ? error.message : "Request failed"}`, "error");
    } finally {
      setProbing(false);
    }
  };

  const addRemoteAgent = async () => {
    if (disabled || probing || mutationPending.current) return;
    if (!name.trim() || !endpoint.trim() || !isRemoteAgentAuthConfigured(credentialSource)) return;
    mutationPending.current = true;
    setSaving(true);
    try {
      const response = await fetch("/api/remote-agents", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, endpoint, description, timeout_seconds: timeoutSeconds, streaming, credential_source: credentialSource, ...probedCard }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Failed to add remote agent");
      setItems((current) => [...current, data.data].sort((a, b) => a.name.localeCompare(b.name)));
      onChange([...new Set([...value, data.data._id])]);
      setName(""); setEndpoint(""); setDescription(""); setTimeoutSeconds(120); setStreaming(false); setProbedCard(null);
      setCredentialSource(selection ? defaultRemoteAgentAuth() : { kind: "none", target: "header", name: "Authorization" });
      toast("Remote A2A agent added", "success");
    } catch (error) {
      toast(`Could not add remote A2A agent: ${error instanceof Error ? error.message : "Request failed"}`, "error");
    } finally {
      mutationPending.current = false;
      setSaving(false);
    }
  };

  const removeRemoteAgent = async (item: RemoteAgentRegistryEntry) => {
    if (disabled || probing || mutationPending.current) return;
    if (!window.confirm(`Disable ${item.name} for future agent configurations?`)) return;
    mutationPending.current = true;
    setSaving(true);
    try {
      const response = await fetch(`/api/remote-agents/${encodeURIComponent(item._id)}`, { method: "DELETE", credentials: "include" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Failed to remove remote agent");
      setItems((current) => current.filter((entry) => entry._id !== item._id));
      onChange(value.filter((id) => id !== item._id));
    } catch (error) {
      toast(`Could not remove remote A2A agent: ${error instanceof Error ? error.message : "Request failed"}`, "error");
    } finally {
      mutationPending.current = false;
      setSaving(false);
    }
  };

  const saveRemoteAgent = async () => {
    if (disabled || probing || mutationPending.current) return;
    if (!editingId) return;
    if (!editValues.name.trim() || !editValues.endpoint.trim() || !isRemoteAgentAuthConfigured(editValues.credential_source)) return;
    mutationPending.current = true;
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
      mutationPending.current = false;
      setSaving(false);
    }
  };

  if (selection) return <RemoteAgentSelection selection={selection} items={items} loading={loading} error={loadError} onRefresh={() => void loadItems()} />;

  const catalog = [
    ...(!loading && !loadError ? items.map(item => ({ source: "a2a" as const, key: `a2a:${item._id}`, item })) : []),
    ...(!acpLoading && !acpError ? acpAgents.map(item => ({ source: "acp" as const, key: `acp:${item.id}`, item })) : []),
  ].filter(entry => [entry.item.name, entry.item.description, entry.source].join(" ").toLowerCase().includes(search.toLowerCase().trim()))
    .sort((left, right) => left.item.name.localeCompare(right.item.name));

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">Choose registered A2A agents or configured ACP agents in Agent Builder under Subagents. Each agent keeps its saved configuration and access checks.</p>
      <div className="flex gap-2">
        <Input aria-label="Search remote agents" placeholder="Search by name, A2A, or ACP…" value={search} onChange={event => setSearch(event.target.value)} />
        <Button type="button" variant="outline" size="sm" disabled={loading || acpLoading} onClick={() => { void loadItems(); void loadAcpAgents(); }}>Refresh agents</Button>
      </div>
      {acpError && <div role="alert" className="text-sm text-destructive">{acpError} <Button type="button" variant="outline" size="sm" onClick={() => void loadAcpAgents()}>Retry ACP agents</Button></div>}
      {acpLoading && <p role="status" className="text-sm text-muted-foreground">Loading configured ACP agents…</p>}
      {!selection && canManage && <RemoteAgentDiscovery disabled={saving || probing} onChoose={(agent: DiscoveredAgent) => {
        setEndpoint(agent.endpoint); setName(agent.error ? "" : agent.name || "");
        setDescription(agent.description || ""); setStreaming(agent.supports_streaming === true);
        setCredentialSource({ kind: "none", target: "header", name: "Authorization" });
        setProbedCard(agent.error ? null : { protocol_version: agent.protocol_version, protocol_bindings: agent.protocol_bindings, supports_streaming: agent.supports_streaming }); setCardPreview(null);
      }} />}
      {loadError && <div role="alert" className="text-sm text-destructive">{loadError} <Button type="button" variant="outline" size="sm" onClick={() => void loadItems()}>Retry</Button></div>}
      {cardPreview && <details className="rounded-lg border p-3" open><summary className="cursor-pointer text-sm font-medium">Agent Card</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(cardPreview, null, 2)}</pre></details>}
      {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading registered A2A agents…</div>}
      {!catalog.length && !loading && !acpLoading && !loadError && !acpError && <p className="text-sm text-muted-foreground">{search ? "No matching remote agents." : "No A2A or configured ACP agents are available."}</p>}
      <div className="space-y-3" aria-label="Remote agent catalog">
          {catalog.map(entry => {
            if (entry.source === "acp") return <ConfiguredAcpAgentCard key={entry.key} agent={entry.item} />;
            const item = entry.item;
            return <div key={entry.key} className="rounded-lg border p-3">
              <div className="flex items-start gap-3">
                {selection && <input aria-label={`Allow ${item.name}`} type="checkbox" className="mt-1 h-4 w-4 accent-primary" checked={value.includes(item._id)} disabled={disabled} onChange={() => toggle(item._id)} />}
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{item.name}<span className="ml-2 text-xs text-muted-foreground">A2A</span></div>
                  {item.streaming && <span className="text-xs text-muted-foreground">Streaming enabled</span>}
                  {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
                  {canManage && item.endpoint && <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{item.endpoint}</p>}
                  <div className="mt-3 flex items-end gap-2">
                    {selection ? <div className="w-36"><Label htmlFor={`timeout-${item._id}`} className="text-xs">Timeout (seconds)</Label><Input id={`timeout-${item._id}`} type="number" min={1} max={600} value={timeoutValues[item._id] ?? item.timeout_seconds ?? 120} disabled={disabled || !value.includes(item._id)} onChange={(event) => { const seconds = Number(event.target.value); if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 600) onTimeoutChange(item._id, seconds); }} /></div> : <span className="text-xs text-muted-foreground">Default timeout: {item.timeout_seconds}s · {item.protocol_bindings?.join(", ") || "A2A"}</span>}
                    {canManage && <>
                      <Button type="button" variant="outline" size="sm" disabled={disabled || saving || probing} onClick={() => void probeEndpoint(false, item)}>Read Agent Card</Button>
                      <Button type="button" variant="ghost" size="sm" disabled={disabled || saving} onClick={() => { setEditingId(item._id); setEditValues({ name: item.name, endpoint: item.endpoint || "", description: item.description || "", timeout_seconds: item.timeout_seconds || 120, streaming: item.streaming === true, credential_source: item.credential_source || defaultRemoteAgentAuth() }); }} aria-label={`Edit ${item.name}`}><Pencil className="h-4 w-4" /></Button>
                      <Button type="button" variant="ghost" size="sm" disabled={disabled || saving} onClick={() => void removeRemoteAgent(item)} aria-label={`Remove ${item.name}`}><Trash2 className="h-4 w-4" /></Button>
                    </>}
                  </div>
                </div>
              </div>
              {canManage && editingId === item._id && (
                <div
                  className="mt-4 space-y-3 border-t pt-3"
                  onKeyDown={(event) => {
                    if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
                    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
                    event.preventDefault();
                    void saveRemoteAgent();
                  }}
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-name-${item._id}`}>Name</Label><Input disabled={disabled || saving || probing} id={`edit-remote-agent-name-${item._id}`} required value={editValues.name} onChange={(event) => setEditValues((current) => ({ ...current, name: event.target.value }))} /></div>
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-endpoint-${item._id}`}>Agent URL</Label><Input disabled={disabled || saving || probing} id={`edit-remote-agent-endpoint-${item._id}`} type="url" required value={editValues.endpoint} onChange={(event) => setEditValues((current) => ({ ...current, endpoint: event.target.value }))} /></div>
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-description-${item._id}`}>Description</Label><Input disabled={disabled || saving || probing} id={`edit-remote-agent-description-${item._id}`} value={editValues.description} onChange={(event) => setEditValues((current) => ({ ...current, description: event.target.value }))} /></div>
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-timeout-${item._id}`}>Default timeout (seconds)</Label><Input disabled={disabled || saving || probing} id={`edit-remote-agent-timeout-${item._id}`} type="number" min={1} max={600} value={editValues.timeout_seconds} onChange={(event) => setEditValues((current) => ({ ...current, timeout_seconds: Number(event.target.value) }))} /></div>
                  </div>
                  <label className="flex items-center gap-2 text-sm"><input id={`edit-remote-agent-streaming-${item._id}`} type="checkbox" className="h-4 w-4 accent-primary" checked={editValues.streaming} disabled={disabled || saving} onChange={(event) => setEditValues((current) => ({ ...current, streaming: event.target.checked }))} />Stream responses</label>
                  <p className="text-xs text-muted-foreground">Show remote output as it arrives. Agents without streaming support return a complete response.</p>
                  <RemoteAgentAuthFields
                    value={editValues.credential_source}
                    onChange={(source) => setEditValues((current) => ({ ...current, credential_source: source }))}
                    idPrefix={`edit-${item._id}`}
                    disabled={disabled || saving || probing}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={disabled || saving || probing || !editValues.endpoint.trim() || !isRemoteAgentAuthConfigured(editValues.credential_source)} onClick={() => void probeEndpoint(true)}>{probing ? "Checking…" : "Test connection"}</Button>
                    <Button type="button" size="sm" disabled={disabled || saving || probing || !editValues.name.trim() || !editValues.endpoint.trim() || !isRemoteAgentAuthConfigured(editValues.credential_source)} onClick={() => void saveRemoteAgent()}><Check className="mr-2 h-4 w-4" />Save</Button>
                    <Button type="button" size="sm" variant="outline" disabled={saving || probing} onClick={() => setEditingId(null)}><X className="mr-2 h-4 w-4" />Cancel</Button>
                  </div>
                </div>
              )}
            </div>;
          })}
        </div>
      {canManage && !disabled && (
        <div
          className="space-y-3 rounded-lg border border-dashed p-4"
          onKeyDown={(event) => {
            if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
            if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
            event.preventDefault();
            void addRemoteAgent();
          }}
        >
          <div className="font-medium">Add a remote A2A agent</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="remote-agent-name">Name</Label><Input disabled={saving || probing} id="remote-agent-name" required value={name} onChange={(event) => setName(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="remote-agent-endpoint">Agent URL</Label><Input disabled={saving || probing} id="remote-agent-endpoint" type="url" required placeholder="https://agent.example.com" value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setProbedCard(null); setCardPreview(null); }} /></div>
            <div className="space-y-1"><Label htmlFor="remote-agent-description">Description</Label><Input disabled={saving || probing} id="remote-agent-description" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="remote-agent-timeout">Timeout (seconds, 1–600)</Label><Input disabled={saving || probing} id="remote-agent-timeout" type="number" min={1} max={600} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /></div>
          </div>
          <label className="flex items-center gap-2 text-sm"><input id="remote-agent-streaming" type="checkbox" className="h-4 w-4 accent-primary" checked={streaming} disabled={saving} onChange={(event) => setStreaming(event.target.checked)} />Stream responses</label>
          <p className="text-xs text-muted-foreground">Show remote output as it arrives. Agents without streaming support return a complete response.</p>
          <RemoteAgentAuthFields
            value={credentialSource}
            onChange={(source) => { setCredentialSource(source); setProbedCard(null); setCardPreview(null); }}
            idPrefix="new-remote-agent"
            disabled={saving || probing}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={saving || probing || !endpoint.trim() || !isRemoteAgentAuthConfigured(credentialSource)} onClick={() => void probeEndpoint()}>{probing ? "Probing…" : "Discover Agent Card"}</Button>
            <Button type="button" size="sm" disabled={saving || probing || !name.trim() || !endpoint.trim() || !isRemoteAgentAuthConfigured(credentialSource)} onClick={() => void addRemoteAgent()}><Plus className="mr-2 h-4 w-4" />{saving ? "Adding…" : selection ? "Add and select" : "Register agent"}</Button>
            {probedCard?.protocol_bindings?.length ? <span className="text-xs text-muted-foreground">A2A {probedCard.protocol_version || ""} · {probedCard.protocol_bindings.join(", ")} · {probedCard.supports_streaming ? "Streaming available" : "Complete responses only"}</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}
