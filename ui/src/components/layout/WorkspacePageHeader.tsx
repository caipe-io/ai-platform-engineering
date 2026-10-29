"use client";

import { HeaderBreadcrumbPortal } from "@/components/layout/HeaderBreadcrumbSlot";
import { useWorkspacePageActionsTarget } from "@/components/layout/WorkspacePageActions";
import { cn } from "@/lib/utils";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { ChevronRight, Layers, Target } from "lucide-react";
import type { NativeExtensionBreadcrumb } from "../../../app-sdk";

export interface WorkspaceBreadcrumbItem extends NativeExtensionBreadcrumb {
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
}

const BREADCRUMB_TONES = {
  primary: "text-primary",
  info: "text-sky-600 dark:text-sky-400",
};

interface WorkspacePageHeaderProps {
  actions?: React.ReactNode;
  breadcrumbs: WorkspaceBreadcrumbItem[];
  className?: string;
  description: string;
  title: string;
  titleId?: string;
}

export function WorkspaceBreadcrumbs({
  breadcrumbs,
  className,
  portal = true,
}: {
  breadcrumbs: WorkspaceBreadcrumbItem[];
  className?: string;
  portal?: boolean;
}): React.ReactElement {
  const breadcrumb = (
    <nav
      aria-label="Breadcrumb"
      className={cn("min-w-0 max-w-full overflow-x-auto",className)}
    >
      <ol className="flex w-max items-center gap-1 whitespace-nowrap text-sm text-muted-foreground">
        {breadcrumbs.map((item,index) => {
          const current = index === breadcrumbs.length - 1;
          const Icon = item.icon === "target" ? Target : item.icon === "layers" ? Layers : null;
          const tone = item.tone ? BREADCRUMB_TONES[item.tone] : undefined;
          const content = Icon ? <>
            <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{item.label}</span>
          </> : item.label;
          return (
            <li className="flex shrink-0 items-center gap-1" key={`${item.label}-${index}`}>
              {index > 0 ? (
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-60" />
              ) : null}
              {item.href ? (
                <NavigationProgressLink
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "min-w-0 max-w-56 rounded-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    Icon ? "inline-flex items-center gap-1" : "truncate",
                    tone ? [tone, "hover:opacity-80"] : "hover:text-foreground",
                    current && "font-medium",
                    current && !tone && "text-foreground",
                  )}
                  href={item.href}
                  onClick={item.onClick}
                >
                  {content}
                </NavigationProgressLink>
              ) : (
                <span
                  aria-current={current ? "page" : undefined}
                  className={cn("min-w-0 max-w-56",Icon ? "inline-flex items-center gap-1" : "truncate",tone,current && "font-medium",current && !tone && "text-foreground")}
                >
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );

  return portal ? (
    <HeaderBreadcrumbPortal>{breadcrumb}</HeaderBreadcrumbPortal>
  ) : breadcrumb;
}

/**
 * Contextual header for a routed workspace destination.
 *
 * Breadcrumbs preserve the route hierarchy while the single h1 names the
 * current task. This avoids repeating a workspace identity as a second title.
 */
export function WorkspacePageHeader({
  actions,
  breadcrumbs,
  className,
  description,
  title,
  titleId,
}: WorkspacePageHeaderProps): React.ReactElement {
  const actionsRef = useWorkspacePageActionsTarget();

  return (
    <header className={cn("space-y-3",className)}>
      <WorkspaceBreadcrumbs breadcrumbs={breadcrumbs} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight" id={titleId}>{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {actions || actionsRef ? (
          <div
            className="flex flex-wrap items-center gap-2"
            ref={actionsRef}
          >
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}
