import {
  APPLICATION_NAVIGATION_COLLAPSED_COOKIE,
  isWorkspaceRailCollapsed,
} from "@/lib/workspace-rail";
import { authOptions } from "@/lib/auth-config";
import { getConfig } from "@/lib/config";
import { recordAppVisit } from "@/lib/app-usage";
import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { after } from "next/server";
import React from "react";
import { AppLayoutClient } from "./layout-client";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const sessionState = await requireApplicationSession();
  if (sessionState === "unavailable") {
    return <main role="alert" className="p-6 text-center">
      <p>Sign-in services are temporarily unavailable. Your session has not been cleared.</p>
      <a className="underline" href="">Retry</a>
    </main>;
  }
  if (sessionState === "authenticated" && process.env.APP_USAGE_ENABLED === "true") {
    const occurredAt = new Date();
    after(async () => {
      try {
        await recordAppVisit(occurredAt);
      } catch {
        // Analytics is best effort and never blocks admission or rendering.
        console.warn("[app-usage] Aggregate counter unavailable");
      }
    });
  }

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
async function requireApplicationSession(): Promise<"authenticated" | "anonymous" | "unavailable"> {
  const authRequired = process.env.NODE_ENV === "production" || getConfig("ssoEnabled");
  if (!authRequired) return "anonymous";

  const session = await getServerSession(authOptions);
  if (session?.error === 'SessionUnavailable') return "unavailable";
  if (!session || session.error || !session.user?.email) {
    redirect("/login");
  }
  if (session.isAuthorized === false) {
    redirect("/unauthorized");
  }
  return "authenticated";
}
