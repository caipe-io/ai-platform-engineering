import {
  Activity,
  Bot,
  Database,
  FileText,
  Globe,
  Hash,
  KeyRound,
  Layers,
  ListChecks,
  Megaphone,
  MessageSquare,
  Plug,
  RefreshCw,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  User,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

export type AdminCategoryKey =
  | "configuration"
  | "platform"
  | "people"
  | "integrations"
  | "insights"
  | "operations"
  | "security";

export type AdminDestinationId =
  | "defaults"
  | "announcements"
  | "agents"
  | "autonomous"
  | "mcp"
  | "rag"
  | "skills"
  | "service-accounts"
  | "credentials"
  | "users"
  | "teams"
  | "identity-sync"
  | "slack"
  | "webex"
  | "stats"
  | "feedback"
  | "metrics"
  | "health"
  | "access-before-sign-in"
  | "ai-review"
  | "action-audit"
  | "approvals"
  | "access-explorer"
  | "rbac-self-check"
  | "audit-logs"
  | "keycloak"
  | "migrations";

export interface AdminDestinationDefinition {
  description: string;
  gateKey: string;
  href: string;
  icon: LucideIcon;
  id: AdminDestinationId;
  label: string;
  subgroup?: string;
}

export interface AdminCategoryDefinition {
  icon: LucideIcon;
  id: AdminCategoryKey;
  label: string;
  destinations: AdminDestinationDefinition[];
}

export const ADMIN_CATEGORIES: AdminCategoryDefinition[] = [
  {
    id: "people",
    label: "Teams & Users",
    icon: Users,
    destinations: [
      {
        id: "users",
        href: "/admin/people/users",
        label: "Users",
        description: "Review people, roles, memberships, and resource access.",
        icon: User,
        gateKey: "users",
      },
      {
        id: "teams",
        href: "/admin/people/teams",
        label: "Teams",
        description: "Manage teams, membership, and shared resources.",
        icon: UsersRound,
        gateKey: "teams",
      },
      {
        id: "identity-sync",
        href: "/admin/people/identity-sync",
        label: "Identity Sync",
        description: "Monitor and control directory-backed team synchronization.",
        icon: RefreshCw,
        gateKey: "identity_sync",
      },
    ],
  },
  {
    id: "configuration",
    label: "Platform configuration",
    icon: SlidersHorizontal,
    destinations: [
      {
        id: "defaults",
        href: "/admin/configuration/defaults",
        label: "Defaults",
        description: "Set fallback behavior for people who have not made a personal choice.",
        icon: SlidersHorizontal,
        gateKey: "platform_settings",
      },
      {
        id: "announcements",
        href: "/admin/configuration/announcements",
        label: "Announcements",
        description: "Control platform-wide release announcements.",
        icon: Megaphone,
        gateKey: "platform_settings",
      },
    ],
  },
  {
    id: "platform",
    label: "Resources",
    icon: Layers,
    destinations: [
      {
        id: "agents",
        href: "/admin/platform/agents",
        label: "Agent configuration",
        description: "Import and reconcile agents from platform configuration.",
        icon: Bot,
        gateKey: "agents",
      },
      {
        id: "mcp",
        href: "/admin/platform/mcp-catalog",
        label: "MCP Catalog",
        description: "Manage the remote MCP providers available to users.",
        icon: Plug,
        gateKey: "mcp",
      },
      {
        id: "rag",
        href: "/admin/platform/rag",
        label: "RAG",
        description: "Configure knowledge base defaults, ingestion, and publication review.",
        icon: Database,
        gateKey: "rag",
      },
      {
        id: "skills",
        href: "/admin/platform/skill-hubs",
        label: "Skill Hubs",
        description: "Manage external skill catalogs and crawl sources.",
        icon: Layers,
        gateKey: "skills",
      },
      {
        id: "service-accounts",
        href: "/admin/platform/service-accounts",
        label: "Service Accounts",
        description: "Manage machine identities and their platform access.",
        icon: KeyRound,
        gateKey: "service_accounts",
      },
      {
        id: "credentials",
        href: "/admin/platform/credentials",
        label: "Credentials",
        description: "Review and manage platform credential access.",
        icon: Shield,
        gateKey: "credentials",
      },
    ],
  },
  {
    id: "integrations",
    label: "Integrations",
    icon: Globe,
    destinations: [
      {
        id: "slack",
        href: "/admin/integrations/slack",
        label: "Slack",
        description: "Manage Slack channels and their platform access.",
        icon: Hash,
        gateKey: "slack",
      },
      {
        id: "webex",
        href: "/admin/integrations/webex",
        label: "Webex",
        description: "Manage Webex spaces and their platform access.",
        icon: MessageSquare,
        gateKey: "webex",
      },
    ],
  },
  {
    id: "insights",
    label: "Insights",
    icon: TrendingUp,
    destinations: [
      {
        id: "stats",
        href: "/admin/insights/statistics",
        label: "Statistics",
        description: "Understand usage, adoption, and workflow outcomes.",
        icon: TrendingUp,
        gateKey: "stats",
      },
      {
        id: "feedback",
        href: "/admin/insights/feedback",
        label: "Feedback",
        description: "Review user feedback across web and connected surfaces.",
        icon: MessageSquare,
        gateKey: "feedback",
      },
    ],
  },
  {
    id: "operations",
    label: "Metrics & Health",
    icon: Activity,
    destinations: [
      {
        id: "metrics",
        href: "/admin/operations/metrics",
        label: "Metrics",
        description: "Inspect live operational and agent metrics.",
        icon: Activity,
        gateKey: "metrics",
      },
      {
        id: "health",
        href: "/admin/operations/health",
        label: "Health",
        description: "Check platform services and dependency health.",
        icon: Database,
        gateKey: "health",
      },
    ],
  },
  {
    id: "security",
    label: "Security & Policy",
    icon: Shield,
    destinations: [
      {
        id: "access-before-sign-in",
        href: "/admin/security/access-before-sign-in",
        label: "Access before sign-in",
        description: "Control starting access for unlinked Slack and Webex callers.",
        icon: Shield,
        gateKey: "platform_settings",
        subgroup: "Policy",
      },
      {
        id: "ai-review",
        href: "/admin/security/ai-review",
        label: "AI Review",
        description: "Configure review policy for AI-generated changes.",
        icon: ListChecks,
        gateKey: "platform_settings",
        subgroup: "Policy",
      },
      {
        id: "autonomous",
        href: "/admin/security/autonomous-enablement",
        label: "Autonomous Enablement",
        description: "Control which teams may use autonomous agents.",
        icon: Bot,
        gateKey: "autonomous",
        subgroup: "Policy",
      },
      {
        id: "action-audit",
        href: "/admin/security/rbac-audit",
        label: "RBAC Audit",
        description: "Review authorization mutations and administrative actions.",
        icon: Shield,
        gateKey: "action_audit",
        subgroup: "Authorization",
      },
      {
        id: "approvals",
        href: "/admin/security/approvals",
        label: "Approvals",
        description: "Review publication requests and your request history.",
        icon: ShieldCheck,
        gateKey: "approvals",
        subgroup: "Authorization",
      },
      {
        id: "access-explorer",
        href: "/admin/security/access-explorer",
        label: "Access Explorer",
        description: "Explore effective access and authorization relationships.",
        icon: Shield,
        gateKey: "openfga",
        subgroup: "Authorization",
      },
      {
        id: "rbac-self-check",
        href: "/admin/security/self-check",
        label: "Self Check",
        description: "Validate the current authorization configuration.",
        icon: ListChecks,
        gateKey: "openfga",
        subgroup: "Authorization",
      },
      {
        id: "audit-logs",
        href: "/admin/security/chat-audit",
        label: "Chat Audit",
        description: "Review retained conversation activity and audit records.",
        icon: FileText,
        gateKey: "audit_logs",
        subgroup: "Audit",
      },
      {
        id: "keycloak",
        href: "/admin/security/keycloak",
        label: "Keycloak",
        description: "Review identity-provider migration health.",
        icon: ShieldCheck,
        gateKey: "migrations",
        subgroup: "Identity & maintenance",
      },
      {
        id: "migrations",
        href: "/admin/security/migrations",
        label: "Migrations",
        description: "Run and monitor platform data migrations.",
        icon: Database,
        gateKey: "migrations",
        subgroup: "Identity & maintenance",
      },
    ],
  },
];

export const ADMIN_DESTINATIONS = ADMIN_CATEGORIES.flatMap(
  (category) => category.destinations,
);

export const DEFAULT_ADMIN_DESTINATION_ID: AdminDestinationId = "users";
export const DEFAULT_READONLY_DESTINATION_ID: AdminDestinationId = "users";

export function findAdminDestinationById(
  id: string | null | undefined,
): AdminDestinationDefinition | undefined {
  return ADMIN_DESTINATIONS.find((destination) => destination.id === id);
}

export function findAdminDestinationByPath(
  pathname: string | null | undefined,
): AdminDestinationDefinition | undefined {
  if (!pathname) return undefined;
  const normalized = pathname.replace(/\/$/, "") || "/admin";
  return ADMIN_DESTINATIONS.find((destination) => destination.href === normalized);
}

export function findAdminCategoryForDestination(
  destinationId: AdminDestinationId,
): AdminCategoryDefinition {
  return ADMIN_CATEGORIES.find((category) =>
    category.destinations.some((destination) => destination.id === destinationId),
  )!;
}

export function filterAdminCategories(
  gateValues: Record<string, boolean>,
): AdminCategoryDefinition[] {
  return ADMIN_CATEGORIES.map((category) => ({
    ...category,
    destinations: category.destinations.filter(
      (destination) => gateValues[destination.gateKey],
    ),
  })).filter((category) => category.destinations.length > 0);
}
