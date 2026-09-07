"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { useApplicationNavigation } from "@/components/layout/ApplicationNavigationContext";
import { GuardedNavigationLink } from "@/components/layout/GuardedNavigationLink";
import { useWorkspaceRail } from "@/components/layout/WorkspaceRailContext";
import { pushWithNavigationProgress } from "@/lib/navigation-progress";
import { cn } from "@/lib/utils";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { useEffect,useId,useRef,useState } from "react";
import { useRouter } from "next/navigation";

export interface WorkspaceNavigationItem {
  children?: WorkspaceNavigationItem[];
  id: string;
  label: string;
  href?: string;
  icon: LucideIcon;
  onSelect?: () => void;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
  prefetch?: boolean;
  testId?: string;
}

function navigationLeaves(items: WorkspaceNavigationItem[]): WorkspaceNavigationItem[] {
  return items.flatMap((item) => item.children?.length
    ? navigationLeaves(item.children)
    : [item]);
}

export interface WorkspaceNavigationGroup {
  id: string;
  label?: string;
  icon?: LucideIcon;
  items: WorkspaceNavigationItem[];
}

export interface WorkspaceNavigationCategory {
  id: string;
  label: string;
  icon: LucideIcon;
  groups: WorkspaceNavigationGroup[];
}

interface WorkspaceNavigationListProps {
  activeItemId: string;
  ariaLabel: string;
  className?: string;
  collapsed?: boolean;
  density?: "compact" | "descriptive";
  groups: WorkspaceNavigationGroup[];
  onNavigate?: () => void;
}

interface CollapsedNavigationFlyoutProps {
  active: boolean;
  children: (close: () => void) => React.ReactNode;
  icon: LucideIcon;
  label: string;
}

/**
 * GitLab-style navigation flyout for a collapsed rail.
 *
 * Hover and focus expose child destinations without changing the rail width.
 * Click keeps the panel available for touchpads and keyboard users.
 */
export function CollapsedNavigationFlyout({
  active,
  children,
  icon: Icon,
  label,
}: CollapsedNavigationFlyoutProps): React.ReactElement {
  const [open,setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const close = () => {
    setOpen(false);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      const activeElement = document.activeElement;
      if (
        activeElement
        && (contentRef.current?.contains(activeElement)
          || triggerRef.current?.contains(activeElement))
      ) return;
      setOpen(false);
    },80);
  };

  useEffect(() => () => cancelClose(),[]);

  return (
    <Popover className="w-full" onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-expanded={open}
          aria-label={label}
          className={cn(
            "group flex min-h-11 w-full items-center justify-center rounded-xl px-2 py-2 text-muted-foreground outline-none transition-colors",
            "hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            active && "bg-muted/60 text-foreground",
          )}
          onBlur={scheduleClose}
          onFocus={() => {
            cancelClose();
            setOpen(true);
          }}
          onMouseEnter={() => {
            cancelClose();
            setOpen(true);
          }}
          onMouseLeave={scheduleClose}
          ref={triggerRef}
          type="button"
        >
          <span
            aria-hidden="true"
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors",
              active
                ? "gradient-primary-br text-white shadow-sm"
                : "group-hover:bg-background group-hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[calc(100dvh-1rem)] w-64 overflow-y-auto overscroll-contain p-2 duration-0"
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose();
        }}
        onFocusCapture={cancelClose}
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        side="right"
        sideOffset={8}
      >
        <div className="space-y-2" ref={contentRef}>
          <div className="border-b border-border/70 px-2 pb-2 pt-1 text-sm font-semibold">
            {label}
          </div>
          {open ? children(close) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NavigationItem({
  active,
  collapsed,
  density,
  item,
  onNavigate,
}: {
  active: boolean;
  collapsed: boolean;
  density: "compact" | "descriptive";
  item: WorkspaceNavigationItem;
  onNavigate?: () => void;
}): React.ReactElement {
  const applicationNavigation = useApplicationNavigation();
  const Icon = item.icon;
  const handleNavigate = () => {
    onNavigate?.();
    applicationNavigation?.closeMobileNavigation();
  };
  const itemClassName = cn(
    "group flex w-full items-center gap-3 rounded-xl border text-left outline-none transition-colors",
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    density === "descriptive" ? "min-h-14 px-2.5 py-2" : "min-h-12 px-2.5 py-2",
    collapsed && "justify-center px-2",
    item.disabled
      ? "cursor-not-allowed border-transparent text-muted-foreground opacity-50"
      : active
        ? "workspace-navigation-active border-transparent font-medium text-foreground"
        : "border-transparent text-muted-foreground hover:border-border/70 hover:bg-muted/60 hover:text-foreground",
  );
  const contents = (
    <>
      {collapsed ? (
        <span
          aria-hidden="true"
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
            !item.disabled && active
              ? "gradient-primary-br text-white shadow-sm"
              : "bg-muted text-muted-foreground",
            !item.disabled && !active && "group-hover:bg-background group-hover:text-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
      ) : null}
      {!collapsed ? (
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{item.label}</span>
          {density === "descriptive" && item.description ? (
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {item.description}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );

  const control = item.disabled ? (
    <span
      aria-disabled="true"
      aria-label={`${item.label}: ${item.disabledReason ?? "Unavailable"}`}
      className={itemClassName}
      data-testid={item.testId}
      role="link"
      tabIndex={0}
    >
      {contents}
    </span>
  ) : item.href ? (
    <GuardedNavigationLink
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={itemClassName}
      data-navigation-leaf="true"
      data-testid={item.testId}
      href={item.href}
      onClick={handleNavigate}
      prefetch={item.prefetch}
    >
      {contents}
    </GuardedNavigationLink>
  ) : (
    <button
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={itemClassName}
      data-navigation-leaf="true"
      data-testid={item.testId}
      onClick={() => {
        item.onSelect?.();
        handleNavigate();
      }}
      type="button"
    >
      {contents}
    </button>
  );

  return (
    <Tooltip className="block w-full">
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent className="max-w-xs whitespace-normal" side="right" sideOffset={8}>
        {item.disabled ? item.disabledReason ?? `${item.label} is unavailable` : item.label}
      </TooltipContent>
    </Tooltip>
  );
}

export function WorkspaceNavigationList({
  activeItemId,
  ariaLabel,
  className,
  collapsed = false,
  density = "compact",
  groups,
  onNavigate,
}: WorkspaceNavigationListProps): React.ReactElement {
  const navigationId = useId();
  const [expandedItemIds,setExpandedItemIds] = useState<Set<string>>(() => new Set(
    groups.flatMap((group) => group.items)
      .filter((item) => item.children?.some((child) => child.id === activeItemId))
      .map((item) => item.id),
  ));

  return (
    <TooltipProvider delayDuration={200}>
      <nav aria-label={ariaLabel} className={cn("space-y-7",className)}>
        {groups.map((group) => {
          const GroupIcon = group.icon;
          const headingId = `${navigationId}-group-${group.id}`;
          return (
            <section
              aria-labelledby={group.label ? headingId : undefined}
              className="space-y-2"
              key={group.id}
            >
              {group.label ? (
                <h2
                  className={cn(
                    "flex items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
                    collapsed && "sr-only",
                  )}
                  id={headingId}
                >
                  {GroupIcon ? <GroupIcon aria-hidden="true" className="h-3 w-3" /> : null}
                  <span>{group.label}</span>
                </h2>
              ) : null}
              <div className="space-y-1">
                {group.items.map((item) => {
                  if (!item.children?.length) {
                    return (
                      <NavigationItem
                        active={item.id === activeItemId}
                        collapsed={collapsed}
                        density={density}
                        item={item}
                        key={item.id}
                        onNavigate={onNavigate}
                      />
                    );
                  }

                  const Icon = item.icon;
                  const active = item.children.some((child) => child.id === activeItemId);
                  const expanded = expandedItemIds.has(item.id);
                  const childrenId = `${navigationId}-children-${item.id}`;
                  if (collapsed) {
                    return (
                      <CollapsedNavigationFlyout
                        active={active}
                        icon={Icon}
                        key={item.id}
                        label={item.label}
                      >
                        {(close) => (
                          <div className="space-y-1">
                            {item.children!.map((child) => (
                              <NavigationItem
                                active={child.id === activeItemId}
                                collapsed={false}
                                density="compact"
                                item={child}
                                key={child.id}
                                onNavigate={() => {
                                  close();
                                  onNavigate?.();
                                }}
                              />
                            ))}
                          </div>
                        )}
                      </CollapsedNavigationFlyout>
                    );
                  }
                  return (
                    <div className="space-y-2" key={item.id}>
                      <Tooltip className="block w-full">
                        <TooltipTrigger asChild>
                          <button
                            aria-controls={childrenId}
                            aria-expanded={expanded}
                            className={cn(
                              "group flex w-full items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 text-left text-muted-foreground outline-none transition-colors",
                              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                              density === "descriptive" ? "min-h-14" : "min-h-12",
                              active
                                ? "workspace-navigation-active font-medium text-foreground"
                                : "hover:bg-muted/60 hover:text-foreground",
                            )}
                            onClick={() => {
                              setExpandedItemIds((current) => {
                                const next = new Set(current);
                                if (next.has(item.id)) {
                                  next.delete(item.id);
                                } else {
                                  next.add(item.id);
                                }
                                return next;
                              });
                            }}
                            type="button"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{item.label}</span>
                              {density === "descriptive" && item.description ? (
                                <span className="block truncate text-xs font-normal text-muted-foreground">
                                  {item.description}
                                </span>
                              ) : null}
                            </span>
                            <ChevronDown
                              aria-hidden="true"
                              className={cn(
                                "h-4 w-4 shrink-0 transition-transform",
                                expanded && "rotate-180",
                              )}
                            />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs whitespace-normal" side="right" sideOffset={8}>
                          {item.label}
                        </TooltipContent>
                      </Tooltip>

                      {expanded ? (
                        <div
                          className="ml-4 space-y-1 border-l border-border/70 pl-3"
                          id={childrenId}
                        >
                          {item.children.map((child) => (
                            <NavigationItem
                              active={child.id === activeItemId}
                              collapsed={false}
                              density="compact"
                              item={child}
                              key={child.id}
                              onNavigate={onNavigate}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </nav>
    </TooltipProvider>
  );
}

interface WorkspaceSectionPickerProps {
  activeItemId: string;
  ariaLabel: string;
  className?: string;
  groups: WorkspaceNavigationGroup[];
}

export function WorkspaceSectionPicker({
  activeItemId,
  ariaLabel,
  className,
  groups,
}: WorkspaceSectionPickerProps): React.ReactElement {
  const router = useRouter();
  const id = useId();
  const activeItem = navigationLeaves(groups.flatMap((group) => group.items))
    .find((item) => item.id === activeItemId);
  const itemValue = (item: WorkspaceNavigationItem): string => item.href ?? item.id;

  return (
    <div className={cn("relative",className)}>
      <label className="mb-1.5 block text-xs font-medium text-muted-foreground" htmlFor={id}>
        {ariaLabel}
      </label>
      <Select
        aria-label={ariaLabel}
        className="h-12 w-full appearance-none rounded-xl border border-input bg-background px-3 pr-10 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        id={id}
        onChange={(event) => {
          const selectedItem = groups
            .flatMap((group) => navigationLeaves(group.items))
            .find((item) => itemValue(item) === event.target.value);
          if (selectedItem?.onSelect) {
            selectedItem.onSelect();
          } else if (selectedItem?.href) {
            pushWithNavigationProgress(router,selectedItem.href);
          }
        }}
        value={activeItem ? itemValue(activeItem) : ""}
      >
        {groups.map((group) => {
          const options = navigationLeaves(group.items).map((item) => (
            <option disabled={item.disabled} key={item.id} value={itemValue(item)}>
              {item.label}
            </option>
          ));
          return group.label ? (
            <optgroup key={group.id} label={group.label}>{options}</optgroup>
          ) : (
            <optgroup key={group.id} label="Sections">{options}</optgroup>
          );
        })}
      </Select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute bottom-4 right-3 h-4 w-4 text-muted-foreground"
      />
    </div>
  );
}

export function WorkspaceRailToggle(): React.ReactElement | null {
  const { collapsed,collapsible,toggle } = useWorkspaceRail();
  if (!collapsible) return null;
  const Icon = collapsed ? ChevronRight : ChevronLeft;
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const control = (
    <button
      aria-label={label}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      onClick={(event) => {
        toggle();
        if (event.detail > 0) event.currentTarget.blur();
      }}
      type="button"
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
    </button>
  );

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{control}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface WorkspaceSectionNavigationProps {
  activeItemId: string;
  groups: WorkspaceNavigationGroup[];
  navigationLabel: string;
  pickerLabel?: string;
}

/**
 * Responsive section navigation for dense settings and workspace pages.
 *
 * Routed workspaces register their navigation with the application rail.
 */
export function WorkspaceSectionNavigation({
  activeItemId,
  groups,
  navigationLabel,
  pickerLabel = navigationLabel,
}: WorkspaceSectionNavigationProps): React.ReactElement {
  return (
    <>
      <WorkspaceSectionPicker
        activeItemId={activeItemId}
        ariaLabel={pickerLabel}
        className="lg:hidden"
        groups={groups}
      />
      <aside className="hidden w-64 shrink-0 lg:block">
        <WorkspaceNavigationList
          activeItemId={activeItemId}
          ariaLabel={navigationLabel}
          groups={groups}
        />
      </aside>
    </>
  );
}

interface WorkspaceHierarchicalNavigationListProps {
  activeCategoryId: string;
  activeItemId: string;
  categories: WorkspaceNavigationCategory[];
  className?: string;
  collapsed?: boolean;
  navigationLabel: string;
  onNavigate?: () => void;
}

export function WorkspaceHierarchicalNavigationList({
  activeCategoryId,
  activeItemId,
  categories,
  className,
  collapsed = false,
  navigationLabel,
  onNavigate,
}: WorkspaceHierarchicalNavigationListProps): React.ReactElement {
  const navigationId = useId();
  const [categoryDisclosure,setCategoryDisclosure] = useState(() => ({
    activeCategoryId,
    expandedCategoryIds: new Set(activeCategoryId ? [activeCategoryId] : []),
    userInitiated: false,
  }));
  if (categoryDisclosure.activeCategoryId !== activeCategoryId) {
    setCategoryDisclosure({
      activeCategoryId,
      expandedCategoryIds: new Set(activeCategoryId ? [activeCategoryId] : []),
      userInitiated: false,
    });
  }
  const expandedCategoryIds = categoryDisclosure.expandedCategoryIds;

  return (
    <TooltipProvider delayDuration={200}>
      <nav aria-label={navigationLabel} className={cn("space-y-1",className)}>
        {categories.map((category) => {
          const active = category.id === activeCategoryId;
          const expanded = expandedCategoryIds.has(category.id);
          const CategoryIcon = category.icon;
          const destinationsId = `${navigationId}-category-${category.id}`;
          if (collapsed) {
            return (
              <CollapsedNavigationFlyout
                active={active}
                icon={CategoryIcon}
                key={category.id}
                label={category.label}
              >
                {(close) => (
                  <div className="space-y-4">
                    {category.groups.map((group) => {
                      const headingId = `${navigationId}-${category.id}-${group.id}-flyout`;
                      return (
                        <section
                          aria-labelledby={group.label ? headingId : undefined}
                          className="space-y-1.5"
                          key={group.id}
                        >
                          {group.label ? (
                            <h2
                              className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                              id={headingId}
                            >
                              {group.label}
                            </h2>
                          ) : null}
                          <div className="space-y-1">
                            {group.items.map((item) => (
                              <NavigationItem
                                active={item.id === activeItemId}
                                collapsed={false}
                                density="compact"
                                item={item}
                                key={item.id}
                                onNavigate={() => {
                                  close();
                                  onNavigate?.();
                                }}
                              />
                            ))}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                )}
              </CollapsedNavigationFlyout>
            );
          }
          const categoryControl = (
            <button
              aria-controls={destinationsId}
              aria-expanded={expanded}
              className={cn(
                "group flex min-h-11 w-full items-center gap-3 rounded-xl border border-transparent px-2.5 py-2 text-left outline-none transition-colors",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                active
                  ? "workspace-navigation-active font-medium text-foreground"
                  : expanded
                    ? "text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
              data-active={active || undefined}
              onClick={() => {
                setCategoryDisclosure((current) => {
                  const next = new Set(current.expandedCategoryIds);
                  if (next.has(category.id)) {
                    next.delete(category.id);
                  } else {
                    next.add(category.id);
                  }
                  return {
                    ...current,
                    expandedCategoryIds: next,
                    userInitiated: true,
                  };
                });
              }}
              type="button"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors",
                  active && "gradient-primary-br text-white shadow-sm",
                  !active && "group-hover:bg-background group-hover:text-foreground",
                )}
              >
                <CategoryIcon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {category.label}
              </span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  "h-4 w-4 shrink-0 transition-transform",
                  expanded && "rotate-180",
                )}
              />
            </button>
          );
          return (
            <section key={category.id}>
              <Tooltip className="block w-full">
                <TooltipTrigger asChild>{categoryControl}</TooltipTrigger>
                <TooltipContent className="max-w-xs whitespace-normal" side="right" sideOffset={8}>
                  {category.label}
                </TooltipContent>
              </Tooltip>

              <div
                aria-hidden={!expanded}
                className={cn(
                  "grid",
                  categoryDisclosure.userInitiated
                    && "transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
                  expanded
                    ? "grid-rows-[1fr] opacity-100"
                    : "pointer-events-none grid-rows-[0fr] opacity-0",
                )}
                id={destinationsId}
                inert={!expanded}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="ml-4 space-y-4 border-l border-border/70 pb-1 pl-3 pt-2">
                    {category.groups.map((group) => {
                      const headingId = `${navigationId}-${category.id}-${group.id}`;
                      return (
                        <section
                          aria-labelledby={group.label ? headingId : undefined}
                          className="space-y-1.5"
                          key={group.id}
                        >
                          {group.label ? (
                            <h2
                              className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                              id={headingId}
                            >
                              {group.label}
                            </h2>
                          ) : null}
                          <div className="space-y-1">
                            {group.items.map((item) => (
                              <NavigationItem
                                active={item.id === activeItemId}
                                collapsed={false}
                                density="compact"
                                item={item}
                                key={item.id}
                                onNavigate={onNavigate}
                              />
                            ))}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>
          );
        })}
      </nav>
    </TooltipProvider>
  );
}
