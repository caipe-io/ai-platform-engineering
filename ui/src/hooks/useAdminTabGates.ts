"use client";

// assisted-by Codex Codex-sonnet-4-6

import { allAdminTabGates,isDevAnonymousAuthEnabled } from "@/lib/auth/dev-auth-provider";
import type { AdminTabGatesMap,AdminTabKey,IntegrationPanelModesMap } from "@/lib/rbac/types";
import { useSession } from "next-auth/react";
import { useCallback,useEffect,useRef,useState } from "react";

const EMPTY_GATES: AdminTabGatesMap = {
  users: false,
  teams: false,
  roles: false,
  identity_group_sync: false,
  slack: false,
  webex: false,
  skills: false,
  feedback: false,
  stats: false,
  metrics: false,
  health: false,
  credentials: false,
  audit_logs: false,
  dynamic_agent_conversations: false,
  action_audit: false,
  openfga: false,
  migrations: false,
  approvals: false,
  service_accounts: false,
};

const ALL_GATES = allAdminTabGates(EMPTY_GATES);

interface AdminTabGatesState {
  gates: AdminTabGatesMap;
  /** Slack/Webex panel mode when the integration tab gate is open. */
  integrationPanelModes: IntegrationPanelModesMap;
  loading: boolean;
  error: string | null;
  /** Visible tab keys (convenience filter of gates with `true` values). */
  visibleTabs: AdminTabKey[];
  /** Force a re-fetch (e.g. after an admin updates a policy). */
  refresh: () => void;
}

/**
 * React hook — fetches admin tab visibility gates from the Web UI backend
 * and exposes a `gates` map for conditional rendering (US2, FR-004).
 *
 * Gates default to `false` (fail-closed) until the Web UI backend responds.
 * Results are cached per session and invalidated on token refresh.
 */
export function useAdminTabGates(): AdminTabGatesState {
  const { data: session, status } = useSession();
  const [gates, setGates] = useState<AdminTabGatesMap>(EMPTY_GATES);
  const [integrationPanelModes, setIntegrationPanelModes] = useState<IntegrationPanelModesMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastTokenRef = useRef<string | undefined>(undefined);
  const devAuthEnabled = isDevAnonymousAuthEnabled();

  const fetchGates = useCallback(async () => {
    if (devAuthEnabled) {
      setGates(ALL_GATES);
      setIntegrationPanelModes({ slack: "full", webex: "full" });
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
      const res = await fetch("/api/rbac/admin-tab-gates");
      if (!res.ok) {
        throw new Error(`Failed to fetch tab gates: ${res.status}`);
      }
      const data = await res.json();
      if (data.gates) {
        setGates(data.gates);
      }
      setIntegrationPanelModes(data.integration_panel_modes ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setGates(EMPTY_GATES);
      setIntegrationPanelModes({});
    } finally {
      setLoading(false);
    }
  }, [devAuthEnabled, status]);

  useEffect(() => {
    if (status === "loading") {
      return;
    }
    if (status === "unauthenticated") {
      if (devAuthEnabled) {
        setGates(ALL_GATES);
        setIntegrationPanelModes({ slack: "full", webex: "full" });
        setLoading(false);
        return;
      }
      setGates(EMPTY_GATES);
      setIntegrationPanelModes({});
      setLoading(false);
      return;
    }
    if (status !== "authenticated") {
      return;
    }

    // NextAuth may omit accessToken on the client session; still load gates using a stable key.
    const token = (session as { accessToken?: string; user?: { email?: string | null } } | null)
      ?.accessToken;
    const stableKey =
      token ?? `session:${(session as { user?: { email?: string | null } } | null)?.user?.email ?? ""}`;
    if (stableKey !== lastTokenRef.current) {
      lastTokenRef.current = stableKey;
      fetchGates();
    }
  }, [session, status, fetchGates, devAuthEnabled]);

  const visibleTabs = (Object.entries(gates) as [AdminTabKey, boolean][])
    .filter(([, v]) => v)
    .map(([k]) => k);

  return { gates, integrationPanelModes, loading, error, visibleTabs, refresh: fetchGates };
}
