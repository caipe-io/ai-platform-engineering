"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import type { RemoteAgentRegistryEntry } from "@/types/dynamic-agent";
import { ExternalLink, RefreshCw, X } from "lucide-react";
import type { RemoteAgentsPickerProps } from "./RemoteAgentRegistry";

export function RemoteAgentSelection({ selection, items, loading, error, onRefresh }: {
  selection: RemoteAgentsPickerProps;
  items: RemoteAgentRegistryEntry[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const { value, onChange, timeoutValues, onTimeoutChange, disabled } = selection;
  const available = items.filter(item => !value.includes(item._id));
  return <section aria-label="Selected remote agents" className="space-y-3">
    <p className="text-sm text-muted-foreground">Add agents from the Remote Agents registry. Their saved connection and authentication settings are reused.</p>
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-0 flex-1">
        <SearchablePicker options={available} onSelect={item => onChange([...new Set([...value, item._id])])}
          getOptionKey={item => item._id} getOptionLabel={item => item.name}
          getSearchText={item => [item.name, item.description || "", item._id]}
          renderOption={item => <div><div>{item.name}</div>{item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}</div>}
          ariaLabel="Add remote agent from registry" placeholder="Add from registry…" searchPlaceholder="Search registered agents…"
          emptyLabel={error ? "Registry unavailable" : items.length ? "All registered agents have been added" : "No registered agents. Open Remote Agents to register one."}
          disabled={disabled || loading || !!error} loading={loading} loadingLabel="Loading registry…" />
      </div>
      <Button type="button" variant="outline" size="sm" disabled={disabled || loading} onClick={onRefresh}>
        <RefreshCw className="mr-2 h-4 w-4" />Refresh registry
      </Button>
      <Button type="button" variant="link" size="sm" asChild>
        <a href="/dynamic-agents?tab=remote-agents" target="_blank" rel="noopener noreferrer">Open Remote Agents<ExternalLink className="ml-2 h-3.5 w-3.5" /></a>
      </Button>
    </div>
    <p className="text-xs text-muted-foreground">Discover and register new agents in Remote Agents, then refresh this list. Your builder draft stays open.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error} Use Refresh registry to retry. Your selected agents are retained.</p>}
    {!value.length && <p className="text-sm text-muted-foreground">No remote agents added to this agent yet.</p>}
    {[...new Set(value)].map(id => {
      const item = items.find(candidate => candidate._id === id);
      const name = item?.name || `Saved remote agent (${id})`;
      return <div key={id} className="space-y-2 rounded-lg border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0"><div className="font-medium">{name}</div>
            {item?.description && <p className="text-sm text-muted-foreground">{item.description}</p>}
            {item && <p className="text-xs text-muted-foreground">{item.protocol_bindings?.join(", ") || "A2A"}{item.streaming ? " · Streaming" : ""}</p>}
            {!item && !loading && !error && <p className="text-xs text-amber-600 dark:text-amber-400">This agent is unavailable in the registry. Remove it or refresh after it is restored.</p>}
          </div>
          <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label={`Remove ${name} from this agent`} onClick={() => onChange(value.filter(selected => selected !== id))}><X className="h-4 w-4" /></Button>
        </div>
        <div className="max-w-48 space-y-1"><Label htmlFor={`remote-timeout-${id}`} className="text-xs">Timeout (seconds)</Label>
          <Input id={`remote-timeout-${id}`} type="number" min={1} max={600} value={timeoutValues[id] ?? item?.timeout_seconds ?? 120} disabled={disabled}
            onChange={event => { const seconds = Number(event.target.value); if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 600) onTimeoutChange(id, seconds); }} />
        </div>
      </div>;
    })}
  </section>;
}
