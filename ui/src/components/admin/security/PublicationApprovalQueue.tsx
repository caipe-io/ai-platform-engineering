"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AccessSubjectMultiPicker,
  type AccessSubjectOption,
  type AccessSubjectRef,
} from "@/components/ui/access-subject-picker";
import {
  TeamMultiPicker,
  TeamPicker,
  type TeamPickerOption,
} from "@/components/ui/team-picker";
import { useUrlFilterParams } from "@/hooks/use-url-filter-params";
import { cn } from "@/lib/utils";
import type {
  PublicationApprovalSettings,
  PublicationRequestDocument,
} from "@/types/publication-approval";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  Hash,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Trash2,
  Video,
  X,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import React from "react";

interface PublicationApprovalQueueProps {
  readOnly?: boolean;
}

interface Summary {
  pending_count: number;
  requester_pending_count: number;
  can_approve: boolean;
  can_manage_settings: boolean;
}

interface PaginationState {
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

const EMPTY_SETTINGS: PublicationApprovalSettings = {
  require_rag_publication_approval: true,
  require_slack_onboarding_approval: true,
  require_webex_onboarding_approval: true,
  allow_organization_wide_self_approval: false,
  trusted_publishers_bypass: true,
  trusted_publisher_subjects: [],
  trusted_publisher_team_slugs: [],
  organization_wide_team_slugs: ["everyone"],
  rag_reviewer_team_slugs: [],
  rag_reviewer_user_subjects: [],
  slack_reviewer_team_slugs: [],
  slack_reviewer_user_subjects: [],
  webex_reviewer_team_slugs: [],
  webex_reviewer_user_subjects: [],
  rag_reviewer_team_delegations: {},
  rag_reviewer_user_delegations: {},
  thresholds: {
    slack_channel_members_without_approval: 0,
    webex_space_members_without_approval: 0,
  },
};

interface IntegrationStatus {
  slack: boolean;
  webex: boolean;
}

interface TeamRow {
  _id?: string;
  name?: string;
  slug?: string;
}

interface DelegationDraft {
  id: string;
  targetTeamSlug: string;
  approvers: AccessSubjectRef[];
}

interface SettingsPayload {
  settings: PublicationApprovalSettings;
  integrations?: Partial<IntegrationStatus>;
  users?: AccessSubjectOption[];
}

function unwrap<T>(value: unknown, key: string): T {
  const outer = value as { data?: Record<string, unknown> };
  return (outer.data?.[key] ?? (value as Record<string, unknown>)[key]) as T;
}

function kindLabel(kind: PublicationRequestDocument["resource"]["kind"]): string {
  switch (kind) {
    case "rag_datasource": return "RAG datasource";
    case "rag_collection": return "RAG collection";
    case "slack_channel": return "Slack channel";
    case "webex_space": return "Webex space";
  }
}

function actorLabel(request: PublicationRequestDocument): string {
  return request.requester.name || request.requester.email || "Unknown user";
}

function decisionLabel(request: PublicationRequestDocument): string | null {
  if (request.status === "rejected") {
    const rejectionEntry = [...request.history]
      .reverse()
      .find((entry) => entry.action === "rejected");
    const reviewer = request.decided_by ?? rejectionEntry?.actor;
    const label = reviewer?.name || reviewer?.email;
    return `Rejected by ${label || "Unknown user"}`;
  }
  if (request.status !== "approved") return null;
  if (request.history.some((entry) => entry.action === "auto_approved")) {
    return "Approved automatically by policy";
  }
  const approvalEntry = [...request.history]
    .reverse()
    .find((entry) => entry.action === "approved");
  const approver = request.decided_by ?? approvalEntry?.actor;
  const label = approver?.name || approver?.email;
  return `Approved by ${label || "Unknown user"}`;
}

function rejectionReason(request: PublicationRequestDocument): string | null {
  if (request.status !== "rejected") return null;
  const stored = request.decision_note?.trim();
  if (stored) return stored;
  const historyEntry = [...request.history]
    .reverse()
    .find((entry) => entry.action === "rejected");
  return historyEntry?.note?.trim() || null;
}

function statusBadgeClass(status: PublicationRequestDocument["status"]): string {
  if (status === "approved") {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600";
  }
  if (status === "rejected") {
    return "border-red-500/40 bg-red-500/10 text-red-600";
  }
  if (status === "pending" || status === "applying") {
    return "border-amber-500/40 bg-amber-500/10 text-amber-600";
  }
  return "border-border bg-muted/40 text-muted-foreground";
}

function sourceChangeSummary(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Change which content this datasource includes";
  }
  const fields = new Set(Object.keys(value as Record<string, unknown>));
  if (
    fields.has("get_child_pages") ||
    fields.has("allowed_title_patterns") ||
    fields.has("denied_title_patterns")
  ) {
    return "Change which Confluence pages this datasource includes";
  }
  if (fields.has("settings")) return "Change the web crawl settings";
  if (fields.has("lookback_days") || fields.has("include_bots")) {
    return "Change which messages this datasource includes";
  }
  if (
    fields.has("jql") ||
    fields.has("include_comments") ||
    fields.has("include_links") ||
    fields.has("custom_fields")
  ) {
    return "Change which Jira content this datasource includes";
  }
  return "Change which content this datasource includes";
}

function riskReasonLabel(reason: string): string {
  if (reason === "new organization-wide audience") {
    return "Adds Search access for a company-wide audience.";
  }
  if (reason === "organization-wide audience removal") {
    return "Removes Search access from a company-wide audience.";
  }
  const teamAudience = /^(\d+) new team audience/.exec(reason);
  if (teamAudience) {
    const count = Number(teamAudience[1]);
    return `Adds Search access for ${count} ${count === 1 ? "team" : "teams"}.`;
  }
  const personAudience = /^(\d+) new person audience/.exec(reason);
  if (personAudience) {
    const count = Number(personAudience[1]);
    return `Adds Search access for ${count} ${count === 1 ? "person" : "people"}.`;
  }
  const removedSources = /^(\d+) datasource(?:s)? removed from a company-wide collection$/.exec(reason);
  if (removedSources) {
    const count = Number(removedSources[1]);
    return `Removes ${count} ${count === 1 ? "datasource" : "datasources"} from a company-wide collection.`;
  }
  if (reason === "material source change with a broad audience") {
    return "Changes what content is included in a datasource that is already widely shared.";
  }
  if (reason === "source is published through a collection") {
    return "This datasource is included in a shared collection.";
  }
  if (reason === "audience size is unknown") {
    return "The number of people who can access this channel or space could not be verified.";
  }
  const connectorMembers = /^(\d+) channel or space members$/.exec(reason);
  if (connectorMembers) {
    return `This channel or space has ${connectorMembers[1]} members.`;
  }
  if (reason === "trusted publisher") {
    return "The requester is a trusted publisher.";
  }
  return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}${reason.endsWith(".") ? "" : "."}`;
}

function requestSummary(
  request: PublicationRequestDocument,
  teamOptions: TeamPickerOption[],
): string[] {
  const teamLabel = (slug: string) =>
    teamOptions.find((team) => team.slug === slug)?.name ??
    (slug.toLowerCase() === "everyone" ? "Everyone" : slug);
  const teams = request.risk_facts.added_team_slugs ?? [];
  const removedTeams = request.risk_facts.removed_team_slugs ?? [];
  const users = request.risk_facts.added_user_subjects ?? [];
  const requested = request.requested_state;
  if (request.resource.kind === "rag_datasource" || request.resource.kind === "rag_collection") {
    const addedSources = Array.isArray(request.risk_facts.added_source_ids)
      ? request.risk_facts.added_source_ids.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const removedSources = Array.isArray(request.risk_facts.removed_source_ids)
      ? request.risk_facts.removed_source_ids.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const previousOwners = Array.isArray(
      request.risk_facts.previous_owner_team_slugs,
    )
      ? request.risk_facts.previous_owner_team_slugs.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const requestedOwners = Array.isArray(
      request.risk_facts.requested_owner_team_slugs,
    )
      ? request.risk_facts.requested_owner_team_slugs.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const ownerUpdate = requested.owner_update &&
      typeof requested.owner_update === "object" &&
      !Array.isArray(requested.owner_update)
      ? requested.owner_update as Record<string, unknown>
      : null;
    const ownerChange = ownerUpdate
      ? typeof ownerUpdate.owner_team_slug === "string"
        ? `Transfer Owner to ${teamLabel(ownerUpdate.owner_team_slug)}`
        : typeof ownerUpdate.owner_subject === "string"
          ? "Transfer Owner to a person"
          : "Transfer Owner"
      : previousOwners.join("\u0000") !== requestedOwners.join("\u0000")
        ? `Change Owner to: ${requestedOwners.map(teamLabel).join(", ") || "personal Owner"}`
        : null;
    return [
      ...(teams.length > 0 ? [`Add Search for: ${teams.map(teamLabel).join(", ")}`] : []),
      ...(removedTeams.length > 0
        ? [`Remove Search for: ${removedTeams.map(teamLabel).join(", ")}`]
        : []),
      ...(users.length > 0
        ? [`Add Search for ${users.length} ${users.length === 1 ? "person" : "people"}`]
        : []),
      ...(addedSources.length > 0
        ? [`Add ${addedSources.length} datasource${addedSources.length === 1 ? "" : "s"} to this shared collection`]
        : []),
      ...(removedSources.length > 0
        ? [`Remove ${removedSources.length} datasource${removedSources.length === 1 ? "" : "s"} from this company-wide collection`]
        : []),
      ...(requested.source_update ? [sourceChangeSummary(requested.source_update)] : []),
      ...(ownerChange ? [ownerChange] : []),
      ...(teams.length === 0 && removedTeams.length === 0 && users.length === 0 && addedSources.length === 0 && removedSources.length === 0 && !requested.source_update && !ownerChange
        ? ["Keep broad Search access after changing the Owner"]
        : []),
    ];
  }
  const targetTeam = typeof requested.team_slug === "string"
    ? teamLabel(requested.team_slug)
    : "Unknown team";
  const agent = typeof requested.agent_id === "string" ? requested.agent_id : "Unknown agent";
  return [`Owner: ${targetTeam}`, `Agent: ${agent}`];
}

function selectedSubjects(
  teamSlugs: string[],
  userSubjects: string[],
): AccessSubjectRef[] {
  return [
    ...teamSlugs.map((id) => ({ kind: "team" as const, id })),
    ...userSubjects.map((id) => ({ kind: "user" as const, id })),
  ];
}

function splitSubjects(subjects: AccessSubjectRef[]): {
  teams: string[];
  users: string[];
} {
  return {
    teams: subjects.filter((subject) => subject.kind === "team").map((subject) => subject.id),
    users: subjects.filter((subject) => subject.kind === "user").map((subject) => subject.id),
  };
}

function delegationDrafts(settings: PublicationApprovalSettings): DelegationDraft[] {
  const targets = Array.from(new Set([
    ...Object.keys(settings.rag_reviewer_team_delegations),
    ...Object.keys(settings.rag_reviewer_user_delegations),
  ])).filter((target) => target !== "*").sort();
  return targets.map((target, index) => ({
    id: `${target}-${index}`,
    targetTeamSlug: target,
    approvers: selectedSubjects(
      settings.rag_reviewer_team_delegations[target] ?? [],
      settings.rag_reviewer_user_delegations[target] ?? [],
    ),
  }));
}

function editableSettings(
  settings: PublicationApprovalSettings,
): PublicationApprovalSettings {
  return {
    ...settings,
    rag_reviewer_team_slugs: Array.from(new Set([
      ...settings.rag_reviewer_team_slugs,
      ...(settings.rag_reviewer_team_delegations["*"] ?? []),
    ])),
    rag_reviewer_user_subjects: Array.from(new Set([
      ...settings.rag_reviewer_user_subjects,
      ...(settings.rag_reviewer_user_delegations["*"] ?? []),
    ])),
  };
}

function serializedDelegations(delegations: DelegationDraft[]): {
  teams: Record<string, string[]>;
  users: Record<string, string[]>;
} {
  const teams: Record<string, string[]> = {};
  const users: Record<string, string[]> = {};
  for (const delegation of delegations) {
    if (!delegation.targetTeamSlug) continue;
    const subjects = splitSubjects(delegation.approvers);
    if (subjects.teams.length > 0) teams[delegation.targetTeamSlug] = subjects.teams;
    if (subjects.users.length > 0) users[delegation.targetTeamSlug] = subjects.users;
  }
  return { teams, users };
}

function PolicySwitch({
  checked,
  label,
  description,
  disabled = false,
  onChange,
}: {
  checked: boolean;
  label: string;
  description: string;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className={cn(
      "flex items-center justify-between gap-4 py-3",
      disabled && "text-muted-foreground",
    )}>
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
        disabled={disabled}
      />
    </div>
  );
}

function NumberSetting({
  id,
  label,
  description,
  value,
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className={cn(
      "flex items-center justify-between gap-4 py-3",
      disabled && "text-muted-foreground",
    )}>
      <div className="min-w-0">
        <Label htmlFor={id}>{label}</Label>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Input
        id={id}
        type="number"
        min={0}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(
          Math.max(0, Number.parseInt(event.target.value || "0", 10)),
        )}
        className="w-28 shrink-0"
      />
    </div>
  );
}

function SectionHelp({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Why review ${label}?`}
          >
            <CircleHelp className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="w-72 whitespace-normal leading-relaxed">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function PublicationApprovalQueue({ readOnly = false }: PublicationApprovalQueueProps) {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const setUrlParams = useUrlFilterParams();
  const linkedRequestId = searchParams.get("request");
  const linkedView = searchParams.get("view") === "history" ? "history" : "pending";
  const [view, setView] = React.useState<"pending" | "history">(linkedView);
  const [requests, setRequests] = React.useState<PublicationRequestDocument[]>([]);
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [page, setPage] = React.useState(1);
  const [pagination, setPagination] = React.useState<PaginationState>({
    page: 1,
    page_size: 20,
    total: 0,
    total_pages: 1,
  });
  const [loading, setLoading] = React.useState(true);
  const [actingId, setActingId] = React.useState<string | null>(null);
  const [rejectingId, setRejectingId] = React.useState<string | null>(null);
  const [decisionNote, setDecisionNote] = React.useState("");
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settings, setSettings] = React.useState<PublicationApprovalSettings>(EMPTY_SETTINGS);
  const [delegations, setDelegations] = React.useState<DelegationDraft[]>([]);
  const [teams, setTeams] = React.useState<TeamPickerOption[]>([]);
  const [knownUsers, setKnownUsers] = React.useState<AccessSubjectOption[]>([]);
  const [integrations, setIntegrations] = React.useState<IntegrationStatus>({
    slack: false,
    webex: false,
  });
  const [loadingSettings, setLoadingSettings] = React.useState(false);
  const [savingSettings, setSavingSettings] = React.useState(false);

  const load = React.useCallback(async (overrideLinkedRequestId = linkedRequestId) => {
    setLoading(true);
    try {
      const status = view === "pending"
        ? "pending,applying"
        : "approved,rejected,cancelled,superseded";
      const summaryResponse = await fetch("/api/publication-requests/summary");
      if (!summaryResponse.ok) throw new Error("Could not load approvals");
      const summaryBody = await summaryResponse.json();
      const loadedSummary = (summaryBody as { data?: Summary }).data ?? summaryBody as Summary;
      const mine = !loadedSummary.can_approve || Boolean(
        overrideLinkedRequestId &&
        view === "history" &&
        !loadedSummary.can_manage_settings,
      );
      const params = new URLSearchParams({
        status,
        page: String(page),
        page_size: "20",
        ...(mine ? { mine: "true" } : {}),
        ...(overrideLinkedRequestId && view === linkedView
          ? { request_id: overrideLinkedRequestId }
          : {}),
      });
      const requestsResponse = await fetch(`/api/publication-requests?${params.toString()}`);
      if (!requestsResponse.ok) throw new Error("Could not load approvals");
      const requestBody = await requestsResponse.json();
      const loadedRequests = unwrap<PublicationRequestDocument[]>(requestBody, "requests") ?? [];
      setRequests(loadedRequests);
      const loadedPagination = unwrap<PaginationState>(requestBody, "pagination");
      const nextPagination = loadedPagination ?? {
        page,
        page_size: 20,
        total: loadedRequests.length,
        total_pages: 1,
      };
      setPagination(nextPagination);
      if (nextPagination.page !== page) setPage(nextPagination.page);
      if (overrideLinkedRequestId && loadedRequests.some((item) => item._id === overrideLinkedRequestId)) {
        setExpandedId(overrideLinkedRequestId);
      }
      setSummary({
        pending_count: loadedSummary.pending_count ?? 0,
        requester_pending_count: loadedSummary.requester_pending_count ?? 0,
        can_approve: loadedSummary.can_approve ?? false,
        can_manage_settings: loadedSummary.can_manage_settings ?? false,
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not load approvals", "error");
    } finally {
      setLoading(false);
    }
  }, [linkedRequestId, linkedView, page, toast, view]);

  React.useEffect(() => {
    setView(linkedView);
    setPage(1);
  }, [linkedView]);

  React.useEffect(() => { void load(); }, [load]);

  React.useEffect(() => {
    if (!settingsOpen || !summary?.can_manage_settings) return;
    setLoadingSettings(true);
    void Promise.all([
      fetch("/api/publication-requests/settings"),
      fetch("/api/dynamic-agents/teams"),
    ])
      .then(async ([settingsResponse, teamsResponse]) => {
        if (!settingsResponse.ok) throw new Error("Could not load approval settings");
        const settingsBody = await settingsResponse.json() as {
          data?: SettingsPayload;
        } & Partial<SettingsPayload>;
        const payload = settingsBody.data ?? settingsBody as SettingsPayload;
        const value = editableSettings(payload.settings);
        setSettings(value);
        setDelegations(delegationDrafts(value));
        setIntegrations({
          slack: payload.integrations?.slack === true,
          webex: payload.integrations?.webex === true,
        });
        setKnownUsers(Array.isArray(payload.users) ? payload.users : []);

        if (teamsResponse.ok) {
          const teamsBody = await teamsResponse.json() as {
            success?: boolean;
            data?: TeamRow[];
          };
          setTeams((teamsBody.data ?? []).flatMap((team) => team.slug ? [{
            slug: team.slug,
            name: team.name ?? team.slug,
            _id: team._id,
          }] : []));
        }
      })
      .catch((error) => toast(error.message, "error"))
      .finally(() => setLoadingSettings(false));
  }, [settingsOpen, summary?.can_manage_settings, toast]);

  const decide = async (id: string, decision: "approve" | "reject") => {
    setActingId(id);
    try {
      const response = await fetch(`/api/publication-requests/${encodeURIComponent(id)}/${decision}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: decisionNote }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && body?.data?.conflict) {
          const reason = body?.data?.request?.decision_note?.trim();
          throw new Error(reason || "This request changed after it was submitted and could not be approved.", {
            cause: "conflict",
          });
        }
        throw new Error(body?.error || body?.data?.error || `Could not ${decision} request`);
      }
      toast(decision === "approve" ? "Publication approved." : "Publication rejected.", "success");
      window.dispatchEvent(new Event("in-app-notifications:refresh"));
      setRejectingId(null);
      setDecisionNote("");
      if (linkedRequestId === id) {
        setUrlParams({ request: null });
        await load(null);
      } else {
        await load();
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : `Could not ${decision} request`, "error", 6000);
      if (error instanceof Error && error.cause === "conflict") {
        await load();
      }
    } finally {
      setActingId(null);
    }
  };

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      const savedDelegations = serializedDelegations(delegations);
      const response = await fetch("/api/publication-requests/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...settings,
          rag_reviewer_team_delegations: savedDelegations.teams,
          rag_reviewer_user_delegations: savedDelegations.users,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || "Could not save approval settings");
      const saved = unwrap<PublicationApprovalSettings>(body, "settings");
      setSettings(saved);
      setDelegations(delegationDrafts(saved));
      toast("Publication approval settings saved.", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save approval settings", "error");
    } finally {
      setSavingSettings(false);
    }
  };

  const setReviewers = (
    domain: "rag" | "slack" | "webex",
    subjects: AccessSubjectRef[],
  ) => {
    const selected = splitSubjects(subjects);
    setSettings((current) => {
      if (domain === "slack") {
        return {
          ...current,
          slack_reviewer_team_slugs: selected.teams,
          slack_reviewer_user_subjects: selected.users,
        };
      }
      if (domain === "webex") {
        return {
          ...current,
          webex_reviewer_team_slugs: selected.teams,
          webex_reviewer_user_subjects: selected.users,
        };
      }
      return {
        ...current,
        rag_reviewer_team_slugs: selected.teams,
        rag_reviewer_user_subjects: selected.users,
        rag_reviewer_team_delegations: Object.fromEntries(
          Object.entries(current.rag_reviewer_team_delegations).filter(
            ([target]) => target !== "*",
          ),
        ),
        rag_reviewer_user_delegations: Object.fromEntries(
          Object.entries(current.rag_reviewer_user_delegations).filter(
            ([target]) => target !== "*",
          ),
        ),
      };
    });
  };

  const setTrustedPublishers = (subjects: AccessSubjectRef[]) => {
    const selected = splitSubjects(subjects);
    setSettings((current) => ({
      ...current,
      trusted_publisher_team_slugs: selected.teams,
      trusted_publisher_subjects: selected.users,
    }));
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" /> Publication approvals
            </CardTitle>
            <CardDescription>
              Review and approve publication requests.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
            </Button>
            {summary?.can_manage_settings && !readOnly && (
              <Button variant="outline" size="sm" onClick={() => setSettingsOpen((open) => !open)}>
                <Settings2 className="mr-2 h-4 w-4" /> Policy settings
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex gap-2">
            <Button
              size="sm"
              variant={view === "pending" ? "default" : "outline"}
              onClick={() => { setView("pending"); setPage(1); }}
            >
              Pending {summary
                ? `(${summary.can_approve
                    ? summary.pending_count
                    : summary.requester_pending_count})`
                : ""}
            </Button>
            <Button
              size="sm"
              variant={view === "history" ? "default" : "outline"}
              onClick={() => { setView("history"); setPage(1); }}
            >
              History
            </Button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading approvals…
            </div>
          ) : requests.length === 0 ? (
            <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
              {view === "pending"
                ? summary?.can_approve
                  ? "No publication requests need your review."
                  : "You have no pending requests."
                : "No request history yet."}
            </div>
          ) : (
            <div className="space-y-3">
              {requests.map((item) => {
                const expanded = expandedId === item._id;
                const rejecting = rejectingId === item._id;
                const decision = decisionLabel(item);
                const rejectedBecause = rejectionReason(item);
                const approverLabels = [
                  ...item.approver_team_slugs.map(
                    (slug) => teams.find((team) => team.slug === slug)?.name ??
                      (slug.toLowerCase() === "everyone" ? "Everyone" : slug),
                  ),
                  ...(item.approver_user_subjects ?? []).map((subject) => {
                    const user = knownUsers.find((candidate) => candidate.id === subject);
                    return user?.name || user?.email || "Selected person";
                  }),
                ];
                return (
                  <div key={item._id} className="rounded-xl border border-border/80 bg-card/60 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-start gap-2 text-left"
                        onClick={() => setExpandedId(expanded ? null : item._id)}
                      >
                        {expanded
                          ? <ChevronDown className="mt-1 h-4 w-4 shrink-0" />
                          : <ChevronRight className="mt-1 h-4 w-4 shrink-0" />}
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{item.resource.label}</span>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {kindLabel(item.resource.kind)} · Requested by {actorLabel(item)} · {new Date(item.created_at).toLocaleString()}
                          </span>
                          {view === "history" && decision && (
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {decision}
                            </span>
                          )}
                          {view === "history" && rejectedBecause && (
                            <span className="mt-1 block text-xs text-red-600">
                              Reason: {rejectedBecause}
                            </span>
                          )}
                        </span>
                      </button>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={cn("capitalize", statusBadgeClass(item.status))}
                        >
                          {item.status}
                        </Badge>
                        {item.risk_facts.organization_wide && (
                          <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-600">Organization-wide</Badge>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 space-y-1 pl-6 text-sm">
                      {requestSummary(item, teams).map((line) => <p key={line}>{line}</p>)}
                    </div>

                    {expanded && (
                      <div className="mt-4 grid gap-3 border-t pt-4 text-xs sm:grid-cols-2">
                        <div>
                          <p className="font-medium text-foreground">Why approval is needed</p>
                          <ul className="mt-1 list-inside list-disc space-y-1 text-muted-foreground">
                            {(item.risk_facts.reasons ?? []).map((reason) => (
                              <li key={reason}>{riskReasonLabel(reason)}</li>
                            ))}
                            {typeof item.risk_facts.estimated_items === "number" && Number.isFinite(item.risk_facts.estimated_items) && (
                              <li>Estimated items: {item.risk_facts.estimated_items}</li>
                            )}
                            {typeof item.risk_facts.member_count === "number" && Number.isFinite(item.risk_facts.member_count) && (
                              <li>Members: {item.risk_facts.member_count}</li>
                            )}
                          </ul>
                        </div>
                        <div>
                          <p className="font-medium text-foreground">Approvers</p>
                          <p className="mt-1 text-muted-foreground">
                            {approverLabels.length > 0
                              ? approverLabels.join(", ")
                              : "Organization administrators"}
                          </p>
                        </div>
                        {item.last_error && (
                          <p className="sm:col-span-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive">
                            Last apply attempt: {item.last_error}
                          </p>
                        )}
                      </div>
                    )}

                    {item.status === "pending" && !readOnly && summary?.can_approve && (
                      <div className="mt-4 border-t pt-4">
                        {rejecting ? (
                          <div className="space-y-2">
                            <Label htmlFor={`reject-${item._id}`}>Reason for rejection</Label>
                            <Textarea
                              id={`reject-${item._id}`}
                              value={decisionNote}
                              onChange={(event) => setDecisionNote(event.target.value)}
                              placeholder="Explain what should change before resubmitting."
                              maxLength={1000}
                            />
                            <div className="flex justify-end gap-2">
                              <Button variant="ghost" onClick={() => { setRejectingId(null); setDecisionNote(""); }}>Cancel</Button>
                              <Button
                                variant="destructive"
                                disabled={!decisionNote.trim() || actingId === item._id}
                                onClick={() => void decide(item._id, "reject")}
                              >
                                {actingId === item._id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                Reject request
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" onClick={() => { setRejectingId(item._id); setDecisionNote(""); }}>
                              <X className="mr-2 h-4 w-4" /> Reject
                            </Button>
                            <Button disabled={actingId === item._id} onClick={() => void decide(item._id, "approve") }>
                              {actingId === item._id
                                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                : <Check className="mr-2 h-4 w-4" />}
                              Approve & publish
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {pagination.total_pages > 1 && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                  <p className="text-xs text-muted-foreground">
                    {pagination.total} request{pagination.total === 1 ? "" : "s"}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={loading || pagination.page <= 1}
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      Previous
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Page {pagination.page} of {pagination.total_pages}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={loading || pagination.page >= pagination.total_pages}
                      onClick={() => setPage((current) => current + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {settingsOpen && summary?.can_manage_settings && !readOnly && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Settings2 className="h-5 w-5" /> Publication policy</CardTitle>
            <CardDescription>
              Choose when publication requires review and who may approve it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {loadingSettings ? (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading policy…
              </div>
            ) : (
              <>
                <section className="overflow-hidden rounded-xl border border-border/80">
                  <div className="border-b border-border/70 bg-muted/20 px-4 py-3">
                    <h4 className="flex items-center gap-2 text-sm font-semibold">
                      <Database className="h-4 w-4 text-primary" />
                      RAG
                      <SectionHelp label="RAG publication">
                        Review prevents one person&apos;s datasource from changing everyone&apos;s search results without approval.
                      </SectionHelp>
                    </h4>
                  </div>
                  <div className="space-y-5 p-4">
                    <div>
                      <PolicySwitch
                        checked={settings.require_rag_publication_approval}
                        label="Enable review for broad sharing in RAG"
                        description="Require approval before RAG data is shared beyond its Owner."
                        onChange={(value) => setSettings((current) => ({
                          ...current,
                          require_rag_publication_approval: value,
                        }))}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Company-wide audiences</Label>
                      <p className="text-xs text-muted-foreground">
                        Sharing with these teams always requires review, even when the team is the Owner. Usually includes Everyone.
                      </p>
                      <TeamMultiPicker
                        options={teams}
                        selected={settings.organization_wide_team_slugs}
                        disabled={!settings.require_rag_publication_approval}
                        onChange={(organizationWideTeams) => setSettings((current) => ({
                          ...current,
                          organization_wide_team_slugs: organizationWideTeams,
                        }))}
                        placeholder="Select company-wide teams"
                        searchPlaceholder="Search teams..."
                        ariaLabel="Company-wide audiences"
                        hideSlugSuffix
                        maxSelections={20}
                      />
                    </div>

                    <PolicySwitch
                      checked={settings.allow_organization_wide_self_approval}
                      label="Allow self-approval for company-wide publication"
                      description="When off, another reviewer must approve. Superadmins can always approve their own requests."
                      disabled={!settings.require_rag_publication_approval}
                      onChange={(value) => setSettings((current) => ({
                        ...current,
                        allow_organization_wide_self_approval: value,
                      }))}
                    />

                    <div className="space-y-2">
                      <Label>Reviewers</Label>
                      <p className="text-xs text-muted-foreground">
                        Selected people and team members can approve RAG requests.
                      </p>
                      <AccessSubjectMultiPicker
                        selected={selectedSubjects(
                          settings.rag_reviewer_team_slugs,
                          settings.rag_reviewer_user_subjects,
                        )}
                        onChange={(subjects) => setReviewers("rag", subjects)}
                        teams={teams}
                        knownUsers={knownUsers}
                        disabled={!settings.require_rag_publication_approval}
                        placeholder="Add people or teams"
                        searchPlaceholder="Search people or teams..."
                        ariaLabel="RAG publication reviewers"
                        maxSelections={100}
                      />
                    </div>

                    <div className="space-y-3 border-t border-border/60 pt-4">
                      <PolicySwitch
                        checked={settings.trusted_publishers_bypass}
                        label="Let trusted publishers bypass review"
                        description="Selected people and teams publish immediately."
                        disabled={!settings.require_rag_publication_approval}
                        onChange={(value) => setSettings((current) => ({
                          ...current,
                          trusted_publishers_bypass: value,
                        }))}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label className="block">Trusted publishers</Label>
                      <AccessSubjectMultiPicker
                        selected={selectedSubjects(
                          settings.trusted_publisher_team_slugs,
                          settings.trusted_publisher_subjects,
                        )}
                        onChange={setTrustedPublishers}
                        teams={teams}
                        knownUsers={knownUsers}
                        disabled={!settings.require_rag_publication_approval || !settings.trusted_publishers_bypass}
                        placeholder="Add people or teams"
                        searchPlaceholder="Search people or teams..."
                        ariaLabel="Trusted publishers"
                        maxSelections={100}
                      />
                    </div>

                    <div className="space-y-3 border-t border-border/60 pt-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <Label>Team-specific reviewers</Label>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Added for that team&apos;s requests. RAG reviewers above can still approve.
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!settings.require_rag_publication_approval}
                          onClick={() => setDelegations((current) => [...current, {
                            id: `delegation-${Date.now()}-${current.length}`,
                            targetTeamSlug: "",
                            approvers: [],
                          }])}
                        >
                          <Plus className="mr-2 h-4 w-4" /> Add rule
                        </Button>
                      </div>

                      {delegations.length === 0 ? (
                        <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                          No team-specific reviewer rules.
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {delegations.map((delegation) => {
                            const selectedTargets = new Set(
                              delegations
                                .filter((candidate) => candidate.id !== delegation.id)
                                .map((candidate) => candidate.targetTeamSlug)
                                .filter(Boolean),
                            );
                            const targetOptions: TeamPickerOption[] = teams.map((team) => ({
                              ...team,
                              disabled: selectedTargets.has(team.slug),
                            }));
                            return (
                              <div
                                key={delegation.id}
                                className="grid gap-3 rounded-lg border border-border/70 p-3 lg:grid-cols-[minmax(12rem,0.8fr)_minmax(18rem,1.4fr)_auto] lg:items-end"
                              >
                                <div className="space-y-2">
                                  <Label>Requests for</Label>
                                  <TeamPicker
                                    options={targetOptions}
                                    value={delegation.targetTeamSlug}
                                    onChange={(targetTeamSlug) => setDelegations((current) => current.map(
                                      (candidate) => candidate.id === delegation.id
                                        ? { ...candidate, targetTeamSlug }
                                        : candidate,
                                    ))}
                                    disabled={!settings.require_rag_publication_approval}
                                    placeholder="Select a team"
                                    searchPlaceholder="Search teams..."
                                    ariaLabel="Publication target team"
                                    hideSlugSuffix
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label>Reviewed by</Label>
                                  <AccessSubjectMultiPicker
                                    selected={delegation.approvers}
                                    onChange={(approvers) => setDelegations((current) => current.map(
                                      (candidate) => candidate.id === delegation.id
                                        ? { ...candidate, approvers }
                                        : candidate,
                                    ))}
                                    teams={teams}
                                    knownUsers={knownUsers}
                                    disabled={!settings.require_rag_publication_approval || !delegation.targetTeamSlug}
                                    placeholder="Add people or teams"
                                    searchPlaceholder="Search people or teams..."
                                    ariaLabel="Delegated publication reviewers"
                                    maxSelections={100}
                                  />
                                </div>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  disabled={!settings.require_rag_publication_approval}
                                  aria-label="Remove reviewer rule"
                                  onClick={() => setDelegations((current) => current.filter(
                                    (candidate) => candidate.id !== delegation.id,
                                  ))}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </section>

                <section className="overflow-hidden rounded-xl border border-border/80">
                  <div className="flex items-start justify-between gap-4 border-b border-border/70 bg-muted/20 px-4 py-3">
                    <div>
                      <h4 className="flex items-center gap-2 text-sm font-semibold">
                        <Hash className="h-4 w-4 text-[#4A154B] dark:text-[#E01E5A]" />
                        Slack
                        <SectionHelp label="Slack onboarding">
                          Review lets someone confirm a channel before it is added.
                        </SectionHelp>
                      </h4>
                    </div>
                    <Badge variant="outline" className={cn(
                      integrations.slack
                        ? "border-emerald-500/40 text-emerald-600"
                        : "border-border text-muted-foreground",
                    )}>
                      {integrations.slack ? "Active" : "Not active"}
                    </Badge>
                  </div>
                  <div className="space-y-4 p-4">
                    <PolicySwitch
                      checked={settings.require_slack_onboarding_approval}
                      label="Review Slack channel onboarding"
                      description={integrations.slack
                        ? "Channels follow the member threshold below."
                        : "The Slack integration is not active."}
                      disabled={!integrations.slack}
                      onChange={(value) => setSettings((current) => ({
                        ...current,
                        require_slack_onboarding_approval: value,
                      }))}
                    />
                    <div className="space-y-2 border-t border-border/60 pt-4">
                      <Label>Reviewers</Label>
                      <p className="text-xs text-muted-foreground">
                        Selected people and team members can approve Slack requests.
                      </p>
                      <AccessSubjectMultiPicker
                        selected={selectedSubjects(
                          settings.slack_reviewer_team_slugs,
                          settings.slack_reviewer_user_subjects,
                        )}
                        onChange={(subjects) => setReviewers("slack", subjects)}
                        teams={teams}
                        knownUsers={knownUsers}
                        disabled={!integrations.slack || !settings.require_slack_onboarding_approval}
                        placeholder="Add people or teams"
                        searchPlaceholder="Search people or teams..."
                        ariaLabel="Slack onboarding reviewers"
                        maxSelections={100}
                      />
                    </div>
                    <NumberSetting
                      id="slack-channel-member-threshold"
                      label="Members allowed without review"
                      description="Larger or unknown channels require review."
                      value={settings.thresholds.slack_channel_members_without_approval}
                      disabled={!integrations.slack || !settings.require_slack_onboarding_approval}
                      onChange={(value) => setSettings((current) => ({
                        ...current,
                        thresholds: {
                          ...current.thresholds,
                          slack_channel_members_without_approval: value,
                        },
                      }))}
                    />
                  </div>
                </section>

                <section className="overflow-hidden rounded-xl border border-border/80">
                  <div className="flex items-start justify-between gap-4 border-b border-border/70 bg-muted/20 px-4 py-3">
                    <div>
                      <h4 className="flex items-center gap-2 text-sm font-semibold">
                        <Video className="h-4 w-4 text-[#00BCEB]" />
                        Webex
                        <SectionHelp label="Webex onboarding">
                          Review lets someone confirm a space before it is added.
                        </SectionHelp>
                      </h4>
                    </div>
                    <Badge variant="outline" className={cn(
                      integrations.webex
                        ? "border-emerald-500/40 text-emerald-600"
                        : "border-border text-muted-foreground",
                    )}>
                      {integrations.webex ? "Active" : "Not active"}
                    </Badge>
                  </div>
                  <div className="space-y-4 p-4">
                    <PolicySwitch
                      checked={settings.require_webex_onboarding_approval}
                      label="Review Webex space onboarding"
                      description={integrations.webex
                        ? "Spaces follow the member threshold below."
                        : "The Webex integration is not active."}
                      disabled={!integrations.webex}
                      onChange={(value) => setSettings((current) => ({
                        ...current,
                        require_webex_onboarding_approval: value,
                      }))}
                    />
                    <div className="space-y-2 border-t border-border/60 pt-4">
                      <Label>Reviewers</Label>
                      <p className="text-xs text-muted-foreground">
                        Selected people and team members can approve Webex requests.
                      </p>
                      <AccessSubjectMultiPicker
                        selected={selectedSubjects(
                          settings.webex_reviewer_team_slugs,
                          settings.webex_reviewer_user_subjects,
                        )}
                        onChange={(subjects) => setReviewers("webex", subjects)}
                        teams={teams}
                        knownUsers={knownUsers}
                        disabled={!integrations.webex || !settings.require_webex_onboarding_approval}
                        placeholder="Add people or teams"
                        searchPlaceholder="Search people or teams..."
                        ariaLabel="Webex onboarding reviewers"
                        maxSelections={100}
                      />
                    </div>
                    <NumberSetting
                      id="webex-space-member-threshold"
                      label="Members allowed without review"
                      description="Larger or unknown spaces require review."
                      value={settings.thresholds.webex_space_members_without_approval}
                      disabled={!integrations.webex || !settings.require_webex_onboarding_approval}
                      onChange={(value) => setSettings((current) => ({
                        ...current,
                        thresholds: {
                          ...current.thresholds,
                          webex_space_members_without_approval: value,
                        },
                      }))}
                    />
                  </div>
                </section>

                <div className="flex justify-end">
                  <Button onClick={() => void saveSettings()} disabled={savingSettings}>
                    {savingSettings ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Clock3 className="mr-2 h-4 w-4" />}
                    Save policy
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
