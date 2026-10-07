"use client";

import { useUnsavedChangesStore } from "@/store/unsaved-changes-store";
import { NavigationProgressLink } from "@/components/layout/NavigationProgressLink";
import { usePathname } from "next/navigation";
import React from "react";

const EDITOR_ROUTES_WITH_OWN_DISCARD_DIALOG = [
  "/workflows",
  "/skills/workspace",
  "/dynamic-agents",
  "/knowledge-bases/collections",
];

const EDITOR_ROUTES_WITH_HEADER_DIALOG = [
  "/workflows",
  "/dynamic-agents",
];

function isOnGuardedEditor(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return EDITOR_ROUTES_WITH_OWN_DISCARD_DIALOG.some((route) =>
    pathname.startsWith(route),
  );
}

export function isOnHeaderDialogEditor(
  pathname: string | null | undefined,
): boolean {
  if (!pathname) return false;
  return EDITOR_ROUTES_WITH_HEADER_DIALOG.some((route) =>
    pathname.startsWith(route),
  );
}

interface GuardedNavigationLinkProps {
  "aria-current"?: "page";
  "aria-label"?: string;
  "data-navigation-leaf"?: string;
  "data-testid"?: string;
  children: React.ReactNode;
  className?: string;
  dataNavKey?: string;
  href: string;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  prefetch?: boolean;
  title?: string;
}

/**
 * Application navigation link that preserves the shared unsaved-change guard.
 */
export function GuardedNavigationLink({
  href,
  children,
  className,
  dataNavKey,
  onClick,
  prefetch,
  title,
  "aria-current": ariaCurrent,
  "aria-label": ariaLabel,
  "data-navigation-leaf": dataNavigationLeaf,
  "data-testid": testId,
}: GuardedNavigationLinkProps): React.ReactElement {
  const { hasUnsavedChanges,requestNavigation } = useUnsavedChangesStore();
  const pathname = usePathname();
  const onGuardedEditor = isOnGuardedEditor(pathname) && hasUnsavedChanges;

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (onGuardedEditor && href !== pathname) {
      event.preventDefault();
      requestNavigation(href);
    }
    onClick?.(event);
  };

  return (
    <NavigationProgressLink
      aria-current={ariaCurrent}
      aria-label={ariaLabel}
      className={className}
      data-navigation-leaf={dataNavigationLeaf}
      data-nav-key={dataNavKey}
      data-testid={testId}
      href={href}
      onClick={handleClick}
      prefetch={prefetch}
      title={title}
    >
      {children}
    </NavigationProgressLink>
  );
}
