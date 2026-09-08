"use client";

import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { AgentPicker, type AgentPickerOption } from "@/components/ui/agent-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { TeamPicker, type TeamPickerOption } from "@/components/ui/team-picker";
import { useToast } from "@/components/ui/toast";
import { getConfig } from "@/lib/config";
import { cn } from "@/lib/utils";
import type {
  DynamicAgentOption,
  ItemAgentRoute,
  ItemSummary,
  TeamOption,
} from "../connector-admin-adapter";

// Webex's Mercury transport only ever delivers @mention events to group
// spaces, so every route is fixed to listen:"mention" with no meaningful
// priority ordering (at most one route per bot per space is enforced
// server-side). Both fields are still written for the shared route shape,
// but are no longer exposed as editable options in this UI.
const FIXED_PRIORITY = 100;
const FIXED_LISTEN = "mention" as const;

async function responseErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return `${fallback}: ${res.status}`;
  try {
    const payload = JSON.parse(text) as { error?: unknown; message?: unknown };
    const detail = typeof payload.error === "string" ? payload.error
      : typeof payload.message === "string" ? payload.message : "";
    return detail ? `${fallback}: ${detail}` : `${fallback}: ${res.status}`;
  } catch { return `${fallback}: ${text}`; }
}

interface WebexRouteDraft {
  agentId: string;
}

function emptyRouteDraft(): WebexRouteDraft {
  return { agentId: "" };
}

function routeToDraft(route: ItemAgentRoute): WebexRouteDraft {
  return { agentId: route.agent_id };
}

function draftErrors(draft: WebexRouteDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.agentId.trim()) errors.agentId = "Choose a Dynamic Agent.";
  return errors;
}

function WebexRouteEditorDialog({
  open,
  onOpenChange,
  selected,
  dynamicAgents,
  onSaved,
  disabled,
  loading,
  setLoading,
  selectedCanManage,
  editingRoute,
  routesFor,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: ItemSummary;
  dynamicAgents: DynamicAgentOption[];
  onSaved: (routes: ItemAgentRoute[]) => Promise<void> | void;
  disabled: boolean;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  selectedCanManage: boolean;
  editingRoute: ItemAgentRoute | null;
  routesFor: (workspaceId: string, itemId: string, identityId?: string) => string;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<WebexRouteDraft>(emptyRouteDraft());
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const validationErrors = draftErrors(draft);
  const visibleErrors = submitAttempted ? validationErrors : {};
  const hasErrors = Object.keys(validationErrors).length > 0;
  const formDisabled = disabled || !selectedCanManage;
  const agentOptions = dynamicAgents.map<AgentPickerOption>((agent) => ({
    value: agent._id,
    label: agent.name || agent._id,
  }));

  useEffect(() => {
    if (open) {
      setDraft(editingRoute ? routeToDraft(editingRoute) : emptyRouteDraft());
      setSubmitAttempted(false);
    }
  }, [editingRoute, open]);

  const saveRoute = async () => {
    const agentId = draft.agentId.trim();
    if (!agentId || hasErrors) return;
    setLoading(true);
    try {
      const nextRoute: ItemAgentRoute = {
        agent_id: agentId,
        enabled: true,
        priority: FIXED_PRIORITY,
        users: { enabled: true, listen: FIXED_LISTEN },
      };
      const res = await fetch(routesFor(selected.workspace_id, selected.item_id, selected.bot_id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes: [nextRoute] }),
      });
      if (!res.ok) throw new Error(await responseErrorMessage(res, "Failed to save Webex space agent"));
      const payload = await res.json();
      const savedRoutes = (payload.data?.routes ?? payload.routes ?? []) as ItemAgentRoute[];
      await onSaved(savedRoutes);
      onOpenChange(false);
      toast(editingRoute ? "Webex space agent updated." : "Webex space agent added.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save Webex space agent", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editingRoute ? `Edit agent:${editingRoute.agent_id}` : `Add Agent${selected ? ` to ${selected.item_name || selected.item_id}` : ""}`}</DialogTitle>
          <DialogDescription>Configure how this Webex space routes messages to a Dynamic Agent.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="webex-route-agent-id" className="block">Dynamic Agent</Label>
            <AgentPicker
              id="webex-route-agent-id"
              ariaLabel="Dynamic Agent"
              value={draft.agentId}
              onChange={(value) => setDraft((prev) => ({ ...prev, agentId: value }))}
              disabled={formDisabled || agentOptions.length === 0}
              placeholder={dynamicAgents.length === 0 ? "No enabled Dynamic Agents found" : "Select Dynamic Agent"}
              options={agentOptions}
              triggerClassName={cn("h-10", visibleErrors.agentId && "border-destructive focus:ring-destructive")}
            />
            {visibleErrors.agentId && <p className="text-xs text-destructive">{visibleErrors.agentId}</p>}
          </div>
        </div>
        <DialogFooter className="border-t pt-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>Cancel</Button>
          <Button type="button" onClick={() => { setSubmitAttempted(true); if (!hasErrors) void saveRoute(); }} disabled={formDisabled || loading}>
            {loading ? "Saving..." : editingRoute ? "Update Agent" : "Add Agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WebexConfiguredSpaceDelete({
  item,
  routeCount,
  disabled,
  loading,
  selectedCanManage,
  setLoading,
  onRefresh,
  onDeselect,
}: {
  item: ItemSummary;
  routeCount: number;
  disabled: boolean;
  loading: boolean;
  selectedCanManage: boolean;
  setLoading: (loading: boolean) => void;
  onRefresh: () => Promise<void> | void;
  onDeselect: () => void;
}) {
  const { toast } = useToast();
  const appName = getConfig("appName");
  const [open, setOpen] = useState(false);
  const label = item.item_name || item.item_id;

  const deleteSpace = async () => {
    setLoading(true);
    try {
      const url = `/api/admin/webex/spaces/${encodeURIComponent(item.workspace_id)}/${encodeURIComponent(item.item_id)}`;
      const params = new URLSearchParams({ bot_id: item.bot_id ?? "" });
      const res = await fetch(`${url}?${params.toString()}`, { method: "DELETE" });
      if (!res.ok) {
        throw new Error(await responseErrorMessage(res, "Failed to delete Webex space"));
      }
      setOpen(false);
      onDeselect();
      toast(`Removed ${label} from ${appName}.`, "success");
      await onRefresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Failed to delete Webex space", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-destructive">Danger zone</div>
          <p className="text-sm text-muted-foreground">
            Remove this space&apos;s team assignment, agent routes, and access rules.
          </p>
        </div>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => setOpen(true)}
          disabled={disabled || !selectedCanManage || loading}
          aria-label={`Delete space ${label}`}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          Delete space
        </Button>
      </div>

      <Dialog open={open} onOpenChange={(nextOpen) => { if (!loading) setOpen(nextOpen); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete space from {appName}?</DialogTitle>
            <DialogDescription>
              This permanently removes everything {appName} stores for {label}. It does not remove the bot from Webex.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>The following are deleted:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>{item.team_slug ? `The team:${item.team_slug} assignment.` : "Any saved team assignment."}</li>
              <li>{routeCount > 0 ? `${routeCount} agent route${routeCount === 1 ? "" : "s"}.` : "All agent routes."}</li>
              <li>All saved access rules for this space.</li>
            </ul>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={loading}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={() => void deleteSpace()} disabled={loading}>
              {loading ? "Deleting..." : "Delete space"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function WebexConfiguredSpaceDetail({
  selected,
  routes,
  dynamicAgents,
  teams,
  disabled,
  loading,
  setLoading,
  selectedCanManage,
  onRefresh,
  onDeselect,
  routesFor,
  listApi,
}: {
  selected: ItemSummary;
  routes: ItemAgentRoute[];
  dynamicAgents: DynamicAgentOption[];
  teams: TeamOption[];
  disabled: boolean;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  selectedCanManage: boolean;
  onRefresh: (routes?: ItemAgentRoute[]) => Promise<void> | void;
  onDeselect: () => void;
  routesFor: (workspaceId: string, itemId: string, identityId?: string) => string;
  listApi: string;
}) {
  const { toast } = useToast();
  const [editorOpen, setEditorOpen] = useState(false);
  const [routePendingDelete, setRoutePendingDelete] = useState<ItemAgentRoute | null>(null);
  const label = selected.item_name || selected.item_id;
  // Webex enforces at most one route per bot per space server-side.
  const route = routes[0] ?? null;

  const setSpaceTeam = async (teamSlug: string) => {
    if (!teamSlug) return;
    setLoading(true);
    try {
      const url = `${listApi}/${encodeURIComponent(selected.workspace_id)}/${encodeURIComponent(selected.item_id)}/team`;
      const params = new URLSearchParams({ bot_id: selected.bot_id ?? "" });
      const res = await fetch(`${url}?${params.toString()}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team_slug: teamSlug, space_name: selected.item_name || selected.item_id }),
      });
      if (!res.ok) throw new Error(await responseErrorMessage(res, "Failed to update Webex space team"));
      toast("Webex space team updated.", "success");
      await onRefresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update Webex space team", "error");
    } finally {
      setLoading(false);
    }
  };

  const deleteRouteConfirmed = async () => {
    if (!routePendingDelete) return;
    setLoading(true);
    try {
      const res = await fetch(routesFor(selected.workspace_id, selected.item_id, selected.bot_id), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: routePendingDelete.agent_id }),
      });
      if (!res.ok) throw new Error(await responseErrorMessage(res, "Failed to remove Webex space agent"));
      setRoutePendingDelete(null);
      toast("Webex space agent removed.", "success");
      await onRefresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to remove Webex space agent", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-background/60 p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Team</div>
            <p className="text-sm text-muted-foreground">Assign a team so this space can be managed and shown to the right admins.</p>
          </div>
          {selected.team_slug ? <Badge variant="secondary">team:{selected.team_slug}</Badge> : <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">no team</Badge>}
        </div>
        <TeamPicker
          value={selected.team_slug ?? ""}
          onChange={(teamSlug) => void setSpaceTeam(teamSlug)}
          disabled={disabled || !selectedCanManage || loading || teams.length === 0}
          placeholder={teams.length === 0 ? "No teams configured" : "Select team"}
          searchPlaceholder="Search teams..."
          ariaLabel={`Team for ${label}`}
          options={teams.map<TeamPickerOption>((team) => ({ slug: team.slug, name: team.name || team.slug, id: team.id, _id: team._id }))}
        />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agent</div>
            <p className="text-sm text-muted-foreground">{route ? `agent:${route.agent_id} responds in ${label}.` : `No agent responds in ${label} yet.`}</p>
          </div>
          {!route && (
            <Button type="button" size="sm" onClick={() => setEditorOpen(true)} disabled={disabled || !selectedCanManage || loading}>Add Agent</Button>
          )}
        </div>
        {!route ? (
          <div className="rounded-md border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">Add an agent to let this space respond to Webex messages.</div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2 text-sm">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">agent:{route.agent_id}</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setEditorOpen(true)} disabled={disabled || !selectedCanManage || loading} aria-label={`Edit agent:${route.agent_id}`}>Edit</Button>
              <Button type="button" variant="destructive" size="sm" onClick={() => setRoutePendingDelete(route)} disabled={disabled || !selectedCanManage || loading} aria-label={`Delete agent:${route.agent_id}`}>Delete</Button>
            </div>
          </div>
        )}
      </div>

      <WebexConfiguredSpaceDelete
        item={selected}
        routeCount={routes.length}
        disabled={disabled}
        loading={loading}
        selectedCanManage={selectedCanManage}
        setLoading={setLoading}
        onRefresh={onRefresh}
        onDeselect={onDeselect}
      />

      <WebexRouteEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        selected={selected}
        dynamicAgents={dynamicAgents}
        onSaved={onRefresh}
        disabled={disabled}
        loading={loading}
        setLoading={setLoading}
        selectedCanManage={selectedCanManage}
        editingRoute={route}
        routesFor={routesFor}
      />

      <Dialog open={Boolean(routePendingDelete)} onOpenChange={(open) => { if (!open && !loading) setRoutePendingDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove agent from space?</DialogTitle>
            <DialogDescription>{routePendingDelete ? `This removes agent:${routePendingDelete.agent_id} from the selected Webex space.` : "This removes the selected agent from the Webex space."}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRoutePendingDelete(null)} disabled={loading}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={() => void deleteRouteConfirmed()} disabled={loading}>{loading ? "Removing..." : "Remove agent"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
