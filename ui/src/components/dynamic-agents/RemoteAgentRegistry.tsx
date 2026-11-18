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
import { ArrowLeft, Check, Loader2, Plus, Trash2, Unplug, X } from "lucide-react";
import React from "react";
import { AddAgentChoices } from "./AddAgentChoices";
import { RemoteAgentDiscovery, type DiscoveredAgent } from "./RemoteAgentDiscovery";
import { RemoteAgentSelection } from "./RemoteAgentSelection";
import { RemoteAgentCatalogCard } from "./RemoteAgentCatalogCard";
import { ConfiguredAcpAgentCard, isConfiguredAcpAgent } from "./ConfiguredAcpAgentCard";
import { defaultRemoteAgentAuth, isRemoteAgentAuthConfigured, RemoteAgentAuthFields } from "./RemoteAgentAuthFields";

export interface RemoteAgentsPickerProps {
  value: string[];
  onChange: (value: string[]) => void;
  timeoutValues: Record<string, number>;
  onTimeoutChange: (remoteAgentId: string, seconds: number) => void;
  disabled?: boolean;
}

export interface RemoteCatalogControls {
  toolbar: React.ReactNode;
  openAddAgent: (trigger: HTMLButtonElement) => void;
  renderAgent: (item: RemoteAgentRegistryEntry, view: "grid" | "list") => React.ReactNode;
  refresh: () => void;
}

export function RemoteAgentRegistry({ selection, renderCatalog, onRegistryChange, onCreateAgent }: { selection?: RemoteAgentsPickerProps; renderCatalog?: (controls: RemoteCatalogControls) => React.ReactNode; onRegistryChange?: () => void; onCreateAgent?: () => void }) {
  const { disabled } = selection ?? {};
  const { toast } = useToast();
  const includeAcp = !selection && !renderCatalog;
  const [acpAgents, setAcpAgents] = React.useState<AvailableSubagent[]>([]);
  const [acpLoading, setAcpLoading] = React.useState(includeAcp);
  const [acpError, setAcpError] = React.useState<string | null>(null);
  const cardTrigger = React.useRef<HTMLButtonElement>(null);
  const addTrigger = React.useRef<HTMLButtonElement>(null);
  const connectionTitle = React.useRef<HTMLHeadingElement>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [connectionStep, setConnectionStep] = React.useState<"choose" | "find" | "review">("find");
  const [detailsId, setDetailsId] = React.useState<string | null>(null);
  const [protocol, setProtocol] = React.useState("all");
  const [checks, setChecks] = React.useState<Record<string, { card?: Record<string, unknown>; error?: string; elapsed?: number }>>({});
  const [search, setSearch] = React.useState("");
  const [items, setItems] = React.useState<RemoteAgentRegistryEntry[]>([]);
  const [canManage, setCanManage] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const mutationPending = React.useRef(false);
  const catalogPending = React.useRef(false);
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

  React.useEffect(() => {
    if (addOpen) connectionTitle.current?.focus();
  }, [addOpen, connectionStep]);

  const openAddAgent = (trigger: HTMLButtonElement) => {
    addTrigger.current = trigger;
    setFramework("unspecified"); setName(""); setEndpoint(""); setDescription("");
    setTimeoutSeconds(120); setStreaming(false); setProbedCard(null); setCardPreview(null);
    setCredentialSource(selection ? defaultRemoteAgentAuth() : { kind: "none", target: "header", name: "Authorization" });
    setConnectionStep(onCreateAgent ? "choose" : "find");
    setAddOpen(true);
  };

  const chooseDiscoveredAgent = (agent: DiscoveredAgent) => {
    setFramework("unspecified"); setEndpoint(agent.endpoint); setName(agent.error ? "" : agent.name || "");
    setDescription(agent.description || ""); setStreaming(agent.supports_streaming === true); setTimeoutSeconds(120);
    setCredentialSource({ kind: "none", target: "header", name: "Authorization" });
    setProbedCard(agent.error ? null : { protocol_version: agent.protocol_version, protocol_bindings: agent.protocol_bindings, supports_streaming: agent.supports_streaming });
    setCardPreview(null); setConnectionStep("review");
  };

  const loadItems = React.useCallback(async () => {
    if (mutationPending.current || catalogPending.current) return;
    catalogPending.current = true;
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
      catalogPending.current = false;
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
    if (disabled || probing || mutationPending.current || catalogPending.current) return;
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
    if (disabled || probing || mutationPending.current || catalogPending.current) return;
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
      setAddOpen(false); setCardPreview(null); setFramework("unspecified");
      setName(""); setEndpoint(""); setDescription(""); setTimeoutSeconds(120); setStreaming(false); setProbedCard(null);
      setCredentialSource(selection ? defaultRemoteAgentAuth() : { kind: "none", target: "header", name: "Authorization" });
      toast("Remote A2A agent added", "success");
      onRegistryChange?.();
    } catch (error) {
      toast(`Could not add remote A2A agent: ${error instanceof Error ? error.message : "Request failed"}`, "error");
    } finally {
      mutationPending.current = false;
      setSaving(false);
    }
  };

  const removeRemoteAgent = async (item: RemoteAgentRegistryEntry) => {
    if (disabled || probing || mutationPending.current || catalogPending.current) return;
    if (!window.confirm(`Disable ${item.name} for future agent configurations?`)) return;
    mutationPending.current = true;
    setSaving(true);
    try {
      const response = await fetch(`/api/remote-agents/${encodeURIComponent(item._id)}`, { method: "DELETE", credentials: "include" });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Failed to remove remote agent");
      setItems((current) => current.filter((entry) => entry._id !== item._id));
      setDetailsId(null);
      onRegistryChange?.();
    } catch (error) {
      toast(`Could not remove remote A2A agent: ${error instanceof Error ? error.message : "Request failed"}`, "error");
    } finally {
      mutationPending.current = false;
      setSaving(false);
    }
  };

  const saveRemoteAgent = async () => {
    if (disabled || probing || mutationPending.current || catalogPending.current) return;
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
      onRegistryChange?.();
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

  const renderAgent = (item: RemoteAgentRegistryEntry, view: "grid" | "list") => <RemoteAgentCatalogCard key={`a2a:${item._id}`} item={item} view={view} status={checks[item._id]} canManage={canManage} busy={saving || probing || loading || !!loadError}
    onDetails={button => { cardTrigger.current = button; setDetailsId(item._id); }}
    onTest={button => { cardTrigger.current = button; setDetailsId(item._id); void probeEndpoint(false, item); }}
    onEdit={button => { cardTrigger.current = button; beginEdit(item); }} />;
  const toolbar = (onCreateAgent || canManage) && (
    <Button type="button" data-tour={onCreateAgent ? "add-agent" : undefined} size="sm"
      className="h-10 sm:h-9" disabled={disabled || saving || probing}
      onClick={event => openAddAgent(event.currentTarget)}>
      {onCreateAgent ? <Plus aria-hidden="true" className="h-4 w-4" /> : <Unplug aria-hidden="true" className="h-4 w-4" />}
      {onCreateAgent ? "Add agent" : "Connect existing agent"}
    </Button>
  );

  return (
    <>
      {renderCatalog ? renderCatalog({ toolbar, openAddAgent, renderAgent, refresh: () => void loadItems() }) : <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">Explore remote specialists, inspect their capabilities, and test a connection before adding them as subagents.</p>
        {toolbar}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input className="min-w-48 flex-1" aria-label="Search remote agents" placeholder="Search agents or capabilities…" value={search} onChange={event => setSearch(event.target.value)} />
        <Select aria-label="Filter by protocol" className="w-40" value={protocol} onChange={event => setProtocol(event.target.value)}><option value="all">All protocols</option><option value="a2a">A2A</option><option value="acp">ACP</option></Select>
        <Button type="button" variant="outline" disabled={loading || acpLoading || saving || probing} onClick={() => { setChecks({}); void loadItems(); void loadAcpAgents(); }}>Refresh agents</Button>
      </div>
      {loadError && <div role="alert" className="text-sm text-destructive">{loadError} <Button type="button" variant="outline" size="sm" onClick={() => void loadItems()}>Retry</Button></div>}
      {acpError && <div role="alert" className="text-sm text-destructive">{acpError} <Button type="button" variant="outline" size="sm" onClick={() => void loadAcpAgents()}>Retry ACP agents</Button></div>}
      {(loading || acpLoading) && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading remote agents…</p>}
      {!catalog.length && !loading && !acpLoading && !loadError && !acpError && <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">{search || protocol !== "all" ? "No matching remote agents." : "No A2A or configured ACP agents are available."}</div>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3" aria-label="Remote agent catalog">
        {catalog.map(entry => {
          if (entry.source === "acp") return <ConfiguredAcpAgentCard key={entry.key} agent={entry.item} />;
          return renderAgent(entry.item, "grid");
        })}
      </div>
      <p className="text-xs text-muted-foreground">{catalog.length} agent{catalog.length === 1 ? "" : "s"} shown · Add these specialists in Agent Builder → Advanced → Subagents.</p>
      </div>}
      {renderCatalog && loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
      <Dialog open={!!detail} onOpenChange={open => { if (!open && !probing && !saving) setDetailsId(null); }}>
        <DialogContent onCloseAutoFocus={event => { event.preventDefault(); if (!editingId) cardTrigger.current?.focus(); }} className="max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100%-2rem))] min-w-0 max-w-2xl overflow-y-auto p-4 [overflow-wrap:anywhere] sm:p-6">
          <DialogHeader><DialogTitle className="flex min-w-0 items-center gap-3 pr-6 text-left leading-snug"><AgentTechnologyIcon decorative agent={detail} protocol="a2a" framework={detail?.framework} />{detail?.name}</DialogTitle><DialogDescription>{detail?.description || "Remote A2A agent details and connection test."}</DialogDescription></DialogHeader>
          {detail && <>
            <div className="flex flex-wrap gap-2"><AgentProtocolBadge protocol="a2a" version={detail.protocol_version} />{detail.framework && detail.framework !== "unspecified" && <Badge variant="secondary">{getAgentFramework(detail.framework).label}</Badge>}<Badge variant="secondary">{detail.streaming ? "Streaming enabled" : "Complete responses"}</Badge><Badge variant="outline">{detail.timeout_seconds}s timeout</Badge></div>
            {canManage && <dl className="space-y-2 text-sm"><dt className="font-medium">Agent URL</dt><dd className="break-all font-mono text-xs text-muted-foreground">{detail.endpoint}</dd><dt className="font-medium">Authentication</dt><dd className="text-muted-foreground">{(detail.credential_source || defaultRemoteAgentAuth()).kind === "caller_token" ? "Your user identity" : (detail.credential_source || defaultRemoteAgentAuth()).kind === "secret_ref" ? "Saved secret" : (detail.credential_source || defaultRemoteAgentAuth()).kind === "provider_connection" ? "Connected credential" : "Public agent"}</dd></dl>}
            <section className="space-y-3 rounded-lg border p-4"><h3 className="font-medium">Connection test</h3><p className="text-sm text-muted-foreground">Reads the Agent Card with the saved authentication. This checks connectivity and advertised capabilities; it does not run a task.</p>
              {canManage ? <Button type="button" disabled={loading || probing || saving} onClick={() => void probeEndpoint(false, detail)}>{probing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{probing ? "Testing…" : "Read Agent Card"}</Button> : <p className="text-sm text-muted-foreground">A registry manager can test this connection.</p>}
              <div aria-live="polite">{checks[detail._id]?.error && <p role="alert" className="text-sm text-destructive">{checks[detail._id].error}</p>}{checks[detail._id]?.card && <><p role="status" className="mb-3 text-sm text-emerald-600 dark:text-emerald-400">Connection verified · {checks[detail._id].elapsed} ms</p><AgentCardDetails card={checks[detail._id].card!} /></>}</div>
            </section>
            {canManage && <div className="flex flex-wrap justify-between gap-2"><Button type="button" variant="outline" disabled={saving || probing} onClick={() => beginEdit(detail)}>Edit configuration</Button><Button type="button" variant="ghost" className="text-destructive" disabled={saving || probing} onClick={() => void removeRemoteAgent(detail)}><Trash2 className="mr-2 h-4 w-4" />Remove agent</Button></div>}
          </>}
        </DialogContent>
      </Dialog>
      <Dialog open={!!editing} onOpenChange={open => { if (!open && !saving && !probing) setEditingId(null); }}>
        <DialogContent onCloseAutoFocus={event => { event.preventDefault(); cardTrigger.current?.focus(); }} className="max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100%-2rem))] min-w-0 max-w-2xl overflow-y-auto p-4 [overflow-wrap:anywhere] sm:p-6"><DialogHeader><DialogTitle>Edit {editing?.name}</DialogTitle><DialogDescription>Update the saved connection and authentication.</DialogDescription></DialogHeader>
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
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-name-${editing._id}`}>Name</Label><Input disabled={disabled || loading || saving || probing} id={`edit-remote-agent-name-${editing._id}`} required value={editValues.name} onChange={(event) => setEditValues((current) => ({ ...current, name: event.target.value }))} /></div>
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-endpoint-${editing._id}`}>Agent URL</Label><Input disabled={disabled || loading || saving || probing} id={`edit-remote-agent-endpoint-${editing._id}`} type="url" required value={editValues.endpoint} onChange={(event) => { setCardPreview(null); setEditValues((current) => ({ ...current, endpoint: event.target.value })); }} /></div>
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-description-${editing._id}`}>Description</Label><Input disabled={disabled || loading || saving || probing} id={`edit-remote-agent-description-${editing._id}`} value={editValues.description} onChange={(event) => setEditValues((current) => ({ ...current, description: event.target.value }))} /></div>
                    <div className="space-y-1"><Label htmlFor={`edit-remote-agent-timeout-${editing._id}`}>Default timeout (seconds)</Label><Input disabled={disabled || loading || saving || probing} id={`edit-remote-agent-timeout-${editing._id}`} type="number" min={1} max={600} value={editValues.timeout_seconds} onChange={(event) => setEditValues((current) => ({ ...current, timeout_seconds: Number(event.target.value) }))} /></div>
                  </div>
                  <AgentFrameworkField id="edit-remote-agent-framework" value={editValues.framework} disabled={loading || saving || probing} onChange={framework => setEditValues(current => ({ ...current, framework }))} />
                  <label className="flex items-center gap-2 text-sm"><input id={`edit-remote-agent-streaming-${editing._id}`} type="checkbox" className="h-4 w-4 accent-primary" checked={editValues.streaming} disabled={disabled || loading || saving} onChange={(event) => setEditValues((current) => ({ ...current, streaming: event.target.checked }))} />Stream responses</label>
                  <p className="text-xs text-muted-foreground">Show remote output as it arrives. Agents without streaming support return a complete response.</p>
                  <RemoteAgentAuthFields
                    value={editValues.credential_source}
                    onChange={(source) => { setCardPreview(null); setEditValues((current) => ({ ...current, credential_source: source })); }}
                    idPrefix={`edit-${editing._id}`}
                    disabled={disabled || loading || saving || probing}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={disabled || loading || saving || probing || !editValues.endpoint.trim() || !isRemoteAgentAuthConfigured(editValues.credential_source)} onClick={() => void probeEndpoint(true)}>{probing ? "Checking…" : "Test connection"}</Button>
                    <Button type="button" size="sm" disabled={disabled || loading || saving || probing || !editValues.name.trim() || !editValues.endpoint.trim() || !isRemoteAgentAuthConfigured(editValues.credential_source)} onClick={() => void saveRemoteAgent()}><Check className="mr-2 h-4 w-4" />Save</Button>
                    <Button type="button" size="sm" variant="outline" disabled={loading || saving || probing} onClick={() => setEditingId(null)}><X className="mr-2 h-4 w-4" />Cancel</Button>
                  </div>
                </div>}
          {cardPreview && <AgentCardDetails card={cardPreview} />}
        </DialogContent>
      </Dialog>
      <Dialog open={addOpen} onOpenChange={open => { if (!open && !saving && !probing) setAddOpen(false); }}>
        <DialogContent onCloseAutoFocus={event => { event.preventDefault(); addTrigger.current?.focus(); }} className="max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100%-2rem))] min-w-0 max-w-2xl overflow-y-auto p-4 [overflow-wrap:anywhere] sm:p-6">
          <DialogHeader>
            <DialogTitle ref={connectionTitle} tabIndex={-1} className="pr-6 leading-snug">
              {connectionStep === "choose" ? "Add agent" : "Connect existing agent"}
            </DialogTitle>
            <DialogDescription>
              {connectionStep === "choose" ? "Build something new, or bring an agent you already run."
                : connectionStep === "find" ? "Find public A2A Agent Cards or configured Kubernetes Services, or enter connection details manually."
                  : "Review the agent details and authentication, then connect it to the catalog."}
            </DialogDescription>
          </DialogHeader>
          {connectionStep === "choose" && onCreateAgent && <AddAgentChoices
            canConnect={canManage && !disabled && !loading}
            onCreate={() => { setAddOpen(false); onCreateAgent(); }}
            onConnect={() => setConnectionStep("find")}
          />}
          {connectionStep !== "choose" && canManage && !disabled && <>
            <ol aria-label="Connection progress" className="flex flex-wrap gap-3 text-sm text-muted-foreground">
              <li aria-current={connectionStep === "find" ? "step" : undefined} className={connectionStep === "find" ? "font-medium text-primary" : undefined}>1 · Find agent</li>
              <li aria-current={connectionStep === "review" ? "step" : undefined} className={connectionStep === "review" ? "font-medium text-primary" : undefined}>2 · Review &amp; connect</li>
            </ol>
            <div hidden={connectionStep !== "find"} className="space-y-3">
              <RemoteAgentDiscovery showHeader={false} disabled={loading || saving || probing} onChoose={chooseDiscoveredAgent} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                {onCreateAgent && <Button type="button" variant="ghost" onClick={() => setConnectionStep("choose")}><ArrowLeft aria-hidden="true" />Back to choices</Button>}
                <Button type="button" variant="outline" disabled={loading || saving || probing} onClick={() => setConnectionStep("review")}>Enter connection details manually</Button>
              </div>
            </div>
          </>}
          {connectionStep === "review" && canManage && !disabled && (        <div
          className="space-y-3"
          onKeyDown={(event) => {
            if (event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) return;
            if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
            event.preventDefault();
            void addRemoteAgent();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="remote-agent-name">Name</Label><Input disabled={loading || saving || probing} id="remote-agent-name" required value={name} onChange={(event) => setName(event.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="remote-agent-endpoint">Agent URL</Label><Input disabled={loading || saving || probing} id="remote-agent-endpoint" type="url" required placeholder="https://agent.example.com" value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setProbedCard(null); setCardPreview(null); }} /></div>
            <div className="space-y-1 sm:col-span-2"><Label htmlFor="remote-agent-description">Description</Label><Input disabled={loading || saving || probing} id="remote-agent-description" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
          </div>
          <RemoteAgentAuthFields
            value={credentialSource}
            onChange={(source) => { setCredentialSource(source); setProbedCard(null); setCardPreview(null); }}
            idPrefix="new-remote-agent"
            disabled={loading || saving || probing}
          />
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">Advanced settings</summary>
            <div className="mt-3 space-y-3">
              <div className="space-y-1"><Label htmlFor="remote-agent-timeout">Timeout (seconds, 1–600)</Label><Input disabled={loading || saving || probing} id="remote-agent-timeout" type="number" min={1} max={600} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} /></div>
              <AgentFrameworkField id="new-remote-agent-framework" value={framework} onChange={setFramework} disabled={loading || saving || probing} />
              <label className="flex items-center gap-2 text-sm"><input id="remote-agent-streaming" type="checkbox" className="h-4 w-4 accent-primary" checked={streaming} disabled={loading || saving || probing} onChange={(event) => setStreaming(event.target.checked)} />Stream responses</label>
              <p className="text-xs text-muted-foreground">Show remote output as it arrives. Agents without streaming support return a complete response.</p>
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={saving || probing} onClick={() => setConnectionStep("find")}><ArrowLeft aria-hidden="true" />Back to discovery</Button>
            <Button type="button" size="sm" variant="outline" disabled={loading || saving || probing || !endpoint.trim() || !isRemoteAgentAuthConfigured(credentialSource)} onClick={() => void probeEndpoint()}>{probing ? "Probing…" : "Discover Agent Card"}</Button>
            <Button type="button" size="sm" disabled={loading || saving || probing || !name.trim() || !endpoint.trim() || !isRemoteAgentAuthConfigured(credentialSource)} onClick={() => void addRemoteAgent()}><Unplug className="mr-2 h-4 w-4" />{saving ? "Connecting…" : "Connect agent"}</Button>
            {probedCard?.protocol_bindings?.length ? <span className="text-xs text-muted-foreground">A2A {probedCard.protocol_version || ""} · {probedCard.protocol_bindings.join(", ")} · {probedCard.supports_streaming ? "Streaming available" : "Complete responses only"}</span> : null}
          </div>
        </div>)}
          {connectionStep === "review" && cardPreview && <AgentCardDetails card={cardPreview} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
