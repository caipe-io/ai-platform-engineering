import {
  APPLICATION_NAVIGATION_COLLAPSED_COOKIE,
  isWorkspaceRailCollapsed,
} from "@/lib/workspace-rail";
import { authOptions } from "@/lib/auth-config";
import { getConfig } from "@/lib/config";
import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import React from "react";
import { AppLayoutClient } from "./layout-client";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  await requireApplicationSession();

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

/**
 * Enforce authentication once for every route below the `(app)` segment.
 *
 * Individual pages and APIs still keep their finer-grained authorization
 * checks, but a page must never become reachable merely because a new route
 * forgot to add its own client-side AuthGuard. The non-production exception
 * preserves the deliberately opt-in local anonymous development provider;
 * production always fails closed, even if SSO_ENABLED is accidentally false.
 */
async function requireApplicationSession(): Promise<void> {
  const authRequired = process.env.NODE_ENV === "production" || getConfig("ssoEnabled");
  if (!authRequired) return;

  const session = await getServerSession(authOptions);
  if (!session) {
    redirect("/login");
  }
  if (session.isAuthorized === false) {
    redirect("/unauthorized");
  }
}
