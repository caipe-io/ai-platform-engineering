"use client";

import { usePathname } from "next/navigation";

import { AgenticAppShell } from "./AgenticAppShell";

/** The app layout survives changes to the catch-all page and owns the frame. */
export function RoutedAgenticAppShell({ appId, hostRoute = false }: { appId: string; hostRoute?: boolean }) {
  const pathname = usePathname() || "/";
  const prefix = hostRoute ? `/agentic-app-routes/${appId}` : `/apps/${appId}`;
  const suffix = pathname === prefix ? "" : pathname.startsWith(prefix + "/") ? pathname.slice(prefix.length) : pathname;
  const path = suffix.split("/").filter(Boolean).map(segment => decodeURIComponent(segment));
  return <AgenticAppShell appId={appId} path={path} hostRoute={hostRoute} />;
}
