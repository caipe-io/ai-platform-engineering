"use client";

import { GuardedNavigationLink } from "@/components/layout/GuardedNavigationLink";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  Bot,
  LoaderCircle,
  MessageSquare,
  Search,
  Zap,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import React from "react";

export interface ApplicationNavigationSearchEntry {
  description?: string;
  group: string;
  href: string;
  icon: LucideIcon;
  id: string;
  label: string;
  section?: "navigation" | "resources";
}

interface AccessibleAgent {
  description?: string;
  id: string;
  name: string;
}

interface ConversationSearchResult {
  _id: string;
  title?: string;
}

interface SkillSearchResult {
  description?: string;
  id: string;
  name: string;
}

interface WorkflowSearchResult {
  _id: string;
  description?: string;
  name: string;
}

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const OPEN_APPLICATION_SEARCH_EVENT = "caipe:open-application-search";

function useCommandPaletteShortcut(): string {
  const [shortcut,setShortcut] = React.useState("⌘/Ctrl K");

  React.useEffect(() => {
    setShortcut(/Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "⌘ K" : "Ctrl K");
  }, []);

  return shortcut;
}

export function ApplicationNavigationSearchTrigger({
  collapsed = false,
  variant = "compact",
}: {
  collapsed?: boolean;
  variant?: "compact" | "sidebar" | "center";
}): React.ReactElement {
  const shortcut = useCommandPaletteShortcut();
  const center = variant === "center";
  const sidebar = variant === "sidebar";

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={`Search CAIPE · ${shortcut}`}
            className={cn(
              "flex items-center text-muted-foreground outline-none transition-colors",
              "hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              variant === "compact" && "h-8 justify-center gap-1.5 rounded-md px-2",
              center && "h-9 w-full justify-start gap-2 rounded-lg border border-border/70 bg-background/70 px-3 shadow-sm hover:border-border",
              sidebar && cn(
                "min-h-10 rounded-lg",
                collapsed ? "w-full justify-center px-2" : "w-full justify-start gap-2 px-3",
              ),
            )}
            data-search-trigger-variant={variant}
            data-testid={`application-navigation-search-trigger-${variant}`}
            onClick={() => window.dispatchEvent(new Event(OPEN_APPLICATION_SEARCH_EVENT))}
            type="button"
          >
            <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
            {center ? (
              <>
                <span className="min-w-0 flex-1 truncate text-left text-sm">Search CAIPE</span>
                <kbd className="rounded border border-border/70 bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                  {shortcut}
                </kbd>
              </>
            ) : sidebar && !collapsed ? (
              <>
                <span className="min-w-0 flex-1 truncate text-left text-sm">Search</span>
                <kbd className="rounded border border-border/70 bg-muted/70 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                  {shortcut}
                </kbd>
              </>
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={8}>
          Search CAIPE · {shortcut}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function filterApplicationNavigationEntries(
  entries: ApplicationNavigationSearchEntry[],
  query: string,
): ApplicationNavigationSearchEntry[] {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return entries;

  return entries.filter((entry) => {
    const haystack = [entry.label,entry.group,entry.description]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Query existing user-scoped APIs. Each endpoint performs its own OpenFGA or
 * ownership filtering, so the palette never receives inaccessible resources.
 */
export async function searchApplicationResources(
  query: string,
  signal?: AbortSignal,
  fetchImplementation: FetchImplementation = fetch,
): Promise<ApplicationNavigationSearchEntry[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const encodedQuery = encodeURIComponent(normalizedQuery);
  const requests = await Promise.allSettled([
    fetchImplementation("/api/user/accessible-agents?page_size=100", {
      credentials: "same-origin",
      signal,
    }).then(responseJson),
    fetchImplementation(`/api/chat/search?q=${encodedQuery}&page=1&page_size=8`, {
      credentials: "same-origin",
      signal,
    }).then(responseJson),
    fetchImplementation(`/api/skills?q=${encodedQuery}&page=1&page_size=8`, {
      credentials: "same-origin",
      signal,
    }).then(responseJson),
    fetchImplementation("/api/workflow-configs", {
      credentials: "same-origin",
      signal,
    }).then(responseJson),
  ]);

  if (signal?.aborted) return [];

  const fulfilled = (index: number): unknown => {
    const result = requests[index];
    return result?.status === "fulfilled" ? result.value : null;
  };

  const agentsPayload = record(fulfilled(0));
  const agentsData = record(agentsPayload?.data);
  const terms = normalizedQuery.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const agents = records(agentsData?.agents)
    .map((agent): AccessibleAgent => ({
      id: stringValue(agent.id),
      name: stringValue(agent.name),
      description: stringValue(agent.description),
    }))
    .filter((agent) => agent.id && agent.name)
    .filter((agent) => {
      const haystack = `${agent.name} ${agent.description ?? ""}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .slice(0,8)
    .map((agent): ApplicationNavigationSearchEntry => ({
      id: `resource-agent-${agent.id}`,
      label: agent.name,
      description: agent.description,
      group: "Agent",
      href: `/dynamic-agents?tab=agents&agent=${encodeURIComponent(agent.id)}`,
      icon: Bot,
      section: "resources",
    }));

  const conversationsPayload = record(fulfilled(1));
  const conversationsData = record(conversationsPayload?.data);
  const conversations = records(conversationsData?.items)
    .map((conversation): ConversationSearchResult => ({
      _id: stringValue(conversation._id),
      title: stringValue(conversation.title),
    }))
    .filter((conversation) => conversation._id)
    .map((conversation): ApplicationNavigationSearchEntry => ({
      id: `resource-conversation-${conversation._id}`,
      label: conversation.title || "Untitled conversation",
      group: "Conversation",
      href: `/chat/${encodeURIComponent(conversation._id)}`,
      icon: MessageSquare,
      section: "resources",
    }));

  const skillsPayload = record(fulfilled(2));
  const skills = records(skillsPayload?.skills)
    .map((skill): SkillSearchResult => ({
      id: stringValue(skill.id),
      name: stringValue(skill.name),
      description: stringValue(skill.description),
    }))
    .filter((skill) => skill.id && skill.name)
    .map((skill): ApplicationNavigationSearchEntry => ({
      id: `resource-skill-${skill.id}`,
      label: skill.name,
      description: skill.description,
      group: "Skill",
      href: `/skills/workspace/${encodeURIComponent(skill.id)}`,
      icon: Zap,
      section: "resources",
    }));

  const workflows = records(fulfilled(3))
    .map((workflow): WorkflowSearchResult => ({
      _id: stringValue(workflow._id),
      name: stringValue(workflow.name),
      description: stringValue(workflow.description),
    }))
    .filter((workflow) => workflow._id && workflow.name)
    .filter((workflow) => {
      const haystack = `${workflow.name} ${workflow.description ?? ""}`.toLocaleLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .slice(0,8)
    .map((workflow): ApplicationNavigationSearchEntry => ({
      id: `resource-workflow-${workflow._id}`,
      label: workflow.name,
      description: workflow.description,
      group: "Workflow",
      href: `/workflows?workflow=${encodeURIComponent(workflow._id)}`,
      icon: Workflow,
      section: "resources",
    }));

  return [...agents,...conversations,...skills,...workflows];
}

function SearchResult({
  active,
  entry,
  index,
  onNavigate,
  onSelect,
}: {
  active: boolean;
  entry: ApplicationNavigationSearchEntry;
  index: number;
  onNavigate?: () => void;
  onSelect: (index: number) => void;
}): React.ReactElement {
  const Icon = entry.icon;
  return (
    <div
      aria-selected={active}
      id={`application-navigation-search-option-${index}`}
      onMouseEnter={() => onSelect(index)}
      role="option"
    >
      <GuardedNavigationLink
        aria-label={`${entry.label}, ${entry.group}`}
        className={cn(
          "group/result flex items-center gap-3 rounded-lg px-3 py-2.5 outline-none transition-colors",
          active
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
        data-navigation-leaf="true"
        data-testid={`application-navigation-search-result-${index}`}
        href={entry.href}
        onClick={onNavigate}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-sm">
          <Icon aria-hidden="true" className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {entry.label}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {entry.group}{entry.description ? ` · ${entry.description}` : ""}
          </span>
        </span>
        <ArrowRight
          aria-hidden="true"
          className="h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover/result:opacity-100"
        />
      </GuardedNavigationLink>
    </div>
  );
}

export function ApplicationNavigationSearch({
  enableShortcut,
  entries,
  onNavigate,
}: {
  enableShortcut: boolean;
  entries: ApplicationNavigationSearchEntry[];
  onNavigate?: () => void;
}): React.ReactElement {
  const [open,setOpen] = React.useState(false);
  const [query,setQuery] = React.useState("");
  const [activeIndex,setActiveIndex] = React.useState(0);
  const [resourceEntries,setResourceEntries] = React.useState<ApplicationNavigationSearchEntry[]>([]);
  const [resourcesLoading,setResourcesLoading] = React.useState(false);
  const resultsRef = React.useRef<HTMLDivElement>(null);
  const navigationEntries = React.useMemo(
    () => filterApplicationNavigationEntries(entries,query),
    [entries,query],
  );
  const results = React.useMemo(
    () => [...navigationEntries,...resourceEntries],
    [navigationEntries,resourceEntries],
  );

  React.useEffect(() => {
    if (!enableShortcut) return undefined;
    const handleOpen = () => setOpen(true);
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() !== "k" || (!event.metaKey && !event.ctrlKey)) {
        return;
      }
      event.preventDefault();
      setOpen((current) => !current);
    };
    window.addEventListener(OPEN_APPLICATION_SEARCH_EVENT,handleOpen);
    window.addEventListener("keydown",handleShortcut);
    return () => {
      window.removeEventListener(OPEN_APPLICATION_SEARCH_EVENT,handleOpen);
      window.removeEventListener("keydown",handleShortcut);
    };
  }, [enableShortcut]);

  React.useEffect(() => {
    if (!open || !query.trim()) {
      setResourceEntries([]);
      setResourcesLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setResourcesLoading(true);
      void searchApplicationResources(query,controller.signal)
        .then(setResourceEntries)
        .finally(() => {
          if (!controller.signal.aborted) setResourcesLoading(false);
        });
    },180);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [open,query]);

  React.useEffect(() => {
    setActiveIndex(0);
  }, [query,open]);

  React.useEffect(() => {
    if (activeIndex >= results.length) setActiveIndex(Math.max(0,results.length - 1));
  }, [activeIndex,results.length]);

  const updateOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setResourceEntries([]);
    }
  };

  const closeAndNavigate = () => {
    updateOpen(false);
    onNavigate?.();
  };

  return (
    <>
      {open ? <Dialog open onOpenChange={updateOpen}>
        <DialogContent className="max-w-xl gap-0 overflow-hidden p-0 [&>button]:hidden">
          <DialogHeader className="sr-only">
            <DialogTitle>Search CAIPE</DialogTitle>
            <DialogDescription>Find a page or resource you can access.</DialogDescription>
          </DialogHeader>
          <div
            className="flex items-center gap-3 border-b border-border/70 px-4"
            data-testid="application-navigation-search-header"
          >
            <Search aria-hidden="true" className="h-5 w-5 shrink-0 text-muted-foreground" />
            <input
              aria-activedescendant={
                results.length > 0
                  ? `application-navigation-search-option-${activeIndex}`
                  : undefined
              }
              aria-controls="application-navigation-search-results"
              aria-expanded="true"
              aria-label="Search pages and resources"
              autoFocus
              className="h-14 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((current) =>
                    results.length === 0 ? 0 : (current + 1) % results.length,
                  );
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((current) =>
                    results.length === 0
                      ? 0
                      : (current - 1 + results.length) % results.length,
                  );
                } else if (event.key === "Enter" && results.length > 0) {
                  event.preventDefault();
                  resultsRef.current
                    ?.querySelector<HTMLAnchorElement>(
                      `[data-testid="application-navigation-search-result-${activeIndex}"]`,
                    )
                    ?.click();
                }
              }}
              placeholder="Search pages, agents, chats, and skills…"
              role="combobox"
              type="search"
              value={query}
            />
            <div className="flex shrink-0 items-center">
              {resourcesLoading ? (
                <LoaderCircle aria-label="Searching resources" className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <kbd className="rounded border border-border/70 bg-muted px-1.5 py-1 text-[10px] font-medium text-muted-foreground">
                  Esc
                </kbd>
              )}
            </div>
          </div>

          <div
            className="max-h-[min(26rem,60vh)] overflow-y-auto p-2"
            id="application-navigation-search-results"
            ref={resultsRef}
            role="listbox"
          >
            {navigationEntries.length > 0 ? (
              <div>
                <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Navigation &amp; quick actions
                </p>
                {navigationEntries.map((entry,index) => (
                  <SearchResult
                    active={index === activeIndex}
                    entry={entry}
                    index={index}
                    key={entry.id}
                    onNavigate={closeAndNavigate}
                    onSelect={setActiveIndex}
                  />
                ))}
              </div>
            ) : null}

            {resourceEntries.length > 0 ? (
              <div className={cn(navigationEntries.length > 0 && "mt-2 border-t border-border/60 pt-1")}>
                <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Resources you can access
                </p>
                {resourceEntries.map((entry,resourceIndex) => {
                  const index = navigationEntries.length + resourceIndex;
                  return (
                    <SearchResult
                      active={index === activeIndex}
                      entry={entry}
                      index={index}
                      key={entry.id}
                      onNavigate={closeAndNavigate}
                      onSelect={setActiveIndex}
                    />
                  );
                })}
              </div>
            ) : null}

            {results.length === 0 && !resourcesLoading ? (
              <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                No pages or accessible resources match “{query}”.
              </div>
            ) : null}
          </div>
          <div className="flex items-center justify-between border-t border-border/70 px-4 py-2 text-[11px] text-muted-foreground">
            <span>↑↓ to move</span>
            <span>Enter to open</span>
          </div>
        </DialogContent>
      </Dialog> : null}
    </>
  );
}
