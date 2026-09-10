"use client";

// assisted-by Codex Codex-sonnet-4-6
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  usePlatformHealthProbes,
  type PlatformHealthCapability,
  type PlatformDiagnosticProbe,
} from "@/hooks/use-platform-health-probes";
import { useVersion } from "@/hooks/use-version";
import { formatBuildIdentifier,formatComponentVersion } from "@/lib/build-identifier";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  ExternalLink,
  HelpCircle,
  Loader2,
  MessageSquare,
  RefreshCw,
  XCircle,
} from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";

type HealthStatus = "healthy" | "degraded" | "down" | "unknown";
type UiStatus = HealthStatus | "disabled";

const STATUS_CONFIG: Record<
  UiStatus,
  { icon: typeof CheckCircle2; color: string; bg: string; label: string }
> = {
  healthy: {
    icon: CheckCircle2,
    color: "text-green-500",
    bg: "bg-green-500",
    label: "Healthy",
  },
  degraded: {
    icon: AlertTriangle,
    color: "text-yellow-500",
    bg: "bg-yellow-500",
    label: "Degraded",
  },
  down: {
    icon: XCircle,
    color: "text-red-500",
    bg: "bg-red-500",
    label: "Down",
  },
  unknown: {
    icon: HelpCircle,
    color: "text-muted-foreground",
    bg: "bg-muted-foreground",
    label: "Unknown",
  },
  disabled: {
    icon: CircleSlash,
    color: "text-muted-foreground",
    bg: "bg-muted-foreground/60",
    label: "Disabled",
  },
};

const GROUP_LABELS: Record<PlatformHealthCapability["group"], string> = {
  runtime: "Runtime",
  knowledge: "Knowledge",
  identity: "Identity",
  observability: "Observability",
  messaging: "Messaging",
};

const PROBE_GROUP_LABELS: Record<PlatformDiagnosticProbe["group"], string> = {
  runtime: "Runtime",
  identity: "Identity",
  storage: "Storage",
  knowledge: "Knowledge",
  bootstrap: "Bootstrap",
  observability: "Observability",
};

const CAPABILITY_PROBES: Record<string, string[]> = {
  "chat-runtime": ["dynamic-agents-runtime", "agentgateway", "agentgateway-config-bridge", "caipe-mongodb"],
  "dynamic-agents": ["dynamic-agents-runtime", "agentgateway", "agentgateway-config-bridge", "caipe-mongodb"],
  "knowledge-bases": ["rag-server", "rag-redis", "milvus", "milvus-minio", "etcd", "web-ingestor"],
  authentication: [
    "keycloak",
    "openfga",
    "openfga-authz-bridge",
    "keycloak-postgres",
    "openfga-postgres",
    "keycloak-bootstrap",
    "openfga-bootstrap",
    "rebac-migrations",
  ],
  metrics: [],
  "audit-service": ["audit-service", "caipe-mongodb"],
  "slack-integration": [],
  "webex-integration": [],
};

interface SlackDirectoryStatus {
  configured: boolean;
  bot_admin: { reachable: boolean; error?: string };
  users: {
    status: "warming" | "ready" | "stale" | "empty";
    users_indexed: number;
    active_users_indexed: number;
    pages_scanned: number;
    members_seen: number;
    fetched_at: number | null;
    updated_at: number | null;
    started_at: number | null;
    last_error?: string;
  };
  emoji: {
    status: "warming" | "ready" | "stale" | "empty";
    emoji_indexed: number;
    fetched_at: number | null;
    updated_at: number | null;
    started_at: number | null;
    last_error?: string;
  };
}

interface WebexDirectoryStatus {
  configured: boolean;
  bot_admin: {
    reachable: boolean;
    error?: string;
    runtime?: {
      route_mode?: string;
      static_spaces?: number;
      static_routes?: number;
      cache_size?: number;
    };
  };
  platform: {
    reachable: boolean;
    spaces_onboarded: number;
    routes_configured: number;
    error?: string;
  };
  space_discovery: {
    configured: boolean;
    status: "warming" | "ready" | "stale" | "empty";
    spaces_indexed: number;
    fetched_at: number | null;
    updated_at: number | null;
    started_at: number | null;
    ttl_seconds?: number;
    last_error?: string;
  };
}

function capabilityToUiStatus(status: PlatformHealthCapability["status"]): UiStatus {
  return status;
}

export function HealthTab() {
  const { versionInfo } = useVersion();
  const {
    capabilities,
    summary,
    probes,
    probeSummary,
    status: platformStatus,
    checkNow: refreshPlatformHealth,
    secondsUntilNextCheck,
  } = usePlatformHealthProbes({ diagnostics: true });

  const systemStatus: UiStatus =
    platformStatus === "checking" ? "unknown" : platformStatus;
  const overallConfig = STATUS_CONFIG[systemStatus];
  const OverallIcon = overallConfig.icon;
  const buildIdentifier = formatBuildIdentifier({
    version: versionInfo?.version,
    packageVersion: versionInfo?.packageVersion,
    gitCommit: versionInfo?.gitCommit,
  }) ?? "Development";
  const [slackStatus, setSlackStatus] = useState<SlackDirectoryStatus | null>(null);
  const [slackStatusError, setSlackStatusError] = useState<string | null>(null);
  const [webexStatus, setWebexStatus] = useState<WebexDirectoryStatus | null>(null);
  const [webexStatusError, setWebexStatusError] = useState<string | null>(null);
  const [selectedCapability, setSelectedCapability] = useState<PlatformHealthCapability | null>(null);
  const [resolvingNotification,setResolvingNotification] = useState(false);
  const [resolutionMessage,setResolutionMessage] = useState<string | null>(null);

  const loadSlackStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/slack/directory/status");
      const payload = await res.json();
      if (res.ok && payload.success) {
        setSlackStatus(payload.data);
        setSlackStatusError(null);
      } else {
        setSlackStatus(null);
        setSlackStatusError(
          typeof payload?.error === "string" ? payload.error : "Slack status check failed",
        );
      }
    } catch {
      setSlackStatus(null);
      setSlackStatusError("Slack status check failed");
    }
  }, []);

  const loadWebexStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/webex/directory/status");
      const payload = await res.json();
      if (res.ok && payload.success) {
        setWebexStatus(payload.data);
        setWebexStatusError(null);
      } else {
        setWebexStatus(null);
        setWebexStatusError(
          typeof payload?.error === "string" ? payload.error : "Webex status check failed",
        );
      }
    } catch {
      setWebexStatus(null);
      setWebexStatusError("Webex status check failed");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSlackStatus();
      void loadWebexStatus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadSlackStatus, loadWebexStatus]);

  const refreshAll = useCallback(() => {
    refreshPlatformHealth();
    void loadSlackStatus();
    void loadWebexStatus();
  }, [refreshPlatformHealth, loadSlackStatus, loadWebexStatus]);

  const slackCapability = capabilities.find((capability) => capability.id === "slack-integration") ?? null;
  const webexCapability = capabilities.find((capability) => capability.id === "webex-integration") ?? null;
  const showSlack = slackStatus?.configured === true || Boolean(slackCapability);
  const showWebex = webexStatus?.configured === true || Boolean(webexCapability);
  const selectedCapabilityProbes = selectedCapability
    ? diagnosticsForCapability(selectedCapability.id, probes)
    : [];

  const resolveNotification = useCallback(async () => {
    if (!selectedCapability) return;
    setResolvingNotification(true);
    setResolutionMessage(null);
    try {
      const response = await fetch(`/api/admin/platform/health/notifications/${encodeURIComponent(selectedCapability.id)}`,{
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "Reviewed and resolved by a platform administrator." }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Could not resolve the platform notification");
      setResolutionMessage("Platform notification resolved for everyone.");
      window.dispatchEvent(new Event("in-app-notifications:refresh"));
    } catch (error) {
      setResolutionMessage(error instanceof Error ? error.message : "Could not resolve the platform notification");
    } finally {
      setResolvingNotification(false);
    }
  },[selectedCapability]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Build information</CardTitle>
          <CardDescription>
            Running CAIPE UI build. Component release versions appear beside each capability below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 rounded-lg border border-border/70 p-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Version</dt>
              <dd className="mt-1 font-medium">{buildIdentifier}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Commit</dt>
              <dd className="mt-1 truncate font-mono text-xs">{versionInfo?.gitCommit ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Built</dt>
              <dd className="mt-1 text-xs">{versionInfo?.buildDate ?? "Unavailable"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card
        className={cn(
          "border-l-4",
          systemStatus === "healthy" && "border-l-green-500",
          systemStatus === "degraded" && "border-l-yellow-500",
          systemStatus === "down" && "border-l-red-500",
          systemStatus === "unknown" && "border-l-muted-foreground",
        )}
      >
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <OverallIcon className={cn("h-6 w-6 shrink-0", overallConfig.color)} />
            <div className="min-w-0">
              <p className="font-medium">System Status: {overallConfig.label}</p>
              <p className="text-xs text-muted-foreground">
                {summary
                  ? `${summary.healthy} healthy · ${summary.degraded} degraded · ${summary.down} down · ${summary.disabled} disabled`
                  : "Checking platform status"}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={refreshAll}
            disabled={platformStatus === "checking"}
          >
            {platformStatus === "checking" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
              <CardTitle>Platform Capabilities</CardTitle>
              <CardDescription>
                Select a capability to inspect upstream service probes.
              </CardDescription>
            </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-end text-xs text-muted-foreground">
            <span>
              {probeSummary ? `${probeSummary.healthy}/${probeSummary.total} probes ready · ` : null}
              Next check: {secondsUntilNextCheck}s
            </span>
          </div>

          {platformStatus === "checking" && capabilities.length === 0 ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Checking platform capabilities...</span>
            </div>
          ) : (
            <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
              {capabilities.map((capability) => {
                const capabilityProbes = diagnosticsForCapability(capability.id, probes);
                return (
                  <CapabilityRow
                    key={capability.id}
                    capability={capability}
                    probeCount={capabilityProbes.length}
                    issueCount={capabilityProbes.filter((probe) => probe.status !== "healthy").length}
                    onSelect={() => setSelectedCapability(capability)}
                  />
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {(showSlack || showWebex) && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Integrations</CardTitle>
              </div>
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {showSlack && slackStatus?.configured ? (
              <SlackIntegrationStatus status={slackStatus} />
            ) : showSlack ? (
              <IntegrationCapabilityStatus
                title="Slack"
                capability={slackCapability}
                error={slackStatusError}
              />
            ) : null}
            {showWebex && webexStatus?.configured ? (
              <WebexIntegrationStatus status={webexStatus} />
            ) : showWebex ? (
              <IntegrationCapabilityStatus
                title="Webex"
                capability={webexCapability}
                error={webexStatusError}
              />
            ) : null}
          </CardContent>
        </Card>
      )}

      <CapabilityDiagnosticsDialog
        capability={selectedCapability}
        probes={selectedCapabilityProbes}
        onResolveNotification={resolveNotification}
        resolvingNotification={resolvingNotification}
        resolutionMessage={resolutionMessage}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedCapability(null);
            setResolutionMessage(null);
          }
        }}
      />
    </div>
  );
}

function diagnosticsForCapability(
  capabilityId: string,
  probes: PlatformDiagnosticProbe[],
): PlatformDiagnosticProbe[] {
  const probeIds = CAPABILITY_PROBES[capabilityId] ?? [];
  const idOrder = new Map(probeIds.map((id, index) => [id, index]));
  return probes
    .filter((probe) => idOrder.has(probe.id))
    .sort((left, right) => (idOrder.get(left.id) ?? 0) - (idOrder.get(right.id) ?? 0));
}

function CapabilityRow({
  capability,
  probeCount,
  issueCount,
  onSelect,
}: {
  capability: PlatformHealthCapability;
  probeCount: number;
  issueCount: number;
  onSelect: () => void;
}) {
  const status = capabilityToUiStatus(capability.status);
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  const version = formatComponentVersion(capability.version);
  const statusNote =
    capability.status === "down" && capability.required
      ? "Required capability unavailable; platform status is down."
      : capability.status === "degraded" && !capability.required
        ? "Optional capability unavailable; platform status is degraded."
        : capability.status === "disabled"
          ? "Disabled capabilities do not affect platform status."
          : null;

  return (
    <button
      type="button"
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 bg-muted/30 px-4 py-3 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onSelect}
      aria-label={`Inspect ${capability.label} health details`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{capability.label}</p>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {GROUP_LABELS[capability.group]}
          </span>
          {capability.required ? (
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
              Required
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {capability.description}
        </p>
        <p className="mt-1 text-xs text-muted-foreground/85">
          {capability.detail}
          {capability.latency_ms !== null ? ` · ${capability.latency_ms}ms` : ""}
        </p>
        {statusNote ? (
          <p className="mt-1 text-xs text-muted-foreground/85">{statusNote}</p>
        ) : null}
        {probeCount > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground/85">
            {probeCount} upstream probe{probeCount === 1 ? "" : "s"}
            {issueCount > 0 ? ` · ${issueCount} need attention` : ""}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="text-right">
          <div className="flex items-center justify-end gap-2">
            <Icon className={cn("h-4 w-4", cfg.color)} />
            <span className="text-sm">{cfg.label}</span>
          </div>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground/80">
            {version ?? "Version not reported"}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>
    </button>
  );
}

function probeToUiStatus(status: PlatformDiagnosticProbe["status"]): UiStatus {
  return status === "warning" ? "degraded" : status;
}

function CapabilityDiagnosticsDialog({
  capability,
  probes,
  onOpenChange,
  onResolveNotification,
  resolvingNotification,
  resolutionMessage,
}: {
  capability: PlatformHealthCapability | null;
  probes: PlatformDiagnosticProbe[];
  onOpenChange: (open: boolean) => void;
  onResolveNotification: () => void;
  resolvingNotification: boolean;
  resolutionMessage: string | null;
}) {
  if (!capability) return null;

  const status = capabilityToUiStatus(capability.status);
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  const unhealthy = probes.filter((probe) => probe.status !== "healthy").length;

  return (
    <Dialog open={Boolean(capability)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className={cn("h-5 w-5", cfg.color)} />
            {capability.label}
          </DialogTitle>
          <DialogDescription>
            {capability.description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="rounded-lg border border-border/70 bg-muted/25 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Capability Status</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {capability.detail}
                  {capability.latency_ms !== null ? ` · ${capability.latency_ms}ms` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2 rounded-full border border-border bg-background px-2.5 py-1 text-xs">
                <StatusDot status={status} />
                {cfg.label}
              </div>
            </div>
            {capability.status === "degraded" || capability.status === "down" ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
                <p className="text-xs text-muted-foreground">
                  Human resolution closes the shared Platform notification for every user. A continuing failure can reopen it after audit confirmation.
                </p>
                <Button disabled={resolvingNotification} onClick={onResolveNotification} size="sm" variant="outline">
                  {resolvingNotification ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                  Resolve notification
                </Button>
              </div>
            ) : null}
            {resolutionMessage ? <p className="mt-2 text-xs text-muted-foreground">{resolutionMessage}</p> : null}
          </section>

          {probes.length > 0 ? (
            <section className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Upstream Probes</p>
                  <p className="text-xs text-muted-foreground">
                    {probes.length - unhealthy}/{probes.length} ready
                    {unhealthy > 0 ? ` · ${unhealthy} need attention` : ""}
                  </p>
                </div>
              </div>
              <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
                {probes.map((probe) => (
                  <DiagnosticProbeRow key={probe.id} probe={probe} />
                ))}
              </div>
            </section>
          ) : (
            <section className="rounded-lg border border-border/70 bg-muted/20 p-3 text-sm text-muted-foreground">
              No additional upstream probes are registered for this capability.
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DiagnosticProbeRow({ probe }: { probe: PlatformDiagnosticProbe }) {
  const status = probeToUiStatus(probe.status);
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 bg-muted/30 px-4 py-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{probe.label}</p>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {PROBE_GROUP_LABELS[probe.group]}
          </span>
        </div>
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {probe.detail}
          {probe.latency_ms !== null ? ` · ${probe.latency_ms}ms` : ""}
        </p>
        <p className="mt-1 break-all text-[11px] text-muted-foreground/75">{probe.target}</p>
        {probe.remediation ? (
          <a
            href={probe.remediation.href}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {probe.remediation.label}
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Icon className={cn("h-4 w-4", cfg.color)} />
        <span className="text-sm">{probe.status === "warning" ? "Warning" : cfg.label}</span>
      </div>
    </div>
  );
}

function cacheStateToStatus(status: SlackDirectoryStatus["users"]["status"], error?: string): UiStatus {
  if (error) return "degraded";
  if (status === "ready") return "healthy";
  if (status === "warming" || status === "stale") return "degraded";
  return "unknown";
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return "never";
  return new Date(ts).toLocaleTimeString();
}

function StatusDot({ status }: { status: UiStatus }) {
  const cfg = STATUS_CONFIG[status];
  return <span className={cn("h-2 w-2 rounded-full", cfg.bg)} />;
}

function IntegrationPanel({
  title,
  status,
  children,
}: {
  title: string;
  status: UiStatus;
  children: React.ReactNode;
}) {
  const cfg = STATUS_CONFIG[status];

  return (
    <section className="rounded-lg border border-border/70 bg-muted/25 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">{title}</div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <StatusDot status={status} />
          {cfg.label}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">{children}</div>
    </section>
  );
}

function StatTile({
  title,
  status,
  detail,
  meta,
}: {
  title: string;
  status: UiStatus;
  detail: string;
  meta?: string;
}) {
  return (
    <div className="rounded-md border border-border/70 bg-background/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-foreground">{title}</div>
        <StatusDot status={status} />
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
      {meta ? <div className="mt-1 text-[11px] text-muted-foreground/80">{meta}</div> : null}
    </div>
  );
}

function SlackIntegrationStatus({ status }: { status: SlackDirectoryStatus }) {
  const botStatus: UiStatus = status.bot_admin.reachable ? "healthy" : "degraded";
  const usersStatus = cacheStateToStatus(status.users.status, status.users.last_error);
  const emojiStatus = cacheStateToStatus(status.emoji.status, status.emoji.last_error);
  const overall: UiStatus =
    [botStatus, usersStatus, emojiStatus].includes("degraded") ? "degraded" : "healthy";

  return (
    <IntegrationPanel title="Slack" status={overall}>
      <StatTile
        title="Bot Admin API"
        status={botStatus}
        detail={status.bot_admin.reachable ? "Reachable" : "Unreachable"}
        meta={status.bot_admin.error}
      />
      <StatTile
        title="User Directory Cache"
        status={usersStatus}
        detail={`${status.users.status}: ${status.users.active_users_indexed} active / ${status.users.users_indexed} indexed`}
        meta={`${status.users.pages_scanned} pages · ${status.users.members_seen} records · updated ${formatTime(status.users.updated_at)}`}
      />
      <StatTile
        title="Emoji Cache"
        status={emojiStatus}
        detail={`${status.emoji.status}: ${status.emoji.emoji_indexed} indexed`}
        meta={`updated ${formatTime(status.emoji.updated_at)}`}
      />
    </IntegrationPanel>
  );
}

function WebexIntegrationStatus({ status }: { status: WebexDirectoryStatus }) {
  const botStatus: UiStatus = status.bot_admin.reachable ? "healthy" : "degraded";
  const platformStatus: UiStatus = status.platform.reachable ? "healthy" : "degraded";
  const discoveryStatus = cacheStateToStatus(status.space_discovery.status, status.space_discovery.last_error);
  const overall: UiStatus =
    [botStatus, platformStatus, discoveryStatus].includes("degraded") ? "degraded" : "healthy";
  const runtime = status.bot_admin.runtime;

  return (
    <IntegrationPanel title="Webex" status={overall}>
      <StatTile
        title="Bot Admin API"
        status={botStatus}
        detail={status.bot_admin.reachable ? "Reachable" : "Unreachable"}
        meta={runtime ? `${runtime.route_mode ?? "routes"} · ${runtime.cache_size ?? 0} cached` : status.bot_admin.error}
      />
      <StatTile
        title="Platform Configuration"
        status={platformStatus}
        detail={`${status.platform.spaces_onboarded} spaces onboarded · ${status.platform.routes_configured} routes configured`}
        meta={status.platform.error}
      />
      <StatTile
        title="Space Discovery Cache"
        status={discoveryStatus}
        detail={
          status.space_discovery.configured
            ? `${status.space_discovery.status}: ${status.space_discovery.spaces_indexed} indexed`
            : "Not configured"
        }
        meta={`updated ${formatTime(status.space_discovery.updated_at)}`}
      />
    </IntegrationPanel>
  );
}

function IntegrationCapabilityStatus({
  title,
  capability,
  error,
}: {
  title: string;
  capability: PlatformHealthCapability | null;
  error: string | null;
}) {
  const status = capability ? capabilityToUiStatus(capability.status) : "degraded";
  const detail = capability?.detail ?? error ?? "Status check failed";

  return (
    <IntegrationPanel title={title} status={status}>
      <StatTile
        title="Integration Status"
        status={status}
        detail={detail}
        meta={error && error !== detail ? error : undefined}
      />
    </IntegrationPanel>
  );
}
