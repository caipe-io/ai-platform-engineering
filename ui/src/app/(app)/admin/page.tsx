"use client";

import { getErrorMessage } from "@/lib/error-utils";

// assisted-by Codex Codex-sonnet-4-6

import {
CategoryBreakdown,
RunStatsTable,
TopCreatorsCard,
VisibilityBreakdown,
} from "@/components/admin/insights/SkillMetricsCards";
import { AsyncStatsCard } from "@/components/admin/insights/AsyncStatsCard";
import { AutonomousTeamAccessPanel } from "@/components/admin/autonomous/AutonomousTeamAccessPanel";
import { ReviewConfigsTab } from "@/components/admin/settings/ReviewConfigsTab";
import {
  AdminNavigation,
  adminDestinationHref,
} from "@/components/admin/workspace/AdminNavigation";
import {
  DEFAULT_ADMIN_DESTINATION_ID,
  DEFAULT_READONLY_DESTINATION_ID,
  filterAdminCategories,
  findAdminCategoryForDestination,
  findAdminDestinationById,
  findAdminDestinationByPath,
} from "@/components/admin/workspace/admin-routes";
import { CrawlConsoleDialog } from "@/components/admin/platform/CrawlConsoleDialog";
import { CrawlConsoleHeaderPill } from "@/components/admin/platform/CrawlConsoleHeaderPill";
import { HealthTab } from "@/components/admin/platform/HealthTab";
import { MetricsTab } from "@/components/admin/platform/MetricsTab";
import { ApiStatsSection } from "@/components/admin/platform/ApiStatsSection";
import { SkillHubsSection } from "@/components/admin/platform/SkillHubsSection";
import { SlackStatsSection } from "@/components/admin/platform/SlackStatsSection";
import { WebexStatsSection } from "@/components/admin/platform/WebexStatsSection";
import { SlackChannelRebacPanel } from "@/components/admin/rebac/SlackChannelRebacPanel";
import { WebexSpaceRebacPanel } from "@/components/admin/rebac/WebexSpaceRebacPanel";
import { AuditLogsTab } from "@/components/admin/security/AuditLogsTab";
import { KeycloakMigrationHealthPanel } from "@/components/admin/security/KeycloakMigrationHealthPanel";
import { MigrationTab } from "@/components/admin/security/MigrationTab";
import { PublicationApprovalQueue } from "@/components/admin/security/PublicationApprovalQueue";
import { AccessExplorerTab } from "@/components/admin/security/AccessExplorerTab";
import { RbacSelfCheckTab } from "@/components/admin/security/RbacSelfCheckTab";
import { UnifiedAuditTab } from "@/components/admin/security/UnifiedAuditTab";
import { ImportAgentsFromConfigCard } from "@/components/admin/settings/ImportAgentsFromConfigCard";
import { MCPCatalogSettingsCard } from "@/components/admin/settings/MCPCatalogSettingsCard";
import { RagSettingsTab } from "@/components/admin/settings/RagSettingsTab";
import { CardPagination } from "@/components/admin/shared/CardPagination";
import { DateRangeFilter,presetToRange,type DateRange,type DateRangePreset } from "@/components/admin/shared/DateRangeFilter";
import { FeedbackTrendChart,type FeedbackTrendPoint } from "@/components/admin/shared/FeedbackTrendChart";
import { SimpleLineChart } from "@/components/admin/shared/SimpleLineChart";
import { CreateTeamDialog } from "@/components/admin/teams/CreateTeamDialog";
import { IdentitySyncPanel } from "@/components/admin/teams/IdentitySyncPanel";
import { TeamDetailsDialog,type DialogMode as TeamDialogMode } from "@/components/admin/teams/TeamDetailsDialog";
import { UserDetailModal } from "@/components/admin/teams/UserDetailModal";
import { ServiceAccountsTab } from "@/components/admin/ServiceAccountsTab";
import { UserDetailPanel } from "@/components/admin/teams/UserDetailPanel";
import { UserManagementTab } from "@/components/admin/teams/UserManagementTab";
import { AuthGuard } from "@/components/auth-guard";
import { AdminCredentialManagementPanel } from "@/components/credentials/AdminCredentialManagementPanel";
import { WorkspacePageHeader } from "@/components/layout/WorkspacePageHeader";
import { WorkspaceShell } from "@/components/layout/WorkspaceShell";
import { PlatformAccessSettings } from "@/components/settings/sections/PlatformAccessSettings";
import { PlatformAnnouncementsSettings } from "@/components/settings/sections/PlatformAnnouncementsSettings";
import { PlatformDefaultsSettings } from "@/components/settings/sections/PlatformDefaultsSettings";
import { Button } from "@/components/ui/button";
import {
  BuiltInResourceHint,
  builtInTeamHelpText,
} from "@/components/ui/built-in-resource-hint";
import { CAIPESpinner } from "@/components/ui/caipe-spinner";
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import {
Dialog,
DialogContent,
DialogDescription,
DialogFooter,
DialogHeader,
DialogTitle,
} from "@/components/ui/dialog";
import { MultiSelect,TagInput } from "@/components/ui/multi-select";
import { Tabs,TabsContent } from "@/components/ui/tabs";
import { useAdminRole } from "@/hooks/use-admin-role";
import { useAdminStatsSections } from "@/hooks/use-admin-stats-sections";
import { useUrlFilterParams } from "@/hooks/use-url-filter-params";
import { useAdminTabGates,type AdminTabGateSimulationTarget } from "@/hooks/useAdminTabGates";
import { getConfig } from "@/lib/config";
import { pushWithNavigationProgress } from "@/lib/navigation-progress";
import { withAdminSimulationParams } from "@/lib/rbac/admin-simulation-query";
import { cn } from "@/lib/utils";
import type { SkillMetricsAdmin } from "@/types/agent-skill";
import { ADMIN_STATS_SECTIONS,type AdminStats,type AdminStatsOwnerType,type AdminStatsSection } from "@/types/admin-stats";
import type { Team as TeamType } from "@/types/teams";
import { Activity,Archive,Bot,CheckCircle2,ChevronLeft,ChevronRight,Clock,Database,ExternalLink,Eye,Filter,Globe,KeyRound,Layers,Link2,Loader2,MessageSquare,RefreshCw,Search,Settings,ThumbsDown,ThumbsUp,Trash2,Unlink,UserPlus,Users,UsersIcon,Wrench,X,Zap } from "lucide-react";
import { useSession } from "next-auth/react";
import { usePathname,useRouter,useSearchParams } from "next/navigation";
import React,{ useCallback,useEffect,useEffectEvent,useMemo,useRef,useState } from "react";

import { SlackIcon } from "@/components/ui/icons";

// Owner classification for the Top Users leaderboards (server-computed in
// /api/admin/stats). Drives the identity badge next to each name.
type OwnerType = AdminStatsOwnerType;

const FILTER_REFRESH_STATS_SECTIONS: readonly AdminStatsSection[] = ADMIN_STATS_SECTIONS.filter(
  (section) => section !== 'filters',
);
const BOT_FILTER_STATS_SECTIONS: readonly AdminStatsSection[] = [
  'top_users',
  'top_agents',
  'response_time',
  'hourly_heatmap',
];

interface FeedbackEntry {
  message_id: string;
  conversation_id?: string;
  conversation_title?: string;
  source?: 'web' | 'slack';
  channel_name?: string | null;
  content_snippet?: string;
  role?: string;
  rating: 'positive' | 'negative';
  reason?: string;
  submitted_by: string;
  submitted_at: string;
  trace_id?: string | null;
  slack_permalink?: string | null;
}

interface FeedbackData {
  entries: FeedbackEntry[];
  channels?: string[];
  summary?: {
    positive: number;
    negative: number;
    total: number;
    positive_rate: number;
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

interface Team {
  _id: string;
  name: string;
  slug?: string;
  description?: string;
  owner_id: string;
  created_at: Date;
  // Lifecycle status. "archived" teams (Okta group vanished, or admin-retired)
  // are hidden by default and rendered with a dimmed card + ArchivedBadge; they
  // grant no access (their resource-grant tuples are stripped on archive).
  status?: string;
  // Commit 5/8 of the canonical-team-membership refactor (spec
  // 2026-05-26-canonical-team-membership): `member_count` is now the
  // authoritative source for the Members badge, aggregated server-side
  // from `team_membership_sources`. `members[]` remains optional during
  // the migration window (commit 6/8 stops the dual write entirely)
  // and is no longer read by the page badge — only kept on the type
  // so older fixtures and dialog state shapes continue to compile.
  member_count?: number;
  // Server-decorated count of distinct KBs the team can access, sourced live
  // from OpenFGA `knowledge_base` grants (the single source of truth; see
  // GET /api/admin/teams). Drives the team-card KBs badge.
  kb_count?: number;
  // Owned + shared agent/skill/workflow counts, server-decorated from OpenFGA
  // (the single source of truth for team↔resource grants). Drive the team-card
  // StatChip counts; the legacy `resources` array is gone.
  agent_count?: number;
  skill_count?: number;
  workflow_count?: number;
  // Per-server MCP tool grant count + wildcard flag, server-decorated from
  // OpenFGA (`tool:<server>/*` caller grants; `tool:*` sentinel = all servers).
  tool_count?: number;
  tool_wildcard?: boolean;
  // Distinct IdP membership source types (okta / oidc_claim / ...) present on
  // the team, server-decorated from team_membership_sources. Drives the
  // "synced from <IdP>" badge so synced teams are distinguishable from manual.
  idp_source_types?: string[];
  // Per-row management gate, server-decorated from OpenFGA. True for org/super
  // admins on every team and for team admins on the teams they own. Drives
  // the "Manage team" vs "View team" affordance on the team card so that team
  // admins (without admin_ui#view) still get the manage entry-point.
  can_manage?: boolean;
  members?: Array<{
    user_id: string;
    role: string;
    added_at: Date;
  }>;
  // Spec 098 US9 — denormalised channel count for the team-card StatChip.
  // Source of truth is `channel_team_mappings`, but we mirror a thin array
  // onto the team document so the card doesn't need an extra round-trip.
  slack_channels?: Array<{ slack_channel_id: string }>;
  webex_spaces?: Array<{ space_id: string; space_name?: string; workspace_id?: string }>;
}

interface SimulationUserOption {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
}

interface SimulationTeamOption {
  _id?: string;
  id?: string;
  slug?: string;
  name: string;
  description?: string;
}

// Admin Teams grid page size. The grid is server-paginated (`?page=`) so the
// browser only ever holds one page of teams regardless of directory size.
// 12 fills the 3-column layout in 4 clean rows.
const TEAMS_PAGE_SIZE = 12;

// IdP membership source types (okta / oidc_claim / active_directory) → display
// label + optional logo asset, for the "synced from <IdP>" team badge.
const IDP_SOURCE_META: Record<string, { label: string; logo?: string }> = {
  okta: { label: 'Okta', logo: '/provider-logos/okta.svg' },
  oidc_claim: { label: 'OIDC' },
  active_directory: { label: 'Active Directory' },
};

// Badges shown on a team card when its membership was synced from an IdP. A
// team can be synced from more than one source (e.g. some members from Okta,
// others from a raw OIDC claim), so we render one pill PER source type rather
// than collapsing them into a single combined label. Each pill shows the
// provider logo (e.g. Okta) when available plus its label, with a
// "Synced with <IdP>" tooltip.
function IdpSyncedBadge({ sourceTypes }: { sourceTypes: string[] }) {
  // Dedupe defensively — the backend $addToSet already returns distinct types,
  // but a stray duplicate would otherwise render two identical pills.
  const seen = new Set<string>();
  const types = sourceTypes.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {types.map((t) => {
        const meta = IDP_SOURCE_META[t] ?? { label: t };
        const title = `Synced with ${meta.label}`;
        return (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 border border-border whitespace-nowrap"
            title={title}
            aria-label={title}
          >
            {meta.logo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={meta.logo} alt="" aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            <span className="text-[10px] font-medium text-muted-foreground">
              {meta.label}
            </span>
          </span>
        );
      })}
    </span>
  );
}

// Shown on a team card when the team is archived — an identity-sync team whose
// Okta group vanished, or a team an admin retired. Archived teams grant no
// access (their resource tuples are stripped on archive), so the pill flags
// that the card is inert. Styled to match IdpSyncedBadge but in a muted-warning
// tone so it reads as a state, not an IdP source.
function ArchivedBadge() {
  const title = "Archived — grants no access";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 border border-amber-500/30 whitespace-nowrap"
      title={title}
      aria-label={title}
    >
      <Archive className="h-3 w-3 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <span className="text-[10px] font-medium text-amber-700 dark:text-amber-300">
        Archived
      </span>
    </span>
  );
}

// Identity badge shown next to a Top Users name so an admin can tell at a glance
// what kind of owner a row is. The four cases the server can reliably tell apart:
//   • service_account — a platform API caller (e.g. a smoke-test SA); NOT a person.
//   • slack_bot       — a Slack bot/app poster (alert bots, MR bots).
//   • linked          — a person whose account is connected to the platform.
//   • unlinked_slack  — a Slack user who chats via the bot without linking.
const OWNER_TYPE_BADGE: Record<OwnerType, { title: string; icon: React.ReactNode }> = {
  service_account: {
    title: "Service account (API access, not a person)",
    icon: <KeyRound className="h-3.5 w-3.5 text-violet-500 dark:text-violet-400" aria-hidden="true" />,
  },
  slack_bot: {
    title: "Slack bot or app",
    icon: <SlackIcon className="h-3.5 w-3.5 text-muted-foreground" />,
  },
  linked: {
    title: "Linked account (connected to the platform)",
    icon: <Link2 className="h-3.5 w-3.5 text-emerald-500 dark:text-emerald-400" aria-hidden="true" />,
  },
  unlinked_slack: {
    title: "Slack user with no linked account",
    icon: <Unlink className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />,
  },
};

function OwnerTypeBadge({ ownerType }: { ownerType?: OwnerType }) {
  if (!ownerType) return null;
  const badge = OWNER_TYPE_BADGE[ownerType];
  if (!badge) return null;
  return (
    <span className="inline-flex shrink-0" title={badge.title} aria-label={badge.title}>
      {badge.icon}
    </span>
  );
}

function localDateFromBucketKey(dateKey: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(dateKey);
  if (!match) return null;
  const [, yearValue, monthValue, dayValue] = match;
  const year = Number(yearValue);
  const month = Number(monthValue) - 1;
  const day = Number(dayValue);
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    ? date
    : null;
}

function feedbackDateRangeForBucket(dateKey: string): DateRange | null {
  const from = localDateFromBucketKey(dateKey);
  if (!from) return null;
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setHours(23, 59, 59, 999);
  return { from: from.toISOString(), to: to.toISOString() };
}

// Bucket keys carry a time component ("2026-07-10T14:30") for hour/minute
// buckets and are date-only ("2026-07-10") for day buckets — use that to
// decide whether to label chart points by time-of-day or by calendar date.
function formatBucketLabel(dateStr: string): string {
  if (dateStr.includes('T')) {
    return new Date(dateStr).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  return localDateFromBucketKey(dateStr)?.toLocaleDateString(
    'en-US',
    { month: 'short', day: 'numeric' },
  ) ?? dateStr;
}

function OverviewStatsCards({
  error,
  loading,
  overview,
}: {
  error?: string | null;
  loading: boolean;
  overview?: AdminStats['overview'];
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      <AsyncStatsCard error={error} loading={loading} testId="stats-card-overview-users">
        {overview ? <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview.total_users}</div>
            <p className="text-xs text-muted-foreground mt-1">
              DAU: {overview.dau} | MAU: {overview.mau}
            </p>
          </CardContent>
        </Card> : undefined}
      </AsyncStatsCard>

      <AsyncStatsCard error={error} loading={loading} testId="stats-card-overview-conversations">
        {overview ? <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Conversations</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview.total_conversations}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Today: +{overview.conversations_today}
            </p>
          </CardContent>
        </Card> : undefined}
      </AsyncStatsCard>

      <AsyncStatsCard error={error} loading={loading} testId="stats-card-overview-messages">
        {overview ? <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Messages</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{overview.total_messages}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Today: +{overview.messages_today}
            </p>
          </CardContent>
        </Card> : undefined}
      </AsyncStatsCard>
    </div>
  );
}

function simulationTargetFromParams(searchParams: { get(name: string): string | null }): AdminTabGateSimulationTarget | null {
  const type = searchParams.get("simulate_type");
  const id = searchParams.get("simulate_id")?.trim();
  const relation = searchParams.get("simulate_relation");
  if ((type !== "user" && type !== "team") || !id) return null;
  return {
    type,
    id,
    ...(type === "team" && (relation === "member" || relation === "admin") ? { relation } : {}),
  };
}

function commaSeparatedFilter(value: string | null): string[] {
  if (!value) return [];
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function isValidDateRange(from: string | null, to: string | null): from is string {
  return Boolean(
    from &&
    to &&
    Number.isFinite(Date.parse(from)) &&
    Number.isFinite(Date.parse(to)) &&
    Date.parse(from) <= Date.parse(to)
  );
}

function AdminPage() {
  const { status } = useSession();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const updateUrlFilters = useUrlFilterParams();
  const { isAdmin, loading: adminRoleLoading } = useAdminRole();
  const simulationTarget = useMemo(() => simulationTargetFromParams(searchParams), [searchParams]);
  const simulationScopeKey = simulationTarget
    ? `${simulationTarget.type}:${simulationTarget.id}:${simulationTarget.relation ?? ""}`
    : "current-user";
  const { gates, integrationPanelModes, loading: adminTabGatesLoading, simulation } = useAdminTabGates(simulationTarget);
  const isSimulationActive = Boolean(simulationTarget);
  const canMutateAdminData = isAdmin && !isSimulationActive;
  const effectiveOrganizationAdmin = isSimulationActive
    ? Boolean(simulation?.subject?.organization_admin)
    : isAdmin;
  const simulationDisplayName =
    simulation?.subject?.display_name ||
    simulation?.subject?.email ||
    simulationTarget?.id ||
    "selected account";
  const auditLogsEnabled = getConfig('auditLogsEnabled');
  const feedbackEnabled = getConfig('feedbackEnabled');
  const [skillStats, setSkillStats] = useState<SkillMetricsAdmin | null>(null);
  // `teams` is the FULL team list, used only by the shared Stats/Feedback
  // team-filter dropdowns and the access-simulation team picker (which need
  // every team available for selection). The Teams grid below does NOT read
  // from this — it has its own server-paginated state (`gridTeams`) so the
  // grid only ever renders one page of cards.
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamSearch, setTeamSearch] = useState("");
  // Server-paginated Teams grid state. `gridTeams` holds only the current
  // page; `gridSearch` is the debounced query sent to the server.
  const [gridTeams, setGridTeams] = useState<Team[]>([]);
  const [gridTotal, setGridTotal] = useState(0);
  const [gridPage, setGridPage] = useState(1);
  const [gridLoading, setGridLoading] = useState(false);
  const [gridLoaded, setGridLoaded] = useState(false);
  // Archived teams are hidden by default; this toggles the `include_archived`
  // query param so admins can reveal retired / orphaned-from-Okta teams.
  const [showArchivedTeams, setShowArchivedTeams] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedUserEmail, setSelectedUserEmail] = useState<string | null>(null);
  const [simulationType, setSimulationType] = useState<"user" | "team">(simulationTarget?.type ?? "user");
  const [simulationId, setSimulationId] = useState(simulationTarget?.id ?? "");
  const [simulationRelation, setSimulationRelation] = useState<"member" | "admin">(
    simulationTarget?.relation ?? "admin"
  );
  const [simulationDialogOpen, setSimulationDialogOpen] = useState(false);
  const [simulationSearch, setSimulationSearch] = useState(simulationTarget?.id ?? "");
  const [simulationUsers, setSimulationUsers] = useState<SimulationUserOption[]>([]);
  const [simulationTeams, setSimulationTeams] = useState<SimulationTeamOption[]>([]);
  const [simulationSearchLoading, setSimulationSearchLoading] = useState(false);
  const defaultDestinationId = effectiveOrganizationAdmin
    ? DEFAULT_ADMIN_DESTINATION_ID
    : DEFAULT_READONLY_DESTINATION_ID;

  const tabGateValues = useMemo<Record<string, boolean>>(
    () => ({
      ...gates,
      platform_settings: effectiveOrganizationAdmin,
      feedback: Boolean(gates.feedback && feedbackEnabled),
      audit_logs: Boolean(gates.audit_logs && auditLogsEnabled),
      credentials: Boolean(gates.credentials && getConfig('credentialsEnabled')),
      // Agents subtab (Import Agents from Config) is an admin-only action.
      agents: effectiveOrganizationAdmin,
      mcp: effectiveOrganizationAdmin,
      autonomous: effectiveOrganizationAdmin && Boolean(getConfig('autonomousAgentsEnabled')),
      rag: effectiveOrganizationAdmin,
      // Identity Sync tab: superadmin-only (reuses the identity_group_sync
      // OpenFGA surface) AND only when an IdP directory connector is enabled.
      identity_sync: Boolean(gates.identity_group_sync && getConfig('oktaSyncEnabled')),
    }),
    [auditLogsEnabled, effectiveOrganizationAdmin, feedbackEnabled, gates]
  );

  const visibleCategories = useMemo(
    () => filterAdminCategories(tabGateValues),
    [tabGateValues]
  );
  const visibleDestinations = useMemo(
    () => visibleCategories.flatMap((category) => category.destinations),
    [visibleCategories],
  );
  const requestedDestination = findAdminDestinationByPath(pathname);
  const requestedDestinationIsVisible = Boolean(
    requestedDestination && visibleDestinations.some(
      (destination) => destination.id === requestedDestination.id,
    ),
  );
  const fallbackDestination =
    visibleDestinations.find((destination) => destination.id === defaultDestinationId) ??
    visibleDestinations[0];
  const activeDestination =
    (requestedDestinationIsVisible ? requestedDestination : undefined) ??
    fallbackDestination ??
    findAdminDestinationById(defaultDestinationId)!;
  const activeCategory =
    visibleCategories.find((category) =>
      category.destinations.some((destination) => destination.id === activeDestination.id),
    ) ?? findAdminCategoryForDestination(activeDestination.id);
  const activeTab = activeDestination.id;
  const breadcrumbSearchParams = new URLSearchParams(searchParams.toString());
  const breadcrumbHref = (destination: typeof activeDestination) =>
    adminDestinationHref(destination,breadcrumbSearchParams,activeDestination.id);
  const categoryBreadcrumbDestination =
    activeCategory.destinations[0] ?? activeDestination;
  const adminBreadcrumbDestination =
    visibleDestinations[0] ?? categoryBreadcrumbDestination;
  const subgroupBreadcrumbDestination = activeDestination.subgroup
    ? activeCategory.destinations.find(
        (destination) => destination.subgroup === activeDestination.subgroup,
      )
    : undefined;
  const adminNavigationVersion = [
    activeDestination.id,
    searchParams.toString(),
    visibleCategories
      .map((category) =>
        `${category.id}:${category.destinations.map((destination) => destination.id).join(",")}`,
      )
      .join("|"),
  ].join(";");

  useEffect(() => {
    if (adminRoleLoading || adminTabGatesLoading) return;
    if (visibleCategories.length === 0) return;
    const params = new URLSearchParams(searchParams.toString());
    if (activeDestination.id !== 'access-explorer') {
      params.delete('subtab');
      params.delete('openfgaTab');
    }
    const shouldSetDefaultStatsRange =
      activeDestination.id === 'stats' && params.get('dateRange') === null;
    if (shouldSetDefaultStatsRange) {
      params.set('dateRange', '30d');
      params.delete('from');
      params.delete('to');
    }
    const query = params.toString();
    const canonicalUrl = query
      ? `${activeDestination.href}?${query}`
      : activeDestination.href;
    if (
      pathname !== activeDestination.href
      || shouldSetDefaultStatsRange
    ) {
      router.replace(canonicalUrl, { scroll: false });
    }
  }, [
    activeDestination,
    adminTabGatesLoading,
    adminRoleLoading,
    pathname,
    router,
    searchParams,
    visibleCategories,
  ]);

  useEffect(() => {
    setSimulationType(simulationTarget?.type ?? "user");
    setSimulationId(simulationTarget?.id ?? "");
    setSimulationSearch(simulationTarget?.id ?? "");
    setSimulationRelation(simulationTarget?.relation ?? "admin");
  }, [simulationTarget]);

  useEffect(() => {
    if (!simulationDialogOpen) return;
    const query = simulationSearch.trim();
    if (query.length < 2) {
      setSimulationUsers([]);
      setSimulationTeams([]);
      setSimulationSearchLoading(false);
      return;
    }

    let cancelled = false;
    setSimulationSearchLoading(true);

    async function loadSimulationSubjects() {
      try {
        if (simulationType === "user") {
          const response = await fetch(`/api/admin/users?search=${encodeURIComponent(query)}&pageSize=20`);
          const payload = await response.json();
          const users = (payload.users ?? payload.data?.users ?? []) as SimulationUserOption[];
          if (!cancelled) setSimulationUsers(users);
        } else {
          const response = await fetch("/api/admin/teams");
          const payload = await response.json();
          const rows = (payload.data?.teams ?? payload.teams ?? []) as SimulationTeamOption[];
          const normalizedQuery = query.toLowerCase();
          const matching = rows.filter((team) =>
            [team.slug, team.name, team.description, team.id, team._id]
              .filter(Boolean)
              .some((value) => String(value).toLowerCase().includes(normalizedQuery))
          );
          if (!cancelled) setSimulationTeams(matching);
        }
      } catch {
        if (!cancelled) {
          setSimulationUsers([]);
          setSimulationTeams([]);
        }
      } finally {
        if (!cancelled) setSimulationSearchLoading(false);
      }
    }

    void loadSimulationSubjects();
    return () => {
      cancelled = true;
    };
  }, [simulationDialogOpen, simulationSearch, simulationType]);

  const applySimulationTarget = useCallback(() => {
    const trimmedId = simulationId.trim();
    if (!trimmedId) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("simulate_type", simulationType);
    params.set("simulate_id", trimmedId);
    if (simulationType === "team") {
      params.set("simulate_relation", simulationRelation);
    } else {
      params.delete("simulate_relation");
    }
    setSimulationDialogOpen(false);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams, simulationId, simulationRelation, simulationType]);

  const clearSimulationTarget = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("simulate_type");
    params.delete("simulate_id");
    params.delete("simulate_relation");
    setSimulationDialogOpen(false);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const [createTeamDialogOpen, setCreateTeamDialogOpen] = useState(false);
  const [teamDetailsOpen, setTeamDetailsOpen] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<TeamType | null>(null);
  const [teamDialogMode, setTeamDialogMode] = useState<TeamDialogMode>("details");
  const [deletingTeam, setDeletingTeam] = useState<string | null>(null);
  const [teamPendingDelete, setTeamPendingDelete] = useState<Team | null>(null);
  // ── Shared filters (source, users, date range) across feedback + stats tabs ──
  const requestedSource = searchParams.get('source');
  const sourceFromUrl: 'all' | 'web' | 'slack' | 'webex' | 'api' =
    requestedSource === 'web' || requestedSource === 'slack' || requestedSource === 'webex' || requestedSource === 'api' ? requestedSource : 'all';
  const usersFromUrl = commaSeparatedFilter(searchParams.get('users'));
  const requestedDatePreset = searchParams.get('dateRange');
  const requestedFrom = searchParams.get('from');
  const requestedTo = searchParams.get('to');
  const validDatePreset = requestedDatePreset &&
    ['1h', '12h', '24h', '7d', '30d', '90d', 'custom'].includes(requestedDatePreset);
  const datePresetFromUrl: DateRangePreset = validDatePreset &&
    (requestedDatePreset !== 'custom' || isValidDateRange(requestedFrom, requestedTo))
    ? requestedDatePreset as DateRangePreset
    : '30d';
  const dateRangeFromUrl: DateRange = datePresetFromUrl === 'custom'
    ? { from: requestedFrom as string, to: requestedTo as string }
    : presetToRange(datePresetFromUrl);

  const [sourceFilter, setSourceFilter] = useState<'all' | 'web' | 'slack' | 'webex' | 'api'>(
    sourceFromUrl
  );
  const [userFilter, setUserFilter] = useState<string[]>(usersFromUrl);
  const [datePreset, setDatePreset] = useState<DateRangePreset>(datePresetFromUrl);
  const [dateRange, setDateRange] = useState<DateRange>(dateRangeFromUrl);
  const [webexEnabled, setWebexEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/user/preferences", { method: "GET", credentials: "same-origin" })
      .then((response) => response.json())
      .then((json: { data?: { integrations?: { webex?: boolean } } }) => {
        if (!cancelled) setWebexEnabled(json.data?.integrations?.webex === true);
      })
      .catch(() => {
        if (!cancelled) setWebexEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openFeedbackForTrendPoint = useCallback((point: FeedbackTrendPoint) => {
    const range = feedbackDateRangeForBucket(point.date);
    if (!range) return;

    setDatePreset('custom');
    setDateRange(range);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('subtab');
    params.delete('openfgaTab');
    params.set('dateRange', 'custom');
    params.set('from', range.from);
    params.set('to', range.to);
    pushWithNavigationProgress(router,`/admin/insights/feedback?${params.toString()}`);
  }, [router,searchParams]);

  // Helper to sync shared filters to URL
  const updateSharedFilterUrl = (overrides: Record<string, string | null> = {}) => {
    const shared: Record<string, string | null> = {
      source: sourceFilter !== 'all' ? sourceFilter : null,
      users: userFilter.length > 0 ? userFilter.join(',') : null,
      dateRange: datePreset,
      from: datePreset === 'custom' ? dateRange.from : null,
      to: datePreset === 'custom' ? dateRange.to : null,
      ...overrides,
    };
    updateUrlFilters(shared);
  };

  // ── Feedback-only filters ──
  const requestedRating = searchParams.get('rating');
  const feedbackRatingFromUrl: 'all' | 'positive' | 'negative' =
    requestedRating === 'positive' || requestedRating === 'negative' ? requestedRating : 'all';
  const feedbackChannelsFromUrl = commaSeparatedFilter(searchParams.get('channels'));
  const feedbackSearchFromUrl = commaSeparatedFilter(searchParams.get('search'));

  const [feedbackData, setFeedbackData] = useState<FeedbackData | null>(null);
  const [feedbackFilter, setFeedbackFilter] = useState<'all' | 'positive' | 'negative'>(
    feedbackRatingFromUrl
  );
  const [feedbackChannelFilter, setFeedbackChannelFilter] = useState<string[]>(feedbackChannelsFromUrl);
  const [feedbackChannels, setFeedbackChannels] = useState<string[]>([]);
  const [feedbackSearchTags, setFeedbackSearchTags] = useState<string[]>(feedbackSearchFromUrl);
  const [feedbackUsers, setFeedbackUsers] = useState<string[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);

  // Sync feedback-only filters to URL
  const updateFeedbackUrl = (overrides: Record<string, string | null>) => {
    const defaults: Record<string, string | null> = {
      rating: feedbackFilter !== 'all' ? feedbackFilter : null,
      channels: feedbackChannelFilter.length > 0 ? feedbackChannelFilter.join(',') : null,
      search: feedbackSearchTags.length > 0 ? feedbackSearchTags.join(',') : null,
    };
    updateUrlFilters({ ...defaults, ...overrides });
  };
  const statsChannelsFromUrl = commaSeparatedFilter(searchParams.get('statsChannels'));
  const statsAgentsFromUrl = commaSeparatedFilter(searchParams.get('statsAgents'));
  const statsIncludeBotsFromUrl = searchParams.get('statsIncludeBots') === 'true';
  const [statsChannelFilter, setStatsChannelFilter] = useState<string[]>(statsChannelsFromUrl);
  const [statsChannels, setStatsChannels] = useState<string[]>([]);
  // Store stable agent IDs in URL/state and map them to labels only for the
  // dropdown. This lets the first deep-linked request apply the filter before
  // the scoped agent option list has loaded.
  const [statsAgentFilter, setStatsAgentFilter] = useState<string[]>(statsAgentsFromUrl);
  const [statsAgents, setStatsAgents] = useState<Array<{ id: string; name: string }>>([]);
  // Top-users leaderboard: hide bot/service identities by default; toggle to show.
  const [showBotUsers, setShowBotUsers] = useState(statsIncludeBotsFromUrl);
  const [topConversationsPage, setTopConversationsPage] = useState(1);
  const [topMessagesPage, setTopMessagesPage] = useState(1);
  const [loadingTopUsersLeaderboard, setLoadingTopUsersLeaderboard] = useState<
    'conversations' | 'messages' | null
  >(null);
  const topConversationsPageRef = useRef(1);
  const topMessagesPageRef = useRef(1);
  const topUsersPageRequestVersionRef = useRef(0);
  const resetTopUserPages = useCallback(() => {
    topUsersPageRequestVersionRef.current += 1;
    topConversationsPageRef.current = 1;
    topMessagesPageRef.current = 1;
    setTopConversationsPage(1);
    setTopMessagesPage(1);
    setLoadingTopUsersLeaderboard(null);
  }, []);
  const insightsFilterUrlKey = [
    searchParams.get('source'),
    searchParams.get('users'),
    searchParams.get('dateRange'),
    searchParams.get('from'),
    searchParams.get('to'),
    searchParams.get('rating'),
    searchParams.get('channels'),
    searchParams.get('search'),
    searchParams.get('statsChannels'),
    searchParams.get('statsAgents'),
    searchParams.get('statsIncludeBots'),
  ].map((value) => value ?? '').join('\u0000');
  const [previousInsightsFilterUrlKey, setPreviousInsightsFilterUrlKey] = useState(insightsFilterUrlKey);

  if (insightsFilterUrlKey !== previousInsightsFilterUrlKey) {
    setPreviousInsightsFilterUrlKey(insightsFilterUrlKey);
    setSourceFilter(sourceFromUrl);
    setUserFilter(usersFromUrl);
    setDatePreset(datePresetFromUrl);
    setDateRange(dateRangeFromUrl);
    setFeedbackFilter(feedbackRatingFromUrl);
    setFeedbackChannelFilter(feedbackChannelsFromUrl);
    setFeedbackSearchTags(feedbackSearchFromUrl);
    setStatsChannelFilter(statsChannelsFromUrl);
    setStatsAgentFilter(statsAgentsFromUrl);
    setShowBotUsers(statsIncludeBotsFromUrl);
  }

  const updateStatsFilterUrl = (overrides: Record<string, string | null> = {}) => {
    updateUrlFilters({
      statsChannels: statsChannelFilter.length > 0 ? statsChannelFilter.join(',') : null,
      statsAgents: statsAgentFilter.length > 0 ? statsAgentFilter.join(',') : null,
      statsIncludeBots: showBotUsers ? 'true' : null,
      ...overrides,
    });
  };
  const selectedStatsAgentNames = statsAgentFilter
    .map((id) => statsAgents.find((agent) => agent.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  const rangeLabel = datePreset === "1h" ? "1 Hour" : datePreset === "12h" ? "12 Hours" : datePreset === "24h" ? "24 Hours" : datePreset === "7d" ? "7 Days" : datePreset === "90d" ? "90 Days" : datePreset === "custom" ? "Custom Range" : "30 Days";
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const selectedStatsFilters = useMemo(() => {
    const userEmails = new Set<string>();
    const teamSlugs = new Set<string>();
    for (const selection of userFilter) {
      if (selection.startsWith('team:')) {
        const team = teams.find((candidate) => candidate.name === selection.slice(5));
        // Team rosters are canonical in team_membership_sources and are no
        // longer embedded in list responses. Send the stable slug so the API
        // can resolve members server-side while preserving its RBAC scope.
        teamSlugs.add(team?.slug?.trim() || team?._id || selection.slice(5));
      } else {
        userEmails.add(selection);
      }
    }
    return { teamSlugs: [...teamSlugs], userEmails: [...userEmails] };
  }, [teams, userFilter]);

  const getStatsSectionUrl = useCallback((section: AdminStatsSection): string => {
    const params = new URLSearchParams({ section });
    if (datePreset === 'custom') {
      params.set('from', dateRange.from);
      params.set('to', dateRange.to);
    } else {
      // Relative presets stay relative when the dashboard is manually refreshed;
      // custom ranges remain fixed to their explicit endpoints.
      params.set('range', datePreset);
    }
    if (sourceFilter !== 'all') params.set('source', sourceFilter);
    if (selectedStatsFilters.userEmails.length > 0) {
      params.set('user', selectedStatsFilters.userEmails.join(','));
    }
    if (selectedStatsFilters.teamSlugs.length > 0) {
      params.set('team', selectedStatsFilters.teamSlugs.join(','));
    }
    if (sourceFilter === 'slack' && statsChannelFilter.length > 0) {
      params.set('channel', statsChannelFilter.join(','));
    }
    if (statsAgentFilter.length > 0) params.set('agent', statsAgentFilter.join(','));
    if (showBotUsers) params.set('include_bots', 'true');
    if (section === 'top_users') {
      params.set('top_conversations_page', String(topConversationsPageRef.current));
      params.set('top_messages_page', String(topMessagesPageRef.current));
    }
    return withAdminSimulationParams(`/api/admin/stats?${params.toString()}`, simulationTarget);
  }, [
    dateRange,
    datePreset,
    selectedStatsFilters,
    showBotUsers,
    simulationTarget,
    sourceFilter,
    statsAgentFilter,
    statsChannelFilter,
  ]);

  const getSkillStatsUrl = useCallback((): string => {
    const params = new URLSearchParams();
    if (datePreset === 'custom') {
      params.set('from', dateRange.from);
      params.set('to', dateRange.to);
    } else {
      params.set('range', datePreset);
    }
    if (sourceFilter !== 'all') params.set('source', sourceFilter);
    if (selectedStatsFilters.userEmails.length > 0) {
      params.set('user', selectedStatsFilters.userEmails.join(','));
    }
    if (selectedStatsFilters.teamSlugs.length > 0) {
      params.set('team', selectedStatsFilters.teamSlugs.join(','));
    }
    return withAdminSimulationParams(`/api/admin/stats/skills?${params.toString()}`, simulationTarget);
  }, [datePreset, dateRange, selectedStatsFilters, simulationTarget, sourceFilter]);

  const {
    data: stats,
    loadSections: loadStatsSections,
    refreshing: statsRefreshing,
    reset: resetStatsSections,
    statuses: statsSectionStatuses,
  } = useAdminStatsSections({
    getSectionUrl: getStatsSectionUrl,
    onFatalError: setError,
    scopeKey: simulationScopeKey,
  });

  useEffect(() => {
    if (stats.available_channels) setStatsChannels(stats.available_channels);
  }, [stats.available_channels]);

  useEffect(() => {
    if (stats.available_agents) setStatsAgents(stats.available_agents);
  }, [stats.available_agents]);

  const visitedTabsRef = useRef<Set<string>>(new Set());
  const previousSimulationScopeKeyRef = useRef(simulationScopeKey);
  const activeDataScopeKeyRef = useRef(simulationScopeKey);
  activeDataScopeKeyRef.current = simulationScopeKey;

  // Data loaded for one preview subject must never survive a switch to a
  // different subject (or back to the current user). Clear the lazy-load
  // guards and scoped response state before loading the active tab again.
  useEffect(() => {
    if (previousSimulationScopeKeyRef.current !== simulationScopeKey) {
      previousSimulationScopeKeyRef.current = simulationScopeKey;
      visitedTabsRef.current.clear();
      resetStatsSections();
      setFeedbackData(null);
      setStatsChannels([]);
      setStatsAgents([]);
      setFeedbackChannels([]);
      setFeedbackUsers([]);
      setTeams([]);
      setGridTeams([]);
      setGridTotal(0);
      setGridPage(1);
      setGridLoaded(false);
      setSelectedUserId(null);
      setSelectedUserEmail(null);
      setFeedbackLoading(false);
      resetTopUserPages();
    }
    if (status !== "authenticated" && getConfig('ssoEnabled')) return;
    loadTabDataEvent(activeTab);
  }, [activeTab, resetStatsSections, resetTopUserPages, simulationScopeKey, status]);
  const fetchTeamsFromDb = async (): Promise<Team[]> => {
    const response = await fetch(withAdminSimulationParams(`/api/admin/teams?fresh=${Date.now()}`, simulationTarget), {
      cache: 'no-store',
    });
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Failed to load teams');
    }

    return result.data?.teams || [];
  };

  // Refresh the FULL team list backing the shared filter dropdowns. The Teams
  // grid has its own paginated loader (`fetchTeamsGridPage`) and does not use
  // this. Runs quietly in the background — no visible spinner.
  const loadTeams = async () => {
    try {
      setTeams(await fetchTeamsFromDb());
    } catch (err) {
      console.error('[Admin] Failed to refresh teams:', err);
    }
  };

  // Fetch one page of the Teams grid from the server. Search is applied
  // server-side so the browser never holds more than a page of rows. The
  // request is the source of truth for `gridTotal`, which drives the pager.
  const fetchTeamsGridPage = useCallback(async (page: number, search: string) => {
    setGridLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        page_size: String(TEAMS_PAGE_SIZE),
        fresh: String(Date.now()),
      });
      if (search.trim()) params.set('search', search.trim());
      if (showArchivedTeams) params.set('include_archived', 'true');
      const response = await fetch(withAdminSimulationParams(`/api/admin/teams?${params.toString()}`, simulationTarget), {
        cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Failed to load teams');
      }
      setGridTeams(result.data?.teams ?? []);
      setGridTotal(result.data?.total ?? 0);
      setGridPage(result.data?.page ?? page);
      setGridLoaded(true);
    } catch (err) {
      console.error('[Admin] Failed to load teams page:', err);
    } finally {
      setGridLoading(false);
    }
  }, [showArchivedTeams, simulationTarget]);

  // Debounced server-side search for the Teams grid. Typing resets to page 1
  // and re-queries the server (~250ms after the last keystroke), matching the
  // discovery-search pattern used elsewhere in the admin dialogs. We only run
  // this while the Teams tab is active so other tabs don't trigger team
  // queries on every keystroke.
  useEffect(() => {
    if (activeTab !== 'teams') return;
    const handle = setTimeout(() => {
      void fetchTeamsGridPage(1, teamSearch);
    }, 250);
    return () => clearTimeout(handle);
  }, [teamSearch, activeTab, fetchTeamsGridPage]);

  const gridTotalPages = Math.max(1, Math.ceil(gridTotal / TEAMS_PAGE_SIZE));
  const gridHasMore = gridPage * TEAMS_PAGE_SIZE < gridTotal;

  const goToTeamsPage = (page: number) => {
    const clamped = Math.min(Math.max(1, page), gridTotalPages);
    void fetchTeamsGridPage(clamped, teamSearch);
  };

  // Refresh after a team mutation (create/edit/delete/member change). Always
  // re-fetches the visible grid page. Also refreshes the full team list — but
  // only when it has already been loaded — so the shared filter dropdowns stay
  // current without forcing a full fetch for users who never opened those tabs.
  const refreshAfterTeamMutation = (page?: number) => {
    void fetchTeamsGridPage(page ?? gridPage, teamSearch);
    if (visitedTabsRef.current.has('_teams-loaded')) {
      void loadTeams();
    }
  };

  // Use a value-based signature so loading the team/filter option lists does not
  // accidentally issue a second stats request. Only data that changes the query
  // participates in the signature.
  const statsFilterKey = useMemo(() => JSON.stringify({
    agents: statsAgentFilter,
    channels: statsChannelFilter,
    from: datePreset === 'custom' ? dateRange.from : null,
    range: datePreset,
    source: sourceFilter,
    to: datePreset === 'custom' ? dateRange.to : null,
    teams: selectedStatsFilters.teamSlugs,
    users: selectedStatsFilters.userEmails,
  }), [
    dateRange.from,
    dateRange.to,
    datePreset,
    selectedStatsFilters,
    sourceFilter,
    statsAgentFilter,
    statsChannelFilter,
  ]);
  const skillStatsFilterKey = useMemo(() => JSON.stringify({
    from: datePreset === 'custom' ? dateRange.from : null,
    range: datePreset,
    source: sourceFilter,
    to: datePreset === 'custom' ? dateRange.to : null,
    teams: selectedStatsFilters.teamSlugs,
    users: selectedStatsFilters.userEmails,
  }), [datePreset, dateRange.from, dateRange.to, selectedStatsFilters, sourceFilter]);
  const skillStatsFilterRef = useRef(skillStatsFilterKey);
  const statsFilterRef = useRef(statsFilterKey);
  useEffect(() => {
    if (statsFilterRef.current === statsFilterKey) return;
    statsFilterRef.current = statsFilterKey;
    if (!visitedTabsRef.current.has('_stats-loaded')) return;
    if (status !== "authenticated" && getConfig('ssoEnabled')) return;
    const handle = window.setTimeout(() => {
      resetTopUserPages();
      void loadStatsSections(FILTER_REFRESH_STATS_SECTIONS);
    }, 150);
    return () => window.clearTimeout(handle);
  }, [loadStatsSections, resetTopUserPages, statsFilterKey, status]);

  const showBotUsersRef = useRef(showBotUsers);
  useEffect(() => {
    if (showBotUsersRef.current === showBotUsers) return;
    showBotUsersRef.current = showBotUsers;
    if (!visitedTabsRef.current.has('_stats-loaded')) return;
    if (status !== "authenticated" && getConfig('ssoEnabled')) return;
    resetTopUserPages();
    void loadStatsSections(BOT_FILTER_STATS_SECTIONS);
  }, [loadStatsSections, resetTopUserPages, showBotUsers, status]);

  const loadTopUsersPage = async (
    leaderboard: 'conversations' | 'messages',
    page: number,
  ): Promise<void> => {
    const requestVersion = topUsersPageRequestVersionRef.current + 1;
    topUsersPageRequestVersionRef.current = requestVersion;
    setLoadingTopUsersLeaderboard(leaderboard);
    if (leaderboard === 'conversations') {
      topConversationsPageRef.current = page;
      setTopConversationsPage(page);
    } else {
      topMessagesPageRef.current = page;
      setTopMessagesPage(page);
    }
    try {
      await loadStatsSections(['top_users']);
    } finally {
      if (topUsersPageRequestVersionRef.current === requestVersion) {
        setLoadingTopUsersLeaderboard(null);
      }
    }
  };

  const topConversationsLoading = loadingTopUsersLeaderboard === null
    ? statsSectionStatuses.top_users.loading
    : loadingTopUsersLeaderboard === 'conversations';
  const topMessagesLoading = loadingTopUsersLeaderboard === null
    ? statsSectionStatuses.top_users.loading
    : loadingTopUsersLeaderboard === 'messages';

  const loadStats = async () => {
    setError(null);
    await loadStatsSections();
  };

  const loadTeamsData = async (): Promise<Team[]> => {
    try {
      const loadedTeams = await fetchTeamsFromDb();
      setTeams(loadedTeams);
      return loadedTeams;
    } catch (err) {
      console.error('[Admin] Failed to load teams:', err);
      return [];
    }
  };

  const loadSkillStats = useCallback(async (): Promise<void> => {
    const requestScopeKey = simulationScopeKey;
    try {
      const res = await fetch(getSkillStatsUrl());
      if (res.ok) {
        const data = await res.json().catch(() => ({ success: false }));
        if (data.success && activeDataScopeKeyRef.current === requestScopeKey) {
          setSkillStats(data.data);
        }
      }
    } catch (err) {
      console.error('[Admin] Failed to load skill stats:', err);
    }
  }, [getSkillStatsUrl, simulationScopeKey]);

  useEffect(() => {
    if (skillStatsFilterRef.current === skillStatsFilterKey) return;
    skillStatsFilterRef.current = skillStatsFilterKey;
    if (!visitedTabsRef.current.has('_stats-loaded')) return;
    if (status !== "authenticated" && getConfig('ssoEnabled')) return;
    const handle = window.setTimeout(() => {
      void loadSkillStats();
    }, 150);
    return () => window.clearTimeout(handle);
  }, [loadSkillStats, skillStatsFilterKey, status]);

  const getFeedbackUrl = (
    rating = feedbackFilter,
    page = 1,
    source = sourceFilter,
    channels = feedbackChannelFilter,
    searchTags = feedbackSearchTags,
    users = userFilter,
    range = dateRange,
    availableTeams = teams,
  ): string => {
    const params = new URLSearchParams({ page: String(page), limit: '50' });
    if (rating !== 'all') params.set('rating', rating);
    if (source !== 'all') params.set('source', source);
    if (source === 'slack' && channels.length > 0) {
      params.set('channel', channels.join(','));
    }
    if (searchTags.length > 0) params.set('search', searchTags.join(','));

    const selectedUsers = new Set<string>();
    const selectedTeams = new Set<string>();
    for (const selection of users) {
      if (selection.startsWith('team:')) {
        const team = availableTeams.find((candidate) => candidate.name === selection.slice(5));
        selectedTeams.add(team?.slug?.trim() || team?._id || selection.slice(5));
      } else {
        selectedUsers.add(selection);
      }
    }
    if (selectedUsers.size > 0) params.set('user', [...selectedUsers].join(','));
    if (selectedTeams.size > 0) params.set('team', [...selectedTeams].join(','));
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);

    return withAdminSimulationParams(`/api/admin/feedback?${params}`, simulationTarget);
  };

  const requestFeedback = async (url: string): Promise<void> => {
    const requestScopeKey = simulationScopeKey;
    setFeedbackLoading(true);
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json().catch(() => ({ success: false }));
        if (data.success && activeDataScopeKeyRef.current === requestScopeKey) {
          setFeedbackData(data.data);
          if (data.data.channels) setFeedbackChannels(data.data.channels);
          if (data.data.users) setFeedbackUsers(data.data.users);
        }
      }
    } catch (err) {
      console.error('[Admin] Failed to load feedback:', err);
    } finally {
      if (activeDataScopeKeyRef.current === requestScopeKey) {
        setFeedbackLoading(false);
      }
    }
  };

  const loadFeedbackOnce = async (availableTeams: Team[]): Promise<void> => {
    if (!getConfig('feedbackEnabled')) return;
    await requestFeedback(getFeedbackUrl(
      feedbackFilter,
      1,
      sourceFilter,
      feedbackChannelFilter,
      feedbackSearchTags,
      userFilter,
      dateRange,
      availableTeams,
    ));
  };

  const loadTabData = async (tab: string) => {
    if (visitedTabsRef.current.has(tab)) return;
    visitedTabsRef.current.add(tab);

    // Teams data is shared across the Stats and Feedback filter dropdowns.
    // Use a data-level key (not the tab name) so it isn't confused with the
    // tab-visit guard that loadTabData adds before invoking the loader.
    const loadTeamsIfNeeded = (): Promise<Team[]> => {
      if (isSimulationActive) return Promise.resolve([]);
      if (visitedTabsRef.current.has('_teams-loaded')) return Promise.resolve(teams);
      visitedTabsRef.current.add('_teams-loaded');
      return loadTeamsData();
    };

    // Stats data uses a separate key from the tab-visit guard.
    const loadStatsIfNeeded = () => {
      if (visitedTabsRef.current.has('_stats-loaded')) return Promise.resolve();
      visitedTabsRef.current.add('_stats-loaded');
      return loadStats();
    };

    // Map of tab key → loader. Tabs not listed here have no upfront data to
    // load and should not block render (loading is initialized to false).
    // The Teams tab is NOT listed here: its grid is server-paginated and
    // self-loads via a debounced effect, so it must not pull the full team
    // list. The full list (`loadTeamsIfNeeded`) is only needed by tabs whose
    // dropdowns offer every team for selection (Stats and Feedback).
    const loaders: Record<string, () => Promise<void>> = {
      // Skill aggregates now render inside the Statistics tab, so they load
      // alongside the rest of the stats data. The Skills tab keeps only the
      // Skill Hubs section, which self-loads.
      stats: async () => { await Promise.all([loadStatsIfNeeded(), loadTeamsIfNeeded(), loadSkillStats()]); },
      feedback: async () => {
        const availableTeams = await loadTeamsIfNeeded();
        await loadFeedbackOnce(availableTeams);
      },
    };

    const loader = loaders[tab];
    if (loader) await loader();
  };

  const loadTabDataEvent = useEffectEvent(loadTabData);

  // Load data once when a tab is first visited.
  useEffect(() => {
    if (status !== "authenticated" && getConfig('ssoEnabled')) return;
    loadTabDataEvent(activeTab);
  }, [activeTab, status]);

  const loadFeedback = async (
    rating?: 'positive' | 'negative' | 'all',
    page = 1,
    source?: 'all' | 'web' | 'slack' | 'webex' | 'api',
    channels?: string[],
    searchTags?: string[],
    users?: string[],
    range?: DateRange,
  ): Promise<void> => {
    await requestFeedback(getFeedbackUrl(
      rating ?? feedbackFilter,
      page,
      source ?? sourceFilter,
      channels ?? feedbackChannelFilter,
      searchTags ?? feedbackSearchTags,
      users ?? userFilter,
      range ?? dateRange,
      teams,
    ));
  };

  const feedbackFilterKey = useMemo(() => JSON.stringify({
    channels: feedbackChannelFilter,
    from: dateRange.from,
    rating: feedbackFilter,
    search: feedbackSearchTags,
    source: sourceFilter,
    to: dateRange.to,
    users: userFilter,
  }), [
    dateRange.from,
    dateRange.to,
    feedbackChannelFilter,
    feedbackFilter,
    feedbackSearchTags,
    sourceFilter,
    userFilter,
  ]);
  const feedbackFilterRef = useRef(feedbackFilterKey);
  const loadFeedbackEvent = useEffectEvent(() => loadFeedback());
  useEffect(() => {
    if (feedbackFilterRef.current === feedbackFilterKey) return;
    feedbackFilterRef.current = feedbackFilterKey;
    if (!visitedTabsRef.current.has('feedback')) return;
    if (status !== "authenticated" && getConfig('ssoEnabled')) return;
    const handle = window.setTimeout(() => {
      void loadFeedbackEvent();
    }, 150);
    return () => window.clearTimeout(handle);
  }, [feedbackFilterKey, status]);

  const handleFeedbackFilterChange = (filter: 'all' | 'positive' | 'negative') => {
    setFeedbackFilter(filter);
    updateFeedbackUrl({ rating: filter !== 'all' ? filter : null });
  };

  const handleFeedbackSourceChange = (source: 'all' | 'web' | 'slack' | 'webex' | 'api') => {
    setSourceFilter(source);
    setFeedbackChannelFilter([]);
    updateSharedFilterUrl({ source: source !== 'all' ? source : null });
    updateFeedbackUrl({ channels: null });
  };


  const handleDeleteTeam = async (team: Team) => {
    setDeletingTeam(team._id);
    try {
      const response = await fetch(`/api/admin/teams/${team._id}`, {
        method: 'DELETE',
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete team');
      }

      // Drop from both local lists, then re-fetch the grid page so a team
      // from the next page backfills the now-empty slot (and the pager total
      // stays correct). If the deletion emptied the current page, step back.
      setTeams((prev) => prev.filter((t) => t._id !== team._id));
      setGridTeams((prev) => prev.filter((t) => t._id !== team._id));
      const nextPage = gridTeams.length === 1 && gridPage > 1 ? gridPage - 1 : gridPage;
      refreshAfterTeamMutation(nextPage);
      setTeamPendingDelete(null);
      console.log(`[Admin] Team deleted: ${team.name}`);
    } catch (err) {
      console.error('[Admin] Failed to delete team:', err);
      alert(`Failed to delete team: ${getErrorMessage(err, "")}`);
    } finally {
      setDeletingTeam(null);
    }
  };

  const openTeamDialog = (team: Team, mode: TeamDialogMode) => {
    if (isSimulationActive) return;
    setSelectedTeam(team as TeamType);
    setTeamDialogMode(mode);
    setTeamDetailsOpen(true);
  };

  if (adminRoleLoading || adminTabGatesLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <CAIPESpinner size="lg" message="Opening admin workspace..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-sm text-destructive mb-2">{error}</p>
          <button
            onClick={() => { visitedTabsRef.current.delete(activeTab); loadTabData(activeTab); }}
            className="text-sm text-primary hover:underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Global Crawl Console dialog. Rendered at the page root so
          it survives admin tab switches; opens via the header pill
          or auto-opens when SkillHubsSection starts the first
          crawl of the session. */}
      <CrawlConsoleDialog />
      <WorkspaceShell
        header={(
          <WorkspacePageHeader
            actions={(
              <>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => setSimulationDialogOpen(true)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      isSimulationActive
                        ? 'border border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400'
                        : 'bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    {isSimulationActive ? (
                      <span className="max-w-64 truncate">Viewing as {simulationDisplayName}</span>
                    ) : (
                      'View as'
                    )}
                  </button>
                )}
                <CrawlConsoleHeaderPill />
              </>
            )}
            breadcrumbs={[
              { label: "Home",href: "/" },
              {
                label: "Admin",
                href: breadcrumbHref(adminBreadcrumbDestination),
              },
              {
                label: activeCategory.label,
                href: breadcrumbHref(categoryBreadcrumbDestination),
              },
              ...(activeDestination.subgroup &&
              activeDestination.subgroup !== activeCategory.label
                ? [{
                    label: activeDestination.subgroup,
                    href: breadcrumbHref(subgroupBreadcrumbDestination ?? activeDestination),
                  }]
                : []),
              {
                label: activeDestination.label,
                href: breadcrumbHref(activeDestination),
              },
            ]}
            description={activeDestination.description}
            title={activeDestination.label}
            titleId="admin-section-title"
          />
        )}
        navigation={visibleCategories.length > 0 ? (
          <AdminNavigation
            activeDestination={activeDestination}
            categories={visibleCategories}
            searchParams={new URLSearchParams(searchParams.toString())}
          />
        ) : null}
        navigationAreaKey="admin"
        navigationVersion={adminNavigationVersion}
      >
        <Tabs value={activeTab} className="space-y-4">

              <Dialog open={simulationDialogOpen} onOpenChange={setSimulationDialogOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>View As — Read-Only Access Preview</DialogTitle>
                    <DialogDescription>
                      Preview which Admin areas and connected resources a user or team can access.
                      This does not sign in as them or change your current session.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-4">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground" htmlFor="simulate-type">
                          Subject type
                        </label>
                        <Select
                          id="simulate-type"
                          value={simulationType}
                          onChange={(event) => {
                            const nextType = event.target.value as "user" | "team";
                            setSimulationType(nextType);
                            setSimulationId("");
                            setSimulationSearch("");
                            setSimulationUsers([]);
                            setSimulationTeams([]);
                          }}
                          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                        >
                          <option value="team">Team</option>
                          <option value="user">User</option>
                        </Select>
                      </div>
                      {simulationType === "team" && (
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground" htmlFor="simulate-relation">
                            Role / relation
                          </label>
                          <Select
                            id="simulate-relation"
                            value={simulationRelation}
                            onChange={(event) => setSimulationRelation(event.target.value as "member" | "admin")}
                            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                          >
                            <option value="admin">Manager/Admin</option>
                            <option value="member">Reader/Member</option>
                          </Select>
                        </div>
                      )}
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground" htmlFor="simulate-search">
                        {simulationType === "team" ? "Search team by name, slug, or ID" : "Search user by name, email, or ID"}
                      </label>
                      <div className="relative">
                        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                        <input
                          id="simulate-search"
                          value={simulationSearch}
                          onChange={(event) => {
                            setSimulationSearch(event.target.value);
                            setSimulationId(event.target.value.trim());
                          }}
                          placeholder={
                            simulationType === "team"
                              ? "Search team name or slug"
                              : "Search by email, name, or user ID"
                          }
                          className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Select a search result or enter an exact user or team ID.
                      </p>
                    </div>

                    <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                      {simulationSearchLoading ? (
                        <div className="p-3 text-sm text-muted-foreground">Searching...</div>
                      ) : simulationType === "user" ? (
                        simulationUsers.length > 0 ? (
                          simulationUsers.map((user) => {
                            const label = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || user.email || user.id;
                            return (
                              <button
                                key={user.id}
                                type="button"
                                onClick={() => {
                                  setSimulationId(user.id);
                                  setSimulationSearch(user.email || user.username || user.id);
                                }}
                                className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
                              >
                                <span className="font-medium">{label}</span>{" "}
                                {user.email && <span className="text-muted-foreground">{user.email}</span>}{" "}
                                <code className="text-xs text-muted-foreground">{user.id}</code>
                              </button>
                            );
                          })
                        ) : (
                          <div className="p-3 text-sm text-muted-foreground">Type at least 2 characters to search users.</div>
                        )
                      ) : simulationTeams.length > 0 ? (
                        simulationTeams.map((team) => {
                          const teamId = team.slug || team.id || team._id || team.name;
                          return (
                            <button
                              key={teamId}
                              type="button"
                              onClick={() => {
                                setSimulationId(teamId);
                                setSimulationSearch(team.slug || team.name);
                              }}
                              className="block w-full px-3 py-2 text-left text-sm hover:bg-muted"
                            >
                              <span className="font-medium">{team.name}</span>{" "}
                              <code className="text-xs text-muted-foreground">{teamId}</code>
                            </button>
                          );
                        })
                      ) : (
                        <div className="p-3 text-sm text-muted-foreground">Type at least 2 characters to search teams.</div>
                      )}
                    </div>

                  </div>

                  <DialogFooter>
                    {isSimulationActive && (
                      <Button type="button" variant="outline" onClick={clearSimulationTarget}>
                        Exit Preview
                      </Button>
                    )}
                    <Button type="button" onClick={applySimulationTarget} disabled={!simulationId.trim()}>
                      Preview
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              {visibleCategories.length === 0 && (
                <div
                  role="status"
                  className="rounded-lg border border-dashed border-amber-500/40 bg-amber-500/5 px-6 py-10 text-center"
                >
                  <p className="font-medium">
                    {isSimulationActive
                      ? `No Admin access is available to ${simulationDisplayName}.`
                      : "No Admin access is available for this account."}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    This account has no Admin areas or connected Slack/Webex resources available.
                  </p>
                </div>
              )}

              {tabGateValues.platform_settings && (
                <TabsContent value="defaults" className="space-y-4">
                  <PlatformDefaultsSettings readOnly={isSimulationActive} />
                </TabsContent>
              )}

              {tabGateValues.platform_settings && (
                <TabsContent value="announcements" className="space-y-4">
                  <PlatformAnnouncementsSettings readOnly={isSimulationActive} />
                </TabsContent>
              )}

              {tabGateValues.platform_settings && (
                <TabsContent value="access-before-sign-in" className="space-y-4">
                  <PlatformAccessSettings readOnly={isSimulationActive} />
                </TabsContent>
              )}

              {tabGateValues.platform_settings && (
                <TabsContent value="ai-review" className="space-y-4">
                  <ReviewConfigsTab readOnly={isSimulationActive} />
                </TabsContent>
              )}

              {tabGateValues.agents && (
                <TabsContent value="agents" className="space-y-4">
                  <ImportAgentsFromConfigCard
                    isAdmin={effectiveOrganizationAdmin}
                    readOnly={isSimulationActive}
                  />
                </TabsContent>
              )}

              {tabGateValues.autonomous && (
                <TabsContent value="autonomous" className="space-y-4">
                  <AutonomousTeamAccessPanel />
                </TabsContent>
              )}

              {tabGateValues.mcp && (
                <TabsContent value="mcp" className="space-y-4">
                  <MCPCatalogSettingsCard
                    isAdmin={effectiveOrganizationAdmin}
                    readOnly={isSimulationActive}
                  />
                </TabsContent>
              )}

              {tabGateValues.rag && (
                <TabsContent value="rag" className="space-y-4">
                  <RagSettingsTab
                    isAdmin={effectiveOrganizationAdmin}
                    readOnly={isSimulationActive}
                  />
                </TabsContent>
              )}

              {tabGateValues.service_accounts && (
                <TabsContent value="service-accounts" className="space-y-4">
                  <ServiceAccountsTab
                    readOnly={isSimulationActive}
                    simulationTarget={simulationTarget}
                  />
                </TabsContent>
              )}

              {tabGateValues.credentials && (
                <TabsContent value="credentials" className="space-y-4">
                  <AdminCredentialManagementPanel readOnly={isSimulationActive} />
                </TabsContent>
              )}

              {tabGateValues.slack && (
                <TabsContent value="slack" className="space-y-4">
                  <SlackChannelRebacPanel
                    disabled={isSimulationActive}
                    simulationTarget={simulationTarget}
                    selfService={integrationPanelModes.slack !== "full"}
                  />
                </TabsContent>
              )}

              {tabGateValues.webex && (
                <TabsContent value="webex" className="space-y-4">
                  <WebexSpaceRebacPanel
                    disabled={isSimulationActive}
                    simulationTarget={simulationTarget}
                    selfService={integrationPanelModes.webex !== "full"}
                  />
                </TabsContent>
              )}

              {/* User Management Tab */}
              <TabsContent value="users" className="space-y-4">
                <UserManagementTab
                  onSelectUser={(id) => setSelectedUserId(id)}
                  simulationTarget={simulationTarget}
                />
                {selectedUserId && (
                  <UserDetailModal
                    userId={selectedUserId}
                    onClose={() => setSelectedUserId(null)}
                    onSaved={() => {}}
                    readOnly={!canMutateAdminData}
                    simulationTarget={simulationTarget}
                    teamOptions={teams.length > 0 ? teams.map((t) => ({ teamId: t.name, label: t.name })) : undefined}
                  />
                )}
              </TabsContent>

              {/* Team Management Tab */}
              <TabsContent value="teams" className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="relative w-full sm:max-w-md">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="search"
                      aria-label="Search teams"
                      value={teamSearch}
                      onChange={(event) => setTeamSearch(event.target.value)}
                      placeholder="Search teams by name, owner, or description"
                      className="h-10 w-full rounded-md border border-input bg-background pl-9 pr-9 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    />
                    {teamSearch && (
                      <button
                        type="button"
                        aria-label="Clear search input"
                        onClick={() => setTeamSearch("")}
                        className="absolute right-2 top-1/2 rounded p-1 text-muted-foreground hover:text-foreground -translate-y-1/2"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <label
                      className="flex cursor-pointer select-none items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
                      title="Archived teams (retired, or whose Okta group was removed) grant no access"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-input accent-primary"
                        checked={showArchivedTeams}
                        onChange={(event) => setShowArchivedTeams(event.target.checked)}
                      />
                      Show archived
                    </label>
                    <Button
                      type="button"
                      variant="outline"
                      className="gap-2"
                      onClick={() => fetchTeamsGridPage(gridPage, teamSearch)}
                      disabled={gridLoading}
                    >
                      {gridLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                      Refresh Teams
                    </Button>
                    {canMutateAdminData && (
                      <Button className="gap-2" onClick={() => setCreateTeamDialogOpen(true)}>
                        <UserPlus className="h-4 w-4" />
                        Create Team
                      </Button>
                    )}
                  </div>
                </div>
                {(!gridLoaded && gridLoading) || (gridLoading && gridTeams.length === 0) ? (
                  <div className="flex justify-center py-12">
                    <CAIPESpinner />
                  </div>
                ) : gridTeams.length === 0 && !teamSearch.trim() ? (
                  <div className="text-center py-12">
                    <UsersIcon className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No Teams Yet</h3>
                    <p className="text-muted-foreground mb-4">
                      {canMutateAdminData
                        ? 'Create teams to enable collaboration and conversation sharing'
                        : 'No teams have been created yet'}
                    </p>
                    {canMutateAdminData && (
                      <Button className="gap-2" onClick={() => setCreateTeamDialogOpen(true)}>
                        <UserPlus className="h-4 w-4" />
                        Create Your First Team
                      </Button>
                    )}
                  </div>
                ) : gridTeams.length === 0 ? (
                  <div className="rounded-lg border border-dashed py-12 text-center">
                    <Search className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No teams match &quot;{teamSearch}&quot;</h3>
                    <p className="text-muted-foreground mb-4">
                      Try a team name, owner email, or description.
                    </p>
                    <Button type="button" variant="outline" onClick={() => setTeamSearch("")}>
                      Clear team search
                    </Button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {gridTeams.map((team) => {
                      const builtInHelp = builtInTeamHelpText(team.slug);
                      return (
                      <Card key={team._id} className={cn(team.status === 'archived' && "opacity-60")}>
                        <CardHeader>
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <CardTitle className="text-lg min-w-0 break-words">{team.name}</CardTitle>
                                {builtInHelp && (
                                  <BuiltInResourceHint text={builtInHelp} />
                                )}
                                {team.status === 'archived' && <ArchivedBadge />}
                                {(team.idp_source_types?.length ?? 0) > 0 && (
                                  <IdpSyncedBadge sourceTypes={team.idp_source_types!} />
                                )}
                              </div>
                              {team.description && (
                                <CardDescription>{team.description}</CardDescription>
                              )}
                            </div>
                            {canMutateAdminData && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-destructive hover:text-destructive"
                                aria-label={`Delete ${team.name}`}
                                onClick={() => setTeamPendingDelete(team)}
                                disabled={deletingTeam === team._id}
                              >
                                {deletingTeam === team._id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Trash2 className="h-4 w-4" />
                                )}
                              </Button>
                            )}
                          </div>
                        </CardHeader>
                        <CardContent>
                          {/* Owner row — clearly labeled, not styled like a button. */}
                          <div className="flex items-center justify-between text-sm pb-3 border-b">
                            <span className="text-muted-foreground">Owner</span>
                            <button
                              type="button"
                              className="text-sm hover:underline truncate max-w-[60%] text-right"
                              onClick={() => setSelectedUserEmail(team.owner_id)}
                              title="Open user details"
                            >
                              {team.owner_id}
                            </button>
                          </div>

                          {/* Quick stats — the four highest-signal chips
                              (Members, Agents, MCP, KBs). They double as
                              deep-links into the matching tab in the
                              team-management dialog. Skills, Workflows, and
                              Chat were dropped from the card to keep it
                              uncluttered; they remain available as tabs. */}
                          <div className="grid grid-cols-4 gap-1.5 mt-3">
                            <StatChip
                              icon={<Users className="h-3.5 w-3.5" />}
                              label="Members"
                              count={team.member_count ?? 0}
                              disabled={isSimulationActive}
                              onClick={() => openTeamDialog(team, "members")}
                            />
                            <StatChip
                              icon={<Bot className="h-3.5 w-3.5" />}
                              label="Agents"
                              count={team.agent_count ?? 0}
                              disabled={isSimulationActive}
                              onClick={() => openTeamDialog(team, "resources")}
                            />
                            <StatChip
                              icon={<Wrench className="h-3.5 w-3.5" />}
                              label="MCPs"
                              count={team.tool_wildcard ? "*" : (team.tool_count ?? 0)}
                              disabled={isSimulationActive}
                              onClick={() => openTeamDialog(team, "mcp")}
                            />
                            <StatChip
                              icon={<Database className="h-3.5 w-3.5" />}
                              label="KBs"
                              count={team.kb_count ?? 0}
                              disabled={isSimulationActive}
                              onClick={() => openTeamDialog(team, "kbs")}
                            />
                          </div>

                          {/* Single primary action — replaces the previous
                              two-button row. The chips above give shortcuts
                              into specific tabs; this is the catch-all. */}
                          <div className="mt-4">
                            <Button
                              size="sm"
                              variant={(!isSimulationActive && (isAdmin || team.can_manage)) ? "default" : "outline"}
                              className="w-full gap-1.5"
                              disabled={isSimulationActive}
                              onClick={() => openTeamDialog(team, "details")}
                            >
                              <Settings className="h-3.5 w-3.5" />
                              {(!isSimulationActive && (isAdmin || team.can_manage)) ? "Manage team" : "View team"}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                      );
                    })}
                  </div>
                )}
                {/* Pager — shown whenever the result set spans more than one
                    page. Prev/Next drive a server fetch; the page indicator
                    reflects server-reported totals. */}
                {gridTotal > TEAMS_PAGE_SIZE && (
                  <div className="flex items-center justify-between pt-2 text-sm">
                    <span className="text-muted-foreground">
                      Page {gridPage} of {gridTotalPages} · {gridTotal} team{gridTotal === 1 ? "" : "s"}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => goToTeamsPage(gridPage - 1)}
                        disabled={gridPage <= 1 || gridLoading}
                        aria-label="Previous page"
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => goToTeamsPage(gridPage + 1)}
                        disabled={!gridHasMore || gridLoading}
                        aria-label="Next page"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </TabsContent>

              {/* Identity Sync Tab — IdP directory sync (Okta, etc.). Superadmin-only,
                  shown only when a directory connector is enabled. */}
              {tabGateValues.identity_sync && (
                <TabsContent value="identity-sync" className="space-y-4">
                  <IdentitySyncPanel isAdmin={canMutateAdminData} />
                </TabsContent>
              )}

              {/* Skills Tab — skill usage aggregates now live in the
                  Statistics tab; this tab keeps only Skill Hubs. */}
              <TabsContent value="skills" className="space-y-4">
                <SkillHubsSection isAdmin={canMutateAdminData} />
              </TabsContent>

              {/* Feedback Tab */}
              {tabGateValues.feedback && <TabsContent value="feedback" className="space-y-4">
                {/* Filters */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex gap-1">
                      {(['all', 'positive', 'negative'] as const).map((f) => (
                        <Button
                          key={f}
                          size="sm"
                          variant={feedbackFilter === f ? 'default' : 'outline'}
                          onClick={() => handleFeedbackFilterChange(f)}
                          className="gap-1.5 h-8 text-xs capitalize"
                        >
                          {f === 'positive' && <ThumbsUp className="h-3 w-3" />}
                          {f === 'negative' && <ThumbsDown className="h-3 w-3" />}
                          {f === 'all' && <Filter className="h-3 w-3" />}
                          {f}
                        </Button>
                      ))}
                    </div>
                    <div className="h-5 w-px bg-border" />
                    <Select
                      value={sourceFilter}
                      onChange={(e) => handleFeedbackSourceChange(e.target.value as 'all' | 'web' | 'slack' | 'webex' | 'api')}
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      <option value="all">All Sources</option>
                      <option value="web">Web</option>
                      <option value="slack">Slack</option>
                    </Select>
                    {sourceFilter === 'slack' && feedbackChannels.length > 0 && (
                      <>
                        <div className="h-5 w-px bg-border" />
                        <MultiSelect
                          options={feedbackChannels}
                          selected={feedbackChannelFilter}
                          onChange={(channels) => {
                            setFeedbackChannelFilter(channels);
                            updateFeedbackUrl({ channels: channels.length > 0 ? channels.join(',') : null });
                          }}
                          placeholder="All Channels"
                          searchPlaceholder="Search channels..."
                          emptyLabel="No channels found"
                          badgeLabel="channels"
                        />
                      </>
                    )}
                    <div className="h-5 w-px bg-border" />
                    <TagInput
                      tags={feedbackSearchTags}
                      onChange={(tags) => {
                        setFeedbackSearchTags(tags);
                        updateFeedbackUrl({ search: tags.length > 0 ? tags.join(',') : null });
                      }}
                      placeholder="Search reasons..."
                      badgeLabel="filters"
                    />
                    {(feedbackUsers.length > 0 || teams.length > 0) && (
                      <>
                        <div className="h-5 w-px bg-border" />
                        <MultiSelect
                          options={[
                            ...teams.map((t) => `team:${t.name}`),
                            ...feedbackUsers,
                          ]}
                          selected={userFilter}
                          onChange={(selected) => {
                            setUserFilter(selected);
                            updateSharedFilterUrl({ users: selected.length > 0 ? selected.join(',') : null });
                          }}
                          placeholder="All Users & Teams"
                          searchPlaceholder="Search users or teams..."
                          emptyLabel="No users found"
                          badgeLabel="selected"
                        />
                      </>
                    )}
                  </div>
                  <DateRangeFilter
                    value={datePreset}
                    customRange={datePreset === 'custom' ? dateRange : undefined}
                    onChange={(preset, range) => {
                      setDatePreset(preset);
                      setDateRange(range);
                      updateSharedFilterUrl({
                        dateRange: preset,
                        from: preset === 'custom' ? range.from : null,
                        to: preset === 'custom' ? range.to : null,
                      });
                    }}
                  />
                </div>

                {/* Summary — positive rate across the current (scoped + filtered) set */}
                {feedbackData?.summary && feedbackData.summary.total > 0 && (
                  <div className="grid grid-cols-3 gap-4">
                    <Card>
                      <CardContent className="pt-6 text-center">
                        <div className="flex items-center justify-center gap-1 mb-1">
                          <ThumbsUp className="h-4 w-4 text-green-500" />
                        </div>
                        <p className="text-2xl font-bold text-green-500">{feedbackData.summary.positive}</p>
                        <p className="text-xs text-muted-foreground">Positive</p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="pt-6 text-center">
                        <div className="flex items-center justify-center gap-1 mb-1">
                          <ThumbsDown className="h-4 w-4 text-red-500" />
                        </div>
                        <p className="text-2xl font-bold text-red-500">{feedbackData.summary.negative}</p>
                        <p className="text-xs text-muted-foreground">Negative</p>
                      </CardContent>
                    </Card>
                    <Card>
                      <CardContent className="pt-6 text-center">
                        <p className="text-2xl font-bold text-primary">{feedbackData.summary.positive_rate}%</p>
                        <p className="text-xs text-muted-foreground">Positive Rate</p>
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* Feedback entries */}
                {feedbackLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : feedbackData?.entries?.length > 0 ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-7 gap-4 pb-2 border-b text-xs font-medium text-muted-foreground">
                      <div>User</div>
                      <div>Source</div>
                      <div>Rating</div>
                      <div>Reason</div>
                      <div>Date</div>
                      <div className="col-span-2">Link</div>
                    </div>
                    {feedbackData.entries.map((entry, i) => (
                      <div key={`${entry.message_id}-${i}`} className="grid grid-cols-7 gap-4 py-2 text-sm hover:bg-muted/50 rounded px-2 items-center">
                        <div className="truncate text-xs text-primary hover:underline cursor-pointer" onClick={() => setSelectedUserEmail(entry.submitted_by)}>{entry.submitted_by}</div>
                        <div>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                            entry.source === 'slack'
                              ? 'bg-purple-500/10 text-purple-600 dark:text-purple-400'
                              : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                          }`}>
                            {entry.source === 'slack' ? `Slack${entry.channel_name ? ` · ${entry.channel_name}` : ''}` : 'Web'}
                          </span>
                        </div>
                        <div>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                            entry.rating === 'positive'
                              ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                              : 'bg-red-500/10 text-red-600 dark:text-red-400'
                          }`}>
                            {entry.rating === 'positive' ? (
                              <ThumbsUp className="h-3 w-3" />
                            ) : (
                              <ThumbsDown className="h-3 w-3" />
                            )}
                            {entry.rating}
                          </span>
                        </div>
                        <div
                          className="text-xs text-muted-foreground truncate cursor-pointer hover:text-foreground"
                          title={entry.reason || undefined}
                          onClick={(e) => {
                            const el = e.currentTarget;
                            el.classList.toggle('truncate');
                            el.classList.toggle('whitespace-normal');
                          }}
                        >
                          {entry.reason || '—'}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {entry.submitted_at
                            ? new Date(entry.submitted_at).toLocaleDateString()
                            : '—'}
                        </div>
                        <div className="col-span-2">
                          {entry.slack_permalink ? (
                            <a
                              href={entry.slack_permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                              title="View Slack thread"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Slack thread
                            </a>
                          ) : entry.conversation_id ? (
                            <a
                              href={`/chat/${entry.conversation_id}?from=feedback${entry.message_id ? `&message=${entry.message_id}` : ''}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                              title={entry.conversation_title || 'View conversation'}
                            >
                              <ExternalLink className="h-3 w-3" />
                              {entry.conversation_title
                                ? entry.conversation_title.length > 20
                                  ? entry.conversation_title.slice(0, 20) + '…'
                                  : entry.conversation_title
                                : 'View chat'}
                            </a>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </div>
                      </div>
                    ))}
                    {feedbackData.pagination.total_pages > 1 && (
                      <div className="flex justify-center gap-2 pt-4">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={feedbackData.pagination.page <= 1}
                          onClick={() => loadFeedback(feedbackFilter, feedbackData.pagination.page - 1)}
                        >
                          Previous
                        </Button>
                        <span className="text-sm text-muted-foreground flex items-center">
                          Page {feedbackData.pagination.page} of {feedbackData.pagination.total_pages}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={feedbackData.pagination.page >= feedbackData.pagination.total_pages}
                          onClick={() => loadFeedback(feedbackFilter, feedbackData.pagination.page + 1)}
                        >
                          Next
                        </Button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <ThumbsUp className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                    <h3 className="text-lg font-semibold mb-2">No Feedback Yet</h3>
                    <p className="text-muted-foreground">
                      User feedback will appear here once users start rating assistant responses.
                    </p>
                  </div>
                )}
              </TabsContent>}

              {/* Usage Statistics Tab */}
              <TabsContent value="stats" className="space-y-4">
                {/* Stats Filters */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-wrap">
                    <Select
                      value={sourceFilter}
                      onChange={(e) => {
                        const src = e.target.value as 'all' | 'web' | 'slack' | 'webex' | 'api';
                        setSourceFilter(src);
                        setStatsChannelFilter([]);
                        updateSharedFilterUrl({ source: src !== 'all' ? src : null });
                        updateStatsFilterUrl({ statsChannels: null });
                      }}
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      <option value="all">All Sources</option>
                      <option value="web">Web</option>
                      <option value="slack">Slack</option>
                      {webexEnabled ? <option value="webex">Webex</option> : null}
                      <option value="api">API</option>
                    </Select>
                    {sourceFilter === 'slack' && statsChannels.length > 0 && (
                      <MultiSelect
                        options={statsChannels}
                        selected={statsChannelFilter}
                        onChange={(channels) => {
                          setStatsChannelFilter(channels);
                          updateStatsFilterUrl({
                            statsChannels: channels.length > 0 ? channels.join(',') : null,
                          });
                        }}
                        placeholder="All Channels"
                        searchPlaceholder="Search channels..."
                        emptyLabel="No channels found"
                        badgeLabel="channels"
                      />
                    )}
                    {statsAgents.length > 0 && (
                      <MultiSelect
                        options={statsAgents.map((a) => a.name)}
                        selected={selectedStatsAgentNames}
                        onChange={(agents) => {
                          const agentIds = agents
                            .map((name) => statsAgents.find((agent) => agent.name === name)?.id)
                            .filter((id): id is string => Boolean(id));
                          setStatsAgentFilter(agentIds);
                          updateStatsFilterUrl({
                            statsAgents: agentIds.length > 0 ? agentIds.join(',') : null,
                          });
                        }}
                        placeholder="All Agents"
                        searchPlaceholder="Search agents..."
                        emptyLabel="No agents found"
                        badgeLabel="agents"
                      />
                    )}
                    <MultiSelect
                      options={[
                        ...teams.map((t) => `team:${t.name}`),
                        ...feedbackUsers,
                      ]}
                      selected={userFilter}
                      onChange={(selected) => {
                        setUserFilter(selected);
                        updateSharedFilterUrl({ users: selected.length > 0 ? selected.join(',') : null });
                      }}
                      placeholder="All Users & Teams"
                      searchPlaceholder="Search users or teams..."
                      emptyLabel="No users found"
                      badgeLabel="selected"
                    />
                    <DateRangeFilter
                      value={datePreset}
                      customRange={datePreset === 'custom' ? dateRange : undefined}
                      onChange={(preset, range) => {
                        setDatePreset(preset);
                        setDateRange(range);
                        updateSharedFilterUrl({
                          dateRange: preset,
                          from: preset === 'custom' ? range.from : null,
                          to: preset === 'custom' ? range.to : null,
                        });
                      }}
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={statsRefreshing}
                    onClick={() => void Promise.all([loadStatsSections(), loadSkillStats()])}
                  >
                    <RefreshCw className={cn("h-3.5 w-3.5", statsRefreshing && "animate-spin")} />
                    Refresh
                  </Button>
                </div>

                  <div className="space-y-4">
                    <OverviewStatsCards
                      error={statsSectionStatuses.overview.error}
                      loading={statsSectionStatuses.overview.loading}
                      overview={stats.overview}
                    />

                    {/* DAU and MAU Trend Charts */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <AsyncStatsCard
                        error={statsSectionStatuses.activity.error ?? statsSectionStatuses.overview.error}
                        loading={statsSectionStatuses.activity.loading || statsSectionStatuses.overview.loading}
                        minHeightClassName="min-h-96"
                        testId="stats-card-daily-active-users"
                      >
                        {stats.daily_activity && stats.overview ? <Card>
                        <CardHeader>
                          <CardTitle>Daily Active Users (DAU)</CardTitle>
                          <CardDescription>Active users per day ({rangeLabel})</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <SimpleLineChart
                            data={stats.daily_activity.map((day) => ({
                              label: formatBucketLabel(day.date),
                              value: day.active_users,
                            }))}
                            height={250}
                            color="rgb(59, 130, 246)"
                          />
                          <div className="mt-4 grid grid-cols-3 gap-4 text-center">
                            <div>
                              <p className="text-2xl font-bold text-blue-500">{stats.overview.dau}</p>
                              <p className="text-xs text-muted-foreground">Today</p>
                            </div>
                            <div>
                              <p className="text-2xl font-bold">{stats.overview.mau}</p>
                              <p className="text-xs text-muted-foreground">This Month</p>
                            </div>
                            <div>
                              <p className="text-2xl font-bold text-green-500">
                                {Math.round(stats.daily_activity.reduce((sum, d) => sum + d.active_users, 0) / Math.max(stats.daily_activity.length, 1))}
                              </p>
                              <p className="text-xs text-muted-foreground">Avg/Day</p>
                            </div>
                          </div>
                        </CardContent>
                        </Card> : undefined}
                      </AsyncStatsCard>

                      <AsyncStatsCard
                        error={statsSectionStatuses.activity.error ?? statsSectionStatuses.overview.error}
                        loading={statsSectionStatuses.activity.loading || statsSectionStatuses.overview.loading}
                        minHeightClassName="min-h-96"
                        testId="stats-card-conversation-activity"
                      >
                        {stats.daily_activity && stats.overview ? <Card>
                        <CardHeader>
                          <CardTitle>Conversation Activity</CardTitle>
                          <CardDescription>New conversations created daily</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <SimpleLineChart
                            data={stats.daily_activity.map((day) => ({
                              label: formatBucketLabel(day.date),
                              value: day.conversations,
                            }))}
                            height={250}
                            color="rgb(34, 197, 94)"
                          />
                          <div className="mt-4 grid grid-cols-3 gap-4 text-center">
                            <div>
                              <p className="text-2xl font-bold text-green-500">{stats.overview.conversations_today}</p>
                              <p className="text-xs text-muted-foreground">Today</p>
                            </div>
                            <div>
                              <p className="text-2xl font-bold">{stats.overview.total_conversations}</p>
                              <p className="text-xs text-muted-foreground">Total</p>
                            </div>
                            <div>
                              <p className="text-2xl font-bold text-purple-500">
                                {Math.round(stats.daily_activity.reduce((sum, d) => sum + d.conversations, 0) / Math.max(stats.daily_activity.length, 1))}
                              </p>
                              <p className="text-xs text-muted-foreground">Avg/Day</p>
                            </div>
                          </div>
                        </CardContent>
                        </Card> : undefined}
                      </AsyncStatsCard>
                    </div>

                    {/* Messages Activity Chart */}
                    <AsyncStatsCard
                      error={statsSectionStatuses.activity.error ?? statsSectionStatuses.overview.error}
                      loading={statsSectionStatuses.activity.loading || statsSectionStatuses.overview.loading}
                      minHeightClassName="min-h-80"
                      testId="stats-card-message-activity"
                    >
                      {stats.daily_activity && stats.overview ? <Card>
                      <CardHeader>
                        <CardTitle>Message Activity ({rangeLabel})</CardTitle>
                        <CardDescription>Messages sent per day</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <SimpleLineChart
                          data={stats.daily_activity.map((day) => ({
                            label: formatBucketLabel(day.date),
                            value: day.messages,
                          }))}
                          height={200}
                          color="rgb(168, 85, 247)"
                        />
                        <div className="mt-4 grid grid-cols-4 gap-4 text-center">
                          <div>
                            <p className="text-2xl font-bold text-purple-500">{stats.overview.messages_today}</p>
                            <p className="text-xs text-muted-foreground">Today</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold">{stats.overview.total_messages}</p>
                            <p className="text-xs text-muted-foreground">Total</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-orange-500">
                              {Math.round(stats.daily_activity.reduce((sum, d) => sum + d.messages, 0) / Math.max(stats.daily_activity.length, 1))}
                            </p>
                            <p className="text-xs text-muted-foreground">Avg/Day</p>
                          </div>
                          <div>
                            <p className="text-2xl font-bold text-blue-500">
                              {stats.overview.avg_messages_per_conversation.toFixed(1)}
                            </p>
                            <p className="text-xs text-muted-foreground">Msgs/Chat</p>
                          </div>
                        </div>
                      </CardContent>
                      </Card> : undefined}
                    </AsyncStatsCard>

                    {/* Top Users */}
                    <div className="flex items-center justify-between">
                      <h3 className="text-lg font-semibold">Top Users</h3>
                      <label
                        className="flex cursor-pointer select-none items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                        title="Include bot and service-account identities (alert posters, MR bots) in the leaderboards"
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-input accent-primary"
                          checked={showBotUsers}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setShowBotUsers(checked);
                            updateStatsFilterUrl({ statsIncludeBots: checked ? 'true' : null });
                          }}
                        />
                        Show bot users
                      </label>
                    </div>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <AsyncStatsCard
                        error={statsSectionStatuses.top_users.error}
                        loading={topConversationsLoading}
                        minHeightClassName="min-h-64"
                        testId="stats-card-top-users-conversations"
                      >
                        {stats.top_users ? <Card>
                        <CardHeader>
                          <CardTitle>Top Users by Conversations</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-2">
                            {stats.top_users.by_conversations.length === 0 ? (
                              <p className="text-sm text-muted-foreground text-center py-4">No data yet</p>
                            ) : stats.top_users.by_conversations.map((u, i) => (
                              <div key={u._id} className="flex items-center justify-between">
                                <div className="flex items-center gap-2 min-w-0">
                                  <div className="w-8 text-sm text-muted-foreground shrink-0">
                                    #{((stats.top_users.pagination?.by_conversations.page ?? topConversationsPage) - 1)
                                      * (stats.top_users.pagination?.by_conversations.limit ?? 10) + i + 1}
                                  </div>
                                  <OwnerTypeBadge ownerType={u.owner_type} />
                                  <div className="text-sm truncate max-w-[200px] text-primary hover:underline cursor-pointer" onClick={() => setSelectedUserEmail(u._id)} title={u._id}>{u.name || u._id}</div>
                                </div>
                                <div className="text-sm font-medium shrink-0">{u.count} chats</div>
                              </div>
                            ))}
                          </div>
                          {stats.top_users.pagination?.by_conversations && (
                            <CardPagination
                              label="top users by conversations"
                              disabled={topConversationsLoading}
                              page={stats.top_users.pagination.by_conversations.page}
                              pageSize={stats.top_users.pagination.by_conversations.limit}
                              total={stats.top_users.pagination.by_conversations.total}
                              className="border-t border-border pt-3"
                              onPageChange={(page) => void loadTopUsersPage('conversations', page)}
                            />
                          )}
                        </CardContent>
                        </Card> : undefined}
                      </AsyncStatsCard>

                      <AsyncStatsCard
                        error={statsSectionStatuses.top_users.error}
                        loading={topMessagesLoading}
                        minHeightClassName="min-h-64"
                        testId="stats-card-top-users-messages"
                      >
                        {stats.top_users ? <Card>
                        <CardHeader>
                          <CardTitle>Top Users by Messages</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-2">
                            {stats.top_users.by_messages.length === 0 ? (
                              <p className="text-sm text-muted-foreground text-center py-4">No data yet</p>
                            ) : stats.top_users.by_messages.map((u, i) => (
                              <div key={u._id} className="flex items-center justify-between">
                                <div className="flex items-center gap-2 min-w-0">
                                  <div className="w-8 text-sm text-muted-foreground shrink-0">
                                    #{((stats.top_users.pagination?.by_messages.page ?? topMessagesPage) - 1)
                                      * (stats.top_users.pagination?.by_messages.limit ?? 10) + i + 1}
                                  </div>
                                  <OwnerTypeBadge ownerType={u.owner_type} />
                                  <div className="text-sm truncate max-w-[200px] text-primary hover:underline cursor-pointer" onClick={() => setSelectedUserEmail(u._id)} title={u._id}>{u.name || u._id}</div>
                                </div>
                                <div className="text-sm font-medium shrink-0">{u.count} messages</div>
                              </div>
                            ))}
                          </div>
                          {stats.top_users.pagination?.by_messages && (
                            <CardPagination
                              label="top users by messages"
                              disabled={topMessagesLoading}
                              page={stats.top_users.pagination.by_messages.page}
                              pageSize={stats.top_users.pagination.by_messages.limit}
                              total={stats.top_users.pagination.by_messages.total}
                              className="border-t border-border pt-3"
                              onPageChange={(page) => void loadTopUsersPage('messages', page)}
                            />
                          )}
                        </CardContent>
                        </Card> : undefined}
                      </AsyncStatsCard>
                    </div>

                    {/* Top Agents and Feedback */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <AsyncStatsCard
                        error={statsSectionStatuses.top_agents.error}
                        loading={statsSectionStatuses.top_agents.loading}
                        minHeightClassName="min-h-72"
                        testId="stats-card-top-agents"
                      >
                        {stats.top_agents ? <Card>
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2">
                            <Bot className="h-5 w-5" />
                            Top Agents by Usage
                          </CardTitle>
                          <CardDescription>Most frequently used AI agents</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-3">
                            {(!stats.top_agents || stats.top_agents.length === 0) ? (
                              <p className="text-sm text-muted-foreground text-center py-4">No agent data yet</p>
                            ) : stats.top_agents.map((agent, i) => {
                              const maxCount = stats.top_agents[0].count;
                              const pct = maxCount > 0 ? (agent.count / maxCount) * 100 : 0;
                              return (
                                <div key={agent._id}>
                                  <div className="flex items-center justify-between mb-1">
                                    <div className="flex items-center gap-2">
                                      <div className="w-6 text-sm text-muted-foreground">#{i + 1}</div>
                                      <div className="text-sm font-medium capitalize">{agent._id}</div>
                                    </div>
                                    <div className="text-sm text-muted-foreground">{agent.count}</div>
                                  </div>
                                  <div className="h-2 bg-muted rounded-full overflow-hidden ml-8">
                                    <div
                                      className="h-full bg-primary rounded-full transition-all"
                                      style={{ width: `${pct}%` }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </CardContent>
                        </Card> : undefined}
                      </AsyncStatsCard>

                      <AsyncStatsCard
                        error={statsSectionStatuses.feedback.error}
                        loading={statsSectionStatuses.feedback.loading}
                        minHeightClassName="min-h-72"
                        testId="stats-card-feedback-summary"
                      >
                        {stats.feedback_summary ? <Card>
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2">
                            <ThumbsUp className="h-5 w-5" />
                            Feedback Summary
                          </CardTitle>
                          <CardDescription>User satisfaction across all platforms</CardDescription>
                        </CardHeader>
                        <CardContent>
                          {stats.feedback_summary && stats.feedback_summary.total > 0 ? (
                            <div className="space-y-4">
                              <div className="grid grid-cols-3 gap-4 text-center">
                                <div>
                                  <div className="flex items-center justify-center gap-1 mb-1">
                                    <ThumbsUp className="h-4 w-4 text-green-500" />
                                  </div>
                                  <p className="text-2xl font-bold text-green-500">{stats.feedback_summary.positive}</p>
                                  <p className="text-xs text-muted-foreground">Positive</p>
                                </div>
                                <div>
                                  <div className="flex items-center justify-center gap-1 mb-1">
                                    <ThumbsDown className="h-4 w-4 text-red-500" />
                                  </div>
                                  <p className="text-2xl font-bold text-red-500">{stats.feedback_summary.negative}</p>
                                  <p className="text-xs text-muted-foreground">Negative</p>
                                </div>
                                <div>
                                  <p className="text-2xl font-bold text-primary mt-5">
                                    {stats.feedback_summary.satisfaction_rate ?? Math.round((stats.feedback_summary.positive / stats.feedback_summary.total) * 100)}%
                                  </p>
                                  <p className="text-xs text-muted-foreground">Positive</p>
                                </div>
                              </div>
                              {/* Satisfaction bar */}
                              <div className="h-3 bg-red-100 dark:bg-red-900/30 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-green-500 rounded-full transition-all"
                                  style={{
                                    width: `${(stats.feedback_summary.positive / stats.feedback_summary.total) * 100}%`,
                                  }}
                                />
                              </div>

                              {/* Source breakdown */}
                              {stats.feedback_summary.by_source && Object.keys(stats.feedback_summary.by_source).length > 1 && (
                                <div className="mt-4 pt-3 border-t border-border">
                                  <p className="text-xs font-medium text-muted-foreground mb-2">By Source</p>
                                  <div className="grid grid-cols-2 gap-3">
                                    {Object.entries(stats.feedback_summary.by_source).map(([source, data]) => (
                                      <div key={source} className="text-center p-2 rounded-lg bg-muted/50">
                                        <p className="text-xs font-medium capitalize">{source}</p>
                                        <p className="text-sm">
                                          <span className="text-green-500">{data.positive}</span>
                                          {' / '}
                                          <span className="text-red-500">{data.negative}</span>
                                        </p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Negative feedback categories */}
                              {stats.feedback_summary.categories && stats.feedback_summary.categories.length > 0 && (
                                <div className="mt-4 pt-3 border-t border-border">
                                  <p className="text-xs font-medium text-muted-foreground mb-2">Negative Feedback Breakdown</p>
                                  <div className="space-y-2">
                                    {stats.feedback_summary.categories.slice(0, 5).map((cat) => {
                                      const maxCat = stats.feedback_summary.categories![0].count;
                                      const pct = maxCat > 0 ? (cat.count / maxCat) * 100 : 0;
                                      return (
                                        <div key={cat.category}>
                                          <div className="flex items-center justify-between mb-0.5">
                                            <span className="text-xs capitalize">{cat.category.replace(/_/g, ' ')}</span>
                                            <span className="text-xs text-muted-foreground">{cat.count}</span>
                                          </div>
                                          <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                            <div className="h-full bg-red-400 rounded-full" style={{ width: `${pct}%` }} />
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground text-center py-4">No feedback data yet</p>
                          )}

                        </CardContent>
                        </Card> : undefined}
                      </AsyncStatsCard>
                    </div>

                    {/* Feedback Trend + Response Time — 50/50 split. Response Time
                        is platform-wide (web + Slack); the source filter narrows
                        it. It sits here rather than in the Web section so it
                        renders for Slack-only stacks too. */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {(statsSectionStatuses.feedback.loading
                        || statsSectionStatuses.feedback.error
                        || (stats.feedback_summary?.daily?.length ?? 0) > 0) && (
                        <AsyncStatsCard
                          error={statsSectionStatuses.feedback.error}
                          loading={statsSectionStatuses.feedback.loading}
                          minHeightClassName="min-h-72"
                          testId="stats-card-feedback-trend"
                        >
                          {stats.feedback_summary?.daily && stats.feedback_summary.daily.length > 0 ? <Card>
                          <CardHeader>
                            <CardTitle>Feedback Trend ({rangeLabel})</CardTitle>
                            <CardDescription>Daily positive vs negative feedback</CardDescription>
                          </CardHeader>
                          <CardContent>
                            <FeedbackTrendChart
                              data={stats.feedback_summary.daily.map((day) => ({
                                date: day.date,
                                label: formatBucketLabel(day.date),
                                positive: day.positive,
                                negative: day.negative,
                              }))}
                              height={180}
                              onPointClick={tabGateValues.feedback
                                ? openFeedbackForTrendPoint
                                : undefined}
                            />
                          </CardContent>
                          </Card> : undefined}
                        </AsyncStatsCard>
                      )}

                      {/* Always shown so filtering to an agent with no latency
                          samples renders an empty chart, not a missing card. */}
                      <AsyncStatsCard
                        error={statsSectionStatuses.response_time.error}
                        loading={statsSectionStatuses.response_time.loading}
                        minHeightClassName="min-h-72"
                        testId="stats-card-response-time"
                      >
                        {stats.response_time ? <Card>
                          <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                              <Zap className="h-5 w-5" />
                              Response Time
                            </CardTitle>
                            <CardDescription>AI response latency across conversations</CardDescription>
                          </CardHeader>
                          <CardContent>
                            {(() => {
                              const samples = stats.response_time.samples ?? [];
                              if (samples.length === 0) {
                                return (
                                  <p className="text-sm text-muted-foreground text-center py-4">Not enough data to plot yet</p>
                                );
                              }
                              // Average computed here (client-side) from the raw samples.
                              const avgMs = samples.reduce((sum, s) => sum + s.latency_ms, 0) / samples.length;
                              return (
                                <SimpleLineChart
                                  data={samples.map((s) => ({
                                    label: formatBucketLabel(s.ts),
                                    value: s.latency_ms,
                                  }))}
                                  height={180}
                                  color="rgb(234, 179, 8)"
                                  avgLine={avgMs}
                                  avgLabel={`avg ${(avgMs / 1000).toFixed(1)}s`}
                                  formatValue={(ms) => `${(ms / 1000).toFixed(1)}s`}
                                />
                              );
                            })()}
                          </CardContent>
                        </Card> : undefined}
                      </AsyncStatsCard>
                    </div>

                    {/* Hourly Activity Heatmap */}
                    <AsyncStatsCard
                      error={statsSectionStatuses.hourly_heatmap.error}
                      loading={statsSectionStatuses.hourly_heatmap.loading}
                      minHeightClassName="min-h-72"
                      testId="stats-card-hourly-activity"
                    >
                      {stats.hourly_heatmap ? <Card>
                        <CardHeader>
                          <CardTitle className="flex items-center gap-2">
                            <Clock className="h-5 w-5" />
                            Activity by Hour ({rangeLabel})
                          </CardTitle>
                          <CardDescription>Message volume distribution across hours of the day (UTC, {rangeLabel})</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <div className="flex items-end gap-1" style={{ height: 128 }}>
                            {(() => {
                              const maxCount = Math.max(...stats.hourly_heatmap.map((x) => x.count), 1);
                              // Deep blue (low) → Green → Yellow (mid) → Orange → Red (high)
                              const heatColor = (ratio: number) => {
                                const stops = [
                                  [0,    30,  80, 220],  // deep blue
                                  [0.25, 34, 197, 94],   // green
                                  [0.5, 234, 179,   8],  // yellow
                                  [0.75,249, 115,  22],  // orange
                                  [1,   239,  68,  68],  // red
                                ];
                                let i = 0;
                                while (i < stops.length - 2 && ratio > stops[i + 1][0]) i++;
                                const [t0, r0, g0, b0] = stops[i];
                                const [t1, r1, g1, b1] = stops[i + 1];
                                const t = (ratio - t0) / (t1 - t0);
                                return `rgb(${Math.round(r0 + t * (r1 - r0))}, ${Math.round(g0 + t * (g1 - g0))}, ${Math.round(b0 + t * (b1 - b0))})`;
                              };
                              const currentHour = new Date().getUTCHours();
                              return stats.hourly_heatmap.map((h) => {
                                const ratio = h.count / maxCount;
                                const barHeight = Math.max(ratio * 100, 3);
                                const bg = h.count > 0 ? heatColor(ratio) : undefined;
                                const isCurrent = h.hour === currentHour;
                                return (
                                  <div
                                    key={h.hour}
                                    className="flex-1 flex flex-col items-center justify-end"
                                    style={{ height: 128 }}
                                    title={`${h.hour}:00 — ${h.count.toLocaleString()} messages${isCurrent ? ' (now)' : ''}`}
                                  >
                                    <div
                                      className={`w-full rounded-t transition-all ${h.count === 0 ? 'bg-muted' : ''}`}
                                      style={{
                                        height: `${barHeight}%`,
                                        backgroundColor: bg,
                                        ...(isCurrent ? { outline: '2px solid hsl(var(--foreground))', outlineOffset: -1, zIndex: 1 } : {}),
                                      }}
                                    />
                                  </div>
                                );
                              });
                            })()}
                          </div>
                          <div className="flex gap-1 mt-1">
                            {stats.hourly_heatmap.map((h) => {
                              const isCurrent = h.hour === new Date().getUTCHours();
                              return (
                                <div key={`lbl-${h.hour}`} className={`flex-1 text-center text-[9px] ${isCurrent ? 'text-foreground font-bold' : 'text-muted-foreground'}`}>
                                  {h.hour}
                                </div>
                              );
                            })}
                          </div>
                          <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                            <span>12am</span>
                            <span>6am</span>
                            <span>12pm</span>
                            <span>6pm</span>
                            <span>11pm</span>
                          </div>
                        </CardContent>
                      </Card> : undefined}
                    </AsyncStatsCard>

                    {/* ─── Web Section ─── */}
                    {(stats.completed_workflows
                      || statsSectionStatuses.completed_workflows.loading
                      || statsSectionStatuses.completed_workflows.error) && (
                      <>
                        <div className="flex items-center gap-2 pt-2">
                          <Globe className="h-5 w-5 text-muted-foreground" />
                          <h3 className="text-lg font-semibold">Web</h3>
                        </div>
                        <div className="h-px bg-border" />

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                          {/* Completed Workflows */}
                          <AsyncStatsCard
                            error={statsSectionStatuses.completed_workflows.error}
                            loading={statsSectionStatuses.completed_workflows.loading}
                            minHeightClassName="min-h-64"
                            testId="stats-card-completed-workflows"
                          >
                            {stats.completed_workflows ? <Card>
                              <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                  <CheckCircle2 className="h-5 w-5" />
                                  Completed Workflows
                                </CardTitle>
                                <CardDescription>Workflow run completion tracking</CardDescription>
                              </CardHeader>
                              <CardContent>
                                <div className="grid grid-cols-2 gap-3 text-center">
                                  <div className="p-2 rounded-lg bg-green-500/10">
                                    <p className="text-xl font-bold text-green-500">{stats.completed_workflows.total}</p>
                                    <p className="text-[10px] text-muted-foreground">Completed</p>
                                  </div>
                                  <div className="p-2 rounded-lg bg-orange-500/10">
                                    <p className="text-xl font-bold text-orange-500">{stats.completed_workflows.failed}</p>
                                    <p className="text-[10px] text-muted-foreground">Failed</p>
                                  </div>
                                  <div className="p-2 rounded-lg bg-primary/10">
                                    <p className="text-xl font-bold text-primary">{stats.completed_workflows.completion_rate}%</p>
                                    <p className="text-[10px] text-muted-foreground">Completion Rate</p>
                                  </div>
                                  <div className="p-2 rounded-lg bg-purple-500/10">
                                    <p className="text-xl font-bold text-purple-500">{stats.completed_workflows.avg_steps_per_workflow}</p>
                                    <p className="text-[10px] text-muted-foreground">Avg Steps/Workflow</p>
                                  </div>
                                </div>
                                {(stats.completed_workflows.total + stats.completed_workflows.failed) > 0 && (
                                  <div className="mt-3">
                                    <div className="h-2 bg-orange-100 dark:bg-orange-900/20 rounded-full overflow-hidden">
                                      <div
                                        className="h-full bg-green-500 rounded-full transition-all"
                                        style={{ width: `${stats.completed_workflows.completion_rate}%` }}
                                      />
                                    </div>
                                  </div>
                                )}
                              </CardContent>
                            </Card> : undefined}
                          </AsyncStatsCard>
                        </div>
                      </>
                    )}

                    {/* ─── Slack Section ─── */}
                    <SlackStatsSection
                      error={statsSectionStatuses.slack.error}
                      loading={statsSectionStatuses.slack.loading}
                      rangeLabel={rangeLabel}
                      slack={stats.slack}
                    />

                    {/* ─── Webex Section ─── */}
                    {webexEnabled && (
                      <WebexStatsSection
                        error={statsSectionStatuses.webex.error}
                        loading={statsSectionStatuses.webex.loading}
                        rangeLabel={rangeLabel}
                        webex={stats.webex}
                      />
                    )}

                    {/* ─── API Section ─── */}
                    <ApiStatsSection
                      api={stats.api}
                      error={statsSectionStatuses.api.error}
                      loading={statsSectionStatuses.api.loading}
                      rangeLabel={rangeLabel}
                    />
                  </div>

                {/* ─── Skills Section ─── */}
                {skillStats && (
                  <div className="space-y-4">
                    <div>
                      <h3 className="text-lg font-semibold">Skills</h3>
                      <p className="text-sm text-muted-foreground">
                        Date and user filters apply to creation and runs; source applies to runs. Legacy skill runs have no agent or channel attribution.
                      </p>
                    </div>

                    {/* Overview Cards */}
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">Skills Created</CardTitle>
                          <Layers className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold">{skillStats.total_skills}</div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {rangeLabel} · {skillStats.system_skills} system, {skillStats.user_skills} user-created
                          </p>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">User Skills Created</CardTitle>
                          <Users className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold">{skillStats.user_skills}</div>
                          <p className="text-xs text-muted-foreground mt-1">
                            by {skillStats.top_creators.length} creator{skillStats.top_creators.length !== 1 ? "s" : ""}
                          </p>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">Total Runs</CardTitle>
                          <Zap className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold">{skillStats.overall_run_stats.total_runs}</div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {skillStats.overall_run_stats.success_rate}% success rate
                          </p>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium">Categories</CardTitle>
                          <Activity className="h-4 w-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          <div className="text-2xl font-bold">{skillStats.by_category.length}</div>
                          <p className="text-xs text-muted-foreground mt-1">
                            unique categories
                          </p>
                        </CardContent>
                      </Card>
                    </div>

                    {/* Visibility + Category Breakdown */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base">Visibility Breakdown</CardTitle>
                          <CardDescription>User-created skills by sharing scope</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <VisibilityBreakdown
                            byVisibility={skillStats.by_visibility}
                            total={skillStats.user_skills}
                          />
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <CardTitle className="text-base">Skills by Category</CardTitle>
                          <CardDescription>Distribution across categories</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <CategoryBreakdown byCategory={skillStats.by_category} />
                        </CardContent>
                      </Card>
                    </div>

                    {/* Creation Timeline */}
                    {skillStats.daily_created.length > 0 && (
                      <Card>
                        <CardHeader>
                          <CardTitle>Skills Created ({rangeLabel})</CardTitle>
                          <CardDescription>New user-created skills per day</CardDescription>
                        </CardHeader>
                        <CardContent>
                          <SimpleLineChart
                            data={skillStats.daily_created.map((d) => ({
                              label: new Date(d.date).toLocaleDateString("en-US", {
                                month: "short",
                                day: "numeric",
                              }),
                              value: d.count,
                            }))}
                            height={200}
                            color="rgb(139, 92, 246)"
                          />
                        </CardContent>
                      </Card>
                    )}

                    {/* Top Creators */}
                    <TopCreatorsCard creators={skillStats.top_creators} onUserClick={setSelectedUserEmail} />

                    {/* Top Skills by Runs */}
                    <RunStatsTable
                      runStats={skillStats.top_skills_by_runs}
                      title="Top Skills by Usage"
                      description="Most frequently executed skills across the platform"
                    />
                  </div>
                )}
              </TabsContent>

              {/* Agent Metrics Tab (Prometheus) */}
              {tabGateValues.metrics && (
                <TabsContent value="metrics" className="space-y-4">
                  <MetricsTab />
                </TabsContent>
              )}

              {/* System Health Tab (live Prometheus + static services) */}
              <TabsContent value="health" className="space-y-4">
                <HealthTab />
              </TabsContent>

              {tabGateValues.audit_logs && (
                <TabsContent value="audit-logs" className="space-y-4">
                  <AuditLogsTab onUserClick={setSelectedUserEmail} />
                </TabsContent>
              )}

              {tabGateValues.action_audit && (
                <TabsContent value="action-audit" className="space-y-4">
                  <UnifiedAuditTab isAdmin={canMutateAdminData} />
                </TabsContent>
              )}

              {tabGateValues.approvals && (
                <TabsContent value="approvals" className="space-y-4">
                  <PublicationApprovalQueue readOnly={isSimulationActive} />
                </TabsContent>
              )}

              {tabGateValues.openfga && (
                <TabsContent value="access-explorer" className="space-y-4">
                  <AccessExplorerTab isAdmin={canMutateAdminData} />
                </TabsContent>
              )}

              {tabGateValues.openfga && (
                <TabsContent value="rbac-self-check" className="space-y-4">
                  <RbacSelfCheckTab isAdmin={canMutateAdminData} />
                </TabsContent>
              )}

              {tabGateValues.migrations && (
                <TabsContent value="keycloak" className="space-y-4">
                  <KeycloakMigrationHealthPanel />
                </TabsContent>
              )}

              {tabGateValues.migrations && (
                <TabsContent value="migrations" className="space-y-4">
                  <MigrationTab isAdmin={canMutateAdminData && tabGateValues.migrations} />
                </TabsContent>
              )}

        </Tabs>
      </WorkspaceShell>

      {/* Create Team Dialog */}
      <CreateTeamDialog
        open={createTeamDialogOpen}
        onOpenChange={setCreateTeamDialogOpen}
        // New teams sort to the top (newest-first), so jump to page 1 to
        // reveal the just-created team.
        onSuccess={() => refreshAfterTeamMutation(1)}
      />

      {/* Team Details / Member Management Dialog */}
      <TeamDetailsDialog
        team={selectedTeam}
        mode={teamDialogMode}
        open={teamDetailsOpen}
        canManageOrganization={canMutateAdminData}
        onOpenChange={setTeamDetailsOpen}
        onTeamUpdated={() => refreshAfterTeamMutation()}
        onTeamMutated={(updatedTeam) => {
          // In-place patch of the grid + full team lists so the row in the
          // background re-renders with the new member count / attributes —
          // without triggering a full dashboard reload.
          //
          // The Team shape used by this page is a structural superset
          // of the one returned by /api/admin/teams/[id]/* mutation
          // endpoints; we merge so any locally-known fields the API
          // doesn't echo back (e.g. denormalised StatChip counters)
          // survive the patch.
          const patch = (t: Team) =>
            t._id === updatedTeam._id
              ? ({ ...t, ...(updatedTeam as Partial<Team>) } as Team)
              : t;
          setGridTeams((prev) => prev.map(patch));
          setTeams((prev) => prev.map(patch));
          // Also keep `selectedTeam` (the prop the dialog reads from)
          // in sync so its `useEffect(() => setCurrentTeam(team), [team])`
          // can pick up the patched payload if the dialog re-opens
          // before the next dashboard refresh.
          setSelectedTeam((prev) =>
            prev
              ? ({ ...prev, ...(updatedTeam as Partial<TeamType>) } as TeamType)
              : (updatedTeam as TeamType),
          );
        }}
      />

      <Dialog
        open={Boolean(teamPendingDelete)}
        onOpenChange={(open) => {
          if (!open && !deletingTeam) {
            setTeamPendingDelete(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete team?</DialogTitle>
            <DialogDescription>
              {teamPendingDelete
                ? `Are you sure you want to delete the team "${teamPendingDelete.name}"? This cannot be undone.`
                : "This cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setTeamPendingDelete(null)}
              disabled={Boolean(deletingTeam)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (teamPendingDelete) {
                  void handleDeleteTeam(teamPendingDelete);
                }
              }}
              disabled={Boolean(deletingTeam)}
            >
              {deletingTeam ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Delete team
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* User Detail Sliding Panel */}
      <UserDetailPanel
        email={selectedUserEmail}
        onClose={() => setSelectedUserEmail(null)}
        simulationTarget={simulationTarget}
      />
    </div>
  );
}

export default function Admin() {
  return (
    <AuthGuard>
      <AdminPage />
    </AuthGuard>
  );
}

/**
 * Compact stat chip used inside team cards. Renders as a button so the whole
 * chip is clickable and keyboard-focusable; clicking jumps the user to the
 * matching tab in the team-management dialog. When `count` is undefined the
 * chip still renders (so the chip layout is stable across teams) but only
 * shows the icon + label, signalling "click to configure".
 */
function StatChip({
  icon,
  label,
  count,
  ariaLabel,
  title,
  disabled = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  // string variant supports wildcard markers like "*" for all-tool grants
  count?: number | string;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-0.5 rounded-md border bg-muted/30 hover:bg-muted/60 transition-colors py-2 px-1 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-muted/30"
      title={title || (disabled ? `${label} details are disabled during preview` : `Manage ${label.toLowerCase()}`)}
    >
      <div className="flex items-center gap-1 text-muted-foreground">
        {icon}
        {(typeof count === "number" || typeof count === "string") && (
          <span className="text-sm font-semibold text-foreground tabular-nums">
            {count}
          </span>
        )}
      </div>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
    </button>
  );
}
