"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import type { AvailableSubagent, DynamicAgentConfig, RemoteAgentRegistryEntry, SubAgentRef, VisibilityType } from "@/types/dynamic-agent";
import type { RemoteAgentsPickerProps } from "./RemoteAgentRegistry";

type Choice = { key: string; id: string; source: "caipe" | "a2a"; name: string; description?: string; runtime: string; visibility?: VisibilityType; timeout?: number; readiness?: string };
const runtimes: Record<string, string> = {
  dynamic_agents: "Deep Agents", claude_agent_sdk: "Claude Agent SDK", claude_agent_sdk_remote: "Claude Agent SDK",
  claude_code_acp: "Claude Agent SDK · ACP", claude_code_cli_acp: "Claude Code · ACP", agentcore: "AgentCore",
};

export function DelegatedAgentsPicker({ agentId, value, onChange, remote, disabled, parentVisibility, allowHarnessChildren = false }: {
  agentId: string | null; value: SubAgentRef[]; onChange: (value: SubAgentRef[]) => void;
  remote: RemoteAgentsPickerProps; disabled?: boolean; parentVisibility: VisibilityType; allowHarnessChildren?: boolean;
}) {
  const [choices, setChoices] = React.useState<Choice[]>([]);
  const [errors, setErrors] = React.useState<Partial<Record<Choice["source"], string>>>({});
  const [loadingSources, setLoadingSources] = React.useState({ caipe: true, a2a: true });
  const loading = loadingSources.caipe || loadingSources.a2a;
  const hasReadySource = (["caipe", "a2a"] as const).some(source => !loadingSources[source] && !errors[source]);
  const [revision, refresh] = React.useReducer(n => n + 1, 0);
  React.useEffect(() => {
    let active = true;
    const controllers: AbortController[] = [];
    setLoadingSources({ caipe: true, a2a: true });
    setErrors({});
    async function load(source: Choice["source"], url: string) {
      const controller = new AbortController();
      controllers.push(controller);
      let rejectAborted: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        rejectAborted = () => reject(new Error("Catalog request timed out"));
        controller.signal.addEventListener("abort", rejectAborted, { once: true });
      });
      const timeout = setTimeout(() => controller.abort(), 10_000);
      setChoices(previous => previous.filter(item => item.source !== source));
      try {
        // Bound both the request and body read, even if a transport ignores abort.
        const { response, body } = await Promise.race([(async () => {
          const response = await fetch(url, { signal: controller.signal, credentials: "include", cache: "no-store" });
          return { response, body: await response.json() };
        })(), aborted]);
        if (!response.ok || !body.success) throw new Error(body.error || `Could not load ${source} agents`);
        const items = source === "a2a" ? body.data?.items : body.data?.agents;
        if (!Array.isArray(items)) throw new Error(`Invalid ${source} agent catalog`);
        const loaded: Choice[] = source === "a2a" ? items.map((item: RemoteAgentRegistryEntry) => ({
          key: `a2a:${item._id}`, id: item._id, source, name: item.name, description: item.description,
          runtime: "A2A", timeout: item.timeout_seconds,
        })) : items.map((item: AvailableSubagent & DynamicAgentConfig) => {
          const id = item.id || item._id;
          return { key: `caipe:${id}`, id, source, name: item.name, description: item.description,
            readiness: item.execution_readiness?.ready === false ? item.execution_readiness.message || "Agent configuration needs attention" : undefined,
            runtime: item.execution_harness_id || "dynamic_agents", visibility: item.visibility === "global" ? "global" : "team" };
        });
        if (active) setChoices(previous => [...previous.filter(item => item.source !== source), ...loaded]);
      } catch (error) {
        if (active) setErrors(previous => ({ ...previous, [source]: error instanceof Error ? error.message : "Catalog unavailable" }));
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", rejectAborted);
        if (active) setLoadingSources(previous => ({ ...previous, [source]: false }));
      }
    }
    void load("caipe", agentId ? `/api/dynamic-agents/available-subagents?id=${encodeURIComponent(agentId)}` : "/api/dynamic-agents/available-subagents?create=true");
    void load("a2a", "/api/remote-agents");
    return () => { active = false; controllers.forEach(controller => controller.abort()); };
  }, [agentId, revision]);

  const selected = [
    ...value.map(ref => ({ key: `caipe:${ref.agent_id}`, id: ref.agent_id, source: "caipe" as const, name: ref.name, description: ref.description, runtime: "", timeout: ref.timeout_seconds })),
    ...remote.value.map(id => ({ key: `a2a:${id}`, id, source: "a2a" as const, name: id, description: undefined, runtime: "A2A", timeout: remote.timeoutValues[id] })),
  ];
  const available = choices.filter(item => !loadingSources[item.source] && !errors[item.source] && (item.source !== "caipe" || item.id !== agentId) && !selected.some(saved => saved.key === item.key));
  const incompatible = (item: Choice) => item.source === "caipe" && (
    Boolean(item.readiness) || !runtimes[item.runtime] || item.runtime !== "dynamic_agents" && !allowHarnessChildren || parentVisibility === "global" && item.visibility !== "global"
  );
  function add(item: Choice) {
    if (item.source === "a2a") remote.onChange([...new Set([...remote.value, item.id])]);
    else onChange([...value, { agent_id: item.id, name: item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), description: item.description || `Delegate to ${item.name}` }]);
  }
  return <section aria-label="Selected subagents" className="space-y-3">
    <p className="text-sm text-muted-foreground">Choose CAIPE agents, including configured ACP agents, or registered A2A agents to delegate work. Each agent keeps its configured runtime and access checks.</p>
    <div className="flex flex-wrap gap-2 items-center">
      <div className="flex-1 min-w-0"><SearchablePicker options={available} onSelect={add} getOptionKey={item => item.key}
        getOptionLabel={item => item.name} getSearchText={item => [item.name, item.description || "", runtimes[item.runtime] || item.runtime]}
        isOptionDisabled={incompatible} renderOption={item => <div>{item.name}<span className="ml-2 text-xs text-muted-foreground">{item.source === "a2a" ? "A2A" : `CAIPE · ${runtimes[item.runtime] || "Unavailable runtime"}`}</span>
          {item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}
          {incompatible(item) && <p className="text-xs text-muted-foreground">{item.readiness || "Runtime or sharing permissions are incompatible."}</p>}</div>}
        ariaLabel="Add subagent" placeholder="Add subagent…" searchPlaceholder="Search agents…" emptyLabel="No available agents"
        loading={loading} disabled={disabled || !hasReadySource} /></div>
      <Button type="button" variant="outline" size="sm" disabled={disabled || loadingSources.caipe && loadingSources.a2a} onClick={refresh}>Refresh agents</Button>
      <Button type="button" variant="link" size="sm" asChild><a href="/dynamic-agents?tab=remote-agents" target="_blank" rel="noopener noreferrer">Discover remote agents</a></Button>
    </div>
    {Object.entries(errors).map(([source, error]) => <p key={source} role="alert" className="text-sm text-destructive">{source === "a2a" ? "Remote registry" : "CAIPE catalog"}: {error}. Refresh to retry; saved selections are retained.</p>)}
    {!selected.length && <p className="text-sm text-muted-foreground">No subagents selected.</p>}
    {selected.map(saved => {
      const item = choices.find(choice => choice.key === saved.key);
      const name = item?.name || saved.name;
      const isHarness = saved.source === "caipe" && item && item.runtime !== "dynamic_agents";
      const update = (patch: Partial<SubAgentRef>) => onChange(value.map(ref => ref.agent_id === saved.id ? { ...ref, ...patch } : ref));
      return <div key={saved.key} className="rounded-lg border p-3 space-y-2">
        <div className="flex items-center justify-between"><div className="font-medium">{name}<span className="ml-2 text-xs text-muted-foreground">{saved.source === "a2a" ? "A2A" : `CAIPE · ${item ? runtimes[item.runtime] || "Unavailable runtime" : "Saved agent"}`}</span></div>
          <Button type="button" size="sm" variant="ghost" disabled={disabled} aria-label={`Remove ${name} subagent`} onClick={() => saved.source === "a2a" ? remote.onChange(remote.value.filter(id => id !== saved.id)) : onChange(value.filter(ref => ref.agent_id !== saved.id))}>Remove</Button></div>
        {saved.source === "caipe" ? <>
          <Label htmlFor={`route-${saved.key}`}>Routing name</Label><Input id={`route-${saved.key}`} value={saved.name} disabled={disabled} onChange={event => update({ name: event.target.value })} />
          <Label htmlFor={`description-${saved.key}`}>Delegation description</Label><Input id={`description-${saved.key}`} value={saved.description || ""} disabled={disabled} onChange={event => update({ description: event.target.value })} />
        </> : item?.description && <p className="text-sm text-muted-foreground">{item.description}</p>}
        {(saved.source === "a2a" || isHarness) && <div className="max-w-48"><Label htmlFor={`timeout-${saved.key}`}>Timeout (seconds)</Label>
          <Input id={`timeout-${saved.key}`} type="number" min={1} max={600} disabled={disabled} value={saved.timeout ?? item?.timeout ?? 120} onChange={event => {
            const seconds = Number(event.target.value);
            if (Number.isInteger(seconds) && seconds >= 1 && seconds <= 600) {
              if (saved.source === "a2a") remote.onTimeoutChange(saved.id, seconds); else update({ timeout_seconds: seconds });
            }
          }} /></div>}
        {!item && !loadingSources[saved.source] && !errors[saved.source] && <p className="text-xs text-amber-600">This saved agent is unavailable. Its reference is retained.</p>}
        {item && incompatible(item) && <p className="text-xs text-destructive">{item.readiness || "This agent has incompatible runtime or sharing permissions."}</p>}
      </div>;
    })}
  </section>;
}
