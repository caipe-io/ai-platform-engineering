"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";

export interface MigrationStatusSummary {
  release: string;
  pending_required_count: number;
  blocking_required_count: number;
  version_bootstrap_required_count?: number;
  version_bootstrap_schema_areas?: string[];
  needs_version_bootstrap?: boolean;
  requires_attention?: boolean;
  is_blocking: boolean;
  override_active: boolean;
}

/** Dispatched after the Migrations tab refreshes so the header alert pill stays in sync. */
export const MIGRATION_STATUS_REFRESH_EVENT = "caipe:migration-status-refresh";

export function refreshMigrationStatus(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(MIGRATION_STATUS_REFRESH_EVENT));
  }
}

/** Admin-only polling; a server denial suspends every automatic refresh. */
export function useMigrationStatus({ enabled = false }: { enabled?: boolean } = {}) {
  const { data: session, status: sessionStatus } = useSession();
  const principal = session?.sub || session?.user?.email;
  const [status, setStatus] = useState<MigrationStatusSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setStatus(null);
    setIsLoading(false);
    if (!enabled || sessionStatus !== "authenticated") return;

    const controller = new AbortController();
    let denied = false;
    let pending = false;
    const refresh = async () => {
      if (denied || pending || controller.signal.aborted) return;
      pending = true;
      setIsLoading(true);
      try {
        const response = await fetch("/api/rbac/migration-status", { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401 || response.status === 403) {
          denied = true;
          window.clearInterval(interval);
          setStatus(null);
          return;
        }
        if (!response.ok) {
          setStatus(null);
          return;
        }
        const body = (await response.json()) as { data?: MigrationStatusSummary };
        if (!controller.signal.aborted) setStatus(body.data ?? null);
      } catch {
        if (!controller.signal.aborted) setStatus(null);
      } finally {
        pending = false;
        if (!controller.signal.aborted) setIsLoading(false);
      }
    };
    const onRefresh = () => { void refresh(); };
    const interval = window.setInterval(onRefresh, 60_000);
    window.addEventListener("focus", onRefresh);
    window.addEventListener(MIGRATION_STATUS_REFRESH_EVENT, onRefresh);
    void refresh();

    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", onRefresh);
      window.removeEventListener(MIGRATION_STATUS_REFRESH_EVENT, onRefresh);
    };
  }, [enabled, sessionStatus, principal]);

  return { status, isLoading };
}
