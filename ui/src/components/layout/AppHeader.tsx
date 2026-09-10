"use client";

import {
  ApplicationNavigationMenuButton,
  MobileApplicationBrand,
} from "@/components/layout/ApplicationNavigation";
import { ApplicationNavigationSearchTrigger } from "@/components/layout/ApplicationNavigationSearch";
import { isOnHeaderDialogEditor } from "@/components/layout/GuardedNavigationLink";
import { ReleaseUpgradeDialog } from "@/components/release/ReleaseUpgradeDialog";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { SettingsPanel } from "@/components/settings-panel";
import { UnsavedChangesDialog } from "@/components/shared/UnsavedChangesDialog";
import { ReportProblemDialog } from "@/components/ticket/ReportProblemDialog";
import { Button } from "@/components/ui/button";
import { useHeaderBreadcrumbSlot } from "@/components/layout/HeaderBreadcrumbSlot";
import {
WorkspaceBreadcrumbs,
type WorkspaceBreadcrumbItem,
} from "@/components/layout/WorkspacePageHeader";
import { GithubIcon as Github } from "@/components/ui/icons";
import {
Popover,
PopoverContent,
PopoverTrigger,
} from "@/components/ui/popover";
import { UserMenu } from "@/components/user-menu";
import { useAdminRole } from "@/hooks/use-admin-role";
import { useKeycloakHealthSummary } from "@/hooks/use-keycloak-health-summary";
import { useMigrationStatus } from "@/hooks/use-migration-status";
import { useReleaseUpgradePrompt } from "@/hooks/use-release-upgrade-prompt";
import { config } from "@/lib/config";
import { pushWithNavigationProgress } from "@/lib/navigation-progress";
import { cn } from "@/lib/utils";
import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import {
AlertTriangle,
BookOpen,
ChevronRight,
MessageSquareText,
} from "lucide-react";
import { useSession } from "next-auth/react";
import { usePathname,useRouter } from "next/navigation";
import React from "react";

const APPLICATION_SECTION_LABELS: Record<string,string> = {
  "agent-builder": "Agent Builder",
  admin: "Admin",
  autonomous: "Autonomous",
  apps: "Apps",
  chat: "Chat",
  credentials: "Credentials",
  "dynamic-agents": "Agents",
  insights: "Insights",
  "knowledge-bases": "Knowledge Bases",
  schedules: "Schedules",
  settings: "Settings",
  skills: "Skills",
  workflows: "Workflows",
};

function titleCaseRouteSegment(segment: string): string {
  return segment
    .split("-")
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

/** Header fallback for routes that do not provide a more specific trail. */
export function getApplicationBreadcrumbs(
  pathname: string,
): WorkspaceBreadcrumbItem[] {
  const section = pathname.split("/").filter(Boolean)[0];
  if (!section) return [];

  return [
    { label: "Home",href: "/" },
    {
      label: APPLICATION_SECTION_LABELS[section] ?? titleCaseRouteSegment(section),
      href: `/${section}`,
    },
  ];
}

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const breadcrumbSlot = useHeaderBreadcrumbSlot();
  const fallbackBreadcrumbs = getApplicationBreadcrumbs(pathname);
  const { data: session } = useSession();
  const { isAdmin } = useAdminRole();
  const {
    hasUnsavedChanges,
    pendingNavigationHref,
    cancelNavigation,
    confirmNavigation,
    requestNavigation,
    setUnsaved,
  } = useUnsavedChangesStore();

  // Editors in EDITOR_ROUTES_WITH_HEADER_DIALOG (Workflows, Dynamic Agent
  // editor) ask the AppHeader to render the discard dialog on their behalf
  // for application-navigation clicks. Other editors (e.g. /skills/workspace) own their own
  // in-page dialog and consume `pendingNavigationHref` directly — that keeps
  // the dialog visually consistent with each editor's "Back" button.
  const shouldRenderHeaderDialog =
    isOnHeaderDialogEditor(pathname) && hasUnsavedChanges;

  const handleDiscard = React.useCallback(() => {
    const href = confirmNavigation();
    if (href) {
      setUnsaved(false);
      pushWithNavigationProgress(router,href);
    }
  }, [confirmNavigation, router, setUnsaved]);

  const handleCancel = React.useCallback(() => {
    cancelNavigation();
  }, [cancelNavigation]);

  // Controlled state for the admin alerts popover. Per-row clicks
  // navigate programmatically (not via an `<a>`
  // inside the popover) because the popover's own outside-click
  // listener tears down the floating layer before the browser's
  // synthetic click on a nested `<a>` can fire — the navigation
  // visibly does nothing in that race. Programmatic navigation + an
  // explicit close after navigation starts is deterministic.
  const [alertsPopoverOpen, setAlertsPopoverOpen] = React.useState(false);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = React.useState(false);

  // Debug logging for admin tab
  React.useEffect(() => {
    if (session) {
      console.log('[AppHeader] Session role:', session.role);
      // Note: groups removed from session to prevent oversized cookies
      console.log('[AppHeader] Is admin (with MongoDB check)?', isAdmin);
    }
  }, [session, isAdmin]);

  const releasePrompt = useReleaseUpgradePrompt();
  const migrationStatus = useMigrationStatus();
  // Admin-only Keycloak health summary so the header chip can surface
  // invariant failures (e.g. missing OBO scope binding, AFFIRMATIVE policy
  // misconfiguration) without making the admin navigate to Security &
  // Policy → Keycloak just to notice. Gated by `isAdmin` so non-admin
  // sessions never trigger the underlying Keycloak Admin round-trip.
  const keycloakHealth = useKeycloakHealthSummary({ enabled: isAdmin });
  const noAuthConfigured = !config.ssoEnabled || config.unsafeRbacBypassEnabled;
  const noAuthStatusText = config.unsafeRbacBypassEnabled
    ? "RBAC bypass is enabled. UI authorization checks allow every operation."
    : "SSO is disabled. This deployment is not enforcing browser sign-in.";

  // Admin-only alerts shown in the right cluster. Sources collapse into
  // a SINGLE pill ("Alerts: <total>") to keep the header uncluttered —
  // see the rendering block further down. Severity is `red` when the
  // condition is service-down / blocking; `amber` otherwise.
  //
  // Order matters for two things:
  //   - the unified pill's deep-link picks the first entry by severity
  //     (red wins, then array order for ties), and
  //   - the title / aria-label lists alerts in the same order so the
  //     hover-text is stable.
  //
  // Counts are source-owned and additive, so the total in the unified
  // pill is a simple sum across the visible sources.
  type AdminAlertSource = {
    id: string;
    label: string;
    count: number;
    severity: "red" | "amber";
    href: string;
  };
  const keycloakSummary = keycloakHealth.summary;
  const keycloakStatus =
    keycloakSummary?.status ?? (keycloakSummary?.reachable ? "reachable" : "unreachable");
  const keycloakStatusAlert =
    keycloakSummary?.configured && keycloakStatus !== "reachable"
      ? {
          id:
            keycloakStatus === "admin_authorization_error"
              ? "keycloak_admin_authorization"
              : keycloakStatus === "reconciliation_error"
                ? "keycloak_reconciliation_error"
                : "keycloak_unreachable",
          label:
            keycloakStatus === "admin_authorization_error"
              ? `Keycloak admin API authorization failed for realm ${keycloakSummary.realm}`
              : keycloakStatus === "reconciliation_error"
                ? `Keycloak reconciliation failing for realm ${keycloakSummary.realm}`
                : `Keycloak realm ${keycloakSummary.realm} unreachable`,
          count: 1,
          severity: "red" as const,
          href: "/admin/security/keycloak",
        }
      : null;
  const adminOnlyAlerts: AdminAlertSource[] = isAdmin
    ? ([
        keycloakStatusAlert,
        migrationStatus.status?.is_blocking
          ? {
              id: "migrations_blocking",
              label: "Migrations required",
              count: migrationStatus.status.blocking_required_count ?? 0,
              severity: "red" as const,
              href: "/admin/security/migrations",
            }
          : null,
        keycloakHealth.summary?.invariants && keycloakHealth.summary.invariants.failing > 0
          ? {
              id: "keycloak_invariants",
              label: `Keycloak invariant${keycloakHealth.summary.invariants.failing === 1 ? "" : "s"} failing`,
              count: keycloakHealth.summary.invariants.failing,
              severity: "amber" as const,
              href: "/admin/security/keycloak",
            }
          : null,
        !migrationStatus.status?.is_blocking && migrationStatus.status?.needs_version_bootstrap
          ? {
              id: "version_bootstrap",
              label: "Version metadata needed",
              count: migrationStatus.status.version_bootstrap_required_count ?? 0,
              severity: "amber" as const,
              href: "/admin/security/migrations",
            }
          : null,
        !migrationStatus.status?.is_blocking && migrationStatus.status?.override_active
          ? {
              id: "migration_override",
              label: "Migration override active",
              count: 1,
              severity: "amber" as const,
              href: "/admin/security/migrations",
            }
          : null,
      ].filter(Boolean) as AdminAlertSource[])
    : [];
  const adminAlerts = adminOnlyAlerts;
  return (
    <>
    <header className="relative z-50 flex h-14 shrink-0 items-center gap-2 bg-card/50 px-3 backdrop-blur-xl sm:px-4">
      <div className="flex min-w-0 shrink-0 items-center gap-1">
        <ApplicationNavigationMenuButton />
        <MobileApplicationBrand />
      </div>

      {/* Breadcrumb slot — pages (e.g. chat) portal their WorkspaceBreadcrumbs
          in here so the crumb trail lives inside the header bar instead of
          floating in its own row underneath it. */}
      <div
        ref={breadcrumbSlot?.setTarget}
        className="flex min-w-0 flex-1 items-center overflow-hidden"
        data-testid="app-header-breadcrumb-slot"
      >
        {breadcrumbSlot && !breadcrumbSlot.hasPortalContent && fallbackBreadcrumbs.length > 0 ? (
          <WorkspaceBreadcrumbs
            breadcrumbs={fallbackBreadcrumbs}
            portal={false}
          />
        ) : null}
      </div>

      {/* Status & Actions */}
      <div className="flex shrink-0 items-center gap-1.5">
        <div className="flex items-center gap-1.5">
          {noAuthConfigured && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  aria-label="No auth configured"
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-amber-500/30 bg-amber-500/15 text-xs font-medium text-amber-500 transition-all hover:bg-amber-500/20 hover:scale-105"
                >
                  <AlertTriangle className="h-3 w-3" />
                  <span>No Auth</span>
                </button>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" className="w-80 p-3">
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-amber-500">
                    <AlertTriangle className="h-4 w-4" />
                    No Auth Configured
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {noAuthStatusText} All operations should be treated as admin-capable. Do not use this mode in production.
                  </p>
                </div>
              </PopoverContent>
            </Popover>
          )}
          {/*
            Unified admin alerts pill. A single labelled `Alerts: <total>`
            trigger keeps the header compact when multiple subsystems flag
            issues simultaneously. Trigger severity is the worst across all
            visible sources (red wins over amber).

            Clicking the pill opens a popover that lists every active alert
            as its own row, each with its own guarded link to the relevant
            admin tab so lower-severity items remain actionable.

            Per-row navigation preserves unsaved-changes
            guards still fire. The popover closes itself on row click
            via the controlled `alertsPopoverOpen` state so the
            destination doesn't see a stale open popover after route
            transition.
          */}
          {adminAlerts.length > 0 && (() => {
            const hasRed = adminAlerts.some((a) => a.severity === "red");
            const totalCount = adminAlerts.reduce((sum, a) => sum + a.count, 0);
            const breakdown = adminAlerts
              .map((a) => `${a.label}: ${a.count}`)
              .join(" · ");
            const triggerLabel = `${totalCount} alert${totalCount === 1 ? "" : "s"} — ${breakdown}. Click to see the list.`;
            return (
              <Popover open={alertsPopoverOpen} onOpenChange={setAlertsPopoverOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={triggerLabel}
                    aria-haspopup="dialog"
                    title={triggerLabel}
                    data-testid="header-admin-alerts-trigger"
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all cursor-pointer hover:scale-105",
                      hasRed
                        ? "border-red-500/30 bg-red-500/15 text-red-500 hover:bg-red-500/20"
                        : "border-amber-500/30 bg-amber-500/15 text-amber-500 hover:bg-amber-500/20",
                    )}
                  >
                    <AlertTriangle className="h-3 w-3" />
                    <span className="hidden xl:inline">Alerts:</span>
                    <span>{totalCount}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="end"
                  className="w-80 p-2"
                  data-testid="header-admin-alerts-popover"
                >
                  <div className="px-2 py-1.5 border-b mb-1">
                    <p className="text-xs font-semibold text-foreground">
                      Alerts ({totalCount})
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      Choose an alert to open the related page.
                    </p>
                  </div>
                  <ul className="space-y-0.5" role="list">
                    {adminAlerts.map((alert) => {
                      const rowLabel = `${alert.label} (${alert.count}) — open the related page`;
                      const handleAlertNavigate = () => {
                        // Honour the unsaved-changes guard the same way
                        // application navigation does — if the user has pending edits
                        // on the current page, defer navigation to the
                        // discard dialog; otherwise navigate immediately.
                        if (hasUnsavedChanges) {
                          requestNavigation(alert.href);
                        } else {
                          pushWithNavigationProgress(router,alert.href);
                        }
                        setAlertsPopoverOpen(false);
                      };
                      return (
                        <li key={alert.id}>
                          <button
                            type="button"
                            onClick={handleAlertNavigate}
                            aria-label={rowLabel}
                            title={rowLabel}
                            data-testid={`admin-alert-row-${alert.id}`}
                            className={cn(
                              "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                              "hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                              alert.severity === "red"
                                ? "text-red-500"
                                : "text-amber-500",
                            )}
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              <span
                                aria-hidden="true"
                                className={cn(
                                  "h-2 w-2 shrink-0 rounded-full",
                                  alert.severity === "red"
                                    ? "bg-red-500"
                                    : "bg-amber-500",
                                )}
                              />
                              <span className="truncate">{alert.label}</span>
                            </span>
                            <span className="flex items-center gap-1 shrink-0">
                              <span
                                className={cn(
                                  "tabular-nums",
                                  alert.severity === "red"
                                    ? "text-red-500"
                                    : "text-amber-500",
                                )}
                              >
                                {alert.count}
                              </span>
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </PopoverContent>
              </Popover>
            );
          })()}
        </div>

        {/* Personalization, Links & User */}
        <div className="flex items-center gap-1">
          {config.envBadge ? (
            <span
              className="mr-1 inline-flex shrink-0 items-center rounded-full border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400"
              title={`${config.envBadge} environment`}
            >
              {config.envBadge}
            </span>
          ) : null}
          <ApplicationNavigationSearchTrigger />
          {config.provideFeedbackEnabled ? (
            <>
              <Button
                aria-label="Provide Feedback"
                className="h-8 w-8 text-muted-foreground hover:text-foreground"
                data-testid="header-provide-feedback"
                onClick={() => setFeedbackDialogOpen(true)}
                size="icon"
                title="Provide Feedback"
                variant="ghost"
              >
                <MessageSquareText aria-hidden="true" className="h-4 w-4" />
              </Button>
              <ReportProblemDialog
                open={feedbackDialogOpen}
                onOpenChange={setFeedbackDialogOpen}
              />
            </>
          ) : null}
          <SettingsPanel />
          {config.docsUrl && (
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
              <a href={config.docsUrl} target="_blank" rel="noopener noreferrer" title="Documentation">
                <BookOpen className="h-4 w-4" />
              </a>
            </Button>
          )}
          {config.sourceUrl && (
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
              <a href={config.sourceUrl} target="_blank" rel="noopener noreferrer" title="Source Code">
                <Github className="h-4 w-4" />
              </a>
            </Button>
          )}
          <NotificationBell enabled={Boolean(session)} />
          <UserMenu />
        </div>
      </div>
    </header>

    {shouldRenderHeaderDialog && pendingNavigationHref && (
      <UnsavedChangesDialog
        open={!!pendingNavigationHref}
        onDiscard={handleDiscard}
        onCancel={handleCancel}
        title="Unsaved changes"
        description="You have unsaved changes. They will be lost if you leave now."
      />
    )}
    {session && releasePrompt.releaseVersion && (
      <ReleaseUpgradeDialog
        open={releasePrompt.open}
        isAdmin={releasePrompt.isAdmin}
        releaseVersion={releasePrompt.releaseVersion}
        release={releasePrompt.release}
        releaseMarkdown={releasePrompt.releaseMarkdown}
        onSkipUntilNextLogin={releasePrompt.skipUntilNextLogin}
        onDismissPermanently={releasePrompt.dismissPermanently}
        isDismissing={releasePrompt.isDismissing}
      />
    )}
    </>
  );
}
