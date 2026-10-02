"use client";

import { getStorageMode } from "@/lib/storage-config";
import { useChatStore } from "@/store/chat-store";
import { useSession } from "next-auth/react";
import { useEffect, useRef } from "react";

const SESSION_IDENTITY_KEY = "caipe-session-identity";

/**
 * Keep identity-owned browser state from crossing login, logout, or
 * impersonation boundaries. The durable identity marker also covers redirects
 * where this component unmounts before NextAuth publishes unauthenticated.
 */
export function SessionIdentityBoundary(): null {
  const { data: session, status } = useSession();
  const lastHandledState = useRef<string | null>(null);
  const subject = typeof session?.sub === "string" ? session.sub.trim() : "";
  const email = session?.user?.email?.trim().toLowerCase();
  const identity = subject ? `sub:${subject}` : email ? `email:${email}` : null;

  useEffect(() => {
    if (status === "loading") return;

    const stateKey = status === "authenticated" && identity
      ? identity
      : "unauthenticated";
    if (lastHandledState.current === stateKey) return;
    lastHandledState.current = stateKey;

    if (stateKey === "unauthenticated") {
      useChatStore.getState().clearAllConversations();
      return;
    }

    const previousIdentity = window.localStorage.getItem(SESSION_IDENTITY_KEY);
    if (
      (previousIdentity && previousIdentity !== identity)
      || (!previousIdentity && getStorageMode() === "mongodb")
    ) {
      useChatStore.getState().clearAllConversations();
    }
    window.localStorage.setItem(SESSION_IDENTITY_KEY, identity);
  }, [identity, status]);

  return null;
}
