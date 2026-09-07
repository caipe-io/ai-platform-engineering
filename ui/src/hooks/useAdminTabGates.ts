"use client";

// assisted-by Codex Codex-sonnet-4-6

import { allAdminTabGates,isDevAnonymousAuthEnabled } from "@/lib/auth/dev-auth-provider";
import type { AdminSimulationQueryTarget } from "@/lib/rbac/admin-simulation-query";
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
  simulation: AdminTabGateSimulation | null;
  /** Visible tab keys (convenience filter of gates with `true` values). */
  visibleTabs: AdminTabKey[];
  /** Force a re-fetch (e.g. after an admin updates a policy). */
  refresh: () => void;
}

export type AdminTabGateSimulationTarget = AdminSimulationQueryTarget;

interface AdminTabGateSimulation {
  active: boolean;
  readonly: true;
  subject?: {
    type: "user" | "team";
    id: string;
    relation?: "member" | "admin";
    openfga_user: string;
    display_name?: string;
    email?: string;
    organization_admin?: boolean;
  };
}

function adminTabGatesUrl(simulationTarget?: AdminTabGateSimulationTarget | null): string {
  if (!simulationTarget?.type || !simulationTarget.id) {
    return "/api/rbac/admin-tab-gates";
  }
  const params = new URLSearchParams({
    simulate_type: simulationTarget.type,
    simulate_id: simulationTarget.id,
  });
  if (simulationTarget.relation) {
    params.set("simulate_relation", simulationTarget.relation);
  }
  return `/api/rbac/admin-tab-gates?${params.toString()}`;
}

/**
 * React hook — fetches admin tab visibility gates from the Web UI backend
 * and exposes a `gates` map for conditional rendering (US2, FR-004).
 *
 * Gates default to `false` (fail-closed) until the Web UI backend responds.
 * Results are cached per session and invalidated on token refresh.
 */
export function useAdminTabGates(
  simulationTarget?: AdminTabGateSimulationTarget | null
): AdminTabGatesState {
  const { data: session, status } = useSession();
  const [gates, setGates] = useState<AdminTabGatesMap>(EMPTY_GATES);
  const [integrationPanelModes, setIntegrationPanelModes] = useState<IntegrationPanelModesMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [simulation, setSimulation] = useState<AdminTabGateSimulation | null>(null);
  const lastTokenRef = useRef<string | undefined>(undefined);
  const simulationKey = simulationTarget?.type && simulationTarget.id
    ? `${simulationTarget.type}:${simulationTarget.id}:${simulationTarget.relation ?? ""}`
    : "";
  const devAuthEnabled = isDevAnonymousAuthEnabled();

  const fetchGates = useCallback(async () => {
    if (devAuthEnabled && !simulationTarget) {
      setGates(ALL_GATES);
      setIntegrationPanelModes({ slack: "full", webex: "full" });
      setSimulation(null);
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
      const res = await fetch(adminTabGatesUrl(simulationTarget));
      if (!res.ok) {
        throw new Error(`Failed to fetch tab gates: ${res.status}`);
      }
      const data = await res.json();
      if (data.gates) {
        setGates(data.gates);
      }
      setIntegrationPanelModes(data.integration_panel_modes ?? {});
      setSimulation(data.simulation ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setGates(EMPTY_GATES);
      setIntegrationPanelModes({});
      setSimulation(null);
    } finally {
      setLoading(false);
    }
  }, [devAuthEnabled, simulationTarget, status]);

  useEffect(() => {
    if (status === "loading") {
      return;
    }
    if (status === "unauthenticated") {
      if (devAuthEnabled && !simulationTarget) {
        setGates(ALL_GATES);
        setIntegrationPanelModes({ slack: "full", webex: "full" });
        setSimulation(null);
        setLoading(false);
        return;
      }
      setGates(EMPTY_GATES);
      setIntegrationPanelModes({});
      setSimulation(null);
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
    const cacheKey = `${stableKey}|${simulationKey}`;
    if (cacheKey !== lastTokenRef.current) {
      lastTokenRef.current = cacheKey;
      fetchGates();
    }
  }, [session, status, fetchGates, simulationKey, devAuthEnabled, simulationTarget]);

  const visibleTabs = (Object.entries(gates) as [AdminTabKey, boolean][])
    .filter(([, v]) => v)
    .map(([k]) => k);

  return { gates, integrationPanelModes, loading, error, simulation, visibleTabs, refresh: fetchGates };
}
