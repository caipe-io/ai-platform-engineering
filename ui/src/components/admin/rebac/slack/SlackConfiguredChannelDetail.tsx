"use client";

import { HelpCircle } from "lucide-react";
import { useEffect,useState } from "react";

import { PromptEditorWorkbench,type PromptSuggestRequest } from "@/components/prompt/PromptEditorWorkbench";
import { AgentPicker,type AgentPickerOption } from "@/components/ui/agent-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { TeamPicker,type TeamPickerOption } from "@/components/ui/team-picker";
import { useToast } from "@/components/ui/toast";
import { Tooltip,TooltipContent,TooltipTrigger } from "@/components/ui/tooltip";
import { getConfig } from "@/lib/config";
import { cn } from "@/lib/utils";
import type { DynamicAgentOption,ItemAgentRoute,ItemSummary,TeamOption,SlackRouteExecutionIdentity } from "../connector-admin-adapter";
import { SlackEmojiCombobox } from "./SlackEmojiCombobox";
import { SlackUserTokenInput } from "./SlackUserTokenInput";
import { ServiceAccountSelect } from "./ServiceAccountSelect";
import {
DEFAULT_OVERTHINK_SKIP_MARKERS,
draftToRoute,
emptyRouteDraft,
routeDraftErrorMap,
routeToDraft,
type ListenMode,
type RouteDraft,
type RouteEscalationDraft,
type RouteSideDraft,
} from "./slack-route-draft";
import type { SlackRouteExecutionMode } from "@/types/slack-rebac";

function HelpTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={`Help: ${label}`} className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs whitespace-normal break-words text-xs">{children}</TooltipContent>
    </Tooltip>
  );
}

function RouteEditorSection({ title, description, enabled, onToggle, disabled, children }: {
  title: string;
  description?: React.ReactNode;
  enabled?: boolean;
  onToggle?: (value: boolean) => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const hasToggle = typeof enabled === "boolean" && onToggle;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <span>{title}</span>
          {description && <HelpTooltip label={title}>{description}</HelpTooltip>}
        </div>
        {hasToggle && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={enabled} disabled={disabled} onChange={(event) => onToggle(event.target.checked)} />
            Enabled
          </label>
        )}
      </div>
      {(!hasToggle || enabled) && <div className="space-y-3">{children}</div>}
    </div>
  );
}

function FollowupPromptEditor({ value, onChange, disabled, channelName, agentId, model }: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  channelName?: string;
  agentId?: string;
  model?: { id?: string; provider?: string };
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  const suggest = async ({ instruction, enhanceExisting, style }: PromptSuggestRequest) => {
    if (!model?.id || !model.provider) return;
    const res = await fetch("/api/dynamic-agents/assistant/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        field: "slack_followup_prompt",
        context: {
          name: agentId ? `Slack route for ${agentId}` : "Slack route",
          slack_channel_name: channelName,
          slack_agent_id: agentId,
          ...(enhanceExisting && draft.trim() ? { followup_prompt: draft } : {}),
        },
        model: { id: model.id, provider: model.provider },
        ...(instruction ? { instruction } : {}),
        prompt_style: style,
      }),
    });
    const payload = await res.json();
    if (!res.ok || !payload.success) throw new Error(payload?.error || "Failed to generate follow-up prompt");
    return payload.data?.content ?? payload.content;
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Label>Follow-up prompt</Label>
        <HelpTooltip label="Follow-up prompt">Used after overthink skips a Slack reply. If a user later explicitly follows up in that thread, this text is prepended to the agent context so it can answer with the earlier skipped reasoning in mind.</HelpTooltip>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-3 py-2">
        <div className="min-w-0 text-sm">
          {value.trim() ? <span className="line-clamp-1 text-muted-foreground">{value.trim()}</span> : <span className="text-muted-foreground">No follow-up prompt configured</span>}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => { setDraft(value); setOpen(true); }} disabled={disabled}>
          {value.trim() ? "Edit prompt" : "Write prompt"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Optional prompt prepended on humble follow-ups.</p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit follow-up prompt</DialogTitle>
            <DialogDescription>Write the prompt in a larger editor. AI Suggest will tailor the text for this Slack route.</DialogDescription>
          </DialogHeader>
          <PromptEditorWorkbench
            id="slack-followup-prompt"
            label="Follow-up prompt"
            value={draft}
            onChange={setDraft}
            placeholder="When confidence is low, briefly explain uncertainty and ask one clarifying question before proceeding..."
            height={420}
            onSuggest={suggest}
            suggestDisabled={!model?.id || !model.provider}
            suggestTitle={!model?.id || !model.provider ? "Select an agent with model metadata before using AI Suggest" : "Generate follow-up prompt with AI"}
            suggestInstructionLabel="What should this Slack follow-up prompt cover?"
            suggestInstructionPlaceholder="e.g., Ask one clarifying question before escalating..."
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" onClick={() => { onChange(draft); setOpen(false); }}>Apply prompt</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RouteSideEditor({ title, side, enabled, onToggleEnabled, onChange, listLabel, listPlaceholder, disabled, channelName, agentId, model, error, lookupKind = "all" }: {
  title: string;
  side: RouteSideDraft;
  enabled: boolean;
  onToggleEnabled: (v: boolean) => void;
  onChange: (next: RouteSideDraft) => void;
  listLabel: string;
  listPlaceholder: string;
  disabled: boolean;
  channelName?: string;
  agentId?: string;
  model?: { id?: string; provider?: string };
  error?: string;
  lookupKind?: "all" | "bots";
}) {
  const idBase = `route-side-${title.toLowerCase()}`;
  return (
    <RouteEditorSection
      title={`Respond to ${title}`}
      description={title === "Users" ? "Controls how this agent handles Slack messages from people." : "Controls how this agent handles messages posted by Slack apps or bots."}
      enabled={enabled}
      onToggle={onToggleEnabled}
      disabled={disabled}
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idBase}-listen`}>Listen</Label>
          <Select id={`${idBase}-listen`} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={side.listen} disabled={disabled} onChange={(e) => onChange({ ...side, listen: e.target.value as ListenMode })}>
            <option value="mention">mention</option>
            <option value="message">message</option>
            <option value="all">all</option>
          </Select>
        </div>
        <SlackUserTokenInput label={listLabel} value={side.allowList} disabled={disabled} placeholder={listPlaceholder} kind={lookupKind} onChange={(next) => onChange({ ...side, allowList: next })} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={side.overthinkEnabled} disabled={disabled} onChange={(e) => onChange({ ...side, overthinkEnabled: e.target.checked })} />
        Overthink (re-evaluate before replying)
      </label>
      {side.overthinkEnabled && (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={`${idBase}-skip`}>Skip markers</Label>
              <HelpTooltip label={`${title} skip markers`}>If the agent&apos;s final response contains one of these bracketed markers, for example <code>[DEFER]</code> or <code>[LOW_CONFIDENCE]</code>, the Slack bot does not post the response. You likely do not need to change these defaults.</HelpTooltip>
            </div>
            <Input id={`${idBase}-skip`} value={side.overthinkSkipMarkers} disabled={disabled} className={cn(error && "border-destructive focus-visible:ring-destructive")} placeholder={DEFAULT_OVERTHINK_SKIP_MARKERS} onChange={(e) => onChange({ ...side, overthinkSkipMarkers: e.target.value })} />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <p className="text-xs text-muted-foreground">Default: {DEFAULT_OVERTHINK_SKIP_MARKERS}. You likely do not need to change this.</p>
          </div>
          <FollowupPromptEditor value={side.overthinkFollowupPrompt} disabled={disabled} channelName={channelName} agentId={agentId} model={model} onChange={(next) => onChange({ ...side, overthinkFollowupPrompt: next })} />
        </div>
      )}
    </RouteEditorSection>
  );
}

function EscalationEditor({ enabled, onToggleEnabled, escalation, onChange, disabled, errors = {} }: {
  enabled: boolean;
  onToggleEnabled: (v: boolean) => void;
  escalation: RouteEscalationDraft;
  onChange: (next: RouteEscalationDraft) => void;
  disabled: boolean;
  errors?: Record<string, string | undefined>;
}) {
  return (
    <RouteEditorSection title="Escalation (“Get help” button)" description="Get Help is a button that appears after a user gives the Forge response a thumbs down." enabled={enabled} onToggle={onToggleEnabled} disabled={disabled}>
      <div className="space-y-4">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={escalation.victoropsEnabled} disabled={disabled} onChange={(e) => onChange({ ...escalation, victoropsEnabled: e.target.checked })} />
            VictorOps on-call paging
          </label>
          {escalation.victoropsEnabled && (
            <div className="space-y-1.5">
              <Label htmlFor="route-esc-vo-team">VictorOps team</Label>
              <Input id="route-esc-vo-team" value={escalation.victoropsTeam} disabled={disabled} className={cn(errors.victoropsTeam && "border-destructive focus-visible:ring-destructive")} placeholder="e.g. dao" onChange={(e) => onChange({ ...escalation, victoropsTeam: e.target.value })} />
              {errors.victoropsTeam && <p className="text-xs text-destructive">{errors.victoropsTeam}</p>}
            </div>
          )}
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={escalation.emojiEnabled} disabled={disabled} onChange={(e) => onChange({ ...escalation, emojiEnabled: e.target.checked })} />
            Emoji reaction
          </label>
          {escalation.emojiEnabled && <SlackEmojiCombobox value={escalation.emojiName} disabled={disabled} error={errors.emojiName} onChange={(next) => onChange({ ...escalation, emojiName: next })} />}
        </div>
        <SlackUserTokenInput label="Ping users" value={escalation.users} disabled={disabled} placeholder="Search Slack users or paste U012ABC" onChange={(next) => onChange({ ...escalation, users: next })} />
        <SlackUserTokenInput label="Delete admins" value={escalation.deleteAdmins} disabled={disabled} placeholder="Search Slack users or paste U012ABC" onChange={(next) => onChange({ ...escalation, deleteAdmins: next })} />
      </div>
      {errors.escalation && <p className="text-xs text-destructive">{errors.escalation}</p>}
    </RouteEditorSection>
  );
}

/**
 * "Run as" selector shown inside the per-route editor dialog.
 * Shows a User radio (default) and a Service Account radio. When Service Account
 * is chosen, shows a picker of active SAs owned by the channel's owning team.
 * In both modes the effective permissions are the intersection of the chosen
 * identity's permissions and the agent's permissions.
 */
function ExecutionIdentitySelector({
  mode,
  serviceAccountSub,
  serviceAccountName,
  onModeChange,
  onServiceAccountChange,
  teamSlug,
  disabled,
  error,
}: {
  mode: SlackRouteExecutionMode;
  serviceAccountSub: string;
  serviceAccountName: string;
  onModeChange: (mode: SlackRouteExecutionMode) => void;
  onServiceAccountChange: (sub: string, name: string) => void;
  teamSlug?: string;
  disabled: boolean;
  error?: string;
}) {
  return (
    <div className="space-y-3">
      <div className="text-sm font-medium">Run as</div>
      <div className="space-y-3">
        <div className="flex flex-col gap-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="execution-mode"
              value="obo_user"
              checked={mode === "obo_user"}
              disabled={disabled}
              onChange={() => onModeChange("obo_user")}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span>User</span>
              <span className="text-xs text-muted-foreground">
                Permissions are the intersection of the user&apos;s permissions and the agent&apos;s permissions.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="execution-mode"
              value="service_account"
              checked={mode === "service_account"}
              disabled={disabled}
              onChange={() => onModeChange("service_account")}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span>Service Account</span>
              <span className="text-xs text-muted-foreground">
                Permissions are the intersection of the service account&apos;s permissions and the agent&apos;s permissions.
              </span>
            </span>
          </label>
        </div>

        {mode === "service_account" && (
          <div className="pl-5">
            <ServiceAccountSelect
              value={serviceAccountSub}
              onChange={onServiceAccountChange}
              teamSlug={teamSlug}
              displayName={serviceAccountName}
              disabled={disabled}
              error={error}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function SlackRouteEditorDialog({
  open,
  onOpenChange,
  selected,
  dynamicAgents,
  routes,
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
  selected: ItemSummary | undefined;
  dynamicAgents: DynamicAgentOption[];
  routes: ItemAgentRoute[];
  onSaved: (routes: ItemAgentRoute[]) => Promise<void> | void;
  disabled: boolean;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  selectedCanManage: boolean;
  editingRoute: ItemAgentRoute | null;
  routesFor: (workspaceId: string, itemId: string) => string;
}) {
  const { toast } = useToast();
  const [routeDraft, setRouteDraft] = useState<RouteDraft>(emptyRouteDraft());
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const selectedAgent = dynamicAgents.find((agent) => agent._id === routeDraft.agentId);
  const validationErrors = routeDraftErrorMap(routeDraft);
  const visibleErrors = submitAttempted ? validationErrors : {};
  const hasErrors = Object.keys(validationErrors).length > 0;
  const formDisabled = disabled || !selectedCanManage;
  // One route per agent per channel (the route store upserts on agent_id), so
  // hide agents that already have a route. The agent being edited stays in the
  // list so it shows as selected and can be swapped for any free agent.
  const takenAgentIds = new Set(
    routes.filter((route) => route.agent_id !== editingRoute?.agent_id).map((route) => route.agent_id),
  );
  const agentOptions = dynamicAgents
    .filter((agent) => !takenAgentIds.has(agent._id))
    .map<AgentPickerOption>((agent) => ({ value: agent._id, label: agent.name || agent._id }));

  useEffect(() => {
    if (open) {
      setRouteDraft(editingRoute ? routeToDraft(editingRoute) : emptyRouteDraft());
      setSubmitAttempted(false);
    }
  }, [editingRoute, open]);

  const saveRoute = async () => {
    const agentId = routeDraft.agentId.trim();
    if (!selected || !agentId) return;
    if (hasErrors) return;
    setLoading(true);
    try {
      const nextRoutes: ItemAgentRoute[] = [
        ...routes.filter((route) => route.agent_id !== agentId && route.agent_id !== editingRoute?.agent_id),
        draftToRoute(routeDraft),
      ];
      const res = await fetch(routesFor(selected.workspace_id, selected.item_id), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes: nextRoutes }),
      });
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      const savedRoutes = (payload.data?.routes ?? payload.routes ?? []) as ItemAgentRoute[];
      await onSaved(savedRoutes);
      onOpenChange(false);
      toast(editingRoute ? "Slack channel agent updated." : "Slack channel agent added.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save Slack channel agent", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[85vh] max-h-[720px] max-w-5xl grid-rows-[auto_minmax(0,1fr)] overflow-visible">
        <DialogHeader>
          <DialogTitle>{editingRoute ? `Edit agent:${editingRoute.agent_id}` : `Add Agent${selected ? ` to ${selected.item_name || selected.item_id}` : ""}`}</DialogTitle>
          <DialogDescription>Configure how this Slack channel routes messages to a Dynamic Agent. Optional response and escalation settings stay hidden until enabled.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 overflow-y-auto">
          <section className="space-y-3">
            <div className="max-w-48 space-y-2">
              <Label htmlFor="connector-route-priority" className="block">Priority</Label>
              <Input id="connector-route-priority" type="number" value={routeDraft.priority} className={cn(visibleErrors.priority && "border-destructive focus-visible:ring-destructive")} onChange={(event) => setRouteDraft((prev) => ({ ...prev, priority: Number(event.target.value) }))} disabled={formDisabled} />
              {visibleErrors.priority && <p className="text-xs text-destructive">{visibleErrors.priority}</p>}
            </div>
          </section>
          <div className="border-t" />
          <section className="space-y-3">
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="connector-route-agent-id" className="block">Dynamic Agent</Label>
                <AgentPicker
                  id="connector-route-agent-id"
                  ariaLabel="Dynamic Agent"
                  value={routeDraft.agentId}
                  onChange={(value) => setRouteDraft((prev) => ({ ...prev, agentId: value }))}
                  disabled={formDisabled || agentOptions.length === 0}
                  placeholder={dynamicAgents.length === 0 ? "No enabled Dynamic Agents found" : agentOptions.length === 0 ? "All Dynamic Agents already added" : "Select Dynamic Agent"}
                  options={agentOptions}
                  triggerClassName={cn("h-10", visibleErrors.agentId && "border-destructive focus:ring-destructive")}
                />
                {visibleErrors.agentId && <p className="text-xs text-destructive">{visibleErrors.agentId}</p>}
              </div>
              <ExecutionIdentitySelector
                mode={routeDraft.executionMode}
                serviceAccountSub={routeDraft.executionServiceAccountSub}
                serviceAccountName={routeDraft.executionServiceAccountName}
                onModeChange={(mode) =>
                  setRouteDraft((prev) => ({
                    ...prev,
                    executionMode: mode,
                    // Clear SA fields when switching back to user mode
                    ...(mode === "obo_user"
                      ? { executionServiceAccountSub: "", executionServiceAccountName: "" }
                      : {}),
                  }))
                }
                onServiceAccountChange={(sub, name) =>
                  setRouteDraft((prev) => ({
                    ...prev,
                    executionServiceAccountSub: sub,
                    executionServiceAccountName: name,
                  }))
                }
                teamSlug={selected?.team_slug}
                disabled={formDisabled}
                error={visibleErrors.executionServiceAccountSub}
              />
            </div>
          </section>
          <div className="border-t" />
          <section className="space-y-3">
            <div className="flex items-center gap-1.5">
              <h4 className="text-sm font-semibold">Responding</h4>
              <HelpTooltip label="Responding">Configure whether this agent handles user messages, bot messages, or both.</HelpTooltip>
            </div>
            <div className="space-y-5">
              {visibleErrors.responding && <p className="text-xs text-destructive">{visibleErrors.responding}</p>}
              <RouteSideEditor title="Users" side={routeDraft.users} enabled={routeDraft.usersEnabled} onToggleEnabled={(value) => setRouteDraft((prev) => ({ ...prev, usersEnabled: value }))} onChange={(next) => setRouteDraft((prev) => ({ ...prev, users: next }))} listLabel="Only these Slack users" listPlaceholder="Search Slack users or paste U012ABC" disabled={formDisabled} channelName={selected?.item_name || selected?.item_id} agentId={routeDraft.agentId} model={selectedAgent?.model} error={visibleErrors.usersSkipMarkers} />
              <RouteSideEditor title="Bots" side={routeDraft.bots} enabled={routeDraft.botsEnabled} onToggleEnabled={(value) => setRouteDraft((prev) => ({ ...prev, botsEnabled: value }))} onChange={(next) => setRouteDraft((prev) => ({ ...prev, bots: next }))} listLabel="Only these Slack bots" listPlaceholder="Search Slack bot users or paste an ID" disabled={formDisabled} lookupKind="bots" channelName={selected?.item_name || selected?.item_id} agentId={routeDraft.agentId} model={selectedAgent?.model} error={visibleErrors.botsSkipMarkers} />
            </div>
          </section>
          <div className="border-t" />
          <section className="space-y-3">
            <h4 className="text-sm font-semibold">Escalation</h4>
            <EscalationEditor enabled={routeDraft.escalationEnabled} onToggleEnabled={(value) => setRouteDraft((prev) => ({ ...prev, escalationEnabled: value }))} escalation={routeDraft.escalation} onChange={(next) => setRouteDraft((prev) => ({ ...prev, escalation: next }))} disabled={formDisabled} errors={visibleErrors} />
          </section>
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

function routeSummaryBadges(route: ItemAgentRoute): string[] {
  const badges: string[] = [];
  if (route.users && route.users.enabled !== false) badges.push(`users:${route.users.listen ?? "mention"}`);
  if (route.bots && route.bots.enabled !== false) badges.push(`bots:${route.bots.listen ?? "message"}`);
  if (route.users?.overthink?.enabled || route.bots?.overthink?.enabled) badges.push("overthink");
  const esc = route.escalation;
  if (esc && (esc.victorops?.enabled || esc.emoji?.enabled || (esc.users?.length ?? 0) > 0 || (esc.delete_admins?.length ?? 0) > 0)) badges.push("escalation");
  // Show execution identity badge when it's explicitly a service account
  const eid: SlackRouteExecutionIdentity | undefined = route.execution_identity;
  if (eid?.mode === "service_account") {
    badges.push(eid.service_account_name ? `sa:${eid.service_account_name}` : "sa");
  }
  return badges;
}

export function SlackConfiguredChannelDetail({
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
  routesFor: (workspaceId: string, itemId: string) => string;
  listApi: string;
}) {
  const appName = getConfig("appName");
  const { toast } = useToast();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRoute, setEditingRoute] = useState<ItemAgentRoute | null>(null);
  const [routePendingDelete, setRoutePendingDelete] = useState<ItemAgentRoute | null>(null);
  const [channelDeleteOpen, setChannelDeleteOpen] = useState(false);

  const setChannelTeam = async (teamSlug: string) => {
    if (!teamSlug) return;
    setLoading(true);
    try {
      const res = await fetch(`${listApi}/${encodeURIComponent(selected.workspace_id)}/${encodeURIComponent(selected.item_id)}/team`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team_slug: teamSlug, channel_name: selected.item_name || selected.item_id }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast("Slack channel team updated.", "success");
      await onRefresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to update Slack channel team", "error");
    } finally {
      setLoading(false);
    }
  };

  const deleteRouteConfirmed = async () => {
    if (!routePendingDelete) return;
    setLoading(true);
    try {
      const res = await fetch(routesFor(selected.workspace_id, selected.item_id), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: routePendingDelete.agent_id }),
      });
      if (!res.ok) throw new Error(await res.text());
      setRoutePendingDelete(null);
      toast("Slack channel agent removed.", "success");
      await onRefresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to remove Slack channel agent", "error");
    } finally {
      setLoading(false);
    }
  };

  const deleteChannelConfirmed = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${listApi}/${encodeURIComponent(selected.workspace_id)}/${encodeURIComponent(selected.item_id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await res.text());
      setChannelDeleteOpen(false);
      toast(`Removed ${selected.item_name || selected.item_id} from ${appName}.`, "success");
      // Close the detail panel before reloading so it doesn't briefly render
      // for a channel that no longer exists.
      onDeselect();
      await onRefresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to delete Slack channel", "error");
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
            <p className="text-sm text-muted-foreground">Assign a team so this channel can be managed and shown to the right admins.</p>
          </div>
          {selected.team_slug ? <Badge variant="secondary">team:{selected.team_slug}</Badge> : <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">no team</Badge>}
        </div>
        <TeamPicker value={selected.team_slug ?? ""} onChange={(teamSlug) => void setChannelTeam(teamSlug)} disabled={disabled || !selectedCanManage || loading || teams.length === 0} placeholder={teams.length === 0 ? "No teams configured" : "Select team"} searchPlaceholder="Search teams..." ariaLabel={`Team for ${selected.item_name || selected.item_id}`} options={teams.map<TeamPickerOption>((team) => ({ slug: team.slug, name: team.name || team.slug, id: team.id, _id: team._id }))} />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agents</div>
            <p className="text-sm text-muted-foreground">{routes.length > 0 ? `${routes.length} agent${routes.length === 1 ? "" : "s"} can respond in ${selected.item_name || selected.item_id}.` : `No agents can respond in ${selected.item_name || selected.item_id} yet.`}</p>
          </div>
          <Button type="button" size="sm" onClick={() => { setEditingRoute(null); setEditorOpen(true); }} disabled={disabled || !selectedCanManage || loading}>Add Agent</Button>
        </div>
        <p className="text-xs text-muted-foreground">Multiple agents can be associated with {selected.item_name}. The Slack bot picks the agent with the lowest priority number whose listen mode matches the message (mention vs. plain message).</p>
        {routes.length === 0 ? (
          <div className="rounded-md border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">Add an agent to let this channel respond to Slack messages.</div>
        ) : (
          <div className="space-y-2">
            {routes.map((route) => (
              <div key={route.agent_id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2 text-sm">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">agent:{route.agent_id}</span>
                    <Badge variant="secondary">priority {route.priority}</Badge>
                    {routeSummaryBadges(route).map((badge) => <Badge key={badge} variant="outline">{badge}</Badge>)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">Users: {route.users?.listen ?? "mention"}{route.bots ? ` · Bots: ${route.bots.listen ?? "message"}` : ""}{route.escalation ? " · Escalation enabled" : ""}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => { setEditingRoute(route); setEditorOpen(true); }} disabled={disabled || !selectedCanManage || loading} aria-label={`Edit agent:${route.agent_id}`}>Edit</Button>
                  <Button type="button" variant="destructive" size="sm" onClick={() => setRoutePendingDelete(route)} disabled={disabled || !selectedCanManage || loading} aria-label={`Delete agent:${route.agent_id}`}>Delete</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-destructive">Danger zone</div>
            <p className="text-sm text-muted-foreground">Remove this channel from {appName} entirely. Deletes its team assignment and every agent route.</p>
          </div>
          <Button type="button" variant="destructive" size="sm" onClick={() => setChannelDeleteOpen(true)} disabled={disabled || !selectedCanManage || loading} aria-label={`Delete channel ${selected.item_name || selected.item_id}`}>Delete channel</Button>
        </div>
      </div>

      <SlackRouteEditorDialog open={editorOpen} onOpenChange={setEditorOpen} selected={selected} dynamicAgents={dynamicAgents} routes={routes} onSaved={onRefresh} disabled={disabled} loading={loading} setLoading={setLoading} selectedCanManage={selectedCanManage} editingRoute={editingRoute} routesFor={routesFor} />

      <Dialog open={Boolean(routePendingDelete)} onOpenChange={(open) => { if (!open && !loading) setRoutePendingDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove agent from channel?</DialogTitle>
            <DialogDescription>{routePendingDelete ? `This removes agent:${routePendingDelete.agent_id} from the selected Slack channel.` : "This removes the selected agent from the Slack channel."}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRoutePendingDelete(null)} disabled={loading}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={() => void deleteRouteConfirmed()} disabled={loading}>{loading ? "Removing..." : "Remove agent"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={channelDeleteOpen} onOpenChange={(open) => { if (!open && !loading) setChannelDeleteOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete channel from {appName}?</DialogTitle>
            <DialogDescription>This removes {selected.item_name || selected.item_id} and everything {appName} stores about it.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>The following are permanently deleted:</p>
            <ul className="list-disc space-y-1 pl-5">
              <li>Its team assignment{selected.team_slug ? ` (team:${selected.team_slug})` : ""}.</li>
              <li>{routes.length > 0 ? `${routes.length} agent route${routes.length === 1 ? "" : "s"}` : "All agent routes"} and their settings.</li>
              <li>All access rules for this channel.</li>
            </ul>
            <p>The Slack bot stops responding here once its route cache expires. Re-onboard the channel from the Onboard tab to set it up again.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setChannelDeleteOpen(false)} disabled={loading}>Cancel</Button>
            <Button type="button" variant="destructive" onClick={() => void deleteChannelConfirmed()} disabled={loading}>{loading ? "Deleting..." : "Delete channel"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
