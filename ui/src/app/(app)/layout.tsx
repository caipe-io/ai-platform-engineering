import {
  APPLICATION_NAVIGATION_COLLAPSED_COOKIE,
  isWorkspaceRailCollapsed,
} from "@/lib/workspace-rail";
import { cookies } from "next/headers";
import React from "react";
import { AppLayoutClient } from "./layout-client";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const cookieStore = await cookies();
  const initialNavigationCollapsed = isWorkspaceRailCollapsed(
    cookieStore.get(APPLICATION_NAVIGATION_COLLAPSED_COOKIE)?.value,
  );

  return (
    <AppLayoutClient
      initialNavigationCollapsed={initialNavigationCollapsed}
    >
      {children}
    </AppLayoutClient>
  );
}
