"use client";

// assisted-by Codex Codex-sonnet-4-6

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover,PopoverContent,PopoverTrigger } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { Tooltip,TooltipContent,TooltipProvider,TooltipTrigger } from "@/components/ui/tooltip";
import type { AuditEventType,UnifiedAuditEvent,UnifiedAuditOutcome } from "@/lib/rbac/types";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Clock,
  Database,
  Download,
  GitBranch,
  KeyRound,
  Loader2,
  Network,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  Shield,
  UserPlus,
  Wrench,
  X,
} from "lucide-react";
import React,{ useCallback,useEffect,useMemo,useRef,useState } from "react";
import { ACCESS_DECISION_COLOURS, ACCESS_GATE_LABELS, describeAccessDecision } from "./access-decision-description";
import { AccessDecisionChain } from "./AccessDecisionChain";
import { AuditReference, type AuditReferenceKind } from "./AuditReference";

interface UnifiedAuditTabProps {
  isAdmin: boolean;
  view?: "audit" | "decisions";
  initialSubjectRef?: string;
}

interface PaginatedResult {
  records: UnifiedAuditEvent[];
  cursor: string;
  next_cursor: string | null;
  since: string;
  until: string;
  as_of: string;
  limit: number;
  warning?: string;
  auditUnavailable?: boolean;
}

interface FilterOption {
  value: string;
  label: string;
  description: string;
}

interface AuditStorageConfig {
  backend?: string;
  readsAvailable?: boolean;
  readsWarning?: string;
  storageBackend?: string;
  storageLabel?: string;
}

interface AuditStorageInfo {
  storage: {
    query_backend?: string;
    record_count?: number;
    pending_archive_count?: number;
    backend?: string;
    audit_bytes?: number;
    audit_bytes_human?: string;
    total_bytes?: number;
    total_bytes_human?: string;
    object_count?: number;
    capped?: boolean;
    local_path?: string;
    retention_days?: number;
  } | null;
  retention: {
    backend?: string;
    retention_days?: number;
    configurable?: boolean;
    note?: string;
    bucket?: string;
    prefix?: string;
  } | null;
  verbosity: {
    verbosity?: string;
    label?: string;
    description?: string;
    allowed_types?: string[];
    allow_all?: boolean;
    available_presets?: { name: string; label: string; description: string; allowed_types: string[]; allow_all: boolean }[];
  } | null;
  errors: string[];
}

const TIME_WINDOW_OPTIONS = [
  { value: "5m", label: "Last 5 min", resolution: "minute" },
  { value: "15m", label: "Last 15 min", resolution: "minute" },
  { value: "30m", label: "Last 30 min", resolution: "minute" },
  { value: "1h", label: "Last 1 hr", resolution: "minute" },
  { value: "6h", label: "Last 6 hr", resolution: "hour" },
  { value: "12h", label: "Last 12 hr", resolution: "hour" },
  { value: "24h", label: "Last 24 hr", resolution: "hour" },
  { value: "48h", label: "Last 48 hr", resolution: "hour" },
  { value: "7d", label: "Last 7 days", resolution: "day" },
] as const;
type TimeWindow = (typeof TIME_WINDOW_OPTIONS)[number]["value"] | "custom";

const TYPE_FILTER_GROUPS: {
  label?: string;
  options: FilterOption[];
}[] = [
  {
    options: [
      {
        value: "",
        label: "All event types",
        description:
          "Every audit record in this log — policy changes, access checks, ReBAC, tools, delegations, and login/API auth.",
      },
    ],
  },
  {
    label: "Central authorization",
    options: [
      {
        value: "cas_grant",
        label: "Policy changes",
        description:
          "Grant and revoke attempts written by CAS (who changed access, for which grantee and resource, success or failure).",
      },
      {
        value: "cas_decision",
        label: "Access decisions",
        description:
          "Allow/deny results when the Centralized Authorization Service evaluates whether a subject may act on a resource.",
      },
      {
        value: "cas_reconcile",
        label: "Policy reconciliations",
        description:
          "OpenFGA relationship changes applied by CAS, including the reconciliation scope and applied tuple counts.",
      },
    ],
  },
  {
    label: "ReBAC",
    options: [
      {
        value: "openfga_rebac",
        label: "OpenFGA checks",
        description:
          "Relationship-based authorization checks from the OpenFGA authz bridge (tuple lookups, not grant/revoke writes).",
      },
    ],
  },
  {
    label: "Runtime",
    options: [
      {
        value: "tool_action",
        label: "Tool invocations",
        description:
          "Audited MCP or agent tool calls — which tool ran, for whom, and whether authorization allowed it.",
      },
      {
        value: "agent_delegation",
        label: "Agent delegations",
        description:
          "When work or authority is delegated from one agent to another in a multi-agent flow.",
      },
      {
        value: "auth",
        label: "Login & API auth",
        description:
          "Session login and API authorization checks (for example admin tab gates and other BFF-protected routes).",
      },
    ],
  },
];

const OUTCOME_OPTIONS: FilterOption[] = [
  {
    value: "",
    label: "All outcomes",
    description: "No outcome filter — show allow, deny, success, and error events together.",
  },
  {
    value: "allow",
    label: "Allow",
    description: "Access was granted for an authorization or access-decision check.",
  },
  {
    value: "deny",
    label: "Deny",
    description: "Access was refused for an authorization or access-decision check.",
  },
  {
    value: "success",
    label: "Success",
    description: "A policy change (grant/revoke) completed and was written to the PDP.",
  },
  {
    value: "error",
    label: "Error",
    description:
      "A policy change failed (for example missing manage capability or OpenFGA write error).",
  },
];

const AUDIT_TYPE_DESCRIPTIONS: Partial<Record<AuditEventType, string>> = Object.fromEntries(
  TYPE_FILTER_GROUPS.flatMap((group) => group.options)
    .filter((option) => option.value !== "")
    .map((option) => [option.value, option.description]),
) as Partial<Record<AuditEventType, string>>;

function FilterDefinitionsHelp({
  ariaLabel,
  title,
  groups,
  flatOptions,
}: {
  ariaLabel: string;
  title: string;
  groups?: typeof TYPE_FILTER_GROUPS;
  flatOptions?: FilterOption[];
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          aria-label={ariaLabel}
          title="View definitions for each option"
        >
          <CircleHelp className="h-4 w-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-3" align="start">
        <p className="text-sm font-medium mb-2">{title}</p>
        <dl className="space-y-3 text-xs">
          {groups
            ? groups.flatMap((group) =>
                group.options.map((option) => (
                  <div key={option.value || "all"}>
                    <dt className="font-medium text-foreground">{option.label}</dt>
                    <dd className="text-muted-foreground mt-0.5">{option.description}</dd>
                  </div>
                )),
              )
            : (flatOptions ?? []).map((option) => (
                <div key={option.value || "all"}>
                  <dt className="font-medium text-foreground">{option.label}</dt>
                  <dd className="text-muted-foreground mt-0.5">{option.description}</dd>
                </div>
              ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

function TypeBadge({ type }: { type: AuditEventType }) {
  let badge: React.ReactNode;
  switch (type) {
    case "auth":
      badge = (
        <Badge variant="outline" className="text-blue-600 border-blue-300 bg-blue-50 dark:bg-blue-950 dark:text-blue-400 dark:border-blue-800 gap-1">
          <Shield className="h-3 w-3" />
          Auth
        </Badge>
      );
      break;
    case "tool_action":
      badge = (
        <Badge variant="outline" className="text-emerald-600 border-emerald-300 bg-emerald-50 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-800 gap-1">
          <Wrench className="h-3 w-3" />
          Tool
        </Badge>
      );
      break;
    case "openfga_rebac":
      badge = (
        <Badge variant="outline" className="text-cyan-600 border-cyan-300 bg-cyan-50 dark:bg-cyan-950 dark:text-cyan-400 dark:border-cyan-800 gap-1">
          <Network className="h-3 w-3" />
          OpenFGA ReBAC
        </Badge>
      );
      break;
    case "cas_decision":
      badge = (
        <Badge variant="outline" className="text-indigo-600 border-indigo-300 bg-indigo-50 dark:bg-indigo-950 dark:text-indigo-400 dark:border-indigo-800 gap-1">
          <KeyRound className="h-3 w-3" />
          Access decision
        </Badge>
      );
      break;
    case "cas_grant":
      badge = (
        <Badge variant="outline" className="text-violet-600 border-violet-300 bg-violet-50 dark:bg-violet-950 dark:text-violet-400 dark:border-violet-800 gap-1">
          <UserPlus className="h-3 w-3" />
          Policy change
        </Badge>
      );
      break;
    case "cas_reconcile":
      badge = (
        <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800 gap-1">
          <RefreshCw className="h-3 w-3" />
          Policy reconciliation
        </Badge>
      );
      break;
    case "agent_delegation":
      badge = (
        <Badge variant="outline" className="text-purple-600 border-purple-300 bg-purple-50 dark:bg-purple-950 dark:text-purple-400 dark:border-purple-800 gap-1">
          <GitBranch className="h-3 w-3" />
          Delegation
        </Badge>
      );
      break;
    default:
      badge = <Badge variant="outline">{type}</Badge>;
  }

  const description = AUDIT_TYPE_DESCRIPTIONS[type];
  if (!description) return badge;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{badge}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}

function OutcomeBadge({ outcome }: { outcome: UnifiedAuditOutcome }) {
  switch (outcome) {
    case "allow":
    case "success":
      return (
        <Badge variant="outline" className="text-green-600 border-green-300 bg-green-50 dark:bg-green-950 dark:text-green-400 dark:border-green-800">
          {outcome}
        </Badge>
      );
    case "deny":
    case "error":
      return (
        <Badge variant="outline" className="text-red-600 border-red-300 bg-red-50 dark:bg-red-950 dark:text-red-400 dark:border-red-800">
          {outcome}
        </Badge>
      );
    default:
      return <Badge variant="outline">{outcome}</Badge>;
  }
}

function formatDuration(ms?: number): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function displaySource(source?: string): string {
  if (source === "bff") return "webui_backend";
  return source || "—";
}

function humanizeToken(value?: string | null): string {
  if (!value) return "unknown";
  const normalized = value.replace(/[_#:-]+/g, " ").trim();
  return normalized || value;
}

function sentenceCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function parseResourceRef(resourceRef?: string | null): { type?: string; id?: string } {
  if (!resourceRef) return {};
  const [type, ...rest] = resourceRef.split(":");
  if (!type || rest.length === 0) return {};
  return { type, id: rest.join(":") };
}

function resourceTypeLabel(type?: string): string {
  if (type === "task") return "workflow config";
  if (type === "mcp_tool") return "MCP tool";
  return humanizeToken(type);
}

function getResourceParts(evt: UnifiedAuditEvent): { type?: string; id?: string; label: string } {
  const parsed = parseResourceRef(evt.resource_ref);
  const type = evt.resource_type || parsed.type;
  const id = evt.resource_id || parsed.id;
  if (type && id) {
    return { type, id, label: `${resourceTypeLabel(type)} ${id}` };
  }
  if (evt.resource_ref) return { label: evt.resource_ref };
  if (evt.agent_name) return { type: "agent", id: evt.agent_name, label: `agent ${evt.agent_name}` };
  return { label: "resource" };
}

function compactHash(value?: string | null): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("sha256:")) return `${value.slice(0, 23)}...`;
  return value;
}

function hasReadableActor(evt: UnifiedAuditEvent): boolean {
  return Boolean(
    evt.actor_display ||
      evt.caller_display ||
      evt.subject_display ||
      evt.user_email ||
      evt.caller_ref ||
      evt.actor_ref ||
      evt.subject_ref,
  );
}

function hasReadableSubject(evt: UnifiedAuditEvent): boolean {
  return Boolean(evt.subject_display || evt.user_email || evt.subject_ref || evt.caller_ref);
}

function actorLabel(evt: UnifiedAuditEvent): string {
  const label =
    evt.actor_display ||
    evt.caller_display ||
    evt.subject_display ||
    evt.user_email ||
    evt.caller_ref ||
    evt.actor_ref ||
    evt.subject_ref ||
    compactHash(evt.actor_hash) ||
    compactHash(evt.subject_hash);
  if (label) return label;
  return evt.type === "cas_reconcile" ? "CAS reconciler" : "unknown";
}

function subjectLabel(evt: UnifiedAuditEvent): string {
  if (evt.type === "cas_reconcile") {
    return "OpenFGA relationships";
  }
  const label =
    evt.subject_display ||
    evt.user_email ||
    evt.subject_ref ||
    evt.caller_ref ||
    compactHash(evt.subject_hash);
  if (label) return label;
  return "unknown";
}

function decisionPathLabel(evt: UnifiedAuditEvent): string {
  const via = evt.decision_via;
  if (via === "tuple") return "OpenFGA tuple";
  if (via === "org_admin") return "Organization admin";
  if (via === "workflow_run_owner") return "Workflow run owner";
  if (via === "workflow_run_owner_mismatch") return "Workflow owner mismatch";
  if (via === "workflow_delegation") return "Workflow delegation";
  if (via) return sentenceCase(humanizeToken(via));
  if (evt.pdp === "openfga") return "OpenFGA";
  if (evt.pdp === "local") return "Local policy";
  return "—";
}

function requestStory(evt: UnifiedAuditEvent): string {
  const resource = getResourceParts(evt).label;
  const action = humanizeToken(evt.action);
  if (evt.type === "cas_reconcile") {
    const target = evt.reconcile_scope
      ? humanizeToken(evt.reconcile_scope)
      : "OpenFGA relationships";
    if (evt.outcome === "error") return `Failed to reconcile ${target}`;
    const changes = relationshipChangeSummary(evt.writes, evt.deletes);
    return changes
      ? `Reconciled ${target} — ${changes}`
      : `Reconciled ${target}`;
  }
  if (evt.type === "cas_grant") {
    const op = evt.operation === "revoke" ? "Revoked" : "Granted";
    return `${op} ${action} on ${resource}`;
  }
  const verb =
    evt.outcome === "allow" || evt.outcome === "success"
      ? "Allowed"
      : evt.outcome === "deny"
        ? "Denied"
        : "Failed";
  return `${verb} to ${action} ${resource}`;
}

function relationshipChangeSummary(
  writes?: number,
  deletes?: number,
): string | undefined {
  if (writes == null && deletes == null) return undefined;
  if ((writes ?? 0) === 0 && (deletes ?? 0) === 0) return "no policy changes";
  return `${writes ?? 0} added, ${deletes ?? 0} removed`;
}

function reconcileRequestSummary(evt: UnifiedAuditEvent): string {
  const scope = evt.reconcile_scope
    ? humanizeToken(evt.reconcile_scope)
    : "OpenFGA relationships";
  const requested = relationshipChangeSummary(
    evt.requested_writes,
    evt.requested_deletes,
  );
  return requested ? `Scope ${scope} · Requested ${requested}` : `Scope ${scope}`;
}

function reasonPhrase(evt: UnifiedAuditEvent): string {
  const reason = evt.reason_code ? humanizeToken(evt.reason_code) : "no reason code";
  if (evt.type === "cas_decision") {
    const service = evt.component === "cas" || evt.source === "cas" ? "CAS" : displaySource(evt.source);
    const decision = evt.outcome === "allow" ? "allowed" : "denied";
    const pdp = evt.pdp === "openfga" ? "OpenFGA" : evt.pdp ? sentenceCase(evt.pdp) : "the policy engine";
    const via = evt.decision_via ? ` via ${decisionPathLabel(evt)}` : "";
    // A bulk evaluation is a list filter, so report what it resolved to rather
    // than implying one request was allowed or denied.
    if (evt.batch) {
      const evaluated = (evt.evaluated_count ?? 0).toLocaleString();
      const allowed = (evt.allowed_count ?? 0).toLocaleString();
      const kind = evt.resource_type ? humanizeToken(evt.resource_type) : "resources";
      return `${service} evaluated ${evaluated} ${kind} for this subject; ${allowed} accessible.`;
    }
    // A list-objects row is a reverse lookup (the PDP's accessible set,
    // intersected with a candidate list) — no per-candidate check happened,
    // so this is worded distinctly from a batch evaluation.
    if (evt.list_objects) {
      const evaluated = (evt.evaluated_count ?? 0).toLocaleString();
      const allowed = (evt.allowed_count ?? 0).toLocaleString();
      const kind = evt.resource_type ? humanizeToken(evt.resource_type) : "resources";
      return `${service} looked up this subject's accessible ${kind} (one PDP call); ${allowed} of ${evaluated} candidates were in it.`;
    }
    if (typeof evt.count === "number" && evt.count > 1) {
      return `${service} ${decision} ${evt.count.toLocaleString()} matching requests because ${pdp} returned ${reason}${via}.`;
    }
    return `${service} ${decision} this request because ${pdp} returned ${reason}${via}.`;
  }
  if (evt.type === "cas_grant") {
    const op = evt.operation === "revoke" ? "revoke" : "grant";
    return `CAS recorded a ${op} attempt with result ${evt.outcome}.`;
  }
  if (evt.type === "cas_reconcile") {
    const scope = evt.reconcile_scope
      ? humanizeToken(evt.reconcile_scope)
      : "OpenFGA relationships";
    if (evt.outcome === "error") {
      return `CAS failed to reconcile ${scope} because ${reason}.`;
    }
    const changes = relationshipChangeSummary(evt.writes, evt.deletes);
    return changes === "no policy changes"
      ? `CAS checked ${scope}; OpenFGA required no relationship changes.`
      : `CAS applied ${changes ?? "the requested relationship changes"} through OpenFGA.`;
  }
  if (typeof evt.count === "number" && evt.count > 1) {
    return `${sentenceCase(displaySource(evt.source))} recorded ${evt.count.toLocaleString()} ${evt.outcome} decisions with reason ${reason}.`;
  }
  return `${sentenceCase(displaySource(evt.source))} recorded ${evt.outcome} with reason ${reason}.`;
}

function formatDownloadTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function downloadBlobFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function downloadAuditZip({
  filename,
  records,
  manifest,
}: {
  filename: string;
  records: UnifiedAuditEvent[];
  manifest: Record<string, unknown>;
}): Promise<void> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();

  zip.file("audit-events.json", JSON.stringify(records, null, 2));
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  downloadBlobFile(filename, blob);
}

export function UnifiedAuditTab({ isAdmin, view = "audit", initialSubjectRef = "" }: UnifiedAuditTabProps) {
  const [typeFilter, setTypeFilter] = useState(view === "decisions" ? "cas_decision" : "");
  const decisionsView = typeFilter === "cas_decision";
  const outcomeOptions = OUTCOME_OPTIONS.map((option) =>
    option.value === "deny" ? { ...option, label: "Blocked", description: "Includes permission denial, rejected context/request, and authorization unavailability. Expand the record for the reason." } : option,
  );
  const [result, setResult] = useState<PaginatedResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const pageCursors = useRef<string[]>([]);
  const [outcomeFilter, setOutcomeFilter] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [agentName, setAgentName] = useState("");
  const [subjectRef, setSubjectRef] = useState(initialSubjectRef);
  const [resourceRef, setResourceRef] = useState("");
  const [decisionId, setDecisionId] = useState("");
  const [correlationId, setCorrelationId] = useState("");
  const [referenceFilters, setReferenceFilters] = useState({
    subject_ref: initialSubjectRef, resource_ref: "", decision_id: "", correlation_id: "",
  });
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>(decisionsView ? "1h" : "5m");

  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [auditConfig, setAuditConfig] = useState<AuditStorageConfig | null>(null);
  const [storageInfo, setStorageInfo] = useState<AuditStorageInfo | null>(null);
  const [showStoragePanel, setShowStoragePanel] = useState(false);
  const [retentionInput, setRetentionInput] = useState("");
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionSaveMsg, setRetentionSaveMsg] = useState<string | null>(null);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const auditConfigRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestQuery = useRef(0);

  const buildAuditParams = useCallback((cursor: string | undefined, limit: number) => {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    params.set("limit", String(limit));
    if (timeWindow !== "custom") {
      params.set("window", timeWindow);
    }
    if (typeFilter) params.set("type", typeFilter);
    if (outcomeFilter) params.set("outcome", outcomeFilter);
    if (userEmail.trim()) params.set("user_email", userEmail.trim());
    if (agentName.trim()) params.set("agent_name", agentName.trim());
    for (const [key, value] of Object.entries(referenceFilters)) {
      if (value) params.set(key, value);
    }
    if (timeWindow === "custom" && dateFrom) params.set("from", new Date(dateFrom).toISOString());
    if (timeWindow === "custom" && dateTo) params.set("to", new Date(dateTo).toISOString());
    return params;
  }, [timeWindow, typeFilter, outcomeFilter, userEmail, agentName, referenceFilters, dateFrom, dateTo]);

  const fetchEvents = useCallback(async (p = 1, cursor?: string) => {
    const queryId = ++latestQuery.current;
    setLoading(true);
    setError(null);
    try {
      const params = buildAuditParams(cursor, 30);

      const res = await fetch(`/api/admin/audit-events?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || body.message || `HTTP ${res.status}`);
      }
      const data: PaginatedResult = await res.json();
      if (queryId !== latestQuery.current) return;
      setResult(data);
      setPage(p);
      if (!cursor) pageCursors.current = [];
      pageCursors.current[p - 1] = data.cursor;
      setExpandedRow(null);
    } catch (err) {
      if (queryId === latestQuery.current) setError(err instanceof Error ? err.message : "Failed to load audit events");
    } finally {
      if (queryId === latestQuery.current) setLoading(false);
    }
  }, [buildAuditParams]);

  const fetchAuditConfig = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const response = await fetch("/api/audit/config");
      const config = (await response.json()) as AuditStorageConfig;
      setAuditConfig(config);
      if (config.readsAvailable === false) {
        if (auditConfigRetryRef.current) clearTimeout(auditConfigRetryRef.current);
        auditConfigRetryRef.current = setTimeout(() => {
          fetchAuditConfig().catch(() => undefined);
        }, 5_000);
      }
    } catch (err) {
      setAuditConfig({
        readsAvailable: false,
        storageLabel: "Storage: unknown",
        readsWarning: err instanceof Error ? err.message : "Failed to load audit storage status",
      });
      if (auditConfigRetryRef.current) clearTimeout(auditConfigRetryRef.current);
      auditConfigRetryRef.current = setTimeout(() => {
        fetchAuditConfig().catch(() => undefined);
      }, 5_000);
    }
  }, [isAdmin]);

  const fetchStorageInfo = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await fetch("/api/admin/audit-storage");
      if (res.ok) {
        setStorageInfo((await res.json()) as AuditStorageInfo);
      }
    } catch {
      // best-effort
    }
  }, [isAdmin]);

  const saveRetention = useCallback(async () => {
    const days = parseInt(retentionInput, 10);
    if (isNaN(days) || days < 0) return;
    setRetentionSaving(true);
    setRetentionSaveMsg(null);
    try {
      const res = await fetch("/api/admin/audit-storage/retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setRetentionSaveMsg(`Error: ${data.error ?? res.status}`);
      } else {
        setRetentionSaveMsg(`Saved — lifecycle rule set to ${days} day${days !== 1 ? "s" : ""}.`);
        await fetchStorageInfo();
      }
    } catch (err) {
      setRetentionSaveMsg(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRetentionSaving(false);
    }
  }, [retentionInput, fetchStorageInfo]);

  const downloadEvents = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const records: UnifiedAuditEvent[] = [];
      let cursor: string | undefined;
      let bounds: Pick<PaginatedResult, "since" | "until" | "as_of"> | undefined;
      const seenCursors = new Set<string>();

      while (true) {
        const params = buildAuditParams(cursor, 200);
        const res = await fetch(`/api/admin/audit-events?${params.toString()}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || body.message || `HTTP ${res.status}`);
        }

        const data: PaginatedResult = await res.json();
        if (data.auditUnavailable) throw new Error("Cannot export decision evidence while audit reads are unavailable");
        bounds ??= { since: data.since, until: data.until, as_of: data.as_of };
        records.push(...data.records);
        if (records.length > 100_000) throw new Error("Export exceeds 100,000 events. Narrow the time range or filters.");
        if (!data.next_cursor) break;
        if (seenCursors.has(data.next_cursor)) throw new Error("Audit export cursor did not advance. Please retry.");
        seenCursors.add(data.next_cursor);
        cursor = data.next_cursor;
      }

      const filters: Record<string, string> = {};
      if (typeFilter) filters.type = typeFilter;
      if (outcomeFilter) filters.outcome = outcomeFilter;
      if (userEmail.trim()) filters.user_email = userEmail.trim();
      if (agentName.trim()) filters.agent_name = agentName.trim();
      for (const [key, value] of Object.entries(referenceFilters)) {
        if (value) filters[key] = value;
      }
      if (timeWindow === "custom") {
        if (dateFrom) filters.from = new Date(dateFrom).toISOString();
        if (dateTo) filters.to = new Date(dateTo).toISOString();
      } else {
        filters.window = timeWindow;
      }

      const exportedAt = new Date().toISOString();
      await downloadAuditZip({
        filename: `security-audit-log-${formatDownloadTimestamp(exportedAt)}.zip`,
        records,
        manifest: {
          exported_at: exportedAt,
          format: "raw-json-zip",
          files: ["audit-events.json", "manifest.json"],
          filters,
          ...bounds,
          record_count: records.length,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download audit events");
    } finally {
      setExporting(false);
    }
  }, [buildAuditParams, timeWindow, typeFilter, outcomeFilter, userEmail, agentName, referenceFilters, dateFrom, dateTo]);

  useEffect(() => {
    if (!isAdmin) return;
    setResult(null);
    fetchEvents(1);
    return () => { latestQuery.current += 1; };
  }, [isAdmin, fetchEvents]);

  useEffect(() => {
    if (!isAdmin) return;
    fetchAuditConfig().catch(() => undefined);
    return () => {
      if (auditConfigRetryRef.current) clearTimeout(auditConfigRetryRef.current);
    };
  }, [isAdmin, fetchAuditConfig]);

  useEffect(() => {
    if (autoRefresh) {
      autoRefreshRef.current = setInterval(() => {
        fetchEvents(1);
        fetchAuditConfig().catch(() => undefined);
      }, 30_000);
    }
    return () => {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current);
    };
  }, [autoRefresh, fetchEvents, fetchAuditConfig]);

  const selectedTypeHelp = useMemo(
    () =>
      TYPE_FILTER_GROUPS.flatMap((group) => group.options).find((option) => option.value === typeFilter)
        ?.description,
    [typeFilter],
  );
  const auditStorageLabel = auditConfig?.storageLabel ?? "Storage: checking...";
  const auditStorageWarning = auditConfig?.readsAvailable === false ? auditConfig.readsWarning : undefined;

  const handleReset = () => {
    setTypeFilter(view === "decisions" ? "cas_decision" : "");
    setOutcomeFilter("");
    setUserEmail("");
    setAgentName("");
    setSubjectRef("");
    setResourceRef("");
    setDecisionId("");
    setCorrelationId("");
    setReferenceFilters({ subject_ref: "", resource_ref: "", decision_id: "", correlation_id: "" });
    setDateFrom("");
    setDateTo("");
    setTimeWindow(view === "decisions" ? "1h" : "5m");
    setPage(1);
    const url = new URL(window.location.href);
    url.searchParams.delete("subject_ref");
    window.history.replaceState(null, "", url);
  };

  if (!isAdmin) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">
            Admin access required to view audit events.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle role="heading" aria-level={3} className="text-lg">Security audit</CardTitle>
            <CardDescription>
              {decisionsView ? "Recorded CAS checks: who attempted what, and which check blocked access." : "Policy changes, access decisions, ReBAC checks, tool use, and delegations in one timeline"}
            </CardDescription>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Badge
                variant="outline"
                className={`gap-1.5 text-[11px] font-medium ${
                  auditStorageWarning
                    ? "border-destructive/40 text-destructive bg-destructive/10"
                    : "border-border/70 text-muted-foreground bg-background/50"
                }`}
                title={auditStorageWarning ?? auditStorageLabel}
              >
                <Database className="h-3 w-3" />
                {auditStorageLabel}
              </Badge>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={downloadEvents}
              disabled={exporting}
              aria-label="Download audit log"
              className="gap-1.5"
              title="Download raw JSON audit events as a ZIP file"
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              Download ZIP
            </Button>
            <Button
              variant={autoRefresh ? "default" : "outline"}
              size="sm"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className="gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${autoRefresh ? "animate-spin" : ""}`} />
              {autoRefresh ? "Auto" : "Auto"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                fetchEvents(1);
                fetchAuditConfig().catch(() => undefined);
              }}
              className="gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Refresh
            </Button>
            <Button
              variant={showStoragePanel ? "secondary" : "outline"}
              size="sm"
              data-testid="audit-storage-settings-toggle"
              onClick={() => {
                setShowStoragePanel((v) => !v);
                if (!storageInfo) fetchStorageInfo().catch(() => undefined);
              }}
              className="gap-1.5"
              title="Storage usage, retention, and verbosity settings"
            >
              <Settings2 className="h-3.5 w-3.5" />
              Settings
            </Button>
          </div>
        </div>
      </CardHeader>

      {/* Storage & Retention Panel */}
      {showStoragePanel && (
        <div className="mx-6 mb-4 rounded-lg border border-border/60 bg-muted/30 p-4">
          <div className="grid gap-4 md:grid-cols-3">
            {/* Storage Usage */}
            <div>
              <div className="mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Storage Usage</div>
              {storageInfo?.storage ? (
                <div className="text-sm space-y-0.5">
                  <div><span className="text-muted-foreground">Queries: </span>{storageInfo.storage.query_backend ?? "—"}</div>
                  <div><span className="text-muted-foreground">Query records (approx.): </span>{storageInfo.storage.record_count?.toLocaleString() ?? "—"}</div>
                  <div><span className="text-muted-foreground">Pending archive: </span>{storageInfo.storage.pending_archive_count?.toLocaleString() ?? "—"}</div>
                  <div>
                    <span className="text-muted-foreground">Archive: </span>
                    <span className="font-medium">{storageInfo.storage.backend ?? "—"}</span>
                  </div>
                  {storageInfo.storage.backend === "local" && (
                    <>
                      <div>
                        <span className="text-muted-foreground">Audit dir size: </span>
                        <span className="font-medium">{storageInfo.storage.audit_bytes_human ?? "—"}</span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate" title={storageInfo.storage.local_path}>
                        {storageInfo.storage.local_path}
                      </div>
                    </>
                  )}
                  {storageInfo.storage.backend === "s3" && (
                    <>
                      <div>
                        <span className="text-muted-foreground">Objects: </span>
                        <span className="font-medium">
                          {storageInfo.storage.object_count?.toLocaleString() ?? "—"}
                          {storageInfo.storage.capped ? "+" : ""}
                        </span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Size: </span>
                        <span className="font-medium">{storageInfo.storage.total_bytes_human ?? "—"}</span>
                        {storageInfo.storage.capped && (
                          <span className="ml-1 text-xs text-muted-foreground">(partial scan)</span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">{storageInfo ? "Unavailable" : "Loading…"}</div>
              )}
            </div>

            {/* Retention */}
            <div>
              <div className="mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Retention</div>
              {storageInfo?.retention ? (
                <div className="text-sm space-y-1.5">
                  <div>
                    <span className="text-muted-foreground">Current: </span>
                    <span className="font-medium">
                      {storageInfo.retention.retention_days
                        ? `${storageInfo.retention.retention_days} day${storageInfo.retention.retention_days !== 1 ? "s" : ""}`
                        : "Not set"}
                    </span>
                  </div>
                  {storageInfo.retention.configurable ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        placeholder="days (0 = off)"
                        value={retentionInput}
                        onChange={(e) => setRetentionInput(e.target.value)}
                        className="h-7 w-28 text-sm"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 text-xs"
                        disabled={retentionSaving || retentionInput === ""}
                        onClick={saveRetention}
                      >
                        {retentionSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                        Save
                      </Button>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">{storageInfo.retention.note}</div>
                  )}
                  {retentionSaveMsg && (
                    <div className={`text-xs ${retentionSaveMsg.startsWith("Error") ? "text-destructive" : "text-green-600 dark:text-green-400"}`}>
                      {retentionSaveMsg}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">{storageInfo ? "Unavailable" : "Loading…"}</div>
              )}
            </div>

            {/* Verbosity */}
            <div>
              <div className="mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Log Verbosity</div>
              {storageInfo?.verbosity ? (
                <div className="text-sm space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[11px]">
                      {storageInfo.verbosity.verbosity ?? "—"}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">{storageInfo.verbosity.description}</div>
                  {!storageInfo.verbosity.allow_all && storageInfo.verbosity.allowed_types && storageInfo.verbosity.allowed_types.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {storageInfo.verbosity.allowed_types.map((t) => (
                        <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">{t}</span>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground mt-1">Set <code className="font-mono">AUDIT_LOG_VERBOSITY</code> to change preset.</div>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">{storageInfo ? "Unavailable" : "Loading…"}</div>
              )}
            </div>
          </div>
        </div>
      )}

      <CardContent>
        {decisionsView && (
          <p className="mb-4 rounded-md border p-3 text-sm text-muted-foreground">
            Historical evidence, not current permissions. Allows may be rollups; catalog lookups are not blocked requests.
            Authentication failures before CAS and downstream credential/tool failures may not be recorded here.
            Audit delivery is best-effort; no matching record is not proof that no check occurred.
          </p>
        )}
        {result?.auditUnavailable && (
          <p role="alert" className="mb-4 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {result.warning} No conclusion can be drawn from an empty result while audit reads are unavailable.
          </p>
        )}
        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="flex items-center gap-0.5">
            <Select
              aria-label="Audit time range"
              value={timeWindow}
              onChange={(e) => {
                const next = e.target.value as TimeWindow;
                setTimeWindow(next);
                if (next !== "custom") {
                  setDateFrom("");
                  setDateTo("");
                }
              }}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              title="Choose how much audit history to scan"
            >
              {TIME_WINDOW_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              <option value="custom">Custom range</option>
            </Select>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground">
                  <Clock className="h-4 w-4" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                Filters and time ranges are queried in MongoDB. Each request reads one bounded page; S3 is the archive.
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="flex items-center gap-0.5">
            <Select
              aria-label="Audit event type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm max-w-[220px]"
              title={selectedTypeHelp}
            >
              {TYPE_FILTER_GROUPS.map((group) =>
                group.label ? (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((o) => (
                      <option key={o.value} value={o.value} title={o.description}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ) : (
                  group.options.map((o) => (
                    <option key={o.value || "all"} value={o.value} title={o.description}>
                      {o.label}
                    </option>
                  ))
                ),
              )}
            </Select>
            <FilterDefinitionsHelp
              ariaLabel="Event type definitions"
              title="Event types"
              groups={TYPE_FILTER_GROUPS}
            />
          </div>
          <div className="flex items-center gap-0.5">
            <Select
              aria-label="Audit outcome"
              value={outcomeFilter}
              onChange={(e) => setOutcomeFilter(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {outcomeOptions.map((o) => (
                <option key={o.value} value={o.value} title={o.description}>
                  {o.label}
                </option>
              ))}
            </Select>
            <FilterDefinitionsHelp
              ariaLabel="Outcome filter definitions"
              title="Outcomes"
              flatOptions={outcomeOptions}
            />
          </div>
          <Input aria-label="Caller principal" placeholder="user:ID or service_account:ID" value={subjectRef} onChange={(e) => setSubjectRef(e.target.value)} className="h-9 w-64" />
          <Input aria-label="Resource reference" placeholder="tool:server/tool or agent:ID" value={resourceRef} onChange={(e) => setResourceRef(e.target.value)} className="h-9 w-64" />
          <Input aria-label="Decision ID" placeholder="Decision ID" value={decisionId} onChange={(e) => setDecisionId(e.target.value)} className="h-9 w-64" />
          <Input aria-label="Correlation ID" placeholder="Correlation ID" value={correlationId} onChange={(e) => setCorrelationId(e.target.value)} className="h-9 w-64" />
          <Input placeholder="User email..." value={userEmail} onChange={(e) => setUserEmail(e.target.value)} className="h-9 w-48" />
          <Input placeholder="Agent name..." value={agentName} onChange={(e) => setAgentName(e.target.value)} className="h-9 w-40" />
          <Input
            type="datetime-local"
            value={dateFrom}
            onChange={(e) => {
              setDateFrom(e.target.value);
              setTimeWindow("custom");
            }}
            className="h-9 w-44"
            disabled={timeWindow !== "custom"}
            title="From"
          />
          <Input
            type="datetime-local"
            value={dateTo}
            onChange={(e) => {
              setDateTo(e.target.value);
              setTimeWindow("custom");
            }}
            className="h-9 w-44"
            disabled={timeWindow !== "custom"}
            title="To"
          />
          <Button variant="ghost" size="sm" onClick={handleReset} className="gap-1 h-9">
            <X className="h-3.5 w-3.5" />
            Clear
          </Button>
          <Button variant="default" size="sm" onClick={() => {
            setReferenceFilters({ subject_ref: subjectRef.trim(), resource_ref: resourceRef.trim(), decision_id: decisionId.trim(), correlation_id: correlationId.trim() });
          }} className="gap-1 h-9">
            <Search className="h-3.5 w-3.5" />
            Search
          </Button>
        </div>
        {/* Error */}
        {error && (
          <div className="text-sm text-destructive bg-destructive/10 rounded-md p-3 mb-4">
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && !result && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Table */}
        {result && (
          <>
            <div className="text-xs text-muted-foreground mb-2">
              {result.auditUnavailable ? "Audit results unavailable" : `${result.records.length} event${result.records.length !== 1 ? "s" : ""} on this page`}
              {loading && <Loader2 className="inline h-3 w-3 ml-1 animate-spin" />}
            </div>
            <div className="border rounded-md overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/50 text-left">
	                    <th className="px-3 py-2 font-medium w-8" />
	                    <th className="px-3 py-2 font-medium">Time</th>
	                    {!decisionsView && <th className="px-3 py-2 font-medium">Event</th>}
	                    <th className="px-3 py-2 font-medium">{decisionsView ? "Caller" : "Actor"}</th>
	                    <th className="px-3 py-2 font-medium">Request</th>
	                    <th className="px-3 py-2 font-medium">{decisionsView ? "Failed check" : "Path"}</th>
	                    <th className="px-3 py-2 font-medium">Outcome</th>
	                    {!decisionsView && <th className="px-3 py-2 font-medium">Source</th>}
	                    {!decisionsView && <th className="px-3 py-2 font-medium">Duration</th>}
	                  </tr>
                </thead>
                <tbody>
                  {result.records.length === 0 && (
                    <tr>
                      <td colSpan={decisionsView ? 6 : 9} className="px-3 py-8 text-center text-muted-foreground">
                        {result.auditUnavailable ? "Audit results unavailable." : "No audit events found for the selected filters."}
                      </td>
                    </tr>
                  )}
	                  {result.records.map((evt) => {
	                    const rowKey = evt.audit_event_id ?? `${evt.correlation_id}-${evt.ts}`;
	                    const isExpanded = expandedRow === rowKey;
	                    const resource = getResourceParts(evt);
	                    const description = evt.type === "cas_decision" ? describeAccessDecision(evt) : undefined;
	                    const story = decisionsView ? `${description?.label ?? evt.outcome}: ${humanizeToken(evt.action)} ${resource.label}` : requestStory(evt);
	                    const actor = actorLabel(evt);
	                    const subject = subjectLabel(evt);
	                    const path = decisionsView ? (evt.failed_gate ? ACCESS_GATE_LABELS[evt.failed_gate] || evt.failed_gate : "—") : decisionPathLabel(evt);
	                    return (
	                      <React.Fragment key={rowKey}>
                        <tr
                          className="border-t hover:bg-muted/30 cursor-pointer transition-colors"
                          onClick={() => setExpandedRow(isExpanded ? null : rowKey)}
                        >
                          <td className="px-3 py-2">
                            {isExpanded ? (
                              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                            {formatTimestamp(evt.ts)}
                          </td>
	                          {!decisionsView && <td className="px-3 py-2">
	                            <TypeBadge type={evt.type} />
	                          </td>}
	                          <td className={`px-3 py-2 text-xs max-w-[220px] ${decisionsView ? "whitespace-normal" : "truncate"}`} title={decisionsView ? subject : actor}>
	                            {decisionsView ? <>
	                              {evt.subject_ref ? <AuditReference kind="principal" value={evt.subject_ref} /> : <span className="text-muted-foreground">Principal not recorded</span>}
	                              {subject !== "unknown" && subject !== evt.subject_ref && <div className="mt-1 text-muted-foreground">{subject}</div>}
	                            </> : actor}
	                          </td>
	                          <td className="px-3 py-2 min-w-[260px]" title={`${evt.action} ${evt.resource_ref || ""}`.trim()}>
	                            <div className="font-medium text-sm">{story}</div>
	                            <div className="text-[11px] text-muted-foreground mt-0.5">
	                              {decisionsView ? <div className="mt-1 flex flex-wrap items-center gap-1">
	                                <AuditReference kind="resource" value={evt.resource_ref || resource.label} />
	                                <AuditReference kind="action" value={evt.action} />
	                              </div> : <>
	                                {evt.type === "cas_reconcile"
	                                  ? reconcileRequestSummary(evt)
	                                  : evt.workflow_run_id
	                                    ? `Workflow run ${evt.workflow_run_id}`
	                                    : `Resource ${resource.label}`}
	                                {evt.type !== "cas_reconcile" && evt.action ? ` · Action ${evt.action}` : ""}
	                              </>}
	                            </div>
	                          </td>
	                          <td className="px-3 py-2 text-xs max-w-[180px] truncate" title={path}>
	                            {path}
	                          </td>
	                          <td className="px-3 py-2">
	                            {decisionsView ? <Badge variant="outline" className={ACCESS_DECISION_COLOURS[description?.tone ?? "neutral"]}>{description?.label ?? evt.outcome}</Badge> : <OutcomeBadge outcome={evt.outcome} />}
	                          </td>
	                          {!decisionsView && <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground max-w-[150px] truncate" title={displaySource(evt.source)}>
	                            {displaySource(evt.source)}
	                          </td>}
	                          {!decisionsView && <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                            {evt.duration_ms != null && (
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {formatDuration(evt.duration_ms)}
                              </span>
                            )}
                            {evt.duration_ms == null && "—"}
                          </td>}
                        </tr>
                        {isExpanded && (
	                          <tr className="border-t bg-muted/20">
	                            <td colSpan={decisionsView ? 6 : 9} className="px-6 py-4">
	                              <div className={`mb-4 rounded-md border border-l-4 p-3 ${decisionsView && description ? ACCESS_DECISION_COLOURS[description.tone] : "border-border/60 bg-background/60"}`}>
	                                <div className="text-xs text-muted-foreground mb-1">What happened:</div>
	                                <div className="text-sm font-medium">{story}</div>
	                                <div className="text-xs text-muted-foreground mt-1">{description?.explanation ?? reasonPhrase(evt)}</div>
	                              </div>
	                              {evt.type === "cas_decision" && <AccessDecisionChain event={evt} />}
	                              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
	                                <DetailField label={decisionsView ? "Checking workload / actor" : "Actor"} value={decisionsView ? evt.actor_ref || evt.actor_display || "Not recorded" : actor} referenceKind={decisionsView ? "workload" : undefined} />
	                                <DetailField
	                                  label={decisionsView ? "Effective principal" : evt.type === "cas_reconcile" ? "Target" : "Subject"}
	                                  value={decisionsView ? evt.subject_ref || "Not recorded" : subject}
	                                  referenceKind={decisionsView && evt.subject_ref ? "principal" : undefined}
	                                />
	                                <DetailField
	                                  label="Request"
	                                  value={
	                                    evt.type === "cas_reconcile"
	                                      ? reconcileRequestSummary(evt)
	                                      : `${humanizeToken(evt.action)} ${resource.label}`
	                                  }
	                                />
	                                <DetailField label="Decision Path" value={decisionPathLabel(evt)} />
	                                <DetailField label="Correlation ID" value={evt.correlation_id} />
	                                <DetailField label="Context ID" value={evt.context_id} />
	                                <DetailField label="Component" value={evt.component} />
                                <DetailField label="Source" value={displaySource(evt.source)} />
                                <DetailField label="Tool" value={evt.tool_name} />
                                <DetailField label="PDP" value={evt.pdp} />
                                <DetailField label="Trace ID" value={evt.trace_id} mono />
                                <DetailField label="Reason Code" value={evt.reason_code} />
                                <DetailField label="Failed check" value={evt.failed_gate ? ACCESS_GATE_LABELS[evt.failed_gate] || evt.failed_gate : undefined} />
                                <DetailField label="Decision ID" value={evt.decision_id} mono />
                                <DetailField label="Gateway operation" value={evt.gateway_operation} />
                                <DetailField label="Agent" value={evt.agent_ref || (evt.gateway_operation ? "Not recorded" : undefined)} />
                                <DetailField label="Checks summarized" value={evt.count?.toString()} />
                                <DetailField label="Rollup start" value={evt.window_start} />
                                <DetailField label="Rollup end" value={evt.window_end} />
                                <DetailField label="Resource Ref" value={evt.resource_ref} referenceKind={decisionsView ? "resource" : undefined} />
                                {decisionsView && <DetailField label="Action" value={evt.action} referenceKind="action" />}
	                                <DetailField label="Resource Type" value={evt.resource_type} />
	                                <DetailField label="Resource ID" value={evt.resource_id} />
	                                <DetailField label="Workflow Run ID" value={evt.workflow_run_id} />
	                                <DetailField label="Raw Decision Path" value={evt.decision_via} />
                                <DetailField label="Operation" value={evt.operation} />
                                <DetailField label="Reconciliation Scope" value={evt.reconcile_scope ? humanizeToken(evt.reconcile_scope) : undefined} />
                                <DetailField label="Requested Additions" value={evt.requested_writes?.toString()} />
                                <DetailField label="Requested Removals" value={evt.requested_deletes?.toString()} />
                                <DetailField label="Applied Additions" value={evt.writes?.toString()} />
                                <DetailField label="Applied Removals" value={evt.deletes?.toString()} />
                                <DetailField label="Caller" value={evt.caller_display || evt.caller_ref} />
                                <DetailField label="Grantee" value={evt.grantee_display || evt.grantee_ref} />
                                <DetailField label="Actor Hash" value={hasReadableActor(evt) ? undefined : evt.actor_hash} mono />
                                <DetailField label="Subject Hash" value={hasReadableSubject(evt) ? undefined : evt.subject_hash} mono />
                                <DetailField label="Tenant" value={evt.tenant_id} />
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {(page > 1 || result.next_cursor) && (
              <div className="flex items-center justify-between mt-4">
                <span className="text-xs text-muted-foreground">
                  Page {page}
                </span>
                <div className="flex gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Previous audit page"
                    disabled={loading || page <= 1}
                    onClick={() => fetchEvents(page - 1, pageCursors.current[page - 2])}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Next audit page"
                    disabled={loading || !result.next_cursor}
                    onClick={() => fetchEvents(page + 1, result.next_cursor ?? undefined)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
    </TooltipProvider>
  );
}

function DetailField({
  label,
  value,
  mono,
  referenceKind,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
  referenceKind?: AuditReferenceKind;
}) {
  if (!value) return null;
  return (
    <div>
      <span className="text-muted-foreground">{label}:</span>{" "}
      {referenceKind ? <AuditReference kind={referenceKind} value={value} /> : <span className={mono ? "font-mono break-all" : ""}>{value}</span>}
    </div>
  );
}
