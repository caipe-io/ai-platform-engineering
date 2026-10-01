"use client";

import { filterAdminCategories } from "@/components/admin/workspace/admin-routes";
import { CREDENTIALS_GROUPS } from "@/components/credentials/navigation";
import { buildDynamicAgentNavigationGroups } from "@/components/dynamic-agents/navigation";
import { useApplicationNavigation } from "@/components/layout/ApplicationNavigationContext";
import {
  APPLICATION_SECTION_AREA_KEYS,
  ApplicationSectionNavigation,
} from "@/components/layout/ApplicationSectionNavigation";
import {
  ApplicationNavigationSearch,
  type ApplicationNavigationSearchEntry,
} from "@/components/layout/ApplicationNavigationSearch";
import { GuardedNavigationLink } from "@/components/layout/GuardedNavigationLink";
import {
  CollapsedNavigationFlyout,
  WorkspaceRailToggle,
} from "@/components/layout/WorkspaceNavigation";
import { useWorkspaceRail } from "@/components/layout/WorkspaceRailContext";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAdminRole } from "@/hooks/use-admin-role";
import { useAutonomousCapability } from "@/hooks/use-autonomous-capability";
import { useHydrated } from "@/hooks/use-hydrated";
import { useKbTabGates } from "@/hooks/use-kb-tab-gates";
import { useAdminTabGates } from "@/hooks/useAdminTabGates";
import { KNOWLEDGE_NAV_ITEMS } from "@/components/rag/KnowledgeSidebar";
import { PERSONAL_SETTINGS_ROUTES } from "@/components/settings/settings-routes";
import { config,getLogoFilterClass } from "@/lib/config";
import { cn } from "@/lib/utils";
import { resolveChatNavigationPath,useChatStore } from "@/store/chat-store";
import { motion,useReducedMotion } from "framer-motion";
import {
  Bot,
  CalendarClock,
  ChevronDown,
  Database,
  FolderKanban,
  Home,
  KeyRound,
  LayoutGrid,
  Mail,
  Menu,
  MessageCircle,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useSession } from "next-auth/react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import React from "react";

interface ApplicationNavigationItem {
  disabled?: boolean;
  disabledReason?: string;
  href: string;
  icon: LucideIcon;
  key: string;
  label: string;
  utility?: boolean;
}

function activeAreaForPath(pathname: string | null): string | null {
  if (pathname === "/") return "home";
  if (pathname?.startsWith("/chat")) return "chat";
  if (pathname?.startsWith("/projects")) return "projects";
  if (pathname?.startsWith("/knowledge-bases")) return "knowledge";
  if (pathname?.startsWith("/credentials")) return "credentials";
  if (pathname?.startsWith("/workflows")) return "workflows";
  if (pathname?.startsWith("/skills") || pathname?.startsWith("/use-cases")) {
    return "skills";
  }
  if (pathname?.startsWith("/dynamic-agents")) return "dynamic-agents";
  if (pathname?.startsWith("/autonomous")) return "autonomous";
  if (pathname?.startsWith("/apps")) return "apps";
  if (pathname?.startsWith("/schedules")) return "schedules";
  if (pathname?.startsWith("/admin")) return "admin";
  if (pathname?.startsWith("/settings")) return "settings";
  return null;
}

function ChatActivityBadge({
  inputRequired,
  overlay,
  streaming,
  unviewed,
}: {
  inputRequired: number;
  overlay: boolean;
  streaming: number;
  unviewed: number;
}): React.ReactElement | null {
  const count = streaming || inputRequired || unviewed;
  if (count === 0) return null;
  const color = streaming
    ? "bg-emerald-500"
    : inputRequired
      ? "bg-amber-500"
      : "bg-blue-500";

  return (
    <span
      aria-label={`${count} chat${count === 1 ? "" : "s"} ${
        streaming ? "streaming" : inputRequired ? "need input" : "unviewed"
      }`}
      className={cn(
        "flex items-center justify-center rounded-full px-1 text-[9px] font-bold text-white",
        overlay
          ? "absolute -right-1.5 -top-1.5 h-4 min-w-4 ring-2 ring-background"
          : "relative ml-auto h-5 min-w-5 shrink-0",
        color,
      )}
    >
      {streaming ? (
        <span
          aria-hidden="true"
          className="absolute inset-0 animate-ping rounded-full bg-emerald-400 opacity-60"
        />
      ) : null}
      <span className="relative">{count}</span>
    </span>
  );
}

function ApplicationNavigationContents({
  collapsed,
  layoutScope,
}: {
  collapsed: boolean;
  /**
   * Distinguishes the rail's always-mounted instance from the mobile
   * drawer's instance so their shared-layout active-item indicators
   * (layoutId below) don't fight each other if both are ever mounted
   * at once.
   */
  layoutScope: "rail" | "drawer";
}): React.ReactElement {
  const contextualNavigationId = React.useId();
  const pathname = usePathname();
  const hydrated = useHydrated();
  const shouldReduceMotion = useReducedMotion();
  const { data: session } = useSession();
  const { isAdmin } = useAdminRole();
  const { canUseAutonomous } = useAutonomousCapability();
  const { gates: adminGates,loading: adminGatesLoading } = useAdminTabGates();
  const {
    gates: knowledgeGates,
    loading: knowledgeGatesLoading,
    orgAdminBypass: knowledgeAdminBypass,
  } = useKbTabGates();
  const applicationNavigation = useApplicationNavigation();
  const {
    activeConversationId,
    conversations,
    inputRequiredConversations,
    streamingConversations,
    unviewedConversations,
  } = useChatStore();
  const chatHref = React.useMemo(
    () => hydrated
      ? resolveChatNavigationPath({ conversations,activeConversationId })
      : "/chat",
    [activeConversationId,conversations,hydrated],
  );
  const storageMode = config.storageMode;
  const knowledgeHasExplicitCapability =
    knowledgeGates.can_ingest === true || knowledgeGates.can_search === true;
  const knowledgeUnavailable =
    !knowledgeGatesLoading &&
    !knowledgeAdminBypass &&
    knowledgeGates.has_any_kb === false &&
    !knowledgeHasExplicitCapability;
  const activeArea = activeAreaForPath(pathname);
  const registeredContextualNavigation =
    applicationNavigation?.registration?.areaKey === activeArea
      ? applicationNavigation.registration.content
      : null;
  const activeHasSectionNavigation = Boolean(
    activeArea
      && (registeredContextualNavigation
        || APPLICATION_SECTION_AREA_KEYS.has(activeArea)),
  );
  const [expansionPreference,setExpansionPreference] = React.useState<{
    activeArea: string | null;
    expandedArea: string | null;
    userInitiated: boolean;
  }>({ activeArea: null,expandedArea: null,userInitiated: false });
  const routeExpandedArea = activeHasSectionNavigation ? activeArea : null;
  const hasUserExpansionPreference =
    expansionPreference.userInitiated
      && expansionPreference.activeArea === activeArea;
  const expandedArea = hasUserExpansionPreference
    ? expansionPreference.expandedArea
    : routeExpandedArea;

  React.useEffect(() => {
    setExpansionPreference((current) => current.activeArea === activeArea
      ? current
      : { activeArea,expandedArea: routeExpandedArea,userInitiated: false });
  }, [activeArea,routeExpandedArea]);

  const items = [
    { key: "home",href: "/",label: "Home",icon: Home },
    { key: "chat",href: chatHref,label: "Chat",icon: MessageCircle },
    config.projectsEnabled && {
      key: "projects",
      href: "/projects",
      label: "Projects",
      icon: FolderKanban,
    },
    { key: "skills",href: "/skills",label: "Skills",icon: Zap },
    config.workflowsEnabled && {
      key: "workflows",
      href: "/workflows",
      label: "Workflows",
      icon: Workflow,
    },
    config.ragEnabled && {
      key: "knowledge",
      href: "/knowledge-bases/search",
      label: "Knowledge Bases",
      icon: Database,
      disabled: knowledgeUnavailable,
      disabledReason:
        "You don't have Knowledge Base access yet. Ask an admin to grant your team permission.",
    },
    storageMode === "mongodb" && {
      key: "dynamic-agents",
      href: "/dynamic-agents",
      label: "Agents",
      icon: Bot,
    },
    config.autonomousAgentsEnabled && canUseAutonomous && {
      key: "autonomous",
      href: "/autonomous",
      label: "Autonomous",
      icon: Sparkles,
    },
    config.agenticAppsEnabled && {
      key: "apps",
      href: "/apps",
      label: "Apps",
      icon: LayoutGrid,
    },
    storageMode === "mongodb"
      && config.dynamicAgentsEnabled
      && config.schedulerEnabled
      && (!config.schedulerAdminOnly || isAdmin) && {
        key: "schedules",
        href: "/schedules",
        label: "Schedules",
        icon: CalendarClock,
      },
    storageMode === "mongodb" && config.userConnectionsEnabled && {
      key: "credentials",
      href: "/credentials/connections",
      label: "Credentials",
      icon: KeyRound,
    },
    (session || isAdmin) && {
      key: "admin",
      href: "/admin",
      label: "Admin",
      icon: Shield,
      disabled: storageMode !== "mongodb",
      disabledReason:
        "Admin tools require persistent platform storage and are unavailable in this deployment.",
      utility: true,
    },
    {
      key: "settings",
      href: "/settings/appearance",
      label: "Settings",
      icon: SlidersHorizontal,
      utility: true,
    },
  ].filter(Boolean) as ApplicationNavigationItem[];

  const firstUtilityKey = items.find((item) => item.utility)?.key;

  const closeMobileNavigation = () =>
    applicationNavigation?.closeMobileNavigation();

  const searchEntries: ApplicationNavigationSearchEntry[] = [
    ...items
      .filter((item) => !item.disabled)
      .map((item) => ({
        id: `page-${item.key}`,
        label: item.label,
        description: item.key === "chat" ? "Open your conversations" : undefined,
        group: item.utility ? "Utilities" : "Pages",
        href: item.href,
        icon: item.icon,
      })),
    ...(config.ragEnabled && !knowledgeUnavailable
      ? KNOWLEDGE_NAV_ITEMS
        .filter((item) => !item.requiresGraphRag)
        .map((item) => ({
          id: `knowledge-${item.id}`,
          label: item.label,
          description: item.description,
          group: "Knowledge Bases",
          href: item.href,
          icon: item.icon,
        }))
      : []),
    ...(storageMode === "mongodb" && config.dynamicAgentsEnabled
      ? buildDynamicAgentNavigationGroups({
        destinationForTab: (tab) => ({ href: `/dynamic-agents?tab=${tab}` }),
        showConversations: Boolean(adminGates.dynamic_agent_conversations),
      }).flatMap((group) => group.items).flatMap((item) => {
        const candidates = item.children ?? [item];
        return candidates.flatMap((candidate) => candidate.href ? [{
          id: `agents-${candidate.id}`,
          label: candidate.label,
          description: candidate.description,
          group: "Agents",
          href: candidate.href,
          icon: candidate.icon,
        }] : []);
      })
      : []),
    ...(storageMode === "mongodb" && config.userConnectionsEnabled
      ? CREDENTIALS_GROUPS.flatMap((group) => group.items).flatMap((item) =>
        item.href ? [{
          id: `credentials-${item.id}`,
          label: item.label,
          description: item.description,
          group: "Credentials",
          href: item.href,
          icon: item.icon,
        }] : [],
      )
      : []),
    ...PERSONAL_SETTINGS_ROUTES.map((route) => ({
      id: `settings-${route.id}`,
      label: route.label,
      description: route.description,
      group: "Settings",
      href: route.href,
      icon: route.icon,
    })),
    ...(!adminGatesLoading && storageMode === "mongodb"
      ? filterAdminCategories({
        ...adminGates,
        platform_settings: isAdmin,
        feedback: Boolean(adminGates.feedback && config.feedbackEnabled),
        audit_logs: Boolean(adminGates.audit_logs && config.auditLogsEnabled),
        credentials: Boolean(adminGates.credentials && config.credentialsEnabled),
        agents: isAdmin,
        mcp: isAdmin,
        identity_sync: Boolean(adminGates.identity_group_sync && config.oktaSyncEnabled),
      }).flatMap((category) => category.destinations.map((destination) => ({
        id: `admin-${destination.id}`,
        label: destination.label,
        description: destination.description,
        group: `Admin · ${category.label}`,
        href: destination.href,
        icon: destination.icon,
      })))
      : []),
  ];

  return (
    <TooltipProvider delayDuration={200}>
      <nav
        aria-label="Application navigation"
        className="flex min-h-full flex-col gap-1"
      >
        <ApplicationNavigationSearch
          enableShortcut={layoutScope === "rail"}
          entries={searchEntries}
          onNavigate={closeMobileNavigation}
        />
        {items.map((item) => {
          const Icon = item.icon;
          const active = activeArea === item.key;
          const builtInSectionNavigation =
            APPLICATION_SECTION_AREA_KEYS.has(item.key)
              ? <ApplicationSectionNavigation areaKey={item.key} />
              : null;
          // Admin pages cross server-component route boundaries. Keep the
          // shell-owned navigation mounted so those transitions cannot replay
          // the disclosure animation while page registration is replaced.
          const contextualNavigation = item.key === "admin"
            ? builtInSectionNavigation
            : registeredContextualNavigation && active
              ? registeredContextualNavigation
              : builtInSectionNavigation;
          const hasSectionNavigation =
            !item.disabled && Boolean(contextualNavigation);
          const contextExpanded =
            hasSectionNavigation && expandedArea === item.key;
          const chatBadge = item.key === "chat" ? (
            <ChatActivityBadge
              inputRequired={inputRequiredConversations.size}
              overlay={collapsed}
              streaming={streamingConversations.size}
              unviewed={unviewedConversations.size}
            />
          ) : null;
          const contents = (
            <>
              <span
                className={cn(
                  "relative isolate flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                  active
                    ? "text-white shadow-sm"
                    : "bg-muted text-muted-foreground group-hover:bg-background group-hover:text-foreground",
                )}
              >
                {active ? (
                  <motion.span
                    aria-hidden="true"
                    className="absolute inset-0 -z-10 rounded-lg gradient-primary-br shadow-sm"
                    layoutId={`nav-active-icon-${layoutScope}`}
                    transition={
                      shouldReduceMotion
                        ? { duration: 0 }
                        : {
                            type: "tween",
                            duration: 0.18,
                            ease: [0.22, 1, 0.36, 1],
                          }
                    }
                  />
                ) : null}
                <Icon aria-hidden="true" className="relative z-10 h-3.5 w-3.5" />
                {collapsed ? chatBadge : null}
              </span>
              {!collapsed ? (
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {item.label}
                </span>
              ) : null}
              {!collapsed ? chatBadge : null}
            </>
          );
          const className = cn(
            "group flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-2 text-left outline-none transition-colors",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            collapsed && "justify-center",
            item.disabled
              ? "cursor-help text-muted-foreground opacity-55"
              : active
                ? "bg-muted/60 font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          );

          if (collapsed && hasSectionNavigation) {
            return (
              <div
                className={cn(item.key === firstUtilityKey && "mt-auto pt-6")}
                key={item.key}
              >
                <CollapsedNavigationFlyout
                  active={active}
                  icon={Icon}
                  label={item.label}
                >
                  {(close) => (
                    <div
                      onClick={(event) => {
                        if (
                          !(event.target as HTMLElement).closest(
                            "[data-navigation-leaf='true']",
                          )
                        ) return;
                        close();
                        closeMobileNavigation();
                      }}
                    >
                      {contextualNavigation}
                    </div>
                  )}
                </CollapsedNavigationFlyout>
              </div>
            );
          }

          const toggleContext = () => {
            setExpansionPreference({
              activeArea,
              expandedArea: contextExpanded ? null : item.key,
              userInitiated: true,
            });
          };
          const control = item.disabled ? (
            <Popover className={cn("w-full", collapsed && "justify-center")}>
              <PopoverTrigger asChild>
                <button
                  aria-disabled="true"
                  aria-label={`${item.label}: unavailable`}
                  className={className}
                  type="button"
                >
                  {contents}
                </button>
              </PopoverTrigger>
              <PopoverContent
                align={collapsed ? "center" : "start"}
                className="w-72 space-y-3 p-4"
                side={collapsed ? "right" : "bottom"}
                sideOffset={8}
              >
                <div className="space-y-1.5">
                  <p className="text-sm font-semibold text-foreground">
                    {item.label} unavailable
                  </p>
                  <p className="text-sm leading-5 text-muted-foreground">
                    {item.disabledReason ?? "This destination is not available in this deployment."}
                  </p>
                </div>
                <Button asChild size="sm" className="w-full">
                  <a
                    href={`mailto:${config.supportEmail}?subject=${encodeURIComponent(`${config.appName} access request`)}`}
                  >
                    <Mail aria-hidden="true" />
                    Contact admin
                  </a>
                </Button>
              </PopoverContent>
            </Popover>
          ) : hasSectionNavigation && !collapsed ? (
            <button
              aria-controls={`${contextualNavigationId}-${item.key}`}
              aria-current={active ? "page" : undefined}
              aria-expanded={contextExpanded}
              className={className}
              onClick={toggleContext}
              type="button"
            >
              {contents}
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "ml-auto h-4 w-4 shrink-0 transition-transform",
                  contextExpanded && "rotate-180",
                )}
              />
            </button>
          ) : (
            <GuardedNavigationLink
              aria-current={active ? "page" : undefined}
              aria-label={collapsed ? item.label : undefined}
              className={className}
              href={item.href}
              onClick={closeMobileNavigation}
              prefetch
            >
              {contents}
            </GuardedNavigationLink>
          );

          return (
            <div
              className={cn(
                "space-y-1",
                item.key === firstUtilityKey && "mt-auto pt-6",
              )}
              key={item.key}
            >
              {collapsed ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {item.disabled ? (
                      <div className="flex w-full justify-center">{control}</div>
                    ) : control}
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {item.disabled
                      ? `${item.label} unavailable`
                      : item.key === "home" ? "Homepage" : item.label}
                  </TooltipContent>
                </Tooltip>
              ) : control}
              {!collapsed && hasSectionNavigation ? (
                <div
                  aria-hidden={!contextExpanded}
                  className={cn(
                    "grid",
                    hasUserExpansionPreference
                      && "transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
                    contextExpanded
                      ? "grid-rows-[1fr] opacity-100"
                      : "pointer-events-none grid-rows-[0fr] opacity-0",
                  )}
                  id={`${contextualNavigationId}-${item.key}`}
                  inert={!contextExpanded}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="ml-3 border-l border-border/60 pb-3 pl-3 pt-2">
                      {contextualNavigation}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>
    </TooltipProvider>
  );
}

function ApplicationBrand({
  collapsed,
}: {
  collapsed: boolean;
}): React.ReactElement {
  const applicationNavigation = useApplicationNavigation();
  const brand = (
    <GuardedNavigationLink
      aria-label={`${config.appName} home`}
      className={cn(
        "brand-link relative flex h-20 w-full items-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        collapsed
          ? "justify-center px-2"
          : "justify-start gap-2.5 px-4",
      )}
      href="/"
      onClick={applicationNavigation?.closeMobileNavigation}
    >
      <Image
        alt=""
        aria-hidden="true"
        className={cn("h-12 w-auto",getLogoFilterClass(config.logoStyle))}
        height={48}
        src={config.logoUrl}
        unoptimized
        width={48}
      />
      {!collapsed ? (
        <span className="brand-lockup relative min-w-0">
          <span
            aria-hidden="true"
            className="brand-name truncate text-2xl font-bold"
          >
            {Array.from(config.appName).map((letter,index) => (
              <span className="brand-letter" key={`${letter}-${index}`}>
                {letter === " " ? "\u00a0" : letter}
              </span>
            ))}
          </span>
        </span>
      ) : null}
    </GuardedNavigationLink>
  );

  return (
    <TooltipProvider delayDuration={1000}>
      <Tooltip className="block w-full">
        <TooltipTrigger asChild>
          <span className="block w-full">{brand}</span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>Homepage</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ApplicationNavigationRail(): React.ReactElement {
  const { collapsed } = useWorkspaceRail();

  return (
    <aside
      className={cn(
        "app-navigation-surface hidden h-full shrink-0 flex-col border-r border-border/60 bg-background/70 backdrop-blur-xl xl:flex",
        collapsed ? "w-[4.25rem]" : "w-64",
      )}
    >
      <ApplicationBrand collapsed={collapsed} />
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2">
        <ApplicationNavigationContents collapsed={collapsed} layoutScope="rail" />
      </div>
      <div className="flex shrink-0 items-center justify-start px-2 pb-3">
        <WorkspaceRailToggle />
      </div>
    </aside>
  );
}

export function ApplicationNavigationDrawer(): React.ReactElement | null {
  const applicationNavigation = useApplicationNavigation();
  if (!applicationNavigation) return null;

  return (
    <Dialog
      onOpenChange={applicationNavigation.setMobileNavigationOpen}
      open={applicationNavigation.mobileNavigationOpen}
    >
      <DialogContent className="app-navigation-surface left-0 top-0 flex h-dvh w-[min(20rem,90vw)] max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-y-0 border-l-0 p-0 sm:rounded-none">
        <DialogHeader className="sr-only">
          <DialogTitle>Navigation</DialogTitle>
          <DialogDescription>Choose a CAIPE destination.</DialogDescription>
        </DialogHeader>
        <ApplicationBrand collapsed={false} />
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <ApplicationNavigationContents collapsed={false} layoutScope="drawer" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ApplicationNavigationMenuButton(): React.ReactElement | null {
  const applicationNavigation = useApplicationNavigation();
  if (!applicationNavigation) return null;

  return (
    <button
      aria-label="Open navigation"
      className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring xl:hidden"
      onClick={applicationNavigation.openMobileNavigation}
      type="button"
    >
      <Menu aria-hidden="true" className="h-5 w-5" />
    </button>
  );
}

export function MobileApplicationBrand(): React.ReactElement {
  return (
    <GuardedNavigationLink
      aria-label={`${config.appName} home`}
      className="brand-link flex min-w-0 items-center gap-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring xl:hidden"
      href="/"
    >
      <Image
        alt=""
        aria-hidden="true"
        className={cn("h-9 w-auto",getLogoFilterClass(config.logoStyle))}
        height={36}
        src={config.logoUrl}
        unoptimized
        width={36}
      />
      <span className="brand-lockup relative hidden min-w-0 sm:inline-block">
        <span className="gradient-text truncate text-lg font-bold">
          {config.appName}
        </span>
      </span>
    </GuardedNavigationLink>
  );
}
