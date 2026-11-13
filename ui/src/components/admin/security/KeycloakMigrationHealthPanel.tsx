"use client";

import {
AlertTriangle,
CheckCircle2,
ChevronDown,
ChevronRight,
HelpCircle,
Loader2,
PlayCircle,
RefreshCw,
Shield,
XCircle,
} from "lucide-react";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog,DialogContent,DialogDescription,DialogHeader,DialogTitle } from "@/components/ui/dialog";
import { Tooltip,TooltipContent,TooltipProvider,TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { explainInvariant } from "../shared/invariant-explanations";
import {
BOOTSTRAP_ADMIN_HEADER_EXPLANATION,
explainWarning,
type WarningExplanation,
} from "../shared/warning-explanations";

type MigrationStatus = "not_started" | "planned" | "running" | "completed" | "failed" | "skipped";
const KEYCLOAK_MIGRATION_ID = "keycloak_rbac_mapping_reconciliation_v1";
const KEYCLOAK_MIGRATION_CONFIRMATION = "MIGRATE keycloak_rbac_mappings TO v1";

/**
 * Reusable "HelpCircle button → tooltip" affordance shared by every
 * explainer in this panel (invariant rows, warning rows, the bootstrap
 * admin section header). The shape mirrors the inline JSX that was
 * already used for invariant rows; centralising it here means the
 * three callsites stay visually identical and a future styling tweak
 * lands in one place.
 *
 * `data-testid` is required so each call site has a stable selector
 * (`invariant-explain-…`, `warning-explain-…`, `bootstrap-admin-header-explain`).
 *
 * The component renders the `body` and an optional "How to fix" block
 * separated by a thin divider. Bodies are 2–4 sentences; fixes are
 * 1–2 sentences. We deliberately do NOT use a Markdown renderer
 * here — backticks render as plain backticks, which is the same
 * convention as the invariant tooltips so the prose reads
 * consistently across the panel.
 */
function ExplainerTooltip({
  trigger,
  explanation,
  testId,
  ariaLabel,
  sideOffset = 6,
}: {
  /** Optional override for the button content; defaults to a `HelpCircle` icon. */
  trigger?: React.ReactNode;
  explanation: { title: string; body: string; fix?: string };
  testId: string;
  ariaLabel: string;
  sideOffset?: number;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid={testId}
          >
            {trigger ?? <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          sideOffset={sideOffset}
          // Override the primitive's default `whitespace-nowrap` so
          // the body wraps. ~360px reads comfortably for the 2-4
          // sentence explanations without dominating the viewport.
          className="whitespace-normal max-w-sm w-max text-left font-normal leading-snug p-3"
        >
          <div className="space-y-1.5">
            <p className="font-semibold text-popover-foreground">
              {explanation.title}
            </p>
            <p className="text-muted-foreground text-[11px]">
              {explanation.body}
            </p>
            {explanation.fix && (
              <>
                <div className="my-1 border-t border-border/60" />
                <p className="text-[11px]">
                  <span className="font-semibold text-popover-foreground">
                    How to fix:{" "}
                  </span>
                  <span className="text-muted-foreground">{explanation.fix}</span>
                </p>
              </>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface MetricDetails {
  title: string;
  description: string;
  rows: Array<Record<string, unknown>>;
}

interface KeycloakMigrationHealth {
  keycloak: {
    configured: boolean;
    reachable: boolean;
    status?:
      | "unconfigured"
      | "reachable"
      | "unreachable"
      | "admin_authorization_error"
      | "reconciliation_error";
    realm: string;
    last_probe_at: string;
    probe_error?: string;
  };
  schema_area: {
    area: string;
    current_version: number | null;
    target_version: number;
    status: "current" | "behind" | "unknown";
    last_migration_id?: string;
  };
  migration: {
    id: string;
    manifest_status: MigrationStatus;
    last_run?: {
      status: MigrationStatus;
      actor?: string;
      completed_at?: string;
      updated_at?: string;
      applied_counts: Record<string, number>;
      planned_counts: Record<string, number>;
      warnings: string[];
      error?: string;
    };
  };
  blocking: {
    is_blocking: boolean;
    blocking_required_count: number;
  };
  bootstrap_admins?: {
    enabled: boolean;
    configured_emails: string[];
    resolved_count: number;
    created_count: number;
    failed_count: number;
    tuple_write_count: number;
    warnings: string[];
    outcomes: Array<Record<string, unknown>>;
  };
  keycloak_values?: {
    obo_permissions?: Array<Record<string, unknown>>;
    bot_service_accounts?: Array<Record<string, unknown>>;
    token_exchange_permissions?: Array<Record<string, unknown>>;
    users_impersonate_permission?: Record<string, unknown>;
  };
  keycloak_values_error?: string;
  keycloak_invariants?: {
    summary: {
      total: number;
      passing: number;
      failing: number;
      unknown: number;
      reconcile_now_recommended: boolean;
    };
    items: Array<KeycloakInvariant>;
  };
}

type InvariantStatus = "pass" | "fail" | "unknown";
type InvariantRemediation = "reconcile_now" | "manual_keycloak" | "none";
type InvariantGroup = "obo" | "client" | "service-account";

interface KeycloakInvariant {
  id: string;
  description: string;
  group: InvariantGroup;
  source: "init-idp.sh" | "init-token-exchange.sh" | "bff-migration";
  status: InvariantStatus;
  detail?: string;
  remediation: InvariantRemediation;
}

const INVARIANT_GROUP_ORDER: InvariantGroup[] = [
  "obo",
  "service-account",
  "client",
];

const INVARIANT_GROUP_LABELS: Record<InvariantGroup, string> = {
  obo: "OBO (token exchange & impersonation)",
  "service-account": "Bot service accounts",
  client: "Clients & realm",
};

interface KeycloakMigrationHealthPanelProps {
  compact?: boolean;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { data?: T; error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }
  return body.data as T;
}

function isTransientFetchFailure(error: unknown): boolean {
  return error instanceof TypeError && error.message === "fetch failed";
}

function statusTone(status: MigrationStatus | "current" | "behind" | "unknown") {
  if (status === "completed" || status === "current") return "text-emerald-600";
  if (status === "failed" || status === "behind") return "text-red-600";
  if (status === "running" || status === "planned") return "text-amber-600";
  return "text-muted-foreground";
}

function formatVersion(version: number | null): string {
  return typeof version === "number" ? `v${version}` : "unknown";
}

function formatVersionRange(current: number | null, target: number): string {
  return `${formatVersion(current)} -> ${formatVersion(target)}`;
}

function formatBootstrapAdminStatus(health: KeycloakMigrationHealth): string {
  const bootstrap = health.bootstrap_admins;
  if (!bootstrap?.enabled) return "not configured";
  return `${bootstrap.resolved_count}/${bootstrap.configured_emails.length} resolved`;
}

function HealthCheck({
  label,
  state,
}: {
  label: string;
  state: "ok" | "warning" | "error";
}) {
  const Icon = state === "ok" ? CheckCircle2 : AlertTriangle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        state === "ok" && "border-emerald-300 bg-emerald-50 text-emerald-700",
        state === "warning" && "border-amber-300 bg-amber-50 text-amber-700",
        state === "error" && "border-red-300 bg-red-50 text-red-700",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function keycloakAccessHealth(keycloak: KeycloakMigrationHealth["keycloak"]): {
  label: string;
  state: "ok" | "warning" | "error";
  hasIssue: boolean;
} {
  const status = keycloak.status ?? (keycloak.reachable ? "reachable" : "unreachable");
  if (status === "reachable") {
    return { label: "Keycloak reachable", state: "ok", hasIssue: false };
  }
  if (status === "admin_authorization_error") {
    return { label: "Keycloak admin unauthorized", state: "error", hasIssue: true };
  }
  if (status === "reconciliation_error") {
    return { label: "Keycloak reconciliation error", state: "error", hasIssue: true };
  }
  if (status === "unconfigured") {
    return { label: "Keycloak URL missing", state: "error", hasIssue: true };
  }
  return { label: "Keycloak unreachable", state: "error", hasIssue: true };
}

function displayText(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\bobo\b/gi, "OBO")
    .replace(/\bid\b/gi, "ID")
    .replace(/^\w/, (match) => match.toUpperCase());
}

function rowColumns(rows: Array<Record<string, unknown>>): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) columns.add(key);
  }
  return [...columns];
}

function ValueDisplay({ value }: { value: unknown }) {
  if (typeof value === "boolean") {
    return (
      <Badge variant={value ? "secondary" : "outline"} className="w-fit">
        {value ? "Yes" : "No"}
      </Badge>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">None</span>;
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((item, index) => (
          <Badge
            key={`${displayText(item)}-${index}`}
            variant="outline"
            className="max-w-full whitespace-normal break-all text-left font-mono text-[11px]"
          >
            {displayText(item)}
          </Badge>
        ))}
      </div>
    );
  }
  const text = displayText(value);
  const monospaced = /(^[a-z0-9][a-z0-9-]*$)|(_|-)|([0-9a-f]{8,})/i.test(text);
  return (
    <span
      className={cn(
        "min-w-0 break-words",
        monospaced && "rounded bg-muted px-1.5 py-1 font-mono text-[11px]",
      )}
    >
      {text}
    </span>
  );
}

export function KeycloakMigrationHealthPanel({ compact = false }: KeycloakMigrationHealthPanelProps) {
  const [health, setHealth] = useState<KeycloakMigrationHealth | null>(null);
  const hasLoadedHealthRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  // Tracks which surface initiated the active reconcile, so we can render an
  // inline "Fixing…" indicator on the originating row without rebuilding the
  // single-button affordance at the top of the panel. `null` = top button or
  // no reconcile in flight; otherwise it's the invariant id of the row that
  // triggered the run.
  const [reconcileOriginId, setReconcileOriginId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconcileMessage, setReconcileMessage] = useState<string | null>(null);
  const [selectedMetric, setSelectedMetric] = useState<MetricDetails | null>(null);

  const loadHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextHealth = await readJson<KeycloakMigrationHealth>(
        await fetch("/api/admin/keycloak/migration-health"),
      );
      hasLoadedHealthRef.current = true;
      setHealth(nextHealth);
    } catch (err) {
      if (hasLoadedHealthRef.current && isTransientFetchFailure(err)) {
        setError("Failed to refresh — connection error. Try again.");
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load Keycloak migration health");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  const runReconcile = useCallback(
    async (originId: string | null) => {
      setReconciling(true);
      setReconcileOriginId(originId);
      setError(null);
      setReconcileMessage(null);
      try {
        const result = await readJson<{ applied_counts?: Record<string, number>; warnings?: string[] }>(
          await fetch(`/api/admin/rebac/migrations/${KEYCLOAK_MIGRATION_ID}/apply`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirmation: KEYCLOAK_MIGRATION_CONFIRMATION }),
          }),
        );
        const warnings = result.warnings ?? [];
        if (warnings.length > 0) {
          setError(`Reconcile completed with errors: ${warnings.join("; ")}`);
        } else {
          const appliedCount = Object.values(result.applied_counts ?? {}).reduce(
            (sum, value) => sum + value,
            0,
          );
          // Every "Fix this" and "Reconcile all" click drives the same global
          // BFF migration, so we phrase the success line the same way regardless
          // of which surface initiated it.
          setReconcileMessage(
            `Reconcile applied${appliedCount ? ` (${appliedCount} updates)` : ""}.`,
          );
        }
        await loadHealth();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to reconcile Keycloak migration");
      } finally {
        setReconciling(false);
        setReconcileOriginId(null);
      }
    },
    [loadHealth],
  );

  const reconcileAll = useCallback(() => runReconcile(null), [runReconcile]);

  const lastRun = health?.migration.last_run;
  const bootstrapHasFailures = Boolean(health?.bootstrap_admins && health.bootstrap_admins.failed_count > 0);
  const keycloakAccess = health ? keycloakAccessHealth(health.keycloak) : null;
  const invariantsFailing = Boolean(
    health?.keycloak_invariants && health.keycloak_invariants.summary.failing > 0,
  );
  const invariantsRecommendReconcile = Boolean(
    health?.keycloak_invariants?.summary.reconcile_now_recommended,
  );
  const degraded = Boolean(
    error ||
      health?.blocking.is_blocking ||
      health?.migration.manifest_status === "failed" ||
      keycloakAccess?.hasIssue ||
      bootstrapHasFailures ||
      invariantsFailing,
  );
  const canReconcile = Boolean(
    health &&
      !compact &&
      health.keycloak.configured &&
      (health.blocking.is_blocking ||
        health.schema_area.status !== "current" ||
        health.migration.manifest_status === "failed" ||
        invariantsRecommendReconcile),
  );
  const Icon = degraded ? AlertTriangle : CheckCircle2;
  const healthContext = health
    ? {
        migration_id: health.migration.id,
        migration_status: health.migration.manifest_status,
        schema_area: health.schema_area.area,
        last_run: health.migration.last_run,
      }
    : {};
  const schemaHealthState =
    health?.schema_area.status === "current"
      ? "ok"
      : health?.schema_area.status === "behind"
        ? "warning"
        : "error";
  const bootstrapHealthState = bootstrapHasFailures ? "warning" : "ok";

  return (
    <Card className={cn(degraded && "border-amber-400/60")}>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" />
            Keycloak Reconciliation Health
          </CardTitle>
          <CardDescription>
            The app automatically keeps Keycloak team access in sync. First-time bootstrap setup is handled separately.
          </CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          {canReconcile && (
            <Button
              type="button"
              size="sm"
              onClick={reconcileAll}
              disabled={reconciling || loading}
              title="Apply the Keycloak reconciliation migration. Fixes every failing 'Reconcile now' invariant and retries bootstrap admin seeding in one transaction."
            >
              {reconciling ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <PlayCircle className="mr-2 h-4 w-4" />
              )}
              {reconciling && reconcileOriginId === null ? "Reconciling…" : "Reconcile all"}
            </Button>
          )}
          {health && (
            <CopyButton
              variant="outline"
              size="sm"
              value={() => JSON.stringify(health, null, 2)}
              copiedLabel="Copied JSON"
              label="Copy full Keycloak diagnostics JSON"
            >
              Copy diagnostics
            </CopyButton>
          )}
          <Button type="button" variant="outline" size="sm" onClick={loadHealth} disabled={loading || reconciling}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div className="flex items-start justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <span className="min-w-0 whitespace-pre-wrap break-words">{error}</span>
            <CopyButton
              value={error}
              label="Copy error"
              className="shrink-0 text-destructive hover:text-destructive"
            />
          </div>
        )}
        {reconcileMessage && (
          <div className="flex items-start justify-between gap-2 rounded-lg border border-emerald-300/60 bg-emerald-50 p-3 text-sm text-emerald-900">
            <span className="min-w-0 whitespace-pre-wrap break-words">{reconcileMessage}</span>
            <CopyButton
              value={reconcileMessage}
              label="Copy message"
              className="shrink-0 text-emerald-900 hover:text-emerald-900"
            />
          </div>
        )}
        {!health && !error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading Keycloak migration health...
          </div>
        )}
        {health && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Icon className={cn("h-4 w-4", degraded ? "text-amber-600" : "text-emerald-600")} />
              <span className="font-medium">Realm {health.keycloak.realm}</span>
              <HealthCheck
                label={health.keycloak.configured ? "Keycloak URL configured" : "Keycloak URL missing"}
                state={health.keycloak.configured ? "ok" : "error"}
              />
              <HealthCheck
                label={keycloakAccessHealth(health.keycloak).label}
                state={keycloakAccessHealth(health.keycloak).state}
              />
              <HealthCheck
                label={`Schema ${health.schema_area.status}`}
                state={schemaHealthState}
              />
              {health.bootstrap_admins && (
                <HealthCheck
                  label={bootstrapHasFailures ? "Bootstrap admin failures" : "Bootstrap admins seeded"}
                  state={bootstrapHealthState}
                />
              )}
              {health.keycloak_invariants && (
                <HealthCheck
                  label={
                    health.keycloak_invariants.summary.failing > 0
                      ? `${health.keycloak_invariants.summary.failing} invariant${
                          health.keycloak_invariants.summary.failing === 1 ? "" : "s"
                        } failing`
                      : health.keycloak_invariants.summary.unknown > 0
                        ? `${health.keycloak_invariants.summary.unknown} invariant${
                            health.keycloak_invariants.summary.unknown === 1 ? "" : "s"
                          } unknown`
                        : `${health.keycloak_invariants.summary.passing} invariants passing`
                  }
                  state={
                    health.keycloak_invariants.summary.failing > 0
                      ? "error"
                      : health.keycloak_invariants.summary.unknown > 0
                        ? "warning"
                        : "ok"
                  }
                />
              )}
            </div>

            <div className={cn("grid gap-2", compact ? "sm:grid-cols-2" : "sm:grid-cols-4")}>
              <Metric
                label="Schema area"
                value={health.schema_area.area}
                details={{
                  title: "Schema area details",
                  description: "Mongo schema-version state for the Keycloak reconciliation area.",
                  rows: [{ ...healthContext, ...health.schema_area }],
                }}
                onInspect={setSelectedMetric}
              />
              <Metric
                label="Version"
                value={formatVersionRange(health.schema_area.current_version, health.schema_area.target_version)}
                details={{
                  title: "Version details",
                  description: "Runtime target version compared to the persisted Mongo schema version.",
                  rows: [{
                    ...healthContext,
                    current_version: formatVersion(health.schema_area.current_version),
                    target_version: formatVersion(health.schema_area.target_version),
                    status: health.schema_area.status,
                  }],
                }}
                onInspect={setSelectedMetric}
              />
              <Metric
                label="Migration status"
                value={health.migration.manifest_status.replace(/_/g, " ")}
                tone={statusTone(health.migration.manifest_status)}
                details={{
                  title: "Migration status details",
                  description: "Last persisted migration run and status metadata.",
                  rows: [{
                    ...healthContext,
                    last_run_status: health.migration.last_run?.status ?? "not_started",
                    completed_at: health.migration.last_run?.completed_at,
                    updated_at: health.migration.last_run?.updated_at,
                    error: health.migration.last_run?.error,
                  }],
                }}
                onInspect={setSelectedMetric}
              />
              <Metric
                label="Last actor"
                value={lastRun?.actor ?? "none"}
                details={{
                  title: "Last actor details",
                  description: "The actor that last updated the Keycloak migration record.",
                  rows: [{ ...healthContext, actor: lastRun?.actor ?? null }],
                }}
                onInspect={setSelectedMetric}
              />
              {health.bootstrap_admins && (
                <Metric
                  label="Bootstrap admins"
                  value={formatBootstrapAdminStatus(health)}
                  tone={health.bootstrap_admins.failed_count > 0 ? "text-amber-600" : "text-emerald-600"}
                  details={{
                    title: "Bootstrap admins details",
                    description: "Email-based bootstrap admin resolution and durable OpenFGA tuple seeding.",
                    rows: health.bootstrap_admins.outcomes,
                  }}
                  onInspect={setSelectedMetric}
                />
              )}
            </div>

            {/*
              The raw `applied_counts` tile grid that used to live here
              (Mongo teams seen / Team scopes reconciled / OBO permission
              sets reconciled / Bot service accounts reconciled / Token
              exchange permissions reconciled / Active team defaults
              selected / Bootstrap admin {resolved,placeholders,tuples,
              failures}) was removed in 2026-05-24. Those values are
              last-run bookkeeping counters from the reconciliation
              algorithm — once Keycloak is steady they are just noise,
              and they don't tell an admin whether the realm is actually
              correctly configured.

              The Invariants section directly below this comment is now
              the single source of truth for "is Keycloak healthy", with
              per-row Fix buttons. The high-signal tiles (Schema area /
              Version / Migration status / Last actor / Bootstrap
              admins) stay at the top of the panel. Raw counts are still
              persisted on the migration record and visible via the JSON
              API for anyone debugging the migration itself.
            */}

            {!compact && ((lastRun?.warnings && lastRun.warnings.length > 0) || health.keycloak_values_error) && (
              <div className="space-y-1 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900">
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium">Warnings</div>
                  <CopyButton
                    value={[
                      ...(lastRun?.warnings ?? []),
                      ...(health.keycloak_values_error ? [`Keycloak value inspection failed: ${health.keycloak_values_error}`] : []),
                    ].join("\n")}
                    label="Copy warnings"
                    className="shrink-0 text-amber-900 hover:text-amber-900"
                  />
                </div>
                {(lastRun?.warnings ?? []).map((warning, idx) => {
                  const explanation = explainWarning(warning);
                  return (
                    <div
                      key={warning}
                      className="flex items-center gap-1.5"
                      data-testid={`migration-warning-row-${idx}`}
                    >
                      <span className="min-w-0 break-words">{warning}</span>
                      <ExplainerTooltip
                        explanation={explanation}
                        testId={`migration-warning-explain-${idx}`}
                        ariaLabel={`Explain warning: ${explanation.title}`}
                      />
                    </div>
                  );
                })}
                {health.keycloak_values_error && (
                  <div className="flex items-center gap-1.5" data-testid="keycloak-values-error-row">
                    <span className="min-w-0 break-words">
                      Keycloak value inspection failed: {health.keycloak_values_error}
                    </span>
                  </div>
                )}
              </div>
            )}

            {!compact && health.keycloak_invariants && (
              <InvariantsSection
                invariants={health.keycloak_invariants}
                reconciling={reconciling}
                reconcileOriginId={reconcileOriginId}
                onFixOne={runReconcile}
              />
            )}

            {(lastRun?.error || health.keycloak.probe_error) && (
              <div className="flex items-start justify-between gap-2 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900">
                <span className="min-w-0 whitespace-pre-wrap break-words">
                  {lastRun?.error ?? health.keycloak.probe_error}
                </span>
                <CopyButton
                  value={lastRun?.error ?? health.keycloak.probe_error ?? ""}
                  label="Copy error"
                  className="shrink-0 text-amber-900 hover:text-amber-900"
                />
              </div>
            )}
            {health.bootstrap_admins && health.bootstrap_admins.failed_count > 0 && (
              <div className="space-y-2 rounded-lg border border-amber-300/60 bg-amber-50 p-3 text-sm text-amber-900">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-1.5 font-medium">
                    <span>
                      Bootstrap admin reconciliation failed for{" "}
                      {health.bootstrap_admins.failed_count} email
                      {health.bootstrap_admins.failed_count === 1 ? "" : "s"}
                    </span>
                    {/*
                      Section-level "what does this mean?" affordance.
                      Hover this for the *concept* of bootstrap admin
                      reconciliation; per-row tooltips (below) explain
                      each specific email failure.
                    */}
                    <ExplainerTooltip
                      explanation={BOOTSTRAP_ADMIN_HEADER_EXPLANATION}
                      testId="bootstrap-admin-header-explain"
                      ariaLabel={`Explain bootstrap admin reconciliation: ${BOOTSTRAP_ADMIN_HEADER_EXPLANATION.title}`}
                    />
                  </div>
                  <CopyButton
                    value={() => JSON.stringify(health.bootstrap_admins, null, 2)}
                    label="Copy bootstrap admin details as JSON"
                    copiedLabel="Copied JSON"
                    className="shrink-0 text-amber-900 hover:text-amber-900"
                  />
                </div>
                {health.bootstrap_admins.warnings.length > 0 && (
                  <ul className="space-y-1 text-xs">
                    {health.bootstrap_admins.warnings.map((warning, idx) => {
                      const explanation: WarningExplanation = explainWarning(warning);
                      return (
                        <li
                          key={warning}
                          className="flex items-center gap-1.5"
                          data-testid={`bootstrap-admin-warning-row-${idx}`}
                        >
                          <span className="min-w-0 break-words">{warning}</span>
                          <ExplainerTooltip
                            explanation={explanation}
                            testId={`bootstrap-admin-warning-explain-${idx}`}
                            ariaLabel={`Explain bootstrap admin warning: ${explanation.title}`}
                          />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
      <Dialog open={selectedMetric !== null} onOpenChange={(open) => !open && setSelectedMetric(null)}>
        <DialogContent
          className="flex max-h-[88vh] w-[calc(100vw-2rem)] flex-col overflow-hidden"
          style={{ maxWidth: "min(960px, calc(100vw - 2rem))" }}
        >
          <DialogHeader className="min-w-0 pr-8">
            <DialogTitle>{selectedMetric?.title}</DialogTitle>
            <DialogDescription>{selectedMetric?.description}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 min-w-0 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium">Keycloak values</div>
              <Badge variant="outline">
                {selectedMetric?.rows.length ?? 0} {(selectedMetric?.rows.length ?? 0) === 1 ? "row" : "rows"}
              </Badge>
            </div>
            <div
              data-testid="keycloak-values-scroll"
              className="max-h-[62vh] min-w-0 space-y-3 overflow-auto pr-1"
            >
              {(selectedMetric?.rows.length ?? 0) > 0 ? (
                (selectedMetric?.rows ?? []).map((row, index) => (
                  <div
                    key={`${selectedMetric?.title ?? "metric"}-${index}`}
                    className="min-w-0 rounded-xl border bg-muted/20 p-4"
                  >
                    <div className="mb-3 text-xs font-medium text-muted-foreground">
                      Result {index + 1}
                    </div>
                    <dl className="grid min-w-0 gap-3 md:grid-cols-2">
                      {rowColumns([row]).map((column) => (
                        <div key={column} className="min-w-0 space-y-1 rounded-lg bg-background/70 p-3">
                          <dt className="text-xs font-medium text-muted-foreground">{humanizeKey(column)}</dt>
                          <dd className="min-w-0 text-sm">
                            <ValueDisplay value={row[column]} />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))
              ) : (
                <div className="p-4 text-sm text-muted-foreground">
                  No Keycloak values were returned for this metric.
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function InvariantStatusPill({ status }: { status: InvariantStatus }) {
  if (status === "pass") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
        <CheckCircle2 className="h-3 w-3" />
        Pass
      </span>
    );
  }
  if (status === "fail") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-red-300 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
        <XCircle className="h-3 w-3" />
        Fail
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
      <HelpCircle className="h-3 w-3" />
      Unknown
    </span>
  );
}

function formatInvariantForCopy(item: KeycloakInvariant): string {
  // Stable, plain-text shape so admins can paste it into a ticket and the
  // ordering matches what they see on screen. Newline-delimited so it
  // renders cleanly without a JSON viewer.
  const lines = [
    `# ${item.description}`,
    `id: ${item.id}`,
    `status: ${item.status}`,
    `group: ${item.group}`,
    `source: ${item.source}`,
    `remediation: ${item.remediation}`,
  ];
  if (item.detail) lines.push("", item.detail);
  return lines.join("\n");
}

function InvariantsSection({
  invariants,
  reconciling,
  reconcileOriginId,
  onFixOne,
}: {
  invariants: NonNullable<KeycloakMigrationHealth["keycloak_invariants"]>;
  reconciling: boolean;
  reconcileOriginId: string | null;
  onFixOne: (originId: string) => void | Promise<void>;
}) {
  // Open failing groups by default so admins see remediation hints
  // without an extra click; happy-path realms render fully collapsed
  // to keep the tile compact.
  const initialOpen = useMemo(() => {
    const set = new Set<InvariantGroup>();
    for (const item of invariants.items) {
      if (item.status !== "pass") set.add(item.group);
    }
    return set;
  }, [invariants.items]);

  const [openGroups, setOpenGroups] = useState<Set<InvariantGroup>>(initialOpen);

  const grouped = useMemo(() => {
    const map = new Map<InvariantGroup, KeycloakInvariant[]>();
    for (const item of invariants.items) {
      const list = map.get(item.group) ?? [];
      list.push(item);
      map.set(item.group, list);
    }
    return map;
  }, [invariants.items]);

  const toggle = (group: InvariantGroup) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  return (
    <section
      aria-label="Keycloak invariants"
      data-testid="keycloak-invariants"
      className="space-y-2 rounded-lg border bg-muted/10 p-3"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Shield className="h-4 w-4" />
          Keycloak invariants
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Badge variant="outline" className="border-emerald-300 text-emerald-700">
            {invariants.summary.passing} pass
          </Badge>
          <Badge
            variant="outline"
            className={cn(
              invariants.summary.failing > 0
                ? "border-red-300 text-red-700"
                : "border-muted text-muted-foreground",
            )}
          >
            {invariants.summary.failing} fail
          </Badge>
          {invariants.summary.unknown > 0 && (
            <Badge variant="outline" className="border-amber-300 text-amber-700">
              {invariants.summary.unknown} unknown
            </Badge>
          )}
        </div>
      </header>

      <p className="text-xs text-muted-foreground">
        Each invariant corresponds to one provisioning step from{" "}
        <code className="rounded bg-muted px-1 font-mono text-[10px]">init-idp.sh</code>,{" "}
        <code className="rounded bg-muted px-1 font-mono text-[10px]">init-token-exchange.sh</code>
        , or the BFF startup migration. Failing checks marked &quot;Reconcile now&quot; can be
        repaired by &quot;Reconcile all&quot; at the top of this card, or row-by-row with the
        &quot;Fix&quot; button next to each item; failures marked &quot;Manual&quot; require direct
        Keycloak Admin Console action.
      </p>

      <ul className="space-y-2">
        {INVARIANT_GROUP_ORDER.filter((group) => grouped.has(group)).map((group) => {
          const items = grouped.get(group)!;
          const failing = items.filter((item) => item.status === "fail").length;
          const unknown = items.filter((item) => item.status === "unknown").length;
          const isOpen = openGroups.has(group);
          return (
            <li key={group} className="rounded-md border bg-background">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/40"
                onClick={() => toggle(group)}
                aria-expanded={isOpen}
                aria-controls={`invariants-${group}`}
              >
                <span className="flex items-center gap-2 font-medium">
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                  {INVARIANT_GROUP_LABELS[group]}
                </span>
                <span className="flex items-center gap-1.5">
                  {failing > 0 && (
                    <Badge variant="outline" className="border-red-300 text-red-700">
                      {failing} fail
                    </Badge>
                  )}
                  {unknown > 0 && (
                    <Badge variant="outline" className="border-amber-300 text-amber-700">
                      {unknown} unknown
                    </Badge>
                  )}
                  {failing === 0 && unknown === 0 && (
                    <Badge variant="outline" className="border-emerald-300 text-emerald-700">
                      {items.length} pass
                    </Badge>
                  )}
                </span>
              </button>
              {isOpen && (
                <ul id={`invariants-${group}`} className="divide-y border-t">
                  {items.map((item) => {
                    const isFailing = item.status !== "pass";
                    const isReconcileNow =
                      item.remediation === "reconcile_now" && isFailing;
                    const isThisRowFixing =
                      reconciling && reconcileOriginId === item.id;
                    return (
                      <li
                        key={item.id}
                        className="space-y-1 px-3 py-2"
                        data-testid={`invariant-${item.id}`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
                          <div className="min-w-0 space-y-0.5">
                            {/*
                              Plain-English explainer rendered as a hover
                              tooltip on a HelpCircle affordance next to
                              the description. The machine ID below the
                              description (e.g. `obo.token_exchange.shared
                              _audience.exists`) is accurate but cryptic;
                              the tooltip body tells admins what the check
                              is verifying and what breaks if it fails.
                              The decoder lives in
                              `./invariant-explanations.ts` and is unit
                              tested against every ID emitted by
                              `keycloak-invariants.ts` to prevent shipping
                              the fallback message.
                            */}
                            {(() => {
                              const explanation = explainInvariant(item.id);
                              return (
                                <div className="flex items-center gap-1.5">
                                  <span className="font-medium">{item.description}</span>
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <button
                                          type="button"
                                          aria-label={`Explain ${item.description}: ${explanation.title}`}
                                          className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                          data-testid={`invariant-explain-${item.id}`}
                                        >
                                          <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                                        </button>
                                      </TooltipTrigger>
                                      <TooltipContent
                                        side="bottom"
                                        sideOffset={6}
                                        // Override the primitive's default
                                        // `whitespace-nowrap` so the body
                                        // wraps. ~360px reads comfortably
                                        // for 2-4 sentence explanations
                                        // without dominating the viewport.
                                        className="whitespace-normal max-w-sm w-max text-left font-normal leading-snug p-3"
                                      >
                                        <div className="space-y-1">
                                          <p className="font-semibold text-popover-foreground">
                                            {explanation.title}
                                          </p>
                                          <p className="text-muted-foreground text-[11px]">
                                            {explanation.body}
                                          </p>
                                        </div>
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                </div>
                              );
                            })()}
                            <div className="font-mono text-[10px] text-muted-foreground">
                              {item.id}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <InvariantStatusPill status={item.status} />
                            {isReconcileNow && (
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                className="h-7 px-2 text-[10px]"
                                onClick={() => onFixOne(item.id)}
                                disabled={reconciling}
                                title="Run the Keycloak reconciliation migration. Fixes every failing 'Reconcile now' invariant in one transaction; this row triggered it."
                                data-testid={`invariant-fix-${item.id}`}
                              >
                                {isThisRowFixing ? (
                                  <>
                                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                    Fixing…
                                  </>
                                ) : (
                                  "Fix"
                                )}
                              </Button>
                            )}
                            {item.remediation === "manual_keycloak" && isFailing && (
                              <Badge variant="outline" className="border-amber-300 text-[10px] text-amber-700">
                                Manual
                              </Badge>
                            )}
                            {isFailing && (
                              <CopyButton
                                value={() => formatInvariantForCopy(item)}
                                label={`Copy diagnostic for ${item.id}`}
                                className="h-7 w-7"
                              />
                            )}
                          </div>
                        </div>
                        {item.detail && (
                          <p className="text-xs text-muted-foreground">{item.detail}</p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
  details,
  onInspect,
}: {
  label: string;
  value: string;
  tone?: string;
  details?: MetricDetails;
  onInspect?: (details: MetricDetails) => void;
}) {
  const content = (
    <>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("break-words font-medium", tone)}>{value}</div>
    </>
  );
  if (details && onInspect) {
    return (
      <button
        type="button"
        aria-label={`Inspect ${label} metric`}
        className="rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onInspect(details)}
      >
        {content}
      </button>
    );
  }
  return (
    <div className="rounded-lg border p-3 text-sm">
      {content}
    </div>
  );
}
