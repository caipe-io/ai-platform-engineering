"use client";

import type { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";

import { SessionIdentityBoundary } from "@/components/session-identity-boundary";

interface AuthProviderProps {
  children: React.ReactNode;
  session?: Session | null;
}

export function AuthProvider({ children, session }: AuthProviderProps) {
  return (
    <SessionProvider
      session={session}
      // Re-fetch session every 4 minutes so the JWT callback runs periodically
      // and can refresh the access token before it expires. Without this,
      // the callback only runs on page navigation or explicit updateSession() calls.
      refetchInterval={4 * 60}
      // Also re-fetch when the user returns to the tab after being away.
      // Background tabs throttle timers, so refetchInterval alone isn't enough.
      refetchOnWindowFocus={true}
    >
      <SessionIdentityBoundary />
      {children}
    </SessionProvider>
  );
}
