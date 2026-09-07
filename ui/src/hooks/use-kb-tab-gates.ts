"use client";

import { isDevAnonymousAuthEnabled } from "@/lib/auth/dev-auth-provider";
import type { KbTabGatesMap,KbTabKey } from "@/lib/rbac/types";
import { useSession } from "next-auth/react";
import { useCallback,useEffect,useRef,useState } from "react";

const EMPTY_GATES: KbTabGatesMap = {
  search: false,
  collections: false,
  data_sources: false,
  graph: false,
  mcp_tools: false,
  has_any_kb: false,
  kb_count: 0,
  can_ingest: false,
  can_search: false,
};

const DEV_AUTH_GATES: KbTabGatesMap = {
  search: true,
  collections: true,
  data_sources: true,
  graph: true,
  mcp_tools: true,
  has_any_kb: true,
  kb_count: -1,
  can_ingest: true,
  can_search: true,
};

interface KbTabGatesState {
  gates: KbTabGatesMap;
  loading: boolean;
  error: string | null;
  /** True iff the BFF served the response from the org-admin super-grant short-circuit. */
  orgAdminBypass: boolean;
  /** Convenience filter of `gates` with `true` values. */
  visibleTabs: KbTabKey[];
  /** Force a re-fetch (e.g. after a team admin grants the user a KB). */
  refresh: () => void;
}

/**
 * React hook — fetches Knowledge sidebar tab visibility from the BFF
 * (`GET /api/rbac/kb-tab-gates`) and exposes a `gates` map plus the
 * `has_any_kb` / `kb_count` fields the sidebar uses to render the
 * empty-state banner.
 *
 * Fails closed: until the BFF responds, every tab is hidden so we never
 * render a control the API would 403. After authentication completes the
 * hook fetches once per access-token change and caches the result.
 *
 * The route contract preserves the org-admin super-grant invariant while
 * failing closed for non-admin users until the BFF confirms visibility.
 */
export function useKbTabGates(): KbTabGatesState {
  const { data: session, status } = useSession();
  const [gates, setGates] = useState<KbTabGatesMap>(EMPTY_GATES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orgAdminBypass, setOrgAdminBypass] = useState(false);
  const lastTokenRef = useRef<string | undefined>(undefined);
  const devAuthEnabled = isDevAnonymousAuthEnabled();

  const fetchGates = useCallback(async () => {
    if (devAuthEnabled) {
      setGates(DEV_AUTH_GATES);
      setOrgAdminBypass(true);
      setError(null);
      setLoading(false);
      return;
    }

    if (status !== "authenticated") {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/rbac/kb-tab-gates");
      if (!res.ok) {
        throw new Error(`Failed to fetch KB tab gates: ${res.status}`);
      }
      const data = (await res.json()) as {
        gates?: KbTabGatesMap;
        org_admin_bypass?: boolean;
      };
      if (data.gates) setGates(data.gates);
      setOrgAdminBypass(Boolean(data.org_admin_bypass));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setGates(EMPTY_GATES);
      setOrgAdminBypass(false);
    } finally {
      setLoading(false);
    }
  }, [devAuthEnabled, status]);

  useEffect(() => {
    if (status === "loading") return;
    if (status === "unauthenticated") {
      if (devAuthEnabled) {
        setGates(DEV_AUTH_GATES);
        setOrgAdminBypass(true);
        setLoading(false);
        return;
      }
      setGates(EMPTY_GATES);
      setOrgAdminBypass(false);
      setLoading(false);
      return;
    }
    if (status !== "authenticated") return;

    const token = (session as { accessToken?: string; user?: { email?: string | null } } | null)
      ?.accessToken;
    const stableKey =
      token ?? `session:${(session as { user?: { email?: string | null } } | null)?.user?.email ?? ""}`;
    if (stableKey !== lastTokenRef.current) {
      lastTokenRef.current = stableKey;
      fetchGates();
    }
  }, [session, status, fetchGates, devAuthEnabled]);

  const visibleTabs = (Object.entries(gates) as [string, unknown][])
    .filter((entry): entry is [KbTabKey, boolean] => {
      const [key, value] = entry;
      return (
        typeof value === "boolean" &&
        (key === "search" ||
          key === "collections" ||
          key === "data_sources" ||
          key === "graph" ||
          key === "mcp_tools") &&
        value === true
      );
    })
    .map(([k]) => k);

  return { gates, loading, error, orgAdminBypass, visibleTabs, refresh: fetchGates };
}
