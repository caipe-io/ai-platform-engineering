"use client";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import React from "react";

export interface DiscoveredAgent {
  endpoint: string;
  name?: string;
  description?: string;
  protocol_version?: string;
  protocol_bindings?: string[];
  supports_streaming?: boolean;
  namespace?: string;
  ready?: boolean;
  error?: string;
}

export function RemoteAgentDiscovery({ onChoose, disabled }: { onChoose: (agent: DiscoveredAgent) => void; disabled?: boolean }) {
  const [source, setSource] = React.useState("urls");
  const [urls, setUrls] = React.useState("");
  const [namespaces, setNamespaces] = React.useState<string[]>([]);
  const [namespace, setNamespace] = React.useState<string | undefined>();
  const [configError, setConfigError] = React.useState<string | null>(null);
  const [configRetry, setConfigRetry] = React.useState(0);
  const [items, setItems] = React.useState<DiscoveredAgent[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [searched, setSearched] = React.useState(false);
  React.useEffect(() => {
    const controller = new AbortController();
    setConfigError(null);
    void fetch("/api/remote-agents/discovery", { signal: controller.signal }).then(async (response) => {
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Could not load discovery configuration");
      setNamespaces(data.data.namespaces || []);
    }).catch((err) => { if (!controller.signal.aborted) setConfigError(err.message); });
    return () => controller.abort();
  }, [configRetry]);
  const candidates = [...new Set(urls.split(/\r?\n/).map((url) => url.trim()).filter(Boolean))];
  const discover = async () => {
    setLoading(true); setError(null); setItems([]); setSearched(false);
    try {
      const response = await fetch("/api/remote-agents/discovery", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(source === "urls" ? { source, urls: candidates } : { source, namespace }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Discovery failed");
      setItems(data.data.items); setSearched(true);
    } catch (err) { setError(err instanceof Error ? err.message : "Discovery failed"); }
    finally { setLoading(false); }
  };
  return <section aria-label="Discover remote agents" className="space-y-3 rounded-lg border bg-muted/20 p-4">
    <h2 className="font-medium">Discover agents</h2>
    <p className="text-sm text-muted-foreground">Read public Agent Cards or find Kubernetes Services. Review a candidate before registering it.</p>
    <div className="max-w-sm space-y-1"><Label htmlFor="a2a-discovery-source">Discovery source</Label>
      <Select id="a2a-discovery-source" value={source} disabled={disabled || loading} onChange={(event) => { setSource(event.target.value); setItems([]); setError(null); setSearched(false); }}>
        <option value="urls">Public URLs</option><option value="kubernetes">Kubernetes Services</option>
      </Select></div>
    {source === "urls" ? <div className="space-y-1"><Label htmlFor="a2a-discovery-urls">Agent URLs or Agent Card URLs</Label>
      <Textarea id="a2a-discovery-urls" value={urls} disabled={disabled || loading} onChange={(event) => setUrls(event.target.value)} placeholder="https://agent.example.com" />
      <p className="text-xs text-muted-foreground">One URL per line, up to 8. Public discovery sends no caller credentials.</p></div>
      : <div className="max-w-sm space-y-1"><Label htmlFor="a2a-discovery-namespace">Namespace</Label>
        <SearchablePicker id="a2a-discovery-namespace" ariaLabel="Discovery namespace" options={namespaces} selected={namespace}
          onSelect={setNamespace} getOptionKey={(value) => value} getOptionLabel={(value) => value}
          placeholder="Choose a configured namespace" searchPlaceholder="Search namespaces…" emptyLabel="No discovery namespaces configured" disabled={disabled || loading} />
        {configError ? <p role="alert" className="text-sm text-destructive">{configError} <Button type="button" variant="link" onClick={() => setConfigRetry((value) => value + 1)}>Retry</Button></p>
          : !namespaces.length && <p className="text-xs text-muted-foreground">Kubernetes discovery is not configured for this deployment.</p>}
      </div>}
    <Button type="button" variant="outline" disabled={disabled || loading || (source === "urls" ? !candidates.length || candidates.length > 8 : !namespace)} onClick={() => void discover()}>{loading ? "Discovering…" : "Discover"}</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {searched && !items.length && <p role="status" className="text-sm text-muted-foreground">No discoverable agents found.</p>}
    {items.map((item) => <div key={item.endpoint} className="flex items-start justify-between gap-3 rounded-md border bg-background p-3">
      <div className="min-w-0"><div className="font-medium">{item.name || item.endpoint}</div><p className="break-all font-mono text-xs text-muted-foreground">{item.endpoint}</p>
        {item.description && <p className="text-sm text-muted-foreground">{item.description}</p>}
        {item.namespace && <p className="text-xs text-muted-foreground">{item.namespace} · {item.ready ? "Ready endpoints" : "No ready endpoints"}</p>}
        {item.error && <p className="text-xs text-destructive">{item.error} You can review the URL and configure authentication.</p>}
      </div><Button type="button" size="sm" disabled={disabled || loading || item.ready === false} onClick={() => onChoose(item)}>Review</Button>
    </div>)}
  </section>;
}
