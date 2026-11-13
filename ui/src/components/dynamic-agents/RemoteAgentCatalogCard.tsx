"use client";

import type { RemoteAgentRegistryEntry } from "@/types/dynamic-agent";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AgentCatalogCard } from "./AgentCatalogCard";
import { AgentIdentity } from "./AgentIdentity";
import { AgentProtocolBadge } from "./AgentTechnology";
import { getAgentFramework } from "@/lib/agent-framework";
import { Pencil } from "lucide-react";
import { agentCardSkills } from "./AgentCardDetails";

export function RemoteAgentCatalogCard({ item, view = "grid", status, canManage, busy, onDetails, onTest, onEdit }: {
  item: RemoteAgentRegistryEntry; view?: "grid" | "list"; status?: { error?: string; elapsed?: number; card?: Record<string, unknown> };
  canManage: boolean; busy: boolean; onDetails: (button: HTMLButtonElement) => void; onTest: (button: HTMLButtonElement) => void; onEdit: (button: HTMLButtonElement) => void;
}) {
  const identity = <AgentIdentity agent={item} protocol="a2a" framework={item.framework} />;
  const state = <span className={`text-xs ${status?.error ? "text-destructive" : status?.card ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>{status?.error ? "Connection failed" : status?.card ? `Connection verified · ${status.elapsed} ms` : "Connection not tested"}</span>;
  const actions = <div className="flex flex-wrap gap-1.5"><Button type="button" variant="outline" size="sm" aria-label={`Details for ${item.name}`} disabled={busy} onClick={event => onDetails(event.currentTarget)}>{view === "list" ? "Details" : "View details"}</Button>{canManage && <><Button type="button" size="sm" disabled={busy} onClick={event => onTest(event.currentTarget)}>{view === "list" ? "Test" : "Test connection"}</Button><Button type="button" variant="ghost" size="sm" className="px-1" disabled={busy} aria-label={`Edit ${item.name}`} onClick={event => onEdit(event.currentTarget)}><Pencil className="h-4 w-4" /></Button></>}</div>;
  if (view === "list") return <article aria-label={`${item.name} A2A agent`} className="grid grid-cols-1 gap-4 rounded-lg px-2 py-3 md:grid-cols-12 md:items-center">
    <div className="flex min-w-0 items-center gap-3 md:col-span-4">{identity}<div className="min-w-0"><h2 className="text-sm font-semibold">{item.name}</h2><p className="truncate text-xs text-muted-foreground">{item.description}</p></div></div><div className="md:col-span-2"><AgentProtocolBadge protocol="a2a" /></div><span className="text-sm text-muted-foreground md:col-span-1">—</span><span className="text-sm text-muted-foreground md:col-span-1">—</span><div className="md:col-span-2">{state}</div><div className="md:col-span-2">{actions}</div>
  </article>;
  return <AgentCatalogCard name={item.name} ariaLabel={`${item.name} A2A agent`} agent={item} identity={identity} subtitle="Connected agent" footer={<>{state}{actions}</>}>
    <p className="line-clamp-3 text-xs text-muted-foreground">{item.description || "No description provided."}</p>
    <div className="flex flex-wrap items-center gap-2"><AgentProtocolBadge protocol="a2a" />{item.framework && item.framework !== "unspecified" && <span className="text-xs text-muted-foreground">{getAgentFramework(item.framework).label}</span>}</div>
    <div className="flex flex-wrap gap-1.5"><Badge variant="secondary">{item.streaming ? "Streaming enabled" : "Complete responses"}</Badge><Badge variant="outline">{item.timeout_seconds}s timeout</Badge>{agentCardSkills(status?.card).slice(0, 3).map((skill, index) => <Badge key={`skill-${index}`} variant="secondary">{skill.name}</Badge>)}{item.protocol_bindings?.map(binding => <Badge key={binding} variant="outline">{binding}</Badge>)}</div>
  </AgentCatalogCard>;
}
