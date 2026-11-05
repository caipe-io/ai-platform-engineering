"use client";

import { beginNavigationProgress } from "@/lib/navigation-progress";
import Link from "next/link";
import React from "react";

export interface NavigationProgressLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  prefetch?: boolean;
}

/**
 * Next.js client navigation with brief, browser-native cursor feedback.
 */
export function NavigationProgressLink({
  children,
  href,
  onClick,
  prefetch,
  ...props
}: NavigationProgressLinkProps): React.ReactElement {
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
      || props.target === "_blank"
      || props.download
    ) return;

    beginNavigationProgress(href);
  };

  // Embedded app mounts share their path with a proxied runtime. A document
  // request selects the host shell; an RSC prefetch would select the iframe.
  if (href.startsWith("/apps/")) {
    return <a href={href} onClick={handleClick} {...props}>{children}</a>;
  }
  return (
    <Link href={href} onClick={handleClick} prefetch={prefetch} {...props}>
      {children}
    </Link>
  );
}
