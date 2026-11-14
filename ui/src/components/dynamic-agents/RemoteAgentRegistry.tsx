"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { AgentTechnologyIcon, AgentProtocolBadge, AgentFrameworkField } from "./AgentTechnology";
import { getAgentFramework, type AgentFramework } from "@/lib/agent-framework";
import { AgentCardDetails, agentCardSkills } from "./AgentCardDetails";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import type { AvailableSubagent, RemoteAgentCredentialSource, RemoteAgentRegistryEntry } from "@/types/dynamic-agent";
import { Check, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
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
  const { value = [], onChange = () => {}, disabled } = selection ?? {};
  const { toast } = useToast();
  const includeAcp = !selection;
  const [acpAgents, setAcpAgents] = React.useState<AvailableSubagent[]>([]);
  const [acpLoading, setAcpLoading] = React.useState(includeAcp);
  const [acpError, setAcpError] = React.useState<string | null>(null);
  const cardTrigger = React.useRef<HTMLButtonElement>(null);
  const addTrigger = React.useRef<HTMLButtonElement>(null);
  const discoverTrigger = React.useRef<HTMLButtonElement>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [discoverOpen, setDiscoverOpen] = React.useState(false);
  const [detailsId, setDetailsId] = React.useState<string | null>(null);
  const [protocol, setProtocol] = React.useState("all");
  const [checks, setChecks] = React.useState<Record<string, { card?: Record<string, unknown>; error?: string; elapsed?: number }>>({});
  const [search, setSearch] = React.useState("");
  const [items, setItems] = React.useState<RemoteAgentRegistryEntry[]>([]);
  const [canManage, setCanManage] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const mutationPending = React.useRef(false);
  const [framework, setFramework] = React.useState<AgentFramework>("unspecified");
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
  const [editValues, setEditValues] = React.useState({ framework: "unspecified" as AgentFramework, name: "", endpoint: "", description: "", timeout_seconds: 120, streaming: false, credential_source: defaultRemoteAgentAuth() });

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

  const probeEndpoint = async (edit = false, registered?: RemoteAgentRegistryEntry) => {
    if (disabled || probing || mutationPending.current) return;
    setProbing(true);
    const started = performance.now();
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
      const card = data.data.agent_card || data.data;
      if (registered) setChecks(current => ({ ...current, [registered._id]: { card, elapsed: Math.round(performance.now() - started) } }));
      else setCardPreview(card);
      if (edit || registered) {
        toast("A2A Agent Card resolved with the selected authentication.", "success");
      } else {
        setName(data.data.name || "");
        setDescription(data.data.description || "");
        setProbedCard({ protocol_version: data.data.protocol_version, protocol_bindings: data.data.protocol_bindings, supports_streaming: data.data.supports_streaming });
        toast("A2A Agent Card found. Review the metadata, then add the agent to the registry.", "success");
      }
    } catch (error) {
      if (registered) setChecks(current => ({ ...current, [registered._id]: { error: error instanceof Error ? error.message : "Connection failed" } }));
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
        body: JSON.stringify({ name, endpoint, description, framework, timeout_seconds: timeoutSeconds, streaming, credential_source: credentialSource, ...probedCard }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Failed to add remote agent");
      setItems((current) => [...current, data.data].sort((a, b) => a.name.localeCompare(b.name)));
      onChange([...new Set([...value, data.data._id])]);
      setAddOpen(false); setCardPreview(null); setFramework("unspecified");
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
      setDetailsId(null);
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
      setEditingId(null); setDetailsId(null); setChecks({});
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
  ].filter(entry => (protocol === "all" || entry.source === protocol) && [entry.item.name, entry.item.description, entry.source, entry.source === "a2a" ? getAgentFramework(entry.item.framework).label : "", ...(entry.source === "a2a" ? [...(entry.item.protocol_bindings || []), entry.item.streaming ? "streaming" : "complete responses", ...agentCardSkills(checks[entry.item._id]?.card).map(skill => `${skill.name} ${skill.description || ""}`)] : ["direct chat", "subagent delegation", "saved sessions"])].join(" ").toLowerCase().includes(search.toLowerCase().trim()))
    .sort((left, right) => left.item.name.localeCompare(right.item.name));

  const detail = items.find(item => item._id === detailsId);
  const editing = items.find(item => item._id === editingId);
  const beginEdit = (item: RemoteAgentRegistryEntry) => {
    setDetailsId(null); setCardPreview(null); setEditingId(item._id);
    setEditValues({ framework: item.framework || "unspecified", name: item.name, endpoint: item.endpoint || "", description: item.description || "", timeout_seconds: item.timeout_seconds || 120, streaming: item.streaming === true, credential_source: item.credential_source || defaultRemoteAgentAuth() });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">Explore remote specialists, inspect their capabilities, and test a connection before adding them as subagents.</p>
        {canManage && <div className="flex gap-2">
          <Button type="button" variant="outline" ref={discoverTrigger} onClick={() => setDiscoverOpen(true)}><Search className="mr-2 h-4 w-4" />Discover agents</Button>
          <Button type="button" ref={addTrigger} onClick={() => { setCardPreview(null); setAddOpen(true); }}><Plus className="mr-2 h-4 w-4" />Add agent</Button>
        </div>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input className="min-w-48 flex-1" aria-label="Search remote agents" placeholder="Search agents or capabilities…" value={search} onChange={event => setSearch(event.target.value)} />
        <Select aria-label="Filter by protocol" className="w-40" value={protocol} onChange={event => setProtocol(event.target.value)}><option value="all">All protocols</option><option value="a2a">A2A</option><option value="acp">ACP</option></Select>
        <Button type="button" variant="outline" disabled={loading || acpLoading} onClick={() => { setChecks({}); void loadItems(); void loadAcpAgents(); }}>Refresh agents</Button>
      </div>
      {loadError && <div role="alert" className="text-sm text-destructive">{loadError} <Button type="button" variant="outline" size="sm" onClick={() => void loadItems()}>Retry</Button></div>}
      {acpError && <div role="alert" className="text-sm text-destructive">{acpError} <Button type="button" variant="outline" size="sm" onClick={() => void loadAcpAgents()}>Retry ACP agents</Button></div>}
      {(loading || acpLoading) && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading remote agents…</p>}
      {!catalog.length && !loading && !acpLoading && !loadError && !acpError && <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">{search || protocol !== "all" ? "No matching remote agents." : "No A2A or configured ACP agents are available."}</div>}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Remote agent catalog">
        {catalog.map(entry => {
          if (entry.source === "acp") return <ConfiguredAcpAgentCard key={entry.key} agent={entry.item} />;
          const item = entry.item;
          const check = checks[item._id];
          return <article key={entry.key} aria-label={`${item.name} A2A agent`} className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5 transition-colors hover:border-primary/40">
            <div className="flex items-start gap-3"><AgentTechnologyIcon protocol="a2a" framework={item.framework} /><div className="min-w-0 flex-1"><h2 className="break-words font-semibold">{item.name}</h2><div className="mt-2 flex flex-wrap items-center gap-2"><AgentProtocolBadge protocol="a2a" /><span className="text-xs text-muted-foreground">{item.framework && item.framework !== "unspecified" ? getAgentFramework(item.framework).label : "Remote service"}</span></div></div></div>
            <p className="line-clamp-3 text-sm text-muted-foreground">{item.description || "No description provided."}</p>
            <div className="flex flex-wrap gap-1.5"><Badge variant="secondary">{item.streaming ? "Streaming enabled" : "Complete responses"}</Badge><Badge variant="outline">{item.timeout_seconds}s timeout</Badge>{agentCardSkills(check?.card).slice(0, 3).map((skill, index) => <Badge key={`skill-${index}`} variant="secondary">{skill.name}</Badge>)}{item.protocol_bindings?.map(binding => <Badge key={binding} variant="outline">{binding}</Badge>)}</div>
            {check?.card && <p className="text-xs text-emerald-600 dark:text-emerald-400">Connection verified · {check.elapsed} ms</p>}
            {check?.error && <p className="text-xs text-destructive">Connection failed</p>}
            {!check && <p className="text-xs text-muted-foreground">Connection not tested</p>}
            <div className="mt-auto flex flex-wrap gap-1.5 pt-2"><Button type="button" variant="outline" size="sm" aria-label={`Details for ${item.name}`} onClick={event => { cardTrigger.current = event.currentTarget; setDetailsId(item._id); }}>View details</Button>
              {canManage && <Button type="button" size="sm" disabled={saving || probing} onClick={event => { cardTrigger.current = event.currentTarget; setDetailsId(item._id); void probeEndpoint(false, item); }}>Test connection</Button>}
              {canManage && <Button type="button" variant="ghost" size="sm" disabled={saving || probing} className="px-1" aria-label={`Edit ${item.name}`} onClick={event => { cardTrigger.current = event.currentTarget; beginEdit(item); }}><Pencil className="h-4 w-4" /></Button>}
            </div>
          </article>;
        })}
      </div>
      <p className="text-xs text-muted-foreground">{catalog.length} agent{catalog.length === 1 ? "" : "s"} shown · Add these specialists in Agent Builder → Advanced → Subagents.</p>
      <Dialog open={!!detail} onOpenChange={open => { if (!open && !probing && !saving) setDetailsId(null); }}>
        <DialogContent onCloseAutoFocus={event => { event.preventDefault(); if (!editingId) cardTrigger.current?.focus(); }} className="max-h-[85dvh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle className="flex items-center gap-3"><AgentTechnologyIcon decorative protocol="a2a" framework={detail?.framework} />{detail?.name}</DialogTitle><DialogDescription>{detail?.description || "Remote A2A agent details and connection test."}</DialogDescription></DialogHeader>
          {detail && <>
            <div className="flex flex-wrap gap-2"><AgentProtocolBadge protocol="a2a" version={detail.protocol_version} />{detail.framework && detail.framework !== "unspecified" && <Badge variant="secondary">{getAgentFramework(detail.framework).label}</Badge>}<Badge variant="secondary">{detail.streaming ? "Streaming enabled" : "Complete responses"}</Badge><Badge variant="outline">{detail.timeout_seconds}s timeout</Badge></div>
            {canManage && <dl className="space-y-2 text-sm"><dt className="font-medium">Agent URL</dt><dd className="break-all font-mono text-xs text-muted-foreground">{detail.endpoint}</dd><dt className="font-medium">Authentication</dt><dd className="text-muted-foreground">{detail.credential_source?.kind === "caller_token" ? "Your user identity" : detail.credential_source?.kind === "secret_ref" ? "Saved secret" : detail.credential_source?.kind === "provider_connection" ? "Connected credential" : "Public agent"}</dd></dl>}
            <section className="space-y-3 rounded-lg border p-4"><h3 className="font-medium">Connection test</h3><p className="text-sm text-muted-foreground">Reads the Agent Card with the saved authentication. This checks connectivity and advertised capabilities; it does not run a task.</p>
              {canManage ? <Button type="button" disabled={probing || saving} onClick={() => void probeEndpoint(false, detail)}>{probing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{probing ? "Testing…" : "Read Agent Card"}</Button> : <p className="text-sm text-muted-foreground">A registry manager can test this connection.</p>}
              <div aria-live="polite">{checks[detail._id]?.error && <p role="alert" className="text-sm text-destructive">{checks[detail._id].error}</p>}{checks[detail._id]?.card && <><p role="status" className="mb-3 text-sm text-emerald-600 dark:text-emerald-400">Connection verified · {checks[detail._id].elapsed} ms</p><AgentCardDetails card={checks[detail._id].card!} /></>}</div>
            </section>
            {canManage && <div className="flex justify-between gap-2"><Button type="button" variant="outline" disabled={saving || probing} onClick={() => beginEdit(detail)}>Edit configuration</Button><Button type="button" variant="ghost" className="text-destructive" disabled={saving || probing} onClick={() => void removeRemoteAgent(detail)}><Trash2 className="mr-2 h-4 w-4" />Remove agent</Button></div>}
          </>}
        </DialogContent>
      </Dialog>
      <Dialog open={!!editing} onOpenChange={open => { if (!open && !saving && !probing) setEditingId(null); }}>
        <DialogContent onCloseAutoFocus={event => { event.preventDefault(); cardTrigger.current?.focus(); }} className="max-h-[85dvh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Edit {editing?.name}</DialogTitle><DialogDescription>Update the saved connection and authentication.</DialogDescription></DialogHeader>
          {editing && <div
                  className="space-y-3"
                  onKeyDown={(event) => {
                    if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
                    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
                    event.preventDefault();
                    void saveRemoteAgent();
                  }}
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-name-${editing._id}`}>Name</Label><Input disabled={disabled || saving || probing} id={`edit-remote-agent-name-${editing._id}`} required value={editValues.name} onChange={(event) => setEditValues((current) => ({ ...current, name: event.target.value }))} /></div>
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-endpoint-${editing._id}`}>Agent URL</Label><Input disabled={disabled || saving || probing} id={`edit-remote-agent-endpoint-${editing._id}`} type="url" required value={editValues.endpoint} onChange={(event) => setEditValues((current) => ({ ...current, endpoint: event.target.value }))} /></div>
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-description-${editing._id}`}>Description</Label><Input disabled={disabled || saving || probing} id={`edit-remote-agent-description-${editing._id}`} value={editValues.description} onChange={(event) => setEditValues((current) => ({ ...current, description: event.target.value }))} /></div>
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-timeout-${editing._id}`}>Default timeout (seconds)</Label><Input disabled={disabled || saving || probing} id={`edit-remote-agent-timeout-${editing._id}`} type="number" min={1} max={600} value={editValues.timeout_seconds} onChange={(event) => setEditValues((current) => ({ ...current, timeout_seconds: Number(event.target.value) }))} /></div>
                  </div>
                  <AgentFrameworkField id="edit-remote-agent-framework" value={editValues.framework} disabled={saving || probing} onChange={framework => setEditValues(current => ({ ...current, framework }))} />
                  <label className="flex items-center gap-2 text-sm"><input id={`edit-remote-agent-streaming-${editing._id}`} type="checkbox" className="h-4 w-4 accent-primary" checked={editValues.streaming} disabled={disabled || saving} onChange={(event) => setEditValues((current) => ({ ...current, streaming: event.target.checked }))} />Stream responses</label>
                  <p className="text-xs text-muted-foreground">Show remote output as it arrives. Agents without streaming support return a complete response.</p>
                  <RemoteAgentAuthFields
                    value={editValues.credential_source}
                    onChange={(source) => setEditValues((current) => ({ ...current, credential_source: source }))}
                    idPrefix={`edit-${editing._id}`}
                    disabled={disabled || saving || probing}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={disabled || saving || probing || !editValues.endpoint.trim() || !isRemoteAgentAuthConfigured(editValues.credential_source)} onClick={() => void probeEndpoint(true)}>{probing ? "Checking…" : "Test connection"}</Button>
                    <Button type="button" size="sm" disabled={disabled || saving || probing || !editValues.name.trim() || !editValues.endpoint.trim() || !isRemoteAgentAuthConfigured(editValues.credential_source)} onClick={() => void saveRemoteAgent()}><Check className="mr-2 h-4 w-4" />Save</Button>
                    <Button type="button" size="sm" variant="outline" disabled={saving || probing} onClick={() => setEditingId(null)}><X className="mr-2 h-4 w-4" />Cancel</Button>
                  </div>
                </div>}
          {cardPreview && <AgentCardDetails card={cardPreview} />}
        </DialogContent>
      </Dialog>
      <Dialog open={discoverOpen} onOpenChange={setDiscoverOpen}><DialogContent onCloseAutoFocus={event => { event.preventDefault(); if (!addOpen) discoverTrigger.current?.focus(); }} className="max-h-[85dvh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Discover remote agents</DialogTitle><DialogDescription>Find public Agent Cards or configured Kubernetes Services.</DialogDescription></DialogHeader>
        {canManage && <RemoteAgentDiscovery disabled={saving || probing} onChoose={(agent: DiscoveredAgent) => {
          setFramework("unspecified"); setEndpoint(agent.endpoint); setName(agent.error ? "" : agent.name || ""); setDescription(agent.description || ""); setStreaming(agent.supports_streaming === true);
          setCredentialSource({ kind: "none", target: "header", name: "Authorization" });
          setProbedCard(agent.error ? null : { protocol_version: agent.protocol_version, protocol_bindings: agent.protocol_bindings, supports_streaming: agent.supports_streaming }); setCardPreview(null); setDiscoverOpen(false); setAddOpen(true);
        }} />}
      </DialogContent></Dialog>
      <Dialog open={addOpen} onOpenChange={open => { if (!open && !saving && !probing) setAddOpen(false); }}>
        <DialogContent onCloseAutoFocus={event => { event.preventDefault(); addTrigger.current?.focus(); }} className="max-h-[85dvh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Add a remote A2A agent</DialogTitle><DialogDescription>Read an Agent Card to fill in its details, then review and register it.</DialogDescription></DialogHeader>
          {canManage && !disabled && (        <div
          className="space-y-3"
          onKeyDown={(event) => {
            if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
            if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
            event.preventDefault();
            void addRemoteAgent();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="remote-agent-name">Name</Label><Input disabled={saving || probing} id="remote-agent-name" required value={name} onChange={(event) => setName(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="remote-agent-endpoint">Agent URL</Label><Input disabled={saving || probing} id="remote-agent-endpoint" type="url" required placeholder="https://agent.example.com" value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setProbedCard(null); setCardPreview(null); }} /></div>
            <div className="space-y-1"><Label htmlFor="remote-agent-description">Description</Label><Input disabled={saving || probing} id="remote-agent-description" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="remote-agent-timeout">Timeout (seconds, 1–600)</Label><Input disabled={saving || probing} id="remote-agent-timeout" type="number" min={1} max={600} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /></div>
          </div>
          <AgentFrameworkField id="new-remote-agent-framework" value={framework} onChange={setFramework} disabled={saving || probing} />
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
        </div>)}
          {cardPreview && <AgentCardDetails card={cardPreview} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
