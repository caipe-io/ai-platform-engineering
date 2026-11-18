"use client";

import { apiClient } from "@/lib/api-client";
import { getConfig } from "@/lib/config";
import { debugLog } from "@/lib/debug-log";
import { useSession } from "next-auth/react";
import { useEffect,useState } from "react";

/**
 * Hook to ensure user is initialized in MongoDB on first login
 * Calls /api/users/me to create user profile if it doesn't exist
 * Only runs when both SSO and MongoDB are enabled.
 */
export function useUserInit() {
  const { data: session, status } = useSession();
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const initializeUser = async () => {
      // Skip if SSO or MongoDB not enabled
      if (!getConfig('ssoEnabled') || getConfig('storageMode') !== 'mongodb') {
        setInitialized(true);
        return;
      }

      // Don't call API until user is fully authenticated
      if (status === "loading") {
        return; // Still loading session, wait
      }
      if (status !== "authenticated" || !session?.user?.email) {
        setInitialized(true); // Not authenticated — nothing to initialize
        return;
      }

      try {
        // Call /api/users/me to ensure user exists in MongoDB
        // This endpoint creates the user if it doesn't exist
        await apiClient.getCurrentUser();
        setInitialized(true);
        debugLog("[useUserInit] User profile initialized in MongoDB");
      } catch (err) {
        // 401/Unauthorized is expected when user isn't fully authenticated yet
        const msg = err instanceof Error ? err.message.toLowerCase() : '';
        if (msg.includes('401') || msg.includes('unauthorized')) {
          debugLog("[useUserInit] Not authenticated yet, skipping initialization");
          setInitialized(true);
          return;
        }
        console.error("[useUserInit] Failed to initialize user:", err);
        setError(err instanceof Error ? err.message : "Failed to initialize user");
      }
    };

    initializeUser();
  }, [status, session]);

  return { initialized, error };
}
